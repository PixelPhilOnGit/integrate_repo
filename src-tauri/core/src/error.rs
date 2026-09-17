//! 统一的错误类型。
//!
//! 这里刻意手写 `Display` / `std::error::Error` 而不引入 `thiserror`，
//! 一来让 `rustdraw-core` 的依赖树只有 serde（`cargo test` 秒级完成），
//! 二来方便把面向用户的文案（中文）集中在一处维护。

use std::fmt;
use std::io;

#[derive(Debug)]
pub enum CoreError {
    /// 目标路径落在工作区之外——包括用 `..` 爬出去，以及顺着符号链接跳出去。
    OutsideWorkspace { path: String },

    /// 传进来的是绝对路径。所有 command 只接受相对于工作区根目录的路径。
    AbsolutePath { path: String },

    /// 路径里出现了 `..` 分量。
    ParentTraversal { path: String },

    /// 文件 / 目录名不合法。
    InvalidName { name: String, reason: &'static str },

    /// 目标已经存在。
    AlreadyExists { path: String },

    /// 目标不存在。
    NotFound { path: String },

    /// 期望是文件却拿到目录，或反过来。
    WrongKind { path: String, reason: &'static str },

    /// 工作区根目录本身有问题（不存在、不是目录、没权限……）。
    BadRoot { path: String, reason: String },

    /// 明确拒绝的操作（例如删除工作区根目录）。
    Denied { reason: String },

    /// 底层 IO 错误。
    Io { path: String, source: io::Error },
}

impl CoreError {
    pub(crate) fn io(path: impl AsRef<std::path::Path>, source: io::Error) -> Self {
        CoreError::Io {
            path: path.as_ref().display().to_string(),
            source,
        }
    }
}

impl fmt::Display for CoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CoreError::OutsideWorkspace { path } => write!(
                f,
                "路径 “{path}” 超出了当前工作区，已拒绝访问。\
                 只能操作工作区目录内部的文件。"
            ),
            CoreError::AbsolutePath { path } => write!(
                f,
                "路径 “{path}” 是绝对路径，已拒绝。请使用相对于工作区根目录的路径。"
            ),
            CoreError::ParentTraversal { path } => write!(
                f,
                "路径 “{path}” 含有 “..”，可能越出工作区，已拒绝。"
            ),
            CoreError::InvalidName { name, reason } => {
                write!(f, "名称 “{name}” 不合法：{reason}。")
            }
            CoreError::AlreadyExists { path } => write!(f, "“{path}” 已经存在。"),
            CoreError::NotFound { path } => write!(f, "找不到 “{path}”。"),
            CoreError::WrongKind { path, reason } => write!(f, "“{path}” {reason}。"),
            CoreError::BadRoot { path, reason } => {
                write!(f, "无法打开工作区 “{path}”：{reason}。")
            }
            CoreError::Denied { reason } => write!(f, "操作被拒绝：{reason}。"),
            CoreError::Io { path, source } => {
                write!(f, "访问 “{path}” 时出错：{}。", humanize_io(source))
            }
        }
    }
}

impl std::error::Error for CoreError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            CoreError::Io { source, .. } => Some(source),
            _ => None,
        }
    }
}

/// 把 IO 错误翻译成用户能看懂的中文，别把 `Os { code: 13, ... }` 甩到界面上。
fn humanize_io(e: &io::Error) -> String {
    match e.kind() {
        io::ErrorKind::NotFound => "文件或目录不存在".to_string(),
        io::ErrorKind::PermissionDenied => "没有访问权限".to_string(),
        io::ErrorKind::AlreadyExists => "已经存在".to_string(),
        io::ErrorKind::InvalidData => "文件内容不是有效的 UTF-8 文本".to_string(),
        io::ErrorKind::IsADirectory => "这是一个目录，不是文件".to_string(),
        io::ErrorKind::NotADirectory => "路径中有一段不是目录".to_string(),
        io::ErrorKind::DirectoryNotEmpty => "目录非空".to_string(),
        io::ErrorKind::StorageFull => "磁盘空间不足".to_string(),
        io::ErrorKind::ReadOnlyFilesystem => "文件系统是只读的".to_string(),
        _ => match e.raw_os_error() {
            Some(code) => format!("系统错误（错误码 {code}）"),
            None => "未知错误".to_string(),
        },
    }
}
