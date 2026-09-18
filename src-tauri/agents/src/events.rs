//! 状态事件目录：agent 的钩子往里写文件，我们读走并删掉。
//!
//! # 约定（和前端定死的，别单方面改）
//!
//! * **一个会话一个文件**，状态写在**文件名**里：`<state>.<paneId>`
//! * `state` ∈ `working` / `waiting` / `done`。`exited` / `idle` / `starting`
//!   是**脚本写不出来的**状态（`exited` 由 pty 自己报，比脚本可靠得多；
//!   `idle` 没有对应的钩子事件），所以出现就当不认识 —— 见 [`parse_name`]。
//! * **时间戳用文件的 mtime**，脚本一个字都不用写（`%TIME%` 在 Windows 上
//!   还带 locale 问题）。
//! * `paneId` 的字符集是 `[A-Za-z0-9_-]{1,64}`，**绝不能含路径分隔符或点** ——
//!   文件名是拼出来当路径用的，这是那道防目录穿越的边界。
//!
//! # 为什么是「写文件」而不是「调我们的程序」
//!
//! Claude Code 的钩子是**同步阻塞 agent** 的。而 Tauri 二进制启动要 200ms+，
//! 每回合卡 200ms 用户会以为工具坏了。往文件里写一个是 shell 一句重定向的事。
//!
//! 顺带的好处：不占端口、Windows 上不弹防火墙、**应用没开着的时候事件也不丢**
//! （攒在目录里，下次启动一口气读到）。
//!
//! # 这一层把目录里的东西全当**不可信输入**
//!
//! 目录里会有杂物：编辑器残留（`.swp`）、用户手扔进来的说明文件、别的程序
//! 顺手放的临时文件。所以规则是**白名单**：认不出来的名字静静跳过，
//! **绝不报错**。报错的后果很具体 —— 用户会看到一条莫名其妙的红色错误条，
//! 而原因只是某个编辑器在这个目录里留了个隐藏文件。

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::AgentError;

/// 事件目录在应用数据目录下的名字。
///
/// 由 Rust 侧决定，前端只拿到绝对路径（`agent_events_dir`）——
/// 路径穿越的边界要尽量窄，能不算的地方就别让前端算。
pub const EVENTS_DIR_NAME: &str = "agent-events";

/// 钩子脚本能写的三个状态。
///
/// **顺序就是状态的语义顺序**（干活 → 要你 → 干完了），
/// 有测试盯着它和 `parse_name` 保持一致。
pub const EVENT_STATES: [&str; 3] = ["working", "waiting", "done"];

/// `paneId` 的长度上限。前端那边也是 64，两边必须一样。
pub const PANE_ID_MAX: usize = 64;

/// 事件目录的绝对路径。
pub fn events_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(EVENTS_DIR_NAME)
}

/// 读出来的一条事件。**这个结构就是 IPC 契约**（见 `contract` 测试）。
///
/// 只给文件名和 mtime，**不解析**：状态和会话 id 的解析在前端的
/// `core/events.ts` 里（那边有它自己的测试），这里再解析一遍等于同一份规则
/// 存两处，迟早不一致。这一层的职责只有两件：**认得出哪些是我们的**（好跳过杂物、
/// 好知道该删谁）、**把时间带出去**（那是文件系统的事实，前端拿不到）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RawEvent {
    /// 完整的文件名（`waiting.pane_k3f9x2a1`）
    pub name: String,
    /// 文件的 mtime，**毫秒** Unix 时间戳
    pub at: u64,
}

/// 会话 id 的字符集校验：`[A-Za-z0-9_-]`，1..=64 个字符。
///
/// ⚠️ **这是这个模块里唯一一条真的路径穿越的入口**，而且它绕过 Rust 侧所有
/// 路径校验：id 会当环境变量注入给钩子脚本，脚本拿它**拼文件名**
/// （`> "$DIR/waiting.$DEVTOOLKIT_PANE_ID"`）。一个含 `/`、`\` 或者 `..` 的 id
/// 能让那句重定向**写到事件目录外面去** —— 脚本是 shell，它不做任何校验。
///
/// 所以调用方（`pty::spawn`）必须在**注入环境变量之前**拦下来。
pub fn valid_pane_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= PANE_ID_MAX
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// 解析一个文件名。认得出来就给 `(state, pane_id)`，认不出来给 `None`。
///
/// 规则（和前端 `parseEventName` 一一对应）：
/// * 恰好一个 `.`（多个点不猜哪个才是分隔符）
/// * 状态段转小写之后在白名单里 —— **Windows 的文件名本来就不区分大小写**，
///   用户在别处把 `done.x` 写成 `Done.x` 我们也该认
/// * 会话 id：`[A-Za-z0-9_-]`，1..=64 个字符，**区分大小写**
///
/// 会话 id **必须**排除 `.`、`/`、`\`：文件名会被拼成路径（`目录 + 名称`），
/// 名字里带上 `..` 或者分隔符就能指到目录外面去。
pub fn parse_name(name: &str) -> Option<(&str, &str)> {
    let (state, rest) = name.split_once('.')?;

    // 还剩点就说明不止一个分隔符（`waiting.a.b`、`waiting...`、`waiting.s1.swp`）
    if rest.contains('.') {
        return None;
    }
    if rest.is_empty() || rest.len() > PANE_ID_MAX {
        return None;
    }
    if !rest
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return None;
    }

    let lower = state.to_ascii_lowercase();
    let known = EVENT_STATES.iter().find(|s| **s == lower)?;
    Some((known, rest))
}

