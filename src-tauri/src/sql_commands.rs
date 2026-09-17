//! SQL 相关的 Tauri command。
//!
//! 和 `commands.rs` / `redis_commands.rs` 一样**只做参数搬运**：真正的逻辑在
//! `devtoolkit-sql` 里，那样它能脱离 WebKit/GTK 跑测试（含打真 PostgreSQL /
//! MySQL 的集成测试）。
//!
//! # 一条容易搞错的语义
//!
//! **引擎拒绝一条 SQL（表不存在、语法错）会以 `Ok(QueryResult { error: Some })`
//! 返回，不是 `Err`。** 那是一次成功的往返，只是没成功执行 —— 前端把它当结果
//! 显示在结果区里，连接不动。只有传输层失败（连不上、断了）才返回 `Err(String)`。

use devtoolkit_sql::{
    ConnectionConfig, ConnectionRegistry, QueryResult, ServerInfo, TableInfo,
};
use tauri::State;

/// 建立连接。同一个 `id` 再连一次是**替换**，不是新建。
#[tauri::command]
pub async fn sql_connect(
    registry: State<'_, ConnectionRegistry>,
    id: String,
    config: ConnectionConfig,
) -> Result<ServerInfo, String> {
    registry.connect(&id, &config).await.map_err(|e| e.to_string())
}

/// 断开连接。幂等：没连过也返回成功。
#[tauri::command]
pub async fn sql_disconnect(
    registry: State<'_, ConnectionRegistry>,
    id: String,
) -> Result<(), String> {
    registry.disconnect(&id).map(|_| ()).map_err(|e| e.to_string())
}

/// 执行一段 SQL。支持一次提交多条语句。
#[tauri::command]
pub async fn sql_query(
    registry: State<'_, ConnectionRegistry>,
    id: String,
    sql: String,
) -> Result<QueryResult, String> {
    registry.query(&id, &sql).await.map_err(|e| e.to_string())
}

/// 库列表。PostgreSQL 查 `pg_database`，MySQL 用 `SHOW DATABASES`。
#[tauri::command]
pub async fn sql_databases(
    registry: State<'_, ConnectionRegistry>,
    id: String,
) -> Result<Vec<String>, String> {
    registry.databases(&id).await.map_err(|e| e.to_string())
}

/// 当前库里的表。
#[tauri::command]
pub async fn sql_tables(
    registry: State<'_, ConnectionRegistry>,
    id: String,
) -> Result<Vec<TableInfo>, String> {
    registry.tables(&id).await.map_err(|e| e.to_string())
}

/// 换库。
///
/// 两种引擎的做法不同（MySQL 用 `USE`，PostgreSQL 重建连接），
/// 但对前端是同一个行为 —— 换完之后 `sql_query` 都打在新库上。
#[tauri::command]
pub async fn sql_use_database(
    registry: State<'_, ConnectionRegistry>,
    id: String,
    database: String,
) -> Result<ServerInfo, String> {
    registry
        .use_database(&id, &database)
        .await
        .map_err(|e| e.to_string())
}
