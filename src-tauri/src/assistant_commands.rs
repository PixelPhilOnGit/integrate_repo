//! 助手的命令层。
//!
//! 三件事：
//!
//! 1. **凭据** —— API key 存进系统钥匙串（**只写不读**，理由见下）；
//! 2. **跑一次对话**（[`assistant_send`]）—— 组装 provider / 工具 / 审批口子 /
//!    记账口子，把内核跑起来，事件通过 `Channel` 推给前端；
//! 3. **回答审批**（[`assistant_approve`]）和**停止**（[`assistant_cancel`]）。
//!
//! 模型配置本身（提供方 / 地址 / 模型）在前端的 KV 里，见 `shared/platform/kv.ts`。
//!
//! # ⚠️ Channel 必须搬进转发任务
//!
//! Rust 侧把一个 `Channel` 丢掉时会往 JS 发一条 `{end: true}`，JS 收到就**注销
//! 回调**。所以 [`assistant_send`] 里那个 `channel` 一定要 move 进
//! `tauri::async_runtime::spawn` 的任务里 —— 留在命令函数里的话，函数一返回
//! 它就 drop 了，前端**一条事件都收不到，而且不报错**（界面一片空白）。
//! 这个坑 SSH 那一轮踩过，形状一模一样。
//!
//! # 和连接密码那套（`secret_commands.rs`）**故意不一样**的地方
//!
//! 那套有 `secret_load`，会把密码**回传给前端**（因为要回填进编辑框让用户改）。
//! 这里**没有对应的读接口** —— key 只需要「换一把」，永远不需要被显示出来。
//! 少一个读接口，就少一条密钥经过 webview 的路。
//!
//! 所以前端能问到的只有两件事：**这台机器存不存得住**、**配了没有**。
//!
//! # 为什么这两个都要 `spawn_blocking`
//!
//! `keyring` 是同步的，而且在某些平台上会去跟系统进程通信（Linux 上是 DBus）。
//! 直接在 async 命令里调，等于把一个可能在等别的进程的调用挂在 tokio 工作线程上 ——
//! 这台机器 2 核，堵两个就转不动了。仓库在 SQLite 和 PTY 写上都栽过同一类。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use devtoolkit_assistant::approval::{
    cancel_pair, ApprovalKey, ApprovalRequest, Cancel, CancelSwitch, Decision, Gate,
};
use devtoolkit_assistant::context::ContextStrategy;
use devtoolkit_assistant::journal::Journal;
use devtoolkit_assistant::loop_runner::Limits;
use devtoolkit_assistant::message::Message;
use devtoolkit_assistant::provider::anthropic::{AnthropicConfig, AnthropicProvider};
use devtoolkit_assistant::provider::openai::{OpenAiConfig, OpenAiProvider};
use devtoolkit_assistant::provider_config::{
    api_key_id, legacy_api_key_id, plan_key_move, KeyMove, ProviderConfig, ProviderKind,
    KEYCHAIN_MODULE,
};
use devtoolkit_assistant::session::{
    run, stream_once, ApprovalOutcome, ApproveGate, EventSink, ProviderRequest, RunEvent, RunSpec,
};
use devtoolkit_assistant::tools::Tools;
use devtoolkit_assistant::transcript::{Transcript, TranscriptJournal};
use devtoolkit_assistant::transport::HyperTransport;
use devtoolkit_core::Workspace;
use devtoolkit_store::secrets;
use tauri::ipc::Channel;
use tauri::State;

/// API key 配到什么程度了。
///
/// ⚠️ 两个字段是**两件事**，前端必须分开显示（见 `services/types.ts`）：
/// `available` 说的是这台机器有没有钥匙串，`configured` 说的是填没填。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantKeyStatus {
    /// 这台机器上有没有可用的钥匙串。
    pub available: bool,
    /// 这个提供方配过 key 没有。
    pub configured: bool,
}

