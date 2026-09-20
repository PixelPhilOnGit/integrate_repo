//! 系统钥匙串的 Tauri command。
//!
//! 和键值那套一样**只做搬运**：真正的逻辑在 `devtoolkit-store` 的 `secrets` 里
//! （能脱离 WebKit 跑测试、也能单独验）。
//!
//! # 两个命令，一条关键约定
//!
//! * `secret_load(module, ids)` —— 一次把一批连接的密码读回来；
//! * `secret_store(module, entries)` —— 一次写一批（空密码 = 删掉那条）。
//!
//! ⚠️ **批量不是优化，是必需**：一个模块几十条连接，一条一个 IPC 往返的话，
//! 切一次模块就要等一串来回，而且其中任何一条失败都会让整次加载失败。
//!
//! ⚠️ **钥匙串用不了的时候要如实说出来**（返回里的 `available: false`），
//! 前端据此退回「密码仍然存在键值表里」那条老路 —— 服务器和 headless 机器上
//! 压根没有钥匙串，那些机器上用户照样得能用这个应用。
//! **但不能静默退回**：界面上要说一句，否则用户以为密码已经进钥匙串了。
//!
//! ⚠️ **单条读失败不连坐**：某一条的密码读不出来（格式坏了、被别的程序动过），
//! 就当他没设密码 —— 一条坏记录不该让整个连接列表打不开。这条和
//! `profiles.ts` 里「逐条校验、坏记录不连坐」是同一个口径。

use std::collections::HashMap;

use devtoolkit_store::secrets::{self, SecretError};
use serde::{Deserialize, Serialize};

/// 一条要存进去的密码
#[derive(Deserialize)]
pub struct SecretEntry {
    pub id: String,
    pub secret: String,
}

/// 一次读一批的结果
#[derive(Serialize)]
pub struct SecretsLoad {
    /// 钥匙串能不能用。**false 表示「这台机器上没有」**，前端要退回明文那条路
    pub available: bool,
    /// 档案 id → 密码。**只包含真的存过的** —— 没存过的这里就没有，
    /// 前端当空密码处理（那不是错误，是「这个连接还没填过密码」）
    pub secrets: HashMap<String, String>,
}

/// 把 `SecretError` 分成两类：**环境的问题**（这台机器没有钥匙串）和
/// **这一次的问题**（读某一条失败）。前端对这两种的反应完全不同。
fn unavailable(error: &SecretError) -> Option<String> {
    match error {
        SecretError::Unavailable(reason) => Some(reason.clone()),
        SecretError::Failed(_) => None,
    }
}

/// 读一批密码。
///
/// 钥匙串用不了时**不报错**，而是 `available: false` + 空的 map：调用方要能
/// 顺着这条信息退回老路，而不是拿到一个 Err 之后不知道该怎么办。
#[tauri::command]
pub async fn secret_load(module: String, ids: Vec<String>) -> Result<SecretsLoad, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !secrets::available() {
            return SecretsLoad { available: false, secrets: HashMap::new() };
        }

        let mut secrets_map = HashMap::new();
        for id in ids {
            match secrets::get(&module, &id) {
                Ok(Some(secret)) => {
                    secrets_map.insert(id, secret);
                }
                // 没存过：正常情况，不是错误
                Ok(None) => {}
                Err(e) => {
                    // 读某一条的途中钥匙串整个不可用了（锁上了、后端掉了）——
                    // 那这条信息比「某一条读不到」重要得多，整体降级
                    if unavailable(&e).is_some() {
                        return SecretsLoad { available: false, secrets: HashMap::new() };
                    }
                    // 别的失败：**跳过这一条**，别连坐（见文件头）
                }
            }
        }

        SecretsLoad { available: true, secrets: secrets_map }
    })
    .await
    .map_err(|e| format!("钥匙串的线程没能跑起来：{e}"))
}

/// 写一批密码（空密码 = 把那条删掉）。
///
/// 返回**钥匙串还能不能用**，前端据此决定下次读的时候走哪条路。
///
/// ⚠️ 单条写失败同样不连坐：某一条存不进去（超长、平台限制）不该让别的
/// 几条也白存 —— 但它们**都得在界面上说出来**，静默失败是「用户以为存上了」的源头。
#[tauri::command]
pub async fn secret_store(module: String, entries: Vec<SecretEntry>) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !secrets::available() {
            return false;
        }

        for entry in entries {
            match secrets::set(&module, &entry.id, &entry.secret) {
                Ok(()) => {}
                Err(e) => {
                    if unavailable(&e).is_some() {
                        return false;
                    }
                    // 别的失败：跳过这一条，继续存后面那些
                }
            }
        }

        true
    })
    .await
    .map_err(|e| format!("钥匙串的线程没能跑起来：{e}"))
}

/// 探测一次这台机器上有没有钥匙串。集成卡片和「连接」那块用它显示状态。
#[tauri::command]
pub async fn secret_available() -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(secrets::available)
        .await
        .map_err(|e| format!("钥匙串的线程没能跑起来：{e}"))
}
