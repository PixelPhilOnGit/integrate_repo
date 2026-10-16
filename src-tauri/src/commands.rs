//! Tauri command 层。
//!
//! 这一层**只做参数搬运**：把 `root` 字符串打开成一个 [`Workspace`]，
//! 调用 [`devtoolkit_core`] 里对应的方法，再把 `CoreError` 转成前端能看的字符串。
//! 所有路径校验、文件操作逻辑都在 `devtoolkit-core` 里，这样它们能脱离
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

use devtoolkit_core::{CoreError, DirEntry, FileNode, Preview, Workspace};

/// 打开工作区并把 `CoreError` 转成中文错误串。
fn with_workspace<T>(
    root: &str,
    f: impl FnOnce(&Workspace) -> Result<T, devtoolkit_core::CoreError>,
) -> Result<T, String> {
    let ws = Workspace::open(root).map_err(|e| e.to_string())?;
    f(&ws).map_err(|e| e.to_string())
}

/// 把一段同步的文件操作丢进 blocking 池。
///
/// ⚠️ 新加的几条命令一律走它：同步命令跑在 IPC 线程上，而目录可能在网络盘、
/// 可能有几十万项 —— 把线程拖住就是「界面假死」（HANDOFF 里那条真机教训）。
pub(crate) fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> impl std::future::Future<Output = Result<T, String>> {
    async move {
        tauri::async_runtime::spawn_blocking(f)
            .await
            .map_err(|e| format!("文件操作的线程没能跑起来：{e}"))?
    }
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

/// 单层列出目录（文件浏览器的懒加载用）。**不过滤**：隐藏项、任意后缀都列。
///
/// 和 `list_tree` 是两条路：那个是图工作区的递归树，这个是「拿用户自己的
/// 项目目录当浏览对象」（智能体会话的「文件」标签）。见 `Workspace::list_dir`。
#[tauri::command]
pub async fn fs_list_dir(root: String, rel: String) -> Result<Vec<DirEntry>, String> {
    blocking(move || with_workspace(&root, |ws| ws.list_dir(&rel))).await
}

/// 读文件预览：文本 / 二进制 / 超限（2 MiB）三态。
///
/// 先 stat 再谈读（FIFO/设备直接拒、超限不读内容），见 `Workspace::read_preview`。
#[tauri::command]
pub async fn fs_read_preview(root: String, rel: String) -> Result<Preview, String> {
    blocking(move || with_workspace(&root, |ws| ws.read_preview(&rel))).await
}

/// 用系统默认程序打开工作区里的一个文件或目录（「用系统程序打开」）。
///
/// # ⚠️ 这是安全姿势上的**例外之二**，别再加第三个
///
/// 和 tasks 那条「参数表里没有路径」的立场不同（见 `task_commands.rs` 头部），
/// 这里是文件浏览器：路径本来就来自**用户自己选的工作目录**。边界仍然收紧在
/// `(root, rel)` 上 —— 相对路径 + `Workspace::resolve` 的闸门（拒绝对路径 /
/// `..` / 符号链接逃逸），换不出工作区外面去。README 的「安全模型」一节
/// 和 HANDOFF 都有这条（例外之一是 `write_export`）。
///
/// 打开本身的命令链（Windows 上 explorer → rundll32 → cmd 的三层退让、
/// 为什么不再依赖文件名清洗表）在 `open.rs` 的模块头。
#[tauri::command]
pub async fn fs_open_path(root: String, rel: String) -> Result<(), String> {
    let abs = blocking(move || {
        with_workspace(&root, |ws| {
            let abs = ws.resolve(&rel)?;
            // resolve 只保证「在工作区里」，不保证「真的存在」（尾部段落不参与
            // canonicalize）。交给系统程序之前先确认它在，否则用户得到的是
            // 「资源管理器弹一句找不到」而不是我们这句人话。
            let exists = abs
                .symlink_metadata()
                .map(|m| m.is_file() || m.is_dir())
                .unwrap_or(false);
            if !exists {
                return Err(CoreError::NotFound { path: rel.clone() });
            }
            Ok(abs)
        })
    })
    .await?;

    // 起进程很快（收尸有专门的线程，见 open.rs），出了 blocking 池再调没问题
    crate::open::open_path(&abs)
}

/// 导出到工作区**之外**的绝对路径（用户在「另存为」对话框里选的）。
///
/// 这条命令**刻意不做工作区校验** —— 理由写在 `devtoolkit_core::export` 的模块文档里：
/// 路径来自用户自己在系统对话框里的显式选择，等同于手动另存为，不构成越权。
/// 反过来说，它是全程序唯一一个绕过工作区边界的写入口，
/// 所以**不要**用它来实现除导出以外的任何功能。
#[tauri::command]
pub fn write_export(path: String, data: Vec<u8>) -> Result<(), String> {
    devtoolkit_core::write_export(&path, &data).map_err(|e| e.to_string())
}