/// 前端传的提供方标识 → 枚举。
///
/// 认不出来就报错，**不猜** —— 猜错的话用户会往 A 家存 key、然后拿着 B 家去发请求，
/// 症状是一个和配置毫无关系的 401。
fn parse_kind(kind: &str) -> Result<ProviderKind, String> {
    match kind {
        "anthropic" => Ok(ProviderKind::Anthropic),
        "openai" => Ok(ProviderKind::OpenAi),
        other => Err(format!("认不出的提供方「{other}」")),
    }
}

/// 配置 id 的合法形状。
///
/// ⚠️ 它进到钥匙串条目名里（`api_key:<id>`，完整形式 `assistant/api_key:<id>`）——
/// **含 `/` 的 id 能跳到别的模块的命名空间去**。前端传的是它自己生成的 id，
/// 但这条边界值得卡一道（agents 那边卡会话 id 的字符集是同一个理由）。
fn check_profile_id(id: &str) -> Result<(), String> {
    let ok = !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if ok {
        Ok(())
    } else {
        Err(format!("配置 id「{id}」的形状不对"))
    }
}

/// 这份**配置**的 key 配到什么程度了。
///
/// ⚠️ 收的是 `profile_id` 而不是 `kind` —— key 挂在**配置**上：同一家可以有好几份
/// 配置，「工作用 Anthropic」和「自己的 Anthropic」不能共用一把。理由见
/// [`devtoolkit_assistant::provider_config::api_key_id`]。
#[tauri::command]
pub async fn assistant_api_key_status(profile_id: String) -> Result<AssistantKeyStatus, String> {
    check_profile_id(&profile_id)?;

    tauri::async_runtime::spawn_blocking(move || {
        // 「有没有钥匙串」和「读得到读不到」要分开：
        // 没有钥匙串时 `get` 会返回 Unavailable，那是**环境问题**，
        // 不能当成「用户没配」—— 前端要给的是两句不同的话。
        let available = secrets::available();
        let configured = match secrets::get(KEYCHAIN_MODULE, &api_key_id(&profile_id)) {
            Ok(Some(v)) => !v.trim().is_empty(),
            Ok(None) => false,
            // 钥匙串用不了：这里回 false，由 `available` 说明原因。
            Err(_) => false,
        };
        AssistantKeyStatus {
            available,
            configured,
        }
    })
    .await
    .map_err(|e| format!("读凭据时出错了：{e}"))
}

