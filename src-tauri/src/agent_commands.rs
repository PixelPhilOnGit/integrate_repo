//! 智能体会话的 Tauri command。
//!
//! 和前四个模块的命令层一样**只做搬运**：真正的逻辑全在 `devtoolkit-agents` 里，
//! 那样它能脱离 WebKit/GTK 跑测试（**真起进程、真杀进程树**那种）。
//!
//! # 这一层多出来的活儿：把事件流接上 `Channel`
//!
//! 和 `ssh_open` 一模一样：`devtoolkit-agents` **不依赖 tauri**，出口是一条
//! `mpsc` 流，适配放在这里。
//!
//! ⚠️ 和 SSH 那条**同一个坑**：前端的 `Channel` 一次只能用一次（Rust 侧丢掉它
//! 会往 JS 发 `{end: true}`，JS 收到就把回调注销）。所以 `agent_open` 必须
//! **把 Channel 搬进转发任务**里，而不是让它跟着函数返回一起被丢掉。
//!
//! # ⚠️ 安全模型：这里会写**用户主目录**里的文件
//!
//! 别的命令都过工作区沙箱（README 的「安全模型」那一节），这一组不是 ——
//! 它改的是 `~/.claude/settings.json` 和 `~/.codex/config.toml`。
//!
//! 所以形状是**故意**这样的：
//!
//! * 路径在 [`paths`] 里从 `app_data_dir()` / `home_dir()` **算出来**；
//! * 前端能传的只有一个 [`IntegrationTarget`] 枚举值（`claude` / `codex`），
//!   **没有任何一个参数是路径**。
//!
//! 也就是说，前端即使被 XSS 拿到，也只能在这两个写死的文件之间选一个 ——
//! 而不是「往任意路径写」。这条不是靠约定，是靠**参数表里没有路径这个类型**。

use std::sync::Arc;

use base64::Engine as _;
use devtoolkit_agents::integration::{self, AgentPaths, IntegrationTarget};
use devtoolkit_agents::registry::forward;
use devtoolkit_agents::{
    events, AgentError, AgentRegistry, EnvironmentReport, IntegrationOutcome, IntegrationStatus,
    PtyConfig, PtyEvent, RawEvent, RemoteOutcome, RemoteRegistry, RemoteSpec,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

/// 从 Tauri 求两个目录。**这是路径的唯一来源**（见模块头）。
///
/// 求不出来（系统没给）就明确失败 —— 这时候宁可不做，也不能猜一个目录去写。
fn paths(app: &AppHandle) -> Result<AgentPaths, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("拿不到用户主目录：{e}"))?;
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("拿不到应用数据目录：{e}"))?;
    Ok(AgentPaths { home, data_dir })
}

/// `agent_open` 收的配置：**本机那套字段 + 一个可选的远端目标**。
///
/// ⚠️ 和 `PtyConfig` 的字段几乎一样，但没有直接复用它：`PtyConfig` 是
/// `devtoolkit-agents` 里「起一个本机 pty 要什么」，不该认识 `RemoteSpec`
/// （那是远端才有的东西）。这一层多出来的就是这个 `remote`。
///
/// ⚠️ **没用 serde 的 `flatten`**：它和 `rename_all` 一起用时字段名会出岔子
/// （真机上踩过「Rust 里叫 `private_key_path`、前端发的是 `privateKeyPath`」那类坑），
/// 而这里字段就那么几个，手写一遍更稳。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOpenConfig {
    pub cwd: String,
    #[serde(default)]
    pub shell: Option<String>,
    #[serde(default)]
    pub command: String,
    pub cols: u32,
    pub rows: u32,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// 空 = **本机**（默认，也是这一版之前唯一的形态）
    #[serde(default)]
    pub remote: Option<RemoteSpec>,
}

impl AgentOpenConfig {
    /// 剥掉远端那一层，剩下本机 pty 要的东西
    fn to_pty_config(&self) -> PtyConfig {
        PtyConfig {
            cwd: self.cwd.clone(),
            command: self.command.clone(),
            cols: self.cols,
            rows: self.rows,
            shell: self.shell.clone(),
            env: self.env.clone(),
        }
    }
}

/// `agent_open` 的结局。
///
/// ⚠️ 主机密钥那两种**不是错误**：前端要弹窗让用户核对指纹（和 SSH 那边
/// 同一个道理，见 `ssh_commands` 的 `OpenOutcome`）。所以这里不能用
/// `Result<(), String>` —— 那条路上只有一句字符串，结构化信息到不了。
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AgentOpenOutcome {
    Ready,
    /// 这台机器没见过。带着指纹给用户核对
    HostKeyUnknown { algorithm: String, fingerprint: String },
    /// 指纹变了 —— **硬停**。界面上没有「就这样继续」，用户得先去清掉那条记录
    HostKeyMismatch { expected: String, actual: String },
}

