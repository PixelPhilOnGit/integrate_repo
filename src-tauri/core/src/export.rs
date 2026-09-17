//! 导出到工作区**之外**的目标路径。
//!
//! # 为什么这里可以绕过工作区校验
//!
//! 这是整个程序里唯一一个不受 [`crate::Workspace::resolve`] 约束的写操作，
//! 所以值得把理由写清楚，免得以后 review 的人以为漏了校验：
//!
//! 这里的 `path` 来自用户在系统「另存为」对话框里的**显式选择**（前端通过
//! `@tauri-apps/plugin-dialog` 的 `save()` 拿到，再原样传进来）。这等价于用户在
//! 文件管理器里自己另存一份 —— 程序无法凭空构造出一个用户没选过的路径，
//! 也就不存在"越权访问"这回事。
//!
//! 反过来说：**只有**导出走这条路。其余所有读写都仍然强制经过工作区校验，
//! 因为那些路径可能来自图文件内容或程序内部状态，属于不可信输入。
//!
//! 即便绕过了工作区边界，仍然会做能做的防护：拒绝空路径、拒绝相对路径、
//! 拒绝把目录当文件写、要求父目录存在、原子写。

use std::path::PathBuf;

use crate::error::CoreError;
use crate::workspace::atomic_write;

/// 把 `data` 写到 `path`（绝对路径），覆盖已存在的文件。
///
/// 用「临时文件 + rename」原子写：导出中途失败不会在用户的桌面或文档目录里
/// 留下一个半截的、打不开的文件。
pub fn write_export(path: &str, data: &[u8]) -> Result<(), CoreError> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(CoreError::Denied {
            reason: "导出路径为空".to_string(),
        });
    }

    let target = PathBuf::from(trimmed);

    if !target.is_absolute() {
        return Err(CoreError::Denied {
            reason: "导出路径必须是绝对路径".to_string(),
        });
    }

    if target.is_dir() {
        return Err(CoreError::WrongKind {
            path: trimmed.to_string(),
            reason: "这是一个目录，不能作为导出目标",
        });
    }

    let parent = target.parent().ok_or_else(|| CoreError::Denied {
        reason: "导出路径没有父目录".to_string(),
    })?;

    if !parent.is_dir() {
        return Err(CoreError::NotFound {
            path: parent.display().to_string(),
        });
    }

    atomic_write(&target, data)
}
