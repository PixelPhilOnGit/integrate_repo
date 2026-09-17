//! 工作区：路径安全边界 + 文件操作。
//!
//! # 安全模型
//!
//! 前端传过来的路径全部是**相对于工作区根目录的相对路径**，一律要经过
//! [`Workspace::resolve`] 校验。这个函数是整个后端唯一的安全闸门，
//! 任何绕过它的文件访问都是漏洞。
//!
//! 校验分三步：
//!
//! 1. **字面检查**：拒绝绝对路径（含 Windows 盘符前缀 `C:` 与 UNC `\\server`）、
//!    拒绝任何 `..` 分量、拒绝 NUL 字节。先把 `\` 统一成 `/`，否则
//!    `sub\..\..\escape` 在 Linux 上会被当成一个合法的文件名而蒙混过关。
//! 2. **规范化**：用 `canonicalize` 解析符号链接。文件不存在时（新建场景），
//!    向上找到最近的已存在祖先目录做 `canonicalize`，再把剩下的段拼回去。
//! 3. **归属确认**：结果必须 `starts_with` 规范化后的工作区根目录。
//!    `Path::starts_with` 是按路径分量比较的，所以 `/ws-evil` 不会被
//!    `/ws` 误判为“在里面”。
//!
//! 因为第 2 步会解析符号链接，所以“工作区里放一个指向 `/etc` 的软链接”
//! 这种绕过同样会被第 3 步拦下。
//!
//! # 已知限制
//!
//! 校验和使用之间存在 TOCTOU 窗口：理论上可以在两步之间把某个目录换成
//! 符号链接。要彻底堵住需要 `openat2(RESOLVE_BENEATH)` / `O_NOFOLLOW` 这类
//! 平台特定 API，且要放弃跨平台的可移植性。对本应用（单用户本地桌面编辑器）
//! 来说不值得，但这是个已知边界。

use std::ffi::OsString;
use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::error::CoreError;

/// 图文件的后缀。目录树只列这个后缀的文件。
pub const DIAGRAM_EXT: &str = ".seq.json";

/// 递归深度上限，防止病态的目录嵌套把栈打爆。
const MAX_TREE_DEPTH: usize = 64;

/// 单个文件 / 目录名的最大字符数。大多数文件系统的上限是 255 字节。
const MAX_NAME_CHARS: usize = 128;

/// Windows 上不能用作文件名的设备名。
const WINDOWS_RESERVED: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// 目录树的一个节点。字段名固定，前端 TS 类型直接照着写。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FileNode {
    /// 展示用的名字（不含父目录）。
    pub name: String,
    /// 相对工作区根目录的路径，**正斜杠分隔**；Windows 上也会转成正斜杠，前端只认这个。
    pub path: String,
    /// `"file"` 或 `"dir"`。
    pub kind: String,
    /// 只有 `kind == "dir"` 才有；文件恒为 `null`。
    pub children: Option<Vec<FileNode>>,
}

impl FileNode {
    fn dir(name: String, path: String, children: Vec<FileNode>) -> Self {
        FileNode {
            name,
            path,
            kind: "dir".to_string(),
            children: Some(children),
        }
    }

    fn file(name: String, path: String) -> Self {
        FileNode {
            name,
            path,
            kind: "file".to_string(),
            children: None,
        }
    }
}

/// 一个已经打开的工作区。持有一个**规范化之后**的根目录。
#[derive(Debug, Clone)]
pub struct Workspace {
    root: PathBuf,
}

impl Workspace {
    /// 打开工作区。`root` 会被 `canonicalize`，所以后续所有比较
    /// 都是在“真实路径”上做的——哪怕用户选的是个软链接目录。
    pub fn open(root: impl AsRef<Path>) -> Result<Self, CoreError> {
        let raw = root.as_ref();

        if raw.as_os_str().is_empty() {
            return Err(CoreError::BadRoot {
                path: String::new(),
                reason: "没有选择目录".to_string(),
            });
        }

        let canon = raw.canonicalize().map_err(|e| match e.kind() {
            io::ErrorKind::NotFound => CoreError::BadRoot {
                path: raw.display().to_string(),
                reason: "目录不存在".to_string(),
            },
            io::ErrorKind::PermissionDenied => CoreError::BadRoot {
                path: raw.display().to_string(),
                reason: "没有访问权限".to_string(),
            },
            _ => CoreError::BadRoot {
                path: raw.display().to_string(),
                reason: format!("无法解析该路径（{}）", e),
            },
        })?;

        if !canon.is_dir() {
            return Err(CoreError::BadRoot {
                path: canon.display().to_string(),
                reason: "不是一个目录".to_string(),
            });
        }

        Ok(Workspace { root: canon })
    }

