//! 群组内核的错误。文案都是中文、能直接给用户看（和 core / knowledge 同一条规矩）。
//!
//! ⚠️ 分工（和 `request_commands` 一样）：`GroupError` 里**没有**「某个成员失败」——
//! 那是**一轮里的事件**（`memberFinished { status: failed }`），不是命令错误。
//! 这里的 `Err` 只表示「这一轮根本没起来」：群不存在、工作目录不对、没有可用成员、
//! `@` 指向不存在的成员、同群已有一轮在跑、空消息。

use std::fmt;
use std::io;

#[derive(Debug)]
pub enum GroupError {
    /// 群 / 成员 / 轮次不存在
    NotFound { what: String },
    /// 输入不合法（名字、权限、额外参数、空消息……）
    BadInput { reason: String },
    /// 工作目录不合法 / 不是目录
    BadWorkspace { path: String, reason: String },
    /// 同一个群已经有一轮在跑
    Busy { group_id: String },
    /// 起进程失败（程序不存在、权限不足、Windows 上 .cmd 拉不起来……）
    Spawn { program: String, reason: String },
    /// 子进程 IO
    Io { what: String, source: io::Error },
    /// 数据库（SQL / 迁移）
    Db { reason: String },
    /// 配置 / 事件序列化
    Json { reason: String },
}

impl GroupError {
    pub fn db(reason: impl Into<String>) -> Self {
        GroupError::Db { reason: reason.into() }
    }

    pub fn bad_input(reason: impl Into<String>) -> Self {
        GroupError::BadInput { reason: reason.into() }
    }

    pub fn not_found(what: impl Into<String>) -> Self {
        GroupError::NotFound { what: what.into() }
    }

    pub fn io(what: impl Into<String>, source: io::Error) -> Self {
        GroupError::Io { what: what.into(), source }
    }

    pub fn spawn(program: impl Into<String>, reason: impl Into<String>) -> Self {
        GroupError::Spawn { program: program.into(), reason: reason.into() }
    }
}

impl fmt::Display for GroupError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            GroupError::NotFound { what } => write!(f, "找不到：{what}"),
            GroupError::BadInput { reason } => write!(f, "{reason}"),
            GroupError::BadWorkspace { path, reason } => {
                write!(f, "工作目录不能用（{reason}）：{path}")
            }
            GroupError::Busy { group_id } => write!(
                f,
                "这个群还有一轮在跑（{group_id}）—— 先停止，或者等它跑完"
            ),
            GroupError::Spawn { program, reason } => {
                write!(f, "起不来 {program}：{reason}")
            }
            GroupError::Io { what, source } => write!(f, "{what} 失败：{source}"),
            GroupError::Db { reason } => write!(f, "群组数据库出错：{reason}"),
            GroupError::Json { reason } => write!(f, "数据格式不对：{reason}"),
        }
    }
}

impl std::error::Error for GroupError {}

impl From<rusqlite::Error> for GroupError {
    fn from(e: rusqlite::Error) -> Self {
        GroupError::db(e.to_string())
    }
}

impl From<serde_json::Error> for GroupError {
    fn from(e: serde_json::Error) -> Self {
        GroupError::Json { reason: e.to_string() }
    }
}
