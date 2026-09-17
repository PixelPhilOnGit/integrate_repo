//! # rustdraw-core
//!
//! rustDraw 的纯逻辑内核：工作区路径安全边界 + 文件操作。
//!
//! 这个 crate **不依赖 tauri**，所以 `cargo test -p rustdraw-core` 几秒钟就能跑完，
//! 路径安全那套逻辑可以脱离 WebKit / GTK 单独验证。Tauri 层（`src/commands.rs`）
//! 只是把这些方法包一层 `#[tauri::command]`。
//!
//! 唯一的安全闸门是 [`Workspace::resolve`]，详见 `workspace` 模块的文档。

mod error;
mod export;
mod workspace;

pub use error::CoreError;
pub use export::write_export;
pub use workspace::{FileNode, Workspace, DIAGRAM_EXT};