    /// 规范化后的工作区根目录（绝对路径）。
    pub fn root(&self) -> &Path {
        &self.root
    }

    // ---------------------------------------------------------------- 路径校验

    /// 把前端给的相对路径解析成受信任的绝对路径。
    ///
    /// 允许目标**尚不存在**（新建场景）：这时会向上找到最近的已存在祖先
    /// 做规范化，再把剩余部分拼回去。
    pub fn resolve(&self, rel: &str) -> Result<PathBuf, CoreError> {
        // Windows 风格分隔符也当分隔符处理，否则 `sub\..\..\x` 在 Linux 上
        // 会变成一个普通的文件名，`..` 检查就被绕过去了。
        let rel = rel.replace('\\', "/");

        if rel.contains('\0') {
            return Err(CoreError::InvalidName {
                name: rel.escape_debug().to_string(),
                reason: "路径不能包含空字符",
            });
        }

        if is_absolute_like(&rel) {
            return Err(CoreError::AbsolutePath { path: rel });
        }

        let mut candidate = self.root.clone();
        for seg in rel.split('/') {
            match seg {
                // 空段（`a//b`、结尾的 `/`）和 `.` 都无害，直接跳过。
                "" | "." => continue,
                ".." => return Err(CoreError::ParentTraversal { path: rel }),
                _ => {}
            }

            // `C:` 这类盘符相对路径：在 Linux 上它只是个普通名字，在 Windows 上
            // 却能改变解析基准，所以不管在哪个平台都拒掉，行为保持一致。
            if is_drive_prefix(seg) {
                return Err(CoreError::AbsolutePath { path: rel });
            }

            candidate.push(seg);
        }

        self.confine(candidate, &rel)
    }

