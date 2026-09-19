//! 任务侧的错误类型。
//!
//! 和另外五个内核一个路子：**手写 `Display` + 中文文案**，不引入 thiserror。
//! 命令层直接把 `to_string()` 的结果给前端，所以这里每一句都是**用户会读到
//! 的那一句**。

use std::fmt;

#[derive(Debug)]
pub enum TaskError {
    /// 库文件打不开 / 建不出来（目录没权限、磁盘满了、文件被别的进程锁着）
    ///
    /// `path` 单独带出来：这一类的失败**全是关于某个具体文件的**，
    /// 而用户往往需要自己去那个目录看一眼
    Open { path: String, reason: String },

    /// 迁移没跑成。**单独一类**：它的意思和「操作失败」完全不同 ——
    /// 库文件在，但结构是我们不认识的（手改过、或者从更新的版本降级回来）
    Migrate { reason: String },

    /// 读写某一行的失败
    Query { reason: String },

    /// 这个 id 上没这条任务
    NotFound { id: String },

    /// 标题是空的之类 —— 参数本身没法用
    BadInput { reason: String },
}

impl fmt::Display for TaskError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            TaskError::Open { path, reason } => write!(
                f,
                "任务库打不开：{path}\n原因：{reason}\n（目录没有写权限、或者磁盘满了都会这样）"
            ),
            TaskError::Migrate { reason } => write!(
                f,
                "任务库的结构不对，迁移没跑成：{reason}\n（这个文件被别的版本或手工改过？备份之后删掉它可以从头开始）"
            ),
            TaskError::Query { reason } => write!(f, "任务库读写失败：{reason}"),
            TaskError::NotFound { id } => write!(f, "没有这条任务：{id}"),
            TaskError::BadInput { reason } => write!(f, "这条任务存不下去：{reason}"),
        }
    }
}

impl std::error::Error for TaskError {}

impl From<rusqlite::Error> for TaskError {
    fn from(e: rusqlite::Error) -> Self {
        TaskError::Query {
            reason: e.to_string(),
        }
    }
}