/// 起一个窗格。
///
/// `config` 是 `{ cwd, shell, command, cols, rows, env, remote? }`
/// （见 [`AgentOpenConfig`]）。**`remote` 给了就连那台机器**，
/// 起来的东西在那边；没给就是本机（默认，也是这一版之前唯一的形态）。
///
/// 命令**不在 argv 里** —— 起的是一个正常 shell，命令当初始输入敲进去，
/// 理由见 `devtoolkit-agents/src/pty.rs` 的头注释。远端那条路一样：
/// 连上之后先 `cd` 到那个目录、再把命令送进去（见 `agents/src/remote.rs`）。
/// 命令**不在 argv 里** —— 起的是一个正常 shell，命令当初始输入敲进去，
/// 理由见 `devtoolkit-agents/src/pty.rs` 的头注释。
///
/// 返回 `Ok(())` 只说明「进程起来了」。之后的输出、退出都走 `channel`：
///
/// ```text
/// agent_open(id, config, channel)   ← channel 是 tauri::ipc::Channel，单向推
///         │
///         ├─ Rust：pty 读线程 → mpsc → 转发任务 → channel.send(Data{base64})
///         └─ 前端：onmessage → 解码 → xterm.write(bytes)
/// ```
///
/// 起不来（工作目录不存在、shell 找不到）走 `Err`，错误文案已经是中文的
/// 「起不来：工作目录不存在：……」那种形状，前端可以直接拿它当状态说明
/// （`status.ts` 里那条 `exited` + `detail`）。
#[tauri::command]
pub async fn agent_open(
    app: AppHandle,
    registry: State<'_, Arc<AgentRegistry>>,
    remotes: State<'_, Arc<RemoteRegistry>>,
    id: String,
    config: AgentOpenConfig,
    channel: Channel<PtyEvent>,
) -> Result<AgentOpenOutcome, String> {
    if let Some(spec) = config.remote.clone() {
        return open_remote(&remotes, id, config, spec, channel).await;
    }

    let mut config = config.to_pty_config();
    // ⚠️ **这两个环境变量由 Rust 说了算，前端传什么都不作数。**
    //
    // 它们决定「钩子把状态写到哪个文件、替哪个会话写」—— 整条状态链路
    // （脚本 → 事件文件 → 我们读 → 前端状态机）都挂在这两个值上，而**它出偏差是
    // 静默的**：目录写错了，界面上只是「状态点永远不动」，没有任何报错。
    // 所以只留一个来源：会话 id 是我们手里的 `id`，目录是 [`agent_events_dir`]
    // 算出来的那个（它顺带保证目录存在）。
    //
    // 前端仍然可以传 `env`（契约里那个字段还在），但传进来的是别的键才会生效 ——
    // 这样它的「注入环境变量」语义还在，只是这两个键不允许被覆盖。
    let events_dir = ensure_events_dir(&app)?;
    config
        .env
        .insert("DEVTOOLKIT_PANE_ID".to_string(), id.clone());
    config
        .env
        .insert("DEVTOOLKIT_EVENT_DIR".to_string(), events_dir);

    let opened = registry.open(&id, &config).map_err(|e| e.to_string())?;

    // Channel 和注册表都要搬进转发任务（Channel 尤其重要：留在这儿的话
    // 函数一返回它就被丢掉，前端那条回调立刻注销，终端一片空白还没有报错）
    let registry = Arc::clone(registry.inner());
    let session_id = id.clone();
    let generation = opened.generation;

    tauri::async_runtime::spawn(async move {
        // `forward` 在收到 Exit（永远是最后一个事件）时返回
        forward(opened.events, |event| {
            let _ = channel.send(event);
        })
        .await;
        // 收尾时把会话从表里摘掉。带代次，免得误摘掉同 id 的新会话
        registry.forget(&session_id, generation);
    });

    Ok(AgentOpenOutcome::Ready)
}