    /// 校验并返回一个可用的文件名 / 目录名。
    ///
    /// 比 [`Workspace::resolve`] 严格：这里针对的是**新建**的名字，
    /// 所以按各平台里最严的那一套来（拒绝 `:`、`<>"|?*`、结尾空格和点、
    /// Windows 保留设备名），保证建出来的工作区在任何系统上都能打开。
    pub fn validate_entry_name<'a>(&self, name: &'a str) -> Result<&'a str, CoreError> {
        let name = name.trim();

        let bad = |reason: &'static str| CoreError::InvalidName {
            name: name.to_string(),
            reason,
        };

        if name.is_empty() {
            return Err(bad("名称不能为空"));
        }
        if name == "." || name == ".." {
            return Err(bad("名称不能是 “.” 或 “..”"));
        }
        if name.chars().count() > MAX_NAME_CHARS {
            return Err(bad("名称太长"));
        }

        for ch in name.chars() {
            match ch {
                '/' | '\\' => return Err(bad("名称不能包含路径分隔符")),
                ':' => return Err(bad("名称不能包含冒号")),
                '<' | '>' | '"' | '|' | '?' | '*' => {
                    return Err(bad("名称包含 Windows 保留字符 <>\"|?*"))
                }
                c if (c as u32) < 0x20 || c == '\u{7f}' => {
                    return Err(bad("名称不能包含控制字符"))
                }
                _ => {}
            }
        }

        // Windows 会静默丢掉结尾的点和空格，导致“建出来的名字和输入的不一样”。
        if name.ends_with('.') || name.ends_with(' ') {
            return Err(bad("名称不能以点或空格结尾"));
        }

        // 保留设备名是按“第一个点之前的部分”判断的，`NUL.txt` 在 Windows 上
        // 同样会被当成设备。
        let stem = name.split('.').next().unwrap_or(name);
        if WINDOWS_RESERVED
            .iter()
            .any(|r| stem.eq_ignore_ascii_case(r))
        {
            return Err(bad("这是 Windows 保留设备名"));
        }

        Ok(name)
    }

    /// 第 2、3 步：规范化 + 归属确认。
    ///
    /// `candidate` 已经过字面检查（绝对路径段、`..` 都清掉了），但**还没解析符号链接**。
    fn confine(&self, candidate: PathBuf, rel: &str) -> Result<PathBuf, CoreError> {
        let outside = || CoreError::OutsideWorkspace {
            path: rel.to_string(),
        };

        // 向上找到最近的、真实存在的祖先。沿途剥下来的段记在 tail 里。
        let mut anchor = candidate;
        let mut tail: Vec<OsString> = Vec::new();

        loop {
            match anchor.symlink_metadata() {
                Ok(_) => break,
                Err(e) if e.kind() == io::ErrorKind::NotFound => {
                    let name = match anchor.file_name() {
                        Some(n) => n.to_os_string(),
                        // 走到根了还不存在，理论上不可能（root 一定存在）。
                        None => return Err(outside()),
                    };
                    tail.push(name);
                    anchor.pop();
                    if anchor.as_os_str().is_empty() {
                        return Err(outside());
                    }
                }
                Err(e) => return Err(CoreError::io(&anchor, e)),
            }
        }

        // canonicalize 会解析符号链接 —— 软链接指向工作区外时，
        // 下面这一步算出来的 real 就不在 root 里了。
        let real = anchor
            .canonicalize()
            .map_err(|e| CoreError::io(&anchor, e))?;

        if !real.starts_with(&self.root) {
            return Err(outside());
        }

        // 把还不存在的尾段拼回去。它们一定不是 `..`（前面已经拦掉了），
        // 而且既然不存在，就不可能是符号链接。
        let mut out = real;
        for name in tail.iter().rev() {
            out.push(name);
        }

        // 双保险：拼接后的结果仍在 root 之下。
        if !out.starts_with(&self.root) {
            return Err(outside());
        }

        Ok(out)
    }

    /// 绝对路径 → 正斜杠分隔的相对路径。前端只认这个格式。
    pub fn rel_path(&self, abs: &Path) -> Result<String, CoreError> {
        let rel = abs.strip_prefix(&self.root).map_err(|_| {
            CoreError::OutsideWorkspace {
                path: abs.display().to_string(),
            }
        })?;

        let mut parts: Vec<String> = Vec::new();
        for comp in rel.components() {
            match comp {
                std::path::Component::Normal(s) => parts.push(s.to_string_lossy().into_owned()),
                // 非 Normal 分量（. .. / 前缀）不应该出现在 canonicalize 之后。
                _ => {}
            }
        }

        Ok(parts.join("/"))
    }

    // ------------------------------------------------------------------ 命令

    /// 递归列出工作区目录树。
    ///
    /// * 只列 `.seq.json` 文件；
    /// * 目录全部保留（哪怕是空的），否则刚建好的空文件夹会立刻从界面上消失；
    /// * 排序：目录在前，然后按名称（忽略大小写）排；
    /// * 跳过符号链接（避免递归出不去 / 出工作区）和以 `.` 开头的隐藏项（`.git` 之类）。
    pub fn list_tree(&self) -> Result<Vec<FileNode>, CoreError> {
        self.walk(&self.root.clone(), 0)
    }

    fn walk(&self, dir: &Path, depth: usize) -> Result<Vec<FileNode>, CoreError> {
        if depth >= MAX_TREE_DEPTH {
            return Ok(Vec::new());
        }

        let entries = fs::read_dir(dir).map_err(|e| CoreError::io(dir, e))?;

        let mut nodes = Vec::new();
        for entry in entries {
            // 单个条目读失败（权限、竞态删除）不该让整棵树挂掉，跳过即可。
            let Ok(entry) = entry else { continue };

            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }

            // file_type() 不跟随符号链接，正好用来识别。
            let Ok(ft) = entry.file_type() else { continue };
            if ft.is_symlink() {
                continue;
            }

            let path = entry.path();
            if ft.is_dir() {
                let children = self.walk(&path, depth + 1)?;
                nodes.push(FileNode::dir(name, self.rel_path(&path)?, children));
            } else if ft.is_file() && name.ends_with(DIAGRAM_EXT) {
                nodes.push(FileNode::file(name, self.rel_path(&path)?));
            }
        }

        nodes.sort_by(|a, b| {
            let (a_dir, b_dir) = (a.kind == "dir", b.kind == "dir");
            b_dir
                .cmp(&a_dir) // true > false → 目录排在前面
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
                .then_with(|| a.name.cmp(&b.name)) // 大小写不同但忽略大小写相等时，保证顺序稳定
        });

        Ok(nodes)
    }

    /// 读取文本文件。
    pub fn read_text_file(&self, rel: &str) -> Result<String, CoreError> {
        let path = self.resolve(rel)?;
        self.ensure_file(&path)?;

        let bytes = fs::read(&path).map_err(|e| CoreError::io(&path, e))?;

        String::from_utf8(bytes).map_err(|_| CoreError::WrongKind {
            path: rel.to_string(),
            reason: "不是有效的 UTF-8 文本文件",
        })
    }

    /// 原子写：先写同目录下的临时文件，`fsync` 之后再 `rename` 覆盖。
    ///
    /// 这样断电 / 崩溃时要么是旧内容、要么是新内容，不会出现写了一半的
    /// `.seq.json`。临时文件以 `.` 开头，不会被目录树列出来。
    pub fn write_text_file(&self, rel: &str, contents: &str) -> Result<(), CoreError> {
        let path = self.resolve(rel)?;
        self.ensure_parent_dir(&path, rel)?;
        atomic_write(&path, contents.as_bytes())
    }

    // 曾经有过 export_binary()：把 PNG 等二进制写进工作区内部。
    // 前端最终走的是 write_export（另存为对话框选任意位置），没人调用它，
    // 所以删掉了，省一个无人使用的写入口。
    // 将来若要支持“把图导出到工作区、放在 .seq.json 旁边”，
    // 把上面那个方法加回来即可（resolve + ensure_parent_dir + atomic_write）。

    /// 在 `dir`（相对路径，空串表示根目录）下新建一个图文件。
    ///
    /// `name` 可以带后缀也可以不带，最终一定是 `.seq.json` 结尾。
    /// 重名时自动加序号（`时序图 (2).seq.json`），不覆盖已有内容。
    ///
    /// 返回新文件的相对路径。注意：这里只**创建空文件占位**，
    /// 初始 JSON 内容由前端通过 `write_text_file` 写入。
    pub fn create_diagram(&self, dir: &str, name: &str) -> Result<String, CoreError> {
        let parent = self.resolve_dir(dir)?;
        let file_name = self.diagram_file_name(name)?;
        let target = unique_child_path(&parent, &file_name);

        // 用 create_new 保证“存在就报错”，不会因为竞态覆盖别人的文件。
        File::create_new(&target).map_err(|e| CoreError::io(&target, e))?;

        self.rel_path(&target)
    }

    /// 在 `dir` 下新建文件夹。重名时自动加序号。
    pub fn create_folder(&self, dir: &str, name: &str) -> Result<String, CoreError> {
        let parent = self.resolve_dir(dir)?;
        let name = self.validate_entry_name(name)?;
        let target = unique_child_path(&parent, name);

        fs::create_dir(&target).map_err(|e| CoreError::io(&target, e))?;

        self.rel_path(&target)
    }

    /// 重命名。返回新的相对路径。
    ///
    /// 图文件会**保住 `.seq.json` 后缀**：传 `"新名字"` 或 `"新名字.seq.json"`
    /// 结果都是 `新名字.seq.json`。这样重命名不会让文件从目录树里消失。
    /// 目标已存在时直接报错（用户明确输入了名字，不该悄悄改成别的）。
    pub fn rename_entry(&self, rel: &str, new_name: &str) -> Result<String, CoreError> {
        let src = self.resolve(rel)?;
        self.ensure_exists(&src, rel)?;
        if src == self.root {
            return Err(CoreError::Denied {
                reason: "不能重命名工作区根目录".to_string(),
            });
        }

        let is_dir = src.is_dir();
        let final_name = if is_dir {
            self.validate_entry_name(new_name)?.to_string()
        } else {
            self.diagram_file_name(new_name)?
        };

        let parent = src.parent().ok_or_else(|| CoreError::Denied {
            reason: "无法确定父目录".to_string(),
        })?;
        let target = parent.join(&final_name);

        if target == src {
            return self.rel_path(&src);
        }
        if target.symlink_metadata().is_ok() {
            return Err(CoreError::AlreadyExists {
                path: self.rel_path(&target).unwrap_or(final_name),
            });
        }

        // 大小写不敏感的文件系统（macOS / Windows）上 `a.seq.json` → `A.seq.json`
        // 会被认为目标已存在，上面的检查已经处理了这种自改名场景。
        fs::rename(&src, &target).map_err(|e| CoreError::io(&src, e))?;

        self.rel_path(&target)
    }

    /// 删除文件或目录（目录递归删除）。
    pub fn delete_entry(&self, rel: &str) -> Result<(), CoreError> {
        let path = self.resolve(rel)?;
        self.ensure_exists(&path, rel)?;

        if path == self.root {
            return Err(CoreError::Denied {
                reason: "不能删除工作区根目录".to_string(),
            });
        }

        let meta = path.symlink_metadata().map_err(|e| CoreError::io(&path, e))?;
        if meta.is_dir() {
            fs::remove_dir_all(&path).map_err(|e| CoreError::io(&path, e))
        } else {
            fs::remove_file(&path).map_err(|e| CoreError::io(&path, e))
        }
    }

    /// 把 `rel` 移动到目录 `new_dir` 下。返回新的相对路径。
    pub fn move_entry(&self, rel: &str, new_dir: &str) -> Result<String, CoreError> {
        let src = self.resolve(rel)?;
        self.ensure_exists(&src, rel)?;
        let dst_dir = self.resolve_dir(new_dir)?;

        if src == self.root {
            return Err(CoreError::Denied {
                reason: "不能移动工作区根目录".to_string(),
            });
        }

        // 已经在该目录下了，什么都不用做。
        if src.parent() == Some(dst_dir.as_path()) {
            return self.rel_path(&src);
        }

        // 目录不能塞进自己的子孙里，否则会把自己递归搬走。
        if src.is_dir() && dst_dir.starts_with(&src) {
            return Err(CoreError::Denied {
                reason: "不能把目录移动到它自己的子目录里".to_string(),
            });
        }

        let file_name = src
            .file_name()
            .ok_or_else(|| CoreError::Denied {
                reason: "无法确定文件名".to_string(),
            })?
            .to_string_lossy()
            .into_owned();

        let target = unique_child_path(&dst_dir, &file_name);

        fs::rename(&src, &target).map_err(|e| CoreError::io(&src, e))?;

        self.rel_path(&target)
    }

    // ---------------------------------------------------------------- 内部工具

    /// 解析一个必须已经存在、且必须是目录的路径。
    fn resolve_dir(&self, rel: &str) -> Result<PathBuf, CoreError> {
        let path = self.resolve(rel)?;
        let meta = path
            .symlink_metadata()
            .map_err(|_| CoreError::NotFound {
                path: if rel.is_empty() {
                    ".".to_string()
                } else {
                    rel.to_string()
                },
            })?;
        if !meta.is_dir() {
            return Err(CoreError::WrongKind {
                path: rel.to_string(),
                reason: "不是一个目录",
            });
        }
        Ok(path)
    }

    fn ensure_exists(&self, abs: &Path, rel: &str) -> Result<(), CoreError> {
        if abs.symlink_metadata().is_err() {
            return Err(CoreError::NotFound {
                path: rel.to_string(),
            });
        }
        Ok(())
    }

    fn ensure_file(&self, abs: &Path) -> Result<(), CoreError> {
        let meta = abs.symlink_metadata().map_err(|e| CoreError::io(abs, e))?;
        if meta.is_dir() {
            return Err(CoreError::WrongKind {
                path: self.rel_path(abs).unwrap_or_else(|_| abs.display().to_string()),
                reason: "是一个目录",
            });
        }
        Ok(())
    }

    /// 写入前确认父目录存在且是目录。
    fn ensure_parent_dir(&self, abs: &Path, rel: &str) -> Result<(), CoreError> {
        let parent = abs.parent().ok_or_else(|| CoreError::WrongKind {
            path: rel.to_string(),
            reason: "无法确定父目录",
        })?;
        let meta = parent.symlink_metadata().map_err(|_| CoreError::NotFound {
            path: rel.to_string(),
        })?;
        if !meta.is_dir() {
            return Err(CoreError::WrongKind {
                path: rel.to_string(),
                reason: "父路径不是一个目录",
            });
        }
        Ok(())
    }

    /// 用户输入的图名 → 合法的 `.seq.json` 文件名。
    fn diagram_file_name(&self, name: &str) -> Result<String, CoreError> {
        let trimmed = name.trim();
        // 允许前端直接传已经带后缀的名字。
        let stem = trimmed.strip_suffix(DIAGRAM_EXT).unwrap_or(trimmed);
        let stem = self.validate_entry_name(stem)?;
        Ok(format!("{stem}{DIAGRAM_EXT}"))
    }
}

