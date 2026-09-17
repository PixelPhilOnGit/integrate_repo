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

use devtoolkit_redis::{
    ConnectionConfig, ConnectionRegistry, DbInfo, KeyDetail, Reply, ScanPage, ServerInfo,
};
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

// ------------------------------------------------------------------ 浏览
//
// 浏览式界面（库列表 / key 列表 / key 详情）用的三个查询命令。
// 它们和上面的 `redis_exec` 是两条路：exec 是「用户敲什么发什么」，
// 这几个是「界面为了渲染自己需要的结构」。

/// 库列表（库号 + 每个库的 key 数）。
///
/// 空库也会列出来 —— 那是 `CONFIG GET databases` 的功劳，
/// `INFO keyspace` 只列出有 key 的库。
#[tauri::command]
pub async fn redis_keyspace(
    registry: State<'_, ConnectionRegistry>,
    id: String,
) -> Result<Vec<DbInfo>, String> {
    registry.keyspace(&id).await.map_err(|e| e.to_string())
}

/// 切到另一个库。`SELECT` 是连接级的，这条连接之后都在新库上操作。
#[tauri::command]
pub async fn redis_select(
    registry: State<'_, ConnectionRegistry>,
    id: String,
    db: i64,
) -> Result<(), String> {
    registry.select(&id, db).await.map_err(|e| e.to_string())
}

/// 扫一页 key。`cursor` 传 0 开始，返回的 `cursor` 为 0 表示翻完了。
#[tauri::command]
pub async fn redis_scan(
    registry: State<'_, ConnectionRegistry>,
    id: String,
    pattern: String,
    cursor: u64,
    count: u32,
) -> Result<ScanPage, String> {
    registry
        .scan(&id, &pattern, cursor, count)
        .await
        .map_err(|e| e.to_string())
}

/// 一个 key 的类型、TTL 和值。
///
/// `key` 收的是**原始字节**（JSON 里的数字数组）而不是字符串：Redis 的 key 是
/// 二进制安全的，前端把字符串用 `TextEncoder` 编成字节传过来，
/// 二进制 key 则原样回传列表里给的那份字节 —— 这样多怪的 key 都能精确查到。
///
/// `knownType` 是**从 key 列表里带过来的类型提示**。给了它就能把
/// 「TTL + 值 + 总数」压进一个管道、一次往返；不给或给错了会自动退回慢路径。
#[tauri::command]
pub async fn redis_key_detail(
    registry: State<'_, ConnectionRegistry>,
    id: String,
    key: Vec<u8>,
    limit: u64,
    known_type: Option<String>,
) -> Result<KeyDetail, String> {
    registry
        .key_detail(&id, &key, limit, known_type.as_deref())
        .await
        .map_err(|e| e.to_string())
}
