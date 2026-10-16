//! 知识库内核的错误。文案都是中文、能直接给用户看（和 core 的内核同一条规矩）。

use std::fmt;
use std::io;

#[derive(Debug)]
pub enum KbError {
    /// 路径不合法（绝对路径、`..`、空串、踩了保留目录）
    BadRel { rel: String, reason: &'static str },
    /// 目标不存在
    NotFound { rel: String },
    /// 名字不合法（新建知识库/卡片时）
    BadName { name: String, reason: &'static str },
    /// 已经存在
    Exists { rel: String },
    /// 文档提取失败（解析不了、格式不认识）
    Extract { rel: String, reason: String },
    /// 底层 IO
    Io { rel: String, source: io::Error },
    /// 索引库出错（SQL/迁移）
    Db { reason: String },
}

impl KbError {
    pub fn io(rel: impl AsRef<str>, source: io::Error) -> Self {
        KbError::Io {
            rel: rel.as_ref().to_string(),
            source,
        }
    }

    pub fn db(reason: impl Into<String>) -> Self {
        KbError::Db {
            reason: reason.into(),
        }
    }
}

impl fmt::Display for KbError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            KbError::BadRel { rel, reason } => write!(f, "路径不合法（{reason}）：{rel}"),
            KbError::NotFound { rel } => write!(f, "不存在：{rel}"),
            KbError::BadName { name, reason } => write!(f, "名字不合法（{reason}）：{name}"),
            KbError::Exists { rel } => write!(f, "已经存在：{rel}"),
            KbError::Extract { rel, reason } => write!(f, "这个文件读不动（{reason}）：{rel}"),
            KbError::Io { rel, source } => write!(f, "文件操作失败（{source}）：{rel}"),
            KbError::Db { reason } => write!(f, "索引库出错：{reason}"),
        }
    }
}

impl std::error::Error for KbError {}

impl From<rusqlite::Error> for KbError {
    fn from(e: rusqlite::Error) -> Self {
        KbError::db(e.to_string())
    }
}
