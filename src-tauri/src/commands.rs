//! Tauri command 层。
//!
//! 这一层**只做参数搬运**：把 `root` 字符串打开成一个 [`Workspace`]，
//! 调用 [`rustdraw_core`] 里对应的方法，再把 `CoreError` 转成前端能看的字符串。
//! 所有路径校验、文件操作逻辑都在 `rustdraw-core` 里，这样它们能脱离
//! WebKit/GTK 单独跑测试。
//!
//! # 参数命名
//!
//! Tauri 2 默认把 Rust 的 snake_case 参数名映射成 JS 的 camelCase，
//! 所以前端这样调用：
//!
//! ```js
//! await invoke('write_text_file', { root, path, contents })
//! await invoke('rename_entry',    { root, path, newName })
//! await invoke('move_entry',      { root, path, newDir })
//! ```
//!
//! # 返回值
//!
//! 下面每个命令都返回 `Result<T, String>`。失败时 `invoke` 的 Promise 会 reject，
//! 字符串是已经中文化好的错误文案，前端直接弹出来即可。

use rustdraw_core::{FileNode, Workspace};

/// 打开工作区并把 `CoreError` 转成中文错误串。
fn with_workspace<T>(
    root: &str,
    f: impl FnOnce(&Workspace) -> Result<T, rustdraw_core::CoreError>,
) -> Result<T, String> {
    let ws = Workspace::open(root).map_err(|e| e.to_string())?;
    f(&ws).map_err(|e| e.to_string())
}

/// 递归列出工作区目录树。只列 `.seq.json` 文件；目录在前、按名称排序。
#[tauri::command]
pub fn list_tree(root: String) -> Result<Vec<FileNode>, String> {
    with_workspace(&root, |ws| ws.list_tree())
}

/// 读取文本文件（图的 JSON 内容）。
#[tauri::command]
pub fn read_text_file(root: String, path: String) -> Result<String, String> {
    with_workspace(&root, |ws| ws.read_text_file(&path))
}

/// 写入文本文件。原子写（临时文件 + rename），不会留下半截内容。
#[tauri::command]
pub fn write_text_file(root: String, path: String, contents: String) -> Result<(), String> {
    with_workspace(&root, |ws| ws.write_text_file(&path, &contents))
}

/// 在 `dir` 下新建图文件，返回新的相对路径。
///
/// `name` 不带后缀会自动补 `.seq.json`；重名时自动加序号。
/// 这里只创建**空文件占位**，初始 JSON 由前端用 `write_text_file` 写入。
#[tauri::command]
pub fn create_diagram(root: String, dir: String, name: String) -> Result<String, String> {
    with_workspace(&root, |ws| ws.create_diagram(&dir, &name))
}

/// 在 `dir` 下新建文件夹，返回新的相对路径。
#[tauri::command]
pub fn create_folder(root: String, dir: String, name: String) -> Result<String, String> {
    with_workspace(&root, |ws| ws.create_folder(&dir, &name))
}

/// 重命名，返回新的相对路径。
///
/// 图文件会保住 `.seq.json` 后缀（传 `"新名"` 得到 `新名.seq.json`）；
/// 目标已存在时直接报错，不会覆盖。
#[tauri::command]
pub fn rename_entry(root: String, path: String, new_name: String) -> Result<String, String> {
    with_workspace(&root, |ws| ws.rename_entry(&path, &new_name))
}

/// 删除文件或目录（目录递归删除）。
#[tauri::command]
pub fn delete_entry(root: String, path: String) -> Result<(), String> {
    with_workspace(&root, |ws| ws.delete_entry(&path))
}

/// 把 `path` 移动到 `new_dir` 目录下，返回新的相对路径。
#[tauri::command]
pub fn move_entry(root: String, path: String, new_dir: String) -> Result<String, String> {
    with_workspace(&root, |ws| ws.move_entry(&path, &new_dir))
}

/// 导出到工作区**之外**的绝对路径（用户在「另存为」对话框里选的）。
///
/// 这条命令**刻意不做工作区校验** —— 理由写在 `rustdraw_core::export` 的模块文档里：
/// 路径来自用户自己在系统对话框里的显式选择，等同于手动另存为，不构成越权。
/// 反过来说，它是全程序唯一一个绕过工作区边界的写入口，
/// 所以**不要**用它来实现除导出以外的任何功能。
#[tauri::command]
pub fn write_export(path: String, data: Vec<u8>) -> Result<(), String> {
    rustdraw_core::write_export(&path, &data).map_err(|e| e.to_string())
}
