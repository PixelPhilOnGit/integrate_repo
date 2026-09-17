//! Redis 相关的 Tauri command。
//!
//! 和 `commands.rs` 一样**只做参数搬运**：真正的逻辑全在 `devtoolkit-redis` 里，
//! 那样它能脱离 WebKit/GTK 跑测试（含打真 Redis 的集成测试）。
//!
//! 单独一个文件而不是并进 `commands.rs`：那个文件的职责是「工作区文件操作」，
//! 把网络相关的命令混进去会让它的边界变模糊。分开之后，
//! 「这个程序都能访问什么」一眼可见。
//!
//! # 为什么没有 `list_connections`
//!
//! 连接**档案**（host/port/密码）归前端持有并持久化，Rust 侧只存**活连接**。
//! 加一个列表命令就等于同一份真相存两遍，迟早漂移。「前端刷新了但 Rust 还挂着
//! 旧连接」这个唯一的缺口由幂等的 `redis_connect` 兜住（同 id 重连即替换）。

use devtoolkit_redis::{ConnectionConfig, ConnectionRegistry, Reply, ServerInfo};
use tauri::State;

/// 建立连接。同一个 `id` 再连一次是**替换**，不是新建。
#[tauri::command]
pub async fn redis_connect(
    registry: State<'_, ConnectionRegistry>,
    id: String,
    config: ConnectionConfig,
) -> Result<ServerInfo, String> {
    registry.connect(&id, &config).await.map_err(|e| e.to_string())
}

/// 断开连接。幂等：没连过也返回成功。
#[tauri::command]
pub async fn redis_disconnect(
    registry: State<'_, ConnectionRegistry>,
    id: String,
) -> Result<(), String> {
    registry.disconnect(&id).map(|_| ()).map_err(|e| e.to_string())
}

/// 执行一条命令。
///
/// `args[0]` 是命令名，其余是参数 —— 分词在前端做（见 `modules/redis/core/tokenize.ts`），
/// 这里只收已经切好的 token 数组。
///
/// # 返回值里那条容易搞错的语义
///
/// **服务器报错（`-ERR unknown command`）会以 `Ok(Reply::Error)` 返回，不是 `Err`。**
/// 它是命令的结果，不是执行失败 —— 前端把它内联显示在命令台日志里，连接不动。
/// 只有传输层失败（连不上、超时、连接断了）才返回 `Err(String)`，
/// 那才是该弹错误条的情况。
#[tauri::command]
pub async fn redis_exec(
    registry: State<'_, ConnectionRegistry>,
    id: String,
    args: Vec<String>,
) -> Result<Reply, String> {
    registry.exec(&id, &args).await.map_err(|e| e.to_string())
}
