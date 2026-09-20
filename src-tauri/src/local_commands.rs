//! 本地终端的 Tauri command：在**本机**起一个 shell（PowerShell / cmd / sh）。
//!
//! # 为什么在 SSH 模块里
//!
//! 用户的原话是「偶尔还是要用本地 ps、cmd 的」。而「终端」这件事（标签栏、
//! 命令块、颜色条、复制粘贴、快捷键）SSH 模块已经有一整套了 —— 本地终端和
//! 远端终端的差别只在**字节从哪来**，所以给它开一个新模块等于把那套东西抄一遍。
//!
//! # 为什么不重写一份 PTY
//!
//! `devtoolkit-agents` 里那套（`AgentRegistry` + `pty.rs`）就是「起本机进程、
//! 流字节、resize、**关掉时杀整棵进程树**」——正好是这里要的东西，而且
//! Windows 上还有 Job Object 收进程树那道保险。抄一份的话那些坑得再踩一遍。
//!
//! # ⚠️ 为什么要包一层 newtype
//!
//! Tauri 的 `State` 是**按类型**索引的：同一个 `Arc<AgentRegistry>` 类型
//! `manage` 两次，第二次会直接 panic（启动就崩）。而本地终端和智能体会话
//! **必须是两张独立的表** —— 两边的会话 id 是各自前端生成的，共用一个表的话
//! 撞了 id 就会互相把对方的会话顶掉（`open` 是替换语义）。
//!
//! 所以这里用一个 newtype 装**第二份**注册表：同一个实现，不同的表。

use std::collections::BTreeMap;

use base64::Engine as _;
use std::sync::Arc;

use devtoolkit_agents::registry::forward;
use devtoolkit_agents::{AgentRegistry, PtyConfig, PtyEvent};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

/// 本地终端的会话表。**和智能体会话那张表不是同一份**（见模块头）。
pub struct LocalTerminals(pub Arc<AgentRegistry>);

impl LocalTerminals {
    pub fn new() -> Self {
        LocalTerminals(Arc::new(AgentRegistry::new()))
    }
}

impl Default for LocalTerminals {
    fn default() -> Self {
        Self::new()
    }
}

/// 起一个本地终端。
///
/// `shell` 是**可选的**：空串 = 平台默认（Windows 上按 `pwsh` → `powershell` →
/// `cmd` 探测，Unix 上 `$SHELL` → `/bin/sh`，见 `devtoolkit_agents` 的
/// `default_shell`）。非空就按名字交给 portable-pty 去 PATH 里找
/// （它自己会补 `PATHEXT`，Windows 上 `pwsh` 能找到 `pwsh.exe`）。
///
/// 事件出口和 `agent_open` 一模一样：字节走 `channel` 推上去。前端那边的形状
/// 也是同一套（`TerminalEvent`），所以 SSH 模块的终端、命令块、标签栏**一行都不用改**。
#[tauri::command]
pub async fn local_open(
    app: AppHandle,
    terminals: State<'_, LocalTerminals>,
    id: String,
    shell: String,
    cols: u32,
    rows: u32,
    channel: Channel<PtyEvent>,
) -> Result<(), String> {
    // ⚠️ 尺寸在 Rust 侧再夹一道：0 列会让全屏程序算出垃圾布局（和 agent 那边同一条）
    let cols = cols.clamp(1, u16::MAX as u32) as u16;
    let rows = rows.clamp(1, u16::MAX as u32) as u16;

    // 工作目录用**用户主目录**：本地终端没别的地方可去，而主目录永远是存在的
    // （不像「当前工作目录」—— 那可能是应用自己的安装目录，跑起来很意外）
    let cwd = app
        .path()
        .home_dir()
        .map_err(|e| format!("拿不到用户主目录：{e}"))?;

    let trimmed = shell.trim();
    let config = PtyConfig {
        cwd: cwd.display().to_string(),
        // 空命令 = 只起一个 shell。本地终端没有「起来之后自动跑一条」这回事
        command: String::new(),
        cols: cols as u32,
        rows: rows as u32,
        shell: (!trimmed.is_empty()).then(|| trimmed.to_string()),
        env: BTreeMap::new(),
    };

    let opened = terminals.0.open(&id, &config).map_err(|e| e.to_string())?;

    // Channel 必须搬进转发任务（和 `agent_open` 同一个坑：留在这儿的话
    // 函数一返回它就被丢掉，前端那条回调立刻注销，终端一片空白且不报错）
    let registry = Arc::clone(&terminals.0);
    let session_id = id.clone();
    let generation = opened.generation;

    tauri::async_runtime::spawn(async move {
        forward(opened.events, |event| {
            let _ = channel.send(event);
        })
        .await;
        registry.forget(&session_id, generation);
    });

    Ok(())
}

/// 往本地终端里发键盘输入。base64，和 SSH / 智能体会话同一个理由（见它们的注释）。
///
/// ⚠️ 丢进 blocking 池：写 PTY 是**阻塞**的，Windows 上还会无限期阻塞
/// （ConPTY 的输入管道只有 4KB，对面不读输入时就填满了）—— 占着 tokio 的
/// 工作线程会把整个应用的命令通道拖死。这条教训写在 HANDOFF 里。
#[tauri::command]
pub async fn local_write(
    terminals: State<'_, LocalTerminals>,
    id: String,
    bytes: String,
) -> Result<(), String> {
    let data = base64::engine::general_purpose::STANDARD
        .decode(bytes.as_bytes())
        .map_err(|e| format!("终端输入不是合法的 base64：{e}"))?;

    let _span = crate::health::span("local_write", &id);
    let registry = Arc::clone(&terminals.0);
    tauri::async_runtime::spawn_blocking(move || registry.write(&id, &data))
        .await
        .map_err(|e| format!("写终端的线程没能跑起来：{e}"))?
        .map_err(|e| e.to_string())
}

/// 告诉本地终端尺寸变了。
#[tauri::command]
pub async fn local_resize(
    terminals: State<'_, LocalTerminals>,
    id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    let cols = cols.clamp(1, u16::MAX as u32) as u16;
    let rows = rows.clamp(1, u16::MAX as u32) as u16;

    let _span = crate::health::span("local_resize", &id);
    let registry = Arc::clone(&terminals.0);
    tauri::async_runtime::spawn_blocking(move || registry.resize(&id, cols, rows))
        .await
        .map_err(|e| format!("resize 的线程没能跑起来：{e}"))?
        .map_err(|e| e.to_string())
}

/// 关掉一个本地终端（**连同它那棵进程树**）。幂等。
#[tauri::command]
pub async fn local_close(
    terminals: State<'_, LocalTerminals>,
    id: String,
) -> Result<(), String> {
    let _span = crate::health::span("local_close", &id);
    let registry = Arc::clone(&terminals.0);
    tauri::async_runtime::spawn_blocking(move || registry.close(&id))
        .await
        .map_err(|e| format!("关终端的线程没能跑起来：{e}"))
}

/// 关掉全部本地终端。前端 `init()` 里调一次（webview 一刷新，那边认不得
/// Rust 侧还活着的会话了，不收的话用户看不见也关不掉它们）。
#[tauri::command]
pub async fn local_close_all(terminals: State<'_, LocalTerminals>) -> Result<(), String> {
    let _span = crate::health::span("local_close_all", "-");
    let registry = Arc::clone(&terminals.0);
    tauri::async_runtime::spawn_blocking(move || registry.close_all())
        .await
        .map_err(|e| format!("收尾的线程没能跑起来：{e}"))
}
