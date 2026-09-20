//! 键值存储的错误类型。
//!
//! 和另外几个内核一个路子：**手写 `Display` + 中文文案**，命令层直接把
//! `to_string()` 交出去。
//!
//! `Import` 单独一类是因为调用方要**据它做决定**：搬迁失败时前端会退回老的
//! JSON 实现（这次会话照常用老数据），而不是把错误弹给用户看。

use std::fmt;

#[derive(Debug)]
pub enum StoreError {
    /// 库打不开 / 建不出来
    Open { path: String, reason: String },
    /// 结构迁移失败（库是更新的版本建的之类）
    Migrate { reason: String },
    /// 读写失败
    Query { reason: String },
    /// 搬迁老 JSON 文件失败。⚠️ **出现它时老文件一定没被动过**
    Import { path: String, reason: String },
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StoreError::Open { path, reason } => write!(
                f,
                "键值库打不开：{path}\n原因：{reason}\n（目录没有写权限、或者磁盘满了都会这样）"
            ),
            StoreError::Migrate { reason } => write!(
                f,
                "键值库的结构不对：{reason}\n（这个文件被别的版本或手工改过？备份之后删掉它可以从头开始）"
            ),
            StoreError::Query { reason } => write!(f, "键值库读写失败：{reason}"),
            StoreError::Import { path, reason } => write!(
                f,
                "老数据文件搬迁失败：{path}\n原因：{reason}\n（**原文件没有动**，这次仍然用老数据）"
            ),
        }
    }
}

impl std::error::Error for StoreError {}

impl From<rusqlite::Error> for StoreError {
    fn from(e: rusqlite::Error) -> Self {
        StoreError::Query {
            reason: e.to_string(),
        }
    }
}