/// 远端那条路：连着别人的机器开会话。
///
/// ⚠️ **和本机那条路分开写**而不是揉在一起：本机是同步的 `registry.open`，
/// 远端是 async 的 `remote::open`，中间还要处理主机密钥那两态 ——
/// 硬揉的话每一行都要 match。
///
/// ⚠️ 远端会话**不注入那两个钩子用的环境变量**（`DEVTOOLKIT_PANE_ID` /
/// `DEVTOOLKIT_EVENT_DIR`）：那是往**本机**的事件目录里写文件用的，
/// 而远端机器上既没有我们的包装脚本、也不该有。
/// 所以远端会话的状态**只靠 OSC 序列和用户的键盘**两条路（见 HANDOFF）。
async fn open_remote(
    remotes: &Arc<RemoteRegistry>,
    id: String,
    config: AgentOpenConfig,
    spec: RemoteSpec,
    channel: Channel<PtyEvent>,
) -> Result<AgentOpenOutcome, String> {
    let generation = next_generation();

    // ⚠️ 事件流是**返回出来**的（和 `registry.open` 那边一个形状）——
    // 这一层不用认识 tokio，直接拿它去喂 `forward`
    let outcome = devtoolkit_agents::remote::open(
        &id,
        &spec,
        &config.cwd,
        &config.command,
        config.cols,
        config.rows,
        generation,
    )
    .await
    .map_err(|e| e.to_string())?;

    let (session, events) = match outcome {
        RemoteOutcome::Ready { session, events } => (session, events),
        RemoteOutcome::HostKeyUnknown { algorithm, fingerprint } => {
            return Ok(AgentOpenOutcome::HostKeyUnknown { algorithm, fingerprint });
        }
        RemoteOutcome::HostKeyMismatch { expected, actual } => {
            return Ok(AgentOpenOutcome::HostKeyMismatch { expected, actual });
        }
    };

    remotes.insert(&id, generation, session).await;

    // 转发任务：和本机那条路**同一个转发器**（Channel 必须搬进来，否则函数一返回
    // 它就被丢掉，前端那条回调立刻注销、终端一片空白还没有报错）
    let remotes = Arc::clone(remotes);
    let session_id = id.clone();
    tauri::async_runtime::spawn(async move {
        forward(events, |event| {
            let _ = channel.send(event);
        })
        .await;
        // 收尾时把它从远端表里摘掉 —— 和本机那条路一样
        remotes.close(&session_id).await;
    });

    Ok(AgentOpenOutcome::Ready)
}

/// 远端会话的 generation —— 和本机那条路**各算各的**（两张表互不相干）。
///
/// 用一个模块级的计数器：只要单调递增就够，它唯一的用途是「别让上一轮的
/// 残留顶掉新会话」。
fn next_generation() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(1);
    NEXT.fetch_add(1, Ordering::SeqCst)
}

/// 往窗格里发键盘输入。
///
/// `bytes` 是 **base64**，和 SSH 那边同一个理由（`Vec<u8>` 过 serde_json 会变成
/// 数字数组；按字符串传会在多字节 UTF-8 被块边界切断时变成 U+FFFD）。
///
/// ⚠️ 前端**必须串行调用**：每次是独立的 invoke，两次没 await 的调用到达顺序
/// 不保证，打字会乱序成 `sl`。串行化在 `modules/agents/services/tauri.ts` 里做。
///
/// # ⚠️ 为什么写要丢到 blocking 线程池
///
/// 写 PTY **是阻塞的**，而且在 Windows 上会**无限期**地阻塞：ConPTY 的输入
/// 是一根 4KB 的匿名管道（阻塞模式），对面（`claude` / `codex` 正在想事情的时候）
/// 不读标准输入，管道就会填满，`write_all` 就卡在那儿 —— 卡多久没有上界。
///
/// 这个函数以前是 `async fn` 但**里面一个 await 都没有**，于是那具阻塞的写
/// 直接跑在 tokio 的**工作线程**上。工作线程是按 CPU 核数配的，堵住几个，
/// 整个应用的命令通道就全停了：界面点什么都没反应，连「关掉这个窗格」
/// 都排不上队 —— 用户看到的就是**假死**。
///
/// 丢进 blocking 池之后，堵住的只是一个可以随时再多开一个的线程池线程，
/// IPC 那条路照样能跑（包括关窗格和退出）。
#[tauri::command]
pub async fn agent_write(
    registry: State<'_, Arc<AgentRegistry>>,
    remotes: State<'_, Arc<RemoteRegistry>>,
    id: String,
    bytes: String,
) -> Result<(), String> {
    let data = base64::engine::general_purpose::STANDARD
        .decode(bytes.as_bytes())
        .map_err(|e| format!("终端输入不是合法的 base64：{e}"))?;

    // ⚠️ **远端优先**：这个 id 上挂着远端会话就走那边（它是 async 的、
    // 不该丢进 blocking 池 —— 那边是给「会无限期阻塞的本地 pty 写」准备的）
    if let Some(session) = remotes.get_any(&id) {
        let _span = crate::health::span("agent_write", &id);
        return session.write(&data).await.map_err(|e| e.to_string());
    }

    // 卡住的话它会一直挂在健康日志的「在跑」那一列里（见 `health.rs`）
    let _span = crate::health::span("agent_write", &id);
    let registry = registry.inner().clone();
    tauri::async_runtime::spawn_blocking(move || registry.write(&id, &data))
        .await
        .map_err(|e| format!("写窗格的线程没能跑起来：{e}"))?
        .map_err(|e| e.to_string())
}

