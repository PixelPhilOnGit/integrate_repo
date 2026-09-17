//! SQL 内核：MySQL 和 PostgreSQL。
//!
//! 分层和 `devtoolkit-core` / `devtoolkit-redis` 一致：**不依赖 Tauri**，
//! 所以 `cargo test -p devtoolkit-sql` 能在没有 WebKit/GTK 的机器上单独跑，
//! 集成测试可以自己拉起真的 `postgres` / `mysqld` 来打。
//!
//! # 一条和 Redis 那边一样的语义
//!
//! **引擎拒绝一条 SQL（表不存在、语法错）不是「执行失败」，是一条查询结果。**
//! 它必须原样显示在结果区里，连接保持不动；只有传输层出问题才算失败。
//! 见 [`QueryResult::error`]。
//!
//! # 一条刻意的取舍
//!
//! 所有单元格**按文本传**，不做完整类型映射。理由和代价写在 `result.rs` 的模块文档里。

mod conn;
mod error;
mod result;

pub use conn::{ConnectionConfig, ConnectionRegistry, ServerInfo, SqlKind, TableInfo, CONNECT_TIMEOUT};
pub use error::SqlError;
pub use result::{Cell, ColumnInfo, QueryResult, MAX_ROWS};