// -------------------------------------------------------------------- 自由函数

/// 长得像绝对路径就拒掉。
///
/// 不能只用 `Path::is_absolute()`：在 Linux 上 `C:\Windows\x` 和 `\\server\share`
/// 都会被判为相对路径，可这些路径在 Windows 上是绝对的。
fn is_absolute_like(rel: &str) -> bool {
    rel.starts_with('/') || rel.starts_with('\\') || is_drive_prefix(rel)
}

/// `C:` / `c:` 形式的盘符前缀（含盘符相对路径 `C:foo`）。
fn is_drive_prefix(s: &str) -> bool {
    let mut chars = s.chars();
    match (chars.next(), chars.next()) {
        (Some(c), Some(':')) => c.is_ascii_alphabetic(),
        _ => false,
    }
}

/// 目标不存在时，找一个不冲突的名字：`a.seq.json` → `a (2).seq.json` → …
fn unique_child_path(dir: &Path, file_name: &str) -> PathBuf {
    let first = dir.join(file_name);
    // 用 symlink_metadata 而不是 exists()：悬空符号链接也占着这个名字。
    if first.symlink_metadata().is_err() {
        return first;
    }

    let (stem, ext) = split_extension(file_name);

    for n in 2..=999 {
        let candidate = dir.join(format!("{stem} ({n}){ext}"));
        if candidate.symlink_metadata().is_err() {
            return candidate;
        }
    }

    // 极端情况下（999 个同名文件）退化成时间戳，保证一定拿到唯一名字。
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    dir.join(format!("{stem} ({nanos}){ext}"))
}

