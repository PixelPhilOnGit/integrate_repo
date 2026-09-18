//! 活的 pane 表：替换、代次、收尾。
//!
//! 「代次」那几条是这个文件存在的理由 —— 收尾是**异步**发生的，它结束的时候
//! 那个 id 完全可能已经属于一个新会话了。这个 bug 在 SSH 那边写过一次
//! （表现是：窗格还在，但每一次输入都报「会话不在活动状态」，而且再也关不掉），
//! 这里不能再来一遍。

mod common;

use std::time::Duration;

use common::*;
use devtoolkit_agents::registry::forward;
use devtoolkit_agents::{AgentRegistry, PtyEvent};

/// ⚠️ **回归：旧会话的收尾不许摘掉新会话。**
///
/// 场景：用户关掉又立刻重开（或者前端重连），于是同一个 id 底下换了一个会话。
/// 这时候第一个会话的转发任务才慢悠悠地结束 —— 它拿着**旧的代次**来 `forget`，
/// 如果 forget 不校验代次，它摘掉的就是**活着的新会话**。
#[tokio::test]
async fn 旧代次的收尾摘不掉新会话() {
    let dir = TempDir::new("registry-generation");
    let reg = AgentRegistry::new();

    let first = reg.open("pane1", &cfg(dir.path(), "")).expect("第一次");
    let old_generation = first.generation;
    // 别让第一个会话的进程继续留在那儿 —— 我们要的是它的**代次**，不是它的命
    reg.close("pane1");

    let second = reg.open("pane1", &cfg(dir.path(), "")).expect("第二次");
    assert_ne!(old_generation, second.generation, "代次必须单调递增");

    // 旧会话的收尾（迟到的那个）
    reg.forget("pane1", old_generation);

    assert_eq!(reg.len(), 1, "旧代次的收尾把新会话摘掉了");
    // 新会话还能用（这才是有意义的判据：表里那条确实还是它）
    assert!(reg.write("pane1", b"echo x\r").is_ok());

    reg.forget("pane1", second.generation);
    assert!(reg.is_empty());
}

/// 收尾之后表是干净的，而且再收一次也不会出事（幂等）。
#[tokio::test]
async fn 收尾是幂等的() {
    let dir = TempDir::new("registry-forget");
    let reg = AgentRegistry::new();
    let opened = reg.open("p1", &cfg(dir.path(), "")).expect("起窗格");

    reg.forget("p1", opened.generation);
    reg.forget("p1", opened.generation);
    assert!(reg.is_empty());
}

/// 没开过的 id：写/resize 要**明确报错**（前端靠这个判断「这个窗格不能用了」），
/// 而 close 要当成功（用户点两次「关窗格」太常见了）。
#[tokio::test]
async fn 不存在的_id_写要报错_关不出错() {
    let reg = AgentRegistry::new();

    let err = reg.write("nope", b"x").expect_err("写不存在的会话要报错");
    assert!(err.to_string().contains("不在活动状态"), "{err}");
    assert!(reg.resize("nope", 80, 24).is_err());

    reg.close("nope"); // 不该 panic
    reg.close_all(); // 空表上也不该出事
    assert!(reg.is_empty());
}

/// 事件流结束之后由转发任务收尾 —— 这是**正常退出**那条路：
/// 进程自己没了，前端收到 `Exit`，转发任务退出，会话从表里摘掉。
#[tokio::test]
async fn 转发任务在退出事件上收工并且收尾() {
    let dir = TempDir::new("registry-forward");
    let reg = AgentRegistry::new();
    let config = cfg(dir.path(), &cmd("echo 走了; exit 7", "echo 走了 & exit 7"));

    let opened = reg.open("p1", &config).expect("起窗格");
    let generation = opened.generation;

    let mut seen = Vec::new();
    let code = forward(opened.events, |event| seen.push(event)).await;

    assert_eq!(code, Some(7), "退出码要带回来");
    assert!(
        matches!(seen.last(), Some(PtyEvent::Exit { .. })),
        "退出事件必须是最后一个"
    );
    // 输出也得在退出之前到齐（forward 不该吞掉数据）
    let text: String = seen
        .iter()
        .filter_map(|e| match e {
            PtyEvent::Data { bytes } => Some(text_of(bytes)),
            _ => None,
        })
        .collect();
    assert!(text.contains("走了"), "转发时丢了输出：{text}");

    // 这就是 agent_commands 里转发任务收尾干的事
    reg.forget("p1", generation);
    assert!(reg.is_empty());
}

/// 前端把窗格关了（或者 webview 重载了）之后，转发任务**照样要能收工** ——
/// 它是靠 `Exit` 退出的，不是靠「还有没有人听」。
///
/// 收不了工的后果是那个任务永远挂着，会话也永远留在表里（每次输入都成功，
/// 但没人再看得到输出）。
#[tokio::test]
async fn 没人听的时候转发任务也能收工() {
    let dir = TempDir::new("registry-forward-close");
    let reg = AgentRegistry::new();
    let opened = reg.open("p1", &cfg(dir.path(), "")).expect("起窗格");

    // 模拟「前端把窗格关了」：整张表收干净，会话被 kill
    reg.close_all();

    let finished = tokio::time::timeout(
        Duration::from_secs(5),
        forward(opened.events, |_| {}),
    )
    .await;
    assert!(finished.is_ok(), "窗格关了之后转发任务没收工");
}

fn text_of(bytes: &str) -> String {
    use base64::Engine as _;
    String::from_utf8_lossy(
        &base64::engine::general_purpose::STANDARD
            .decode(bytes.as_bytes())
            .expect("合法 base64"),
    )
    .to_string()
}