/// 读走目录里的全部事件，**读完就删**（一个事件只用一次）。
///
/// 目录不存在就建出来（应用第一次跑的时候它还没被创建过）。
///
/// 返回的事件**按时间升序**排好。前端是逐条按时间顺序喂给状态机的
/// （`working` 紧接着 `waiting` 这一对压成一条就会丢掉「它离开过等待又回来了」
/// 这个事实），所以这个顺序是语义的一部分，不该让每个调用点自己去排。
/// 同一毫秒的按文件名排，保证同样的目录每次读出来顺序一样（可测）。
pub fn scan(dir: &Path) -> Result<Vec<RawEvent>, AgentError> {
    std::fs::create_dir_all(dir).map_err(|e| AgentError::Events {
        dir: dir.display().to_string(),
        reason: format!("建目录失败：{e}"),
    })?;

    let entries = std::fs::read_dir(dir).map_err(|e| AgentError::Events {
        dir: dir.display().to_string(),
        reason: format!("读目录失败：{e}"),
    })?;

    let mut events = Vec::new();

    for entry in entries {
        // 单项读不出来（权限、竞态删除）就当它不存在。**一条坏记录不能让整批
        // 事件读不出来** —— 那会让状态点集体失灵，而原因只是某个文件恰好
        // 在扫描的瞬间被删掉了
        let Ok(entry) = entry else { continue };
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };

        if parse_name(name).is_none() {
            continue;
        }

        // symlink_metadata 而不是 metadata：**不跟随符号链接**。
        // 一个断掉的软链接 `waiting.x` 也该被消费掉，否则它会永远躺在目录里，
        // 每次扫描都要重新判断一遍
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            // 目录（哪怕是叫 `done.pane1` 的目录）不是我们写的，别动它
            continue;
        }

        let at = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            // 时钟被设到 1970 之前、或者文件系统不给 mtime：当成「很久以前」。
            // **不能用「现在」** —— 那会让一条陈年事件看起来像刚刚发生的
            .unwrap_or(0);

        take(&entry.path(), RawEvent { name: name.to_string(), at }, &mut events);
    }

    events.sort_by(|a, b| a.at.cmp(&b.at).then_with(|| a.name.cmp(&b.name)));
    Ok(events)
}

/// 收下一条事件，然后把它从磁盘上删掉（**一个事件只用一次**）。
///
/// ⚠️ **删除失败时事件照样留在结果里**（先 push 再删，删不掉也不回滚）。
/// 下次扫描会再读到它一次，于是前端又收到一遍同样的 `(state, at)`。
///
/// 两个方向都是错的，选这个的理由：这个模块的全部价值就是「它在等你」那个提醒。
/// **丢掉**事件 = 这一回合的状态变化永远没了，用户根本不知道有东西在等；
/// **重复**一条 = 最多多应用一次同样的状态。宁可重复。
///
/// 代价说清楚：重复的那条**带着旧的 mtime**，前端如果不看时间戳就应用，
/// 会把状态改回旧值 —— 所以前端有一条配套要求：
/// **忽略比会话当前 statusAt 还早的信号**。
///
/// 删不掉通常是 Windows 上「文件被别的进程占着」，或者权限问题，
/// 都是一次性的怪状态，不值得为它设计一套重试。
fn take(path: &Path, event: RawEvent, out: &mut Vec<RawEvent>) {
    out.push(event);
    if let Err(e) = std::fs::remove_file(path) {
        eprintln!(
            "Devtoolkit：事件文件删不掉（{}），它下次还会被读到一次：{e}",
            path.display()
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ⚠️ **删不掉的事件也得给出去。**
    ///
    /// 这里拿一个**目录**当「删不掉的文件」：`remove_file` 对目录一定失败
    /// （EISDIR/EPERM），而权限位那套在 root 下根本模拟不出来（root 无视它们，
    /// 而本地开发和 CI 容器里都可能是 root）。所以用「一定删不掉」的东西
    /// 来钉住这条策略，而不是去伪造一个 EACCES。
    #[test]
    fn 删不掉的事件照样给出去() {
        let dir = std::env::temp_dir().join(format!("devtoolkit-events-take-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("建目录");
        let undeletable = dir.join("waiting.pane1");
        std::fs::create_dir_all(&undeletable).expect("建一个删不掉的目录");

        let mut out = Vec::new();
        take(
            &undeletable,
            RawEvent {
                name: "waiting.pane1".to_string(),
                at: 7,
            },
            &mut out,
        );

        assert_eq!(out.len(), 1, "删不掉的时候**不能**把事件收回去");
        assert_eq!(out[0].name, "waiting.pane1");
        assert!(undeletable.exists(), "前提变了：这个目录居然被删掉了");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