/// 告诉窗格里的程序尺寸变了（用户拖了分隔条、或者切了布局）。
///
/// 尺寸在 Rust 侧还会夹一遍（0 列会让全屏程序算出垃圾布局）。
#[tauri::command]
pub async fn agent_resize(
    registry: State<'_, Arc<AgentRegistry>>,
    remotes: State<'_, Arc<RemoteRegistry>>,
    id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    // 远端优先（同 `agent_write`）
    if let Some(session) = remotes.get_any(&id) {
        let cols = cols.clamp(1, 1000);
        let rows = rows.clamp(1, 1000);
        return session.resize(cols, rows).await.map_err(|e| e.to_string());
    }

    // 前端那边 `clampSize` 已经把明显的垃圾挡住了；这里是第二道。
    // 夹到 u16 是因为 pty 的尺寸就是这个宽度（IPC 上是 u32，好让前端传得进来）
    let cols = cols.clamp(1, u16::MAX as u32) as u16;
    let rows = rows.clamp(1, u16::MAX as u32) as u16;

    // 同 `agent_write`：`ResizePseudoConsole` 在旧版 Windows 上会等客户端，
    // 而 resize 还要拿 master 的锁（别的线程可能正卡在里面）—— 别占着工作线程
    let _span = crate::health::span("agent_resize", &id);
    let registry = registry.inner().clone();
    tauri::async_runtime::spawn_blocking(move || registry.resize(&id, cols, rows))
        .await
        .map_err(|e| format!("resize 的线程没能跑起来：{e}"))?
        .map_err(|e| e.to_string())
}

/// 关掉一个窗格（**连同它那棵进程树**）。幂等：不存在也算成功。
///
/// 同 `agent_write`：这里会 `TerminateJobObject`（**等整棵树死**）并拿两把锁，
/// 都可能在坏情况下等很久。丢到 blocking 池，别把命令通道拖死。
#[tauri::command]
pub async fn agent_close(
    registry: State<'_, Arc<AgentRegistry>>,
    remotes: State<'_, Arc<RemoteRegistry>>,
    id: String,
) -> Result<(), String> {
    // 远端优先。两边都关一遍也没关系（各自的 close 都是幂等的、
    // 而且 id 不会同时挂在两张表上）
    if remotes.get_any(&id).is_some() {
        let _span = crate::health::span("agent_close", &id);
        remotes.close(&id).await;
        return Ok(());
    }

    let _span = crate::health::span("agent_close", &id);
    let registry = registry.inner().clone();
    tauri::async_runtime::spawn_blocking(move || registry.close(&id))
        .await
        .map_err(|e| format!("关窗格的线程没能跑起来：{e}"))
}

/// 关掉全部窗格。给两件事用：
///
/// 1. 前端 `init()` —— webview 一刷新，它那边的回调 id 全没了，但 Rust 侧的
///    pane 还活着，用户在新界面上**看不见也关不掉**它们；
/// 2. 应用退出（在 `lib.rs` 的 `RunEvent::Exit` 里直接调注册表，不走这条命令）。
#[tauri::command]
pub async fn agent_close_all(
    registry: State<'_, Arc<AgentRegistry>>,
    remotes: State<'_, Arc<RemoteRegistry>>,
) -> Result<(), String> {
    // 远端那半：它是 async 的，直接 await（不占 blocking 池）
    remotes.close_all().await;

    // 同上：收尾要杀树 + 拿锁，可能等很久。前端 `init()` 会同步等这个调用，
    // 堵住工作线程等于把「刚打开应用」也拖住
    let _span = crate::health::span("agent_close_all", "-");
    let registry = registry.inner().clone();
    tauri::async_runtime::spawn_blocking(move || registry.close_all())
        .await
        .map_err(|e| format!("收尾的线程没能跑起来：{e}"))
}

