//! SSH 相关的 Tauri command。
//!
//! 和前两个模块的命令层一样**只做搬运**：真正的逻辑全在 `devtoolkit-ssh` 里，
//! 那样它能脱离 WebKit/GTK 跑测试（包括起一个进程内 SSH 服务端、以及打真 sshd
//! 的集成测试）。
//!
//! # 这一层唯一多出来的活儿：把事件流接上 `Channel`
//!
//! `devtoolkit-ssh` **不依赖 tauri**，所以它的出口是一条 `mpsc` 流，不是
//! `tauri::ipc::Channel`。适配放在这里 —— 一个闭包的事儿。
//!
//! # 为什么注册表是 `Arc<SshRegistry>` 而不是 `SshRegistry`
//!
//! 转发任务要活到会话结束，而它需要拿到注册表来收尾（`forget`）。
//! `State<'_, T>` 借的是 Tauri 自己管的那份，活不到 `'static`；
//! 管一个 `Arc` 进去，`.inner().clone()` 出来就能搬进 `tokio::spawn`。
//!
//! # ⚠️ 前端的 `Channel` 一次只能用一次
//!
//! Rust 侧的 `Channel` 被丢掉时会往 JS 发一条 `{end: true}`，JS 收到就把回调
//! **注销**。所以任何在发消息之前就返回的 `ssh_open`（TOFU 的第一次必然如此）
//! 都会把这个 Channel 打死 —— 前端必须**每次尝试都新建一个 Channel**，
//! 复用的话第二次的消息会全部石沉大海（终端一片空白，也没有报错）。

use std::sync::Arc;

use base64::Engine as _;
use devtoolkit_ssh::{forward, OpenOutcome, SshConfig, SshRegistry, TerminalEvent};
use tauri::ipc::Channel;
use tauri::State;

/// 建立会话。
///
/// 返回值的三种 `kind` 前端要分别处理，其中**主机密钥的两种拒绝走的是 `Ok`**
/// （理由见 `devtoolkit-ssh` 的 `lib.rs`）：`Ok` 只说明「这次往返做完了」，
/// 不代表会话开起来了 —— 判据是 `kind == "ready"`。
///
/// `Err` 留给「拿到就只想显示出来」的失败：连不上、超时、认证被拒。
#[tauri::command]
pub async fn ssh_open(
    registry: State<'_, Arc<SshRegistry>>,
    id: String,
    config: SshConfig,
    channel: Channel<TerminalEvent>,
) -> Result<OpenOutcome, String> {
    let opened = registry
        .open(&id, &config)
        .await
        .map_err(|e| e.to_string())?;

    if matches!(opened.outcome, OpenOutcome::Ready(_)) {
        let registry = Arc::clone(registry.inner());
        let session_id = id.clone();
        let generation = opened.generation;

        tauri::async_runtime::spawn(async move {
            // `forward` 在收到 Exit（永远是最后一个事件）时返回。
            // 无论它是正常结束还是前端已经没人听了，都要把会话从表里摘掉 ——
            // 摘的时候带代次，免得误摘掉同 id 的新会话
            forward(opened.events, |event| {
                let _ = channel.send(event);
            })
            .await;
            registry.forget(&session_id, generation);
        });
    }

    Ok(opened.outcome)
}

/// 往会话里发键盘输入。
///
/// `bytes` 是 **base64**，和输出方向对称。不走 `Vec<u8>` 是因为 serde 会把
/// 它编成数字数组（每个字节三四个字符），粘贴一大段文本时白胖三倍。
///
/// ⚠️ 前端**必须串行调用**这个命令：它是独立的 invoke，两次未 await 的调用
/// 到达顺序不保证，打字会乱序成 `sl`。串行化在 `services/tauri.ts` 里做。
#[tauri::command]
pub async fn ssh_write(
    registry: State<'_, Arc<SshRegistry>>,
    id: String,
    bytes: String,
) -> Result<(), String> {
    let data = base64::engine::general_purpose::STANDARD
        .decode(bytes.as_bytes())
        .map_err(|e| format!("终端输入不是合法的 base64：{e}"))?;
    registry.write(&id, &data).await.map_err(|e| e.to_string())
}

/// 告诉远端窗口大小变了。
///
/// 不发这个的话 `vim`、`top` 这类全屏程序会按旧尺寸排版，拉伸窗口之后花屏。
#[tauri::command]
pub async fn ssh_resize(
    registry: State<'_, Arc<SshRegistry>>,
    id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    registry
        .resize(&id, cols, rows)
        .await
        .map_err(|e| e.to_string())
}

/// 关掉一个会话。幂等：不存在也算成功（用户点「关标签」时它可能早就结束了）。
#[tauri::command]
pub async fn ssh_close(registry: State<'_, Arc<SshRegistry>>, id: String) -> Result<(), String> {
    registry.close(&id).await;
    Ok(())
}

/// 关掉全部会话。
///
/// 给「前端重新加载了」兜底：webview 一刷新，它那边的回调 id 全没了，但 Rust 侧的
/// 会话还活着 —— 用户在新界面上**看不见也关不掉**它们，远端那边还挂着登录着的
/// shell。前端 `init()` 时调一次这个，等于把孤儿收干净。
#[tauri::command]
pub async fn ssh_close_all(registry: State<'_, Arc<SshRegistry>>) -> Result<(), String> {
    registry.close_all().await;
    Ok(())
}
