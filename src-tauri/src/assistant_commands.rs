//! 助手的命令层。
//!
//! 现在只有**凭据**这一件事（配置本身在前端的 KV 里，见 `shared/platform/kv.ts`）。
//! 对话、工具调用、上下文策略的命令等模型接上之后再加。
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

use devtoolkit_assistant::provider_config::{api_key_id, ProviderKind, KEYCHAIN_MODULE};
use devtoolkit_store::secrets;

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

/// 这个提供方的 key 配到什么程度了。
#[tauri::command]
pub async fn assistant_api_key_status(kind: String) -> Result<AssistantKeyStatus, String> {
    let kind = parse_kind(&kind)?;

    tauri::async_runtime::spawn_blocking(move || {
        // 「有没有钥匙串」和「读得到读不到」要分开：
        // 没有钥匙串时 `get` 会返回 Unavailable，那是**环境问题**，
        // 不能当成「用户没配」—— 前端要给的是两句不同的话。
        let available = secrets::available();
        let configured = match secrets::get(KEYCHAIN_MODULE, &api_key_id(kind)) {
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
pub async fn assistant_set_api_key(kind: String, key: String) -> Result<(), String> {
    let kind = parse_kind(&kind)?;

    tauri::async_runtime::spawn_blocking(move || {
        let id = api_key_id(kind);
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