/// 事件目录的绝对路径（前端要把它塞进 `env.DEVTOOLKIT_EVENT_DIR`）。
#[tauri::command]
pub async fn agent_events_dir(app: AppHandle) -> Result<String, String> {
    ensure_events_dir(&app)
}

/// 算事件目录，**顺便把它建出来**。
///
/// 非建不可：钩子脚本是往这个目录里写文件的（`> "$DIR/状态.id"`），目录不存在
/// 的话那句重定向会失败 —— 而脚本在别的终端里必须安静，所以那个失败是被吞掉的。
/// 也就是说目录没建出来的话，**第一条状态事件会静默丢失**，用户看到的是
/// 「状态点不动」，没有任何报错指向这里。
///
/// 两个调用方（`agent_events_dir` 和 `agent_open`）都走它，所以「路径」和
/// 「目录存在」这两件事不会各算各的。
fn ensure_events_dir(app: &AppHandle) -> Result<String, String> {
    let paths = paths(app)?;
    let dir = events::events_dir(&paths.data_dir);
    std::fs::create_dir_all(&dir).map_err(|e| {
        AgentError::Events {
            dir: dir.display().to_string(),
            reason: format!("建目录失败：{e}"),
        }
        .to_string()
    })?;
    Ok(dir.display().to_string())
}

/// 读走攒下的状态事件（读完就删 —— 一个事件只用一次）。
///
/// 返回按时间升序排好的一批 `{ name, at }`。**应用没开着时攒下的事件也在这里
/// 一次性读到**，所以前端要逐条按时间顺序喂给状态机（不是「每个会话留最新
/// 那条」，那样会把「它离开过等待又回来了」这件事压没）。
#[tauri::command]
pub async fn agent_take_events(app: AppHandle) -> Result<Vec<RawEvent>, String> {
    let paths = paths(&app)?;
    let dir = events::events_dir(&paths.data_dir);
    events::scan(&dir).map_err(|e| e.to_string())
}

/// 看一眼钩子装了没有。**不改任何东西。**
///
/// `state` 是 `missing` / `absent` / `installed` / `modified` / `unusable`；
/// `preview` 是「改了什么」的可读文本 —— 向导里给用户看的就是它
/// （`unusable` 时它是**原因**）。
#[tauri::command]
pub async fn agent_integration_status(
    app: AppHandle,
    target: IntegrationTarget,
) -> Result<IntegrationStatus, String> {
    let paths = paths(&app)?;
    integration::status(&paths, target).map_err(|e| e.to_string())
}

/// 装上（或者更新）钩子，并写出包装脚本。**幂等**。
///
/// 返回里的 `backupPath` 是改动前原文的备份；原文件本来就不存在时是 `null`
/// （不是空字符串）。
#[tauri::command]
pub async fn agent_integration_apply(
    app: AppHandle,
    target: IntegrationTarget,
) -> Result<IntegrationOutcome, String> {
    let paths = paths(&app)?;
    integration::apply(&paths, target).map_err(|e| e.to_string())
}

/// 撤销：把我们加进去的那几条**精确摘掉**，不碰用户的其它配置。
///
/// 刻意不从备份恢复（用户很可能在启用之后又改过自己的配置），所以只摘我们认得
/// 的那几条。返回的 `backupPath` 是 `null`：撤销本身就是「回到没有我们之前」，
/// 而原文件在 `apply` 时已经备过一份了。
#[tauri::command]
pub async fn agent_integration_revert(
    app: AppHandle,
    target: IntegrationTarget,
) -> Result<IntegrationOutcome, String> {
    let paths = paths(&app)?;
    integration::revert(&paths, target).map_err(|e| e.to_string())
}

/// 环境自检：把**我们这个进程眼里的** claude / git / bash 和 PATH 摊开。
///
/// 用途见 `devtoolkit_agents::probe_environment` 的说明 —— 一句话：
/// 「VS Code 里好好的、窗格里跑不起来」这类问题，差别只在环境，而环境是不可见的。
#[tauri::command]
pub async fn agent_probe() -> Result<EnvironmentReport, String> {
    // 解析 PATH 要扫目录、Windows 上还要问一次注册表（`reg query`）——
    // 丢 blocking 池，别占着 tokio 的工作线程（教训见 HANDOFF）
    let _span = crate::health::span("agent_probe", "-");
    tauri::async_runtime::spawn_blocking(devtoolkit_agents::probe_environment)
        .await
        .map_err(|e| format!("自检的线程没能跑起来：{e}"))
}