/// 拆出「主名 + 扩展名」。`.seq.json` 这种双段后缀会在第一个点处切开，
/// 不影响唯一性——反正只是用来拼 `(2)` 的位置。
fn split_extension(file_name: &str) -> (&str, &str) {
    if file_name.ends_with(DIAGRAM_EXT) {
        let stem = &file_name[..file_name.len() - DIAGRAM_EXT.len()];
        return (stem, DIAGRAM_EXT);
    }
    match file_name.rfind('.') {
        // 开头的点是隐藏文件的标记，不是扩展名（`.gitignore`）。
        Some(i) if i > 0 => (&file_name[..i], &file_name[i..]),
        _ => (file_name, ""),
    }
}

/// 临时文件计数器，配合 pid + 纳秒保证同一进程内的唯一性。
static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// 原子写：临时文件 → fsync → rename。
pub(crate) fn atomic_write(path: &Path, data: &[u8]) -> Result<(), CoreError> {
    let dir = path.parent().ok_or_else(|| CoreError::Denied {
        reason: "无效的目标路径".to_string(),
    })?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "out".to_string());

    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seq = TMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    // 以 `.` 开头 + 不是 .seq.json 结尾 → 永远不会出现在目录树里。
    let tmp = dir.join(format!(
        ".{name}.tmp-{}-{nanos}-{seq}",
        std::process::id()
    ));

    let result = (|| -> io::Result<()> {
        let mut file = File::create(&tmp)?;
        file.write_all(data)?;
        file.sync_all()?;
        Ok(())
    })();

    if let Err(e) = result {
        let _ = fs::remove_file(&tmp);
        return Err(CoreError::io(path, e));
    }

    // 同目录内 rename 在 POSIX 上是原子的；Windows 上 Rust 走
    // MoveFileEx(MOVEFILE_REPLACE_EXISTING)，同样是替换而非先删后建。
    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(CoreError::io(path, e));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_extension_handles_diagram_suffix() {
        assert_eq!(split_extension("a.seq.json"), ("a", ".seq.json"));
        assert_eq!(split_extension("a.b.seq.json"), ("a.b", ".seq.json"));
        assert_eq!(split_extension("a.png"), ("a", ".png"));
        assert_eq!(split_extension("noext"), ("noext", ""));
        assert_eq!(split_extension(".gitignore"), (".gitignore", ""));
    }

    #[test]
    fn drive_prefix_detection() {
        assert!(is_drive_prefix("C:"));
        assert!(is_drive_prefix("c:foo"));
        assert!(!is_drive_prefix("foo"));
        assert!(!is_drive_prefix(":foo"));
        assert!(!is_drive_prefix("1:"));
    }

    #[test]
    fn absolute_like_detection() {
        assert!(is_absolute_like("/etc/passwd"));
        assert!(is_absolute_like("\\server\\share"));
        assert!(is_absolute_like("C:\\Windows"));
        assert!(!is_absolute_like("a/b"));
        assert!(!is_absolute_like(""));
    }
}