/// 存一把 key。**空串 = 删掉**（和前端假实现同一套语义）。
#[tauri::command]
pub async fn assistant_set_api_key(profile_id: String, key: String) -> Result<(), String> {
    check_profile_id(&profile_id)?;

    tauri::async_runtime::spawn_blocking(move || {
        let id = api_key_id(&profile_id);
        let trimmed = key.trim();
        let result = if trimmed.is_empty() {
            secrets::delete(KEYCHAIN_MODULE, &id)
        } else {
            secrets::set(KEYCHAIN_MODULE, &id, trimmed)
        };
        result.map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("存凭据时出错了：{e}"))?
}

/// 把老版**按提供方**命名的凭据搬到**按配置**命名的条目上（升级用）。
///
/// ⚠️ **幂等，可以反复调。** 调用方**什么都不用记** —— 前端只在这份配置
/// 「还没有 key 且它正是从旧版迁过来的那一份」时才调它，搬没搬成从
/// [`assistant_api_key_status`] 看得出来。于是「搬到一半崩了」「钥匙串当时锁着」
/// 都能在下次自动重试，直到成功为止。
///
/// ⚠️ 顺序恒为 **读来源 → 写目标（目标非空就不写）→ 删来源**：
/// 任何一个中间态都不能「两边都没有」，那就是用户的 key 凭空蒸发。
/// 分支决策在 `plan_key_move` 里（纯函数，有穷举测试）。
#[tauri::command]
pub async fn assistant_migrate_api_key(
    from_kind: String,
    to_profile_id: String,
) -> Result<(), String> {
    let kind = parse_kind(&from_kind)?;
    check_profile_id(&to_profile_id)?;

    tauri::async_runtime::spawn_blocking(move || {
        let from = legacy_api_key_id(kind);
        let to = api_key_id(&to_profile_id);

        // 钥匙串读不了就直接说 —— 调用方下次还会再试
        let source = secrets::get(KEYCHAIN_MODULE, &from).map_err(|e| e.to_string())?;
        let target = secrets::get(KEYCHAIN_MODULE, &to).map_err(|e| e.to_string())?;

        match plan_key_move(source.as_deref(), target.as_deref()) {
            // 老条目本来就空：用户没配过，什么都不用做
            KeyMove::Nothing => Ok(()),
            KeyMove::CopyThenDelete => {
                // ⚠️ **先写目标**；写失败就返回 Err，老条目原封不动
                secrets::set(KEYCHAIN_MODULE, &to, source.as_deref().unwrap_or_default())
                    .map_err(|e| e.to_string())?;
                // 写成了才删来源。删失败**不算错**（下次调用走 JustDelete 再试）
                let _ = secrets::delete(KEYCHAIN_MODULE, &from);
                Ok(())
            }
            KeyMove::JustDelete => {
                let _ = secrets::delete(KEYCHAIN_MODULE, &from);
                Ok(())
            }
        }
    })
    .await
    .map_err(|e| format!("搬凭据时出错了：{e}"))?
}

// ============================================================ 跑一次对话

/// 会话记录库的文件名（在应用数据目录下）。
const TRANSCRIPT_FILE: &str = "assistant-transcript.db";

/// 一次 run 最多允许迭代几轮。
///
/// 40 是 `Limits` 的默认值，这里显式写出来只是因为命令层要有个地方能看见它。
const MAX_ITERATIONS: usize = 40;

/// 「测试连接」最多等多久。
///
/// 比一次正常对话短得多 —— 用户点它是为了**立刻知道通不通**，
/// 等两分钟才给答案就失去意义了。代价是慢网关可能被误报成超时，
/// 所以文案里要说清「可能只是慢」。
const TEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// 按配置建一个 provider，名字绑到 `$provider` 上，然后跑 `$body`。
///
/// 为什么要一个宏：两家 provider 的泛型不同（`AnthropicProvider<HyperTransport>`
/// 和 `OpenAiProvider<HyperTransport>`），而 `Provider` 不是对象安全的
/// （方法用了 RPITIT），所以没法统一成 `Box<dyn Provider>`。两条路
/// **只有建哪一个不一样**，其余一字不差 —— 手抄两遍的话，
/// 将来改一处忘一处，两边行为就分了。
///
/// `$config` 是**引用**（两条分支都要用它，不能 move）。
macro_rules! with_provider {
    ($config:expr, $key:expr, $provider:ident => $body:expr) => {{
        let config = $config;
        let key = &$key;
        match config.kind {
            ProviderKind::Anthropic => {
                let $provider = AnthropicProvider::new(
                    HyperTransport::new(),
                    config.base_url.clone(),
                    AnthropicConfig {
                        model: config.model.clone(),
                        ..AnthropicConfig::default()
                    },
                    key.clone(),
                );
                $body
            }
            ProviderKind::OpenAi => {
                let $provider = OpenAiProvider::new(
                    HyperTransport::new(),
                    config.base_url.clone(),
                    OpenAiConfig {
                        model: config.model.clone(),
                        ..OpenAiConfig::default()
                    },
                    key.clone(),
                );
                $body
            }
        }
    }};
}

/// 提供方的中文名（报错文案里用）。
fn provider_label(kind: ProviderKind) -> &'static str {
    match kind {
        ProviderKind::Anthropic => "Anthropic",
        ProviderKind::OpenAi => "OpenAI 兼容",
    }
}

