//! Redis 内核。
//!
//! 分层与 `devtoolkit-core` 一致：**不依赖 Tauri**，所以
//! `cargo test -p devtoolkit-redis` 能在没有 WebKit/GTK 的机器上单独跑，
//! 而且集成测试可以自己拉起一个真 `redis-server` 来打。
//!
//! 这里只有三件事：
//!
//! * [`Reply`] —— 把 Redis 的回复树转成一个能序列化成 JSON 的形状，交给前端渲染
//! * [`ConnectionRegistry`] —— 活连接的管理（连接、断开、执行）
//! * [`RedisError`] —— 手写中文文案的错误（沿用 `CoreError` 的传统，不用 thiserror）
//!
//! # 一条必须守住的语义
//!
//! **服务器返回的错误（`-ERR unknown command`）是「一条回复」，不是「执行失败」。**
//! 它必须原样出现在命令台的日志里，连接保持不动；只有传输层出问题
//! （连不上、超时、连接断了）才算失败。
//!
//! 这条语义靠 [`Reply::Error`] 承载：`exec` 遇到服务端错误返回 `Ok(Reply::Error{..})`。

mod browse;
mod conn;
mod error;
mod reply;

pub use browse::{DbInfo, KeyDetail, KeyMeta, ScanPage};
pub use conn::{ConnectionConfig, ConnectionRegistry, ServerInfo, COMMAND_TIMEOUT, CONNECT_TIMEOUT};
pub use error::RedisError;
pub use reply::Reply;