/// 试出来的结果（直接显示给用户，所以文案都是成品）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionReport {
    /// 通没通。
    pub ok: bool,
    /// 花了多少毫秒。
    pub millis: u64,
    /// 一句话。**成功和失败都有**，直接放到界面上。
    pub message: String,
    /// 模型真回了什么（成功时才有）。它是「真的通了」的证据 ——
    /// 只显示「成功」的话，用户没法分辨自己是不是被中间设备骗了
    /// （有的企业代理会回一个 200 然后什么也不给）。
    pub reply: String,
}

/// 试一下这套配置通不通（用户点「测试连接」）。
///
/// # ⚠️ 它**不走 Channel**，这是刻意的
///
/// 用户卡住的时候，「界面收不到事件」和「网络根本不通」是**两回事**，
/// 而走 `Channel` 的话这两种会表现成同一个样子（都卡着、都不报错）。
/// 一个一次往返、直接返回结果的命令才能把它们分开：
///
/// * 这里**成功** + 对话卡住 → 问题在事件通道那一层；
/// * 这里**失败** → 问题就在下面这句话里。
///
/// # 为什么发的是最小请求
///
/// 不带工具、system 为空、只让它回一个字 —— 目标是**最快地知道握手成不成**，
/// 不是验证模型聪不聪明。所以它比一次正常对话快得多，也便宜得多。
#[tauri::command]
pub async fn assistant_test_connection(
    config: ProviderConfig,
    profile_id: String,
) -> Result<ConnectionReport, String> {
    config.validate()?;
    check_profile_id(&profile_id)?;

    let key = tauri::async_runtime::spawn_blocking(move || {
        secrets::get(KEYCHAIN_MODULE, &api_key_id(&profile_id))
    })
    .await
    .map_err(|e| format!("读凭据时出错了：{e}"))?
    .map_err(|e| e.to_string())?
    .filter(|k| !k.trim().is_empty())
    .ok_or_else(|| {
        // ⚠️ 报的是**这份配置**没配 key，不是「Anthropic 没配」——
        // 同一家可以有好几份，说成后者会让人以为是另一份的问题。
        format!(
            "这份配置（{}）还没配 API key —— 在这里的输入框里填一把再试。",
            provider_label(config.kind)
        )
    })?;

    let started = std::time::Instant::now();

    let request = ProviderRequest {
        system: String::new(),
        messages: vec![Message::user_text("只回一个字：好")],
        // ⚠️ **不带工具**：带了的话请求体大一圈，而且模型可能选择调工具，
        // 那就不止一次往返了。这里要的是「握手」，不是「干活」。
        tools: Vec::new(),
        max_tokens: 32,
    };

    // `stream` 要一个事件出口，但这里没人听 —— 丢掉的接收端会让
    // `EventSink::send` 静默失败（它本来就是 `try_send`），正合我们意。
    let (events, _nobody_listens) = EventSink::new(1);

    // ⚠️ 超时在**内核**里（`stream_once`），不是在这儿包一层 `tokio::timeout`：
    // app crate 没有 tokio（它走 `tauri::async_runtime`），而且超时的文案
    // 该和「怎么跑一轮」那段逻辑住在一起。
    let result = with_provider!(&config, key, provider => {
        stream_once(&provider, request, events, TEST_TIMEOUT).await
    });

    let millis = started.elapsed().as_millis() as u64;

    match result {
        Ok(turn) => {
            let reply: String = turn
                .blocks
                .iter()
                .filter_map(|b| match b {
                    devtoolkit_assistant::message::Block::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect();
            Ok(ConnectionReport {
                ok: true,
                millis,
                message: format!("通了（{millis} 毫秒）。key、地址、模型名都对得上。"),
                reply: reply.trim().to_string(),
            })
        }
        // ⚠️ 把模型侧的原话**原样带出来** —— 「key 不对」「模型名写错了」
        // 这类话就在里面，那才是能照着改的东西。
        Err(e) => Ok(ConnectionReport {
            ok: false,
            millis,
            message: e.message,
            reply: String::new(),
        }),
    }
}

/// 助手的运行期状态。Tauri 的 `manage` 持有。
///
/// 三样东西，各有各的理由：
///
/// * **闸门**（跨 run 共享一份）—— 「本次会话记住」的授权住在它手里，
///   而那句话的意思是「我批准过 `git` 这一类操作」，换个 run 不该忘。
///   ⚠️ 那份授权**只在内存里、永不落盘**（见 `approval.rs`）。
/// * **正在跑的 run** —— 取消要能找到人。
/// * **记录库** —— 惰性打开（第一次真要记的时候才碰磁盘），和 `tasks` 一个路子。
pub struct AssistantRuntime {
    gate: Arc<Gate>,
    running: Mutex<HashMap<u64, CancelSwitch>>,
    next_run: AtomicU64,
    transcript: Mutex<Option<Arc<Transcript>>>,
    /// 每个会话的历史。
    ///
    /// ⚠️ **只在内存里**：应用一关就没了。落盘的那份是 `transcript` 的事，
    /// 但它一期只记**用量**不记消息（见 `transcript.rs` 的头部）——
    /// 所以 v1 的对话**跨重启不延续**。这是已知的，不是 bug。
    ///
    /// ⚠️ 它**没有上限**：聊得越久越长。收窄它靠的是上下文策略
    /// （用户能在顶栏选「只留最近 N 段」）—— 那正是这个功能存在的理由，
    /// 不是「反正有策略所以随便涨」。
    histories: Mutex<HashMap<String, Vec<Message>>>,
}

impl AssistantRuntime {
    /// 建一个空的（不碰磁盘、不碰 tokio 运行时，启动期安全）。
    pub fn new() -> Self {
        AssistantRuntime {
            gate: Arc::new(Gate::new()),
            running: Mutex::new(HashMap::new()),
            next_run: AtomicU64::new(1),
            transcript: Mutex::new(None),
            histories: Mutex::new(HashMap::new()),
        }
    }

    fn forget(&self, run: u64) {
        self.running
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&run);
    }

    /// 取一个会话的历史（没有就是空的 = 一次全新的对话）。
    fn history_of(&self, session: &str) -> Vec<Message> {
        self.histories
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(session)
            .cloned()
            .unwrap_or_default()
    }

    /// 把跑完的历史存回去，接下一轮。
    fn remember(&self, session: &str, history: Vec<Message>) {
        self.histories
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(session.to_string(), history);
    }

    /// 忘掉一个会话（用户点了「清空」）。
    fn forget_session(&self, session: &str) {
        self.histories
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(session);
    }

    /// 惰性打开记录库，返回一个记账口子。
    ///
    /// ⚠️ **打不开就返回 `None`，绝不报错。** 「记不上」是遗憾，「聊不了」是事故 ——
    /// 和 `secrets.rs` 里那条「拿不到密码是遗憾，打不开是事故」是同一个道理。
    ///
    /// 这里有一次同步 IO（建目录 + 开库），但只在**第一次**发生，而且 SQLite
    /// 开一个本地文件是微秒级的 —— 为它套一层 `spawn_blocking` 反而要多搬一个
    /// 句柄进去，不值。
    fn journal(
        &self,
        handle: &tauri::AppHandle,
        session: String,
        model: String,
        workspace: String,
    ) -> Option<Arc<dyn Journal>> {
        use tauri::Manager as _;

        let dir = handle.path().app_data_dir().ok()?;
        let store = {
            let mut slot = self.transcript.lock().unwrap_or_else(|e| e.into_inner());
            if slot.is_none() {
                if let Err(e) = std::fs::create_dir_all(&dir) {
                    eprintln!("[assistant] 建不了数据目录 {}：{e}", dir.display());
                    return None;
                }
                match Transcript::open(&dir.join(TRANSCRIPT_FILE)) {
                    Ok(t) => *slot = Some(Arc::new(t)),
                    Err(e) => {
                        eprintln!("[assistant] 打不开会话记录库：{e}");
                        return None;
                    }
                }
            }
            Arc::clone(slot.as_ref()?)
        };

        Some(Arc::new(TranscriptJournal::new(
            store,
            session,
            model,
            "assistant".to_string(),
            workspace,
        )))
    }
}

impl Default for AssistantRuntime {
    fn default() -> Self {
        Self::new()
    }
}

/// 系统提示。
///
/// ⚠️ 这里**只写「怎么干活」**，不写「你是谁」那种人设 —— 后者对新版模型是
/// 噪音。真正影响行为的是那几条工具纪律，而它们**必须**和工具描述一致
/// （`tools/fs.rs` / `tools/exec.rs` 里也各写了一遍）：模型同时看到提示词和
/// 工具描述，两边打架时它挑哪个是不确定的。
const SYSTEM_PROMPT: &str = "\
你是 Devtoolkit 里的编码助手，直接在用户的项目目录里干活。

几条规矩：
- 改文件之前**先读它**，不要凭记忆或猜测去改。
- 改已有文件用 `edit_file`；`write_file` 会把整个文件替换掉，你没读到的部分会丢。
- 跑命令用 `run_command`，它不过 shell —— 程序名和参数分开给，不要写管道和 &&。
- 干完说清楚你动了哪些文件、为什么。不要复述工具的输出。
- 拿不准就问，不要猜着做。

中文回答。";

/// 发一句话，跑一次。
///
/// 返回这次 run 的编号（前端拿它来 `assistant_cancel`）。审批用的编号是同一个值，
/// 在 `RunEvent::ApprovalNeeded` 的 `key.run` 里。
/// ⚠️ `session` 是**对话的延续性所在**：同一个 `session` 的几次 `send` 共享历史，
/// 换了它就是从零开始。前端在「清空对话」时换一个新的。
#[tauri::command]
pub async fn assistant_send(
    runtime: State<'_, Arc<AssistantRuntime>>,
    app: tauri::AppHandle,
    session: String,
    workspace: String,
    prompt: String,
    config: ProviderConfig,
    // 用哪一份**配置**的 key —— key 挂在配置上，不挂在提供方上
    //（同一家可以有好几份配置，见 `provider_config::api_key_id`）
    profile_id: String,
    strategy: String,
    channel: Channel<RunEvent>,
) -> Result<u64, String> {
    // ① 配置先过一遍。缺东西的话现在就说，别等转到网络上才报一个
    //    「和配置毫无关系」的错。
    config.validate()?;
    check_profile_id(&profile_id)?;

    // ② 工作区（路径闸门在 `Workspace::open` 里：canonicalize + 必须是目录）。
    let ws = Workspace::open(&workspace).map_err(|e| e.to_string())?;

    // ③ key 从**系统钥匙串**拿 —— 在 Rust 侧拿，永远不经过 webview。
    let kind = config.kind;
    let key = tauri::async_runtime::spawn_blocking(move || {
        secrets::get(KEYCHAIN_MODULE, &api_key_id(&profile_id))
    })
    .await
    .map_err(|e| format!("读凭据时出错了：{e}"))?
    .map_err(|e| e.to_string())?
    .filter(|k| !k.trim().is_empty())
    .ok_or_else(|| {
        // ⚠️ 报的是**这份配置**没配 key，不是「Anthropic 没配」——
        // 同一家可以有好几份，说成后者会让人以为是另一份的问题。
        format!(
            "这份配置（{}）还没配 API key —— 在右侧的「模型」面板里填一把。",
            provider_label(kind)
        )
    })?;

    // ④ 这次 run 的编号 + 取消开关。
    let run_id = runtime.next_run.fetch_add(1, Ordering::SeqCst);
    let (switch, cancel) = cancel_pair();
    runtime
        .running
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(run_id, switch);

    // ⑤ 四件套：工具、审批口子、记账口子、事件出口。
    let tools = Tools::new(ws);
    let approver = GateApprover {
        gate: Arc::clone(&runtime.gate),
    };
    let journal = runtime.journal(&app, session.clone(), config.model.clone(), workspace);

    // ⚠️ 把上一次的对话接上。不接的话每一句都是独立的问题，
    // 模型看不到上一句 —— 症状是「它怎么不记得我刚才说的」。
    let history = runtime.history_of(&session);

    let spec = RunSpec {
        run_id,
        system: SYSTEM_PROMPT.to_string(),
        prompt,
        history,
        strategy: ContextStrategy::parse(&strategy)?,
        tools: tools.specs(),
        limits: Limits {
            max_iterations: MAX_ITERATIONS,
            ..Limits::default()
        },
        max_tokens: 16_000,
        journal,
    };

    let (sink, mut events_rx) = EventSink::new(256);

    // ⑥ 跑起来。
    //
    // ⚠️ `channel` **必须**搬进这个任务（见模块头部那段）—— 留在这里的话
    // 命令一返回它就 drop，前端一条事件都收不到，而且不报错。
    let runtime = Arc::clone(runtime.inner());
    tauri::async_runtime::spawn(async move {
        // 转发：把内核那头的 `mpsc` 搬到 `Channel` 上。它就是 SSH 那边的
        // `forward` 的同款 —— 一个循环，直到发送端全没了为止。
        let pump = tauri::async_runtime::spawn(async move {
            while let Some(event) = events_rx.recv().await {
                // 前端不听了（切走了 / webview 重载了）就算了，继续把队列排空 ——
                // 卡在这儿会让整个 run 停住。
                let _ = channel.send(event);
            }
        });

        // 两家 provider 的泛型不同（`Provider` 不是对象安全的），所以建哪一个
        // 要 match；`with_provider!` 把那段样板收在一处 —— 见它的文档。
        // `spec` / `sink` 在展开后的两条分支里各 move 一次，分支互斥，合法。
        let outcome = with_provider!(&config, key, provider => {
            run(&provider, &tools, &approver, &cancel, spec, sink).await
        });

        // 收尾：把这轮跑出来的完整历史存回去，接下一轮。
        //
        // ⚠️ 存的是 `outcome.history`（**循环手里那份完整的**），不是前端看到
        // 的那串文字 —— 里面有 `tool_use` / `tool_result` 那些块，
        // 少了它们模型下一轮会以为自己的工具调用没发生过。
        //
        // `outcome` 本身不用往上报：`run` 的最后一条事件就是
        // `RunEvent::Finished`，前端从那儿拿结局。
        runtime.remember(&session, outcome.history);
        runtime.forget(run_id);

        // 等转发排空（`sink` 已经随 `run` 一起 drop，`rx` 会收到 None）。
        let _ = pump.await;
    });

    Ok(run_id)
}

/// 回答一条审批。
///
/// 返回 `false` 表示这条审批**已经不存在了**（超时 / 被取消 / 重复点击）——
/// ⚠️ 那是**一个明确的契约，不是错误**（见 `approval.rs` 的 `Gate::answer`）。
/// 前端拿到 `false` 该做的是**什么都不做**，而不是弹个报错。
#[tauri::command]
pub async fn assistant_approve(
    runtime: State<'_, Arc<AssistantRuntime>>,
    run: u64,
    call: String,
    decision: String,
) -> Result<bool, String> {
    let decision = match decision.as_str() {
        "allow" => Decision::Allow,
        "session" => Decision::AllowSession,
        "deny" => Decision::Deny,
        other => return Err(format!("认不出的回答「{other}」")),
    };

    Ok(runtime
        .gate
        .answer(&ApprovalKey { run, call }, decision))
}

/// 停止一次 run。
///
/// ⚠️ 停止**不是**「拒绝这次审批」：拒绝只让模型换个做法继续跑，
/// 停止是整个 run 结束（见 `approval.rs` 的 `Cancel` 文档）。
/// 这个区别用户感知很强 —— 点了停止还在花钱是最糟的一类 bug。
#[tauri::command]
pub async fn assistant_cancel(
    runtime: State<'_, Arc<AssistantRuntime>>,
    run: u64,
) -> Result<(), String> {
    // 找不到就说明它已经结束了 —— 停一个已经停下的东西**不是错误**，
    // 用户连点两下停止是完全正常的。
    //
    // 就地按下去，不把开关克隆出来：`cancel` 只是把 `watch` 的值翻成 true
    // （不阻塞、不会 await），持锁调用没有风险。克隆的话还得给
    // `CancelSwitch` 加 `Clone`，而那个语义（几个克隆共享一次取消）需要额外解释。
    let running = runtime.running.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(switch) = running.get(&run) {
        switch.cancel();
    }
    Ok(())
}

/// 忘掉这个会话的历史（用户点了「清空对话」）。
///
/// ⚠️ **不碰正在跑的那个 run** —— 停掉它是 [`assistant_cancel`] 的事。
/// 而且**必须等它停下来再清**：收尾时会 `remember` 一次，
/// 边跑边清的话那份历史马上会被写回来。界面上那个「清空」按钮在跑的时候
/// 是禁用的，就是为了这条。
#[tauri::command]
pub async fn assistant_clear_session(
    runtime: State<'_, Arc<AssistantRuntime>>,
    session: String,
) -> Result<(), String> {
    runtime.forget_session(&session);
    Ok(())
}

/// 审批口子的真实现。
///
/// 它做两件事，顺序不能反：
/// 1. **先看本会话批准过没有**（`gate.is_granted`）—— 批准过就不再打扰用户；
/// 2. 没有就登记 + 等回答。
struct GateApprover {
    gate: Arc<Gate>,
}

impl ApproveGate for GateApprover {
    async fn approve(
        &self,
        request: ApprovalRequest,
        cancel: &Cancel,
        events: &EventSink,
    ) -> ApprovalOutcome {
        // ① 本会话已经批准过这一类了吗。
        //
        // ⚠️ `grant` 是 `None` 时**不能免审** —— 那是「这个操作不给记住」
        // （跑 shell 解释器就是这一类：记住 `bash` 等于免审之后所有的
        // `bash -c "…"`）。判定逻辑在 `tool.rs` 的 `needs_approval` 里，
        // 这里只是照着它说的做。
        if let Some(key) = &request.grant {
            if self.gate.is_granted(key) {
                return ApprovalOutcome::Allowed;
            }
        }

        // ② 登记 + 等回答。
        //
        // ⚠️ **事件在 `emit` 回调里发** —— 那是 `Gate::request` 保证的
        // 「登记完成之后、而且不持锁」那一刻。在调用 `request` **之前**发的话，
        // 前端可能抢在登记完成前就回答了，那条回答落在空处：
        // 表现是「弹层消失了，但什么也没发生」（不变量 1）。
        let key = request.key.clone();
        let tool = request.tool.clone();
        let display = request.display.clone();
        let grant = request.grant.clone();
        // ⚠️ `grant.is_some()` 就是「可以记住」—— 前端拿它决定「记住」按钮
        // 显不显示。`None` 是**有含义的**（跑 shell 解释器就是这一类），
        // 所以这里不能顺手补一个默认值。
        let can_remember = grant.is_some();
        let answer = self
            .gate
            .request(request, None, cancel, || {
                events.send(RunEvent::ApprovalNeeded {
                    key,
                    tool,
                    display,
                    can_remember,
                });
            })
            .await;

        match answer {
            Some(Decision::Allow) => ApprovalOutcome::Allowed,
            Some(Decision::AllowSession) => {
                // 记下「本会话记住」。⚠️ 只有真的给了 key 才记 ——
                // 上面说了 `None` 是「不给记住」。
                if let Some(key) = grant {
                    self.gate.grant(key);
                }
                ApprovalOutcome::Allowed
            }
            Some(Decision::Deny) => ApprovalOutcome::Denied,
            // `None` = 被取消（或者闸门的那一头没了）—— **整个 run 结束**，
            // 不是「拒绝这一次」。混起来的话用户点了停止、模型换个法子继续烧钱。
            None => ApprovalOutcome::Cancelled,
        }
    }
}
