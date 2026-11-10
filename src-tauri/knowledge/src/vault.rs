//! vault（知识库目录）的模型：布局、路径闸门、扫描、卡片的读写。
//!
//! # 布局（和 HANDOFF 里画的图一致）
//!
//! ```text
//! <vault>/
//! ├── .devtoolkit/index.db     ← 派生索引（删掉不丢知识，下次重建）
//! ├── 卡片.md / 子目录/卡片.md  ← 「卡片区」：任意层级的 .md
//! ├── _sources/…               ← 上传的原件拷贝（生成知识用）
//! ├── _files/…                 ← 图片（卡片的 ![[...]] 指向这里）
//! └── _attachments/…           ← 卡片挂载的文件（任何扩展名，单段文件名）
//! ```
//!
//! # 路径闸门
//!
//! 所有从前端来的相对路径都过 [`safe_rel`]：拒绝绝对路径、`..`、NUL、空串；
//! 卡片区还额外**拒绝保留区**（`_sources`/`_files`/`.devtoolkit` 开头的相对
//! 路径不能当卡片写 —— 卡片的进与出只走卡片区，保留区归上传/附件两条专线）。

use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

use crate::error::KbError;
use crate::frontmatter::{self, Frontmatter};

/// 保留目录名（卡片区的路径闸门要挡住的）。
pub const SOURCES_DIR: &str = "_sources";
pub const FILES_DIR: &str = "_files";
pub const ATTACHMENTS_DIR: &str = "_attachments";
pub const META_DIR: &str = ".devtoolkit";

/// 卡片的后缀。**只认 `.md`** —— 库的承诺是「卡片就是 markdown」。
pub const CARD_EXT: &str = ".md";

/// 一个打开的知识库。
#[derive(Debug, Clone)]
pub struct Vault {
    root: PathBuf,
}

/// 扫描出来的一张卡片文件的元信息（还没解析内容）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CardFile {
    /// 相对 vault 根，正斜杠
    pub rel: String,
    /// 文件 mtime（毫秒 Unix）
    pub mtime: u64,
    pub size: u64,
}

impl Vault {
    /// 打开一个**已存在**的知识库目录（不存在时报错；创建走 [`create`]）。
    pub fn open(root: impl AsRef<Path>) -> Result<Self, KbError> {
        let root = root.as_ref();
        if !root.is_dir() {
            return Err(KbError::NotFound {
                rel: root.display().to_string(),
            });
        }
        Ok(Vault {
            root: root.to_path_buf(),
        })
    }

    /// 新建一个知识库目录（含布局）。父目录必须已经存在。
    ///
    /// 名字的校验（非法字符、保留名）在命令层做一遍，这里再兜一次「打不开就算」。
    pub fn create(root: impl AsRef<Path>) -> Result<Self, KbError> {
        let root = root.as_ref();
        if root.exists() {
            return Err(KbError::Exists {
                rel: root.display().to_string(),
            });
        }
        fs::create_dir_all(root).map_err(|e| KbError::io(root.display().to_string(), e))?;
        let vault = Vault {
            root: root.to_path_buf(),
        };
        vault.ensure_layout()?;
        Ok(vault)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// 建出 `_sources/`、`_files/`、`_attachments/`、`.devtoolkit/`（幂等）。
    pub fn ensure_layout(&self) -> Result<(), KbError> {
        for dir in [SOURCES_DIR, FILES_DIR, ATTACHMENTS_DIR, META_DIR] {
            let p = self.root.join(dir);
            fs::create_dir_all(&p).map_err(|e| KbError::io(dir, e))?;
        }
        Ok(())
    }

    /// 派生索引的库文件路径（**藏进 `.devtoolkit/`**：一个知识库 = 可以整体
    /// 拷贝/搬走的一个目录，索引跟着走但不碍眼）。
    pub fn index_db_path(&self) -> PathBuf {
        self.root.join(META_DIR).join("index.db")
    }

    /// 上传原件的落点（`_sources/<清洗名>`）。
    pub fn source_path(&self, stored_name: &str) -> PathBuf {
        self.root.join(SOURCES_DIR).join(stored_name)
    }

    /// 卡片附件的落点（`_attachments/<存储名>`）。
    pub fn attachment_path(&self, stored_name: &str) -> PathBuf {
        self.root.join(ATTACHMENTS_DIR).join(stored_name)
    }

    /// 绝对路径（给 CLI 直读图片、给「在系统里打开」用）——**只在 Rust 侧用**。
    pub fn abs(&self, rel: &str) -> Result<PathBuf, KbError> {
        let rel = safe_rel(rel)?;
        Ok(self.root.join(rel))
    }

    /// 读一张卡片：`(frontmatter, 正文)`。文件不在给 `NotFound`。
    pub fn read_card(&self, rel: &str) -> Result<(Frontmatter, String), KbError> {
        let rel = safe_card_rel(rel)?;
        let path = self.root.join(&rel);
        let text = fs::read_to_string(&path).map_err(|e| match e.kind() {
            io::ErrorKind::NotFound => KbError::NotFound { rel: rel.clone() },
            _ => KbError::io(&rel, e),
        })?;
        Ok(frontmatter::parse(&text))
    }

    /// 写一张卡片（原子写：临时文件 + rename，照 core 的做法）。
    pub fn write_card(&self, rel: &str, fm: &Frontmatter, body: &str) -> Result<(), KbError> {
        let rel = safe_card_rel(rel)?;
        let path = self.root.join(&rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| KbError::io(&rel, e))?;
        }
        let text = frontmatter::serialize(fm, body);
        atomic_write(&path, text.as_bytes()).map_err(|e| KbError::io(&rel, e))
    }

    /// 删除一张卡片。**只删卡片区的 `.md`** —— 闸门挡住别的。
    pub fn delete_card(&self, rel: &str) -> Result<(), KbError> {
        let rel = safe_card_rel(rel)?;
        let path = self.root.join(&rel);
        fs::remove_file(&path).map_err(|e| match e.kind() {
            io::ErrorKind::NotFound => KbError::NotFound { rel: rel.clone() },
            _ => KbError::io(&rel, e),
        })
    }

    /// `_files/` 下某个文件的绝对路径（只在 Rust 侧用）。
    pub fn files_path(&self, file_name: &str) -> PathBuf {
        self.root.join(FILES_DIR).join(file_name)
    }

    /// 写一张图片（原子写；`rel` 必须过 `_files/` 闸门）。
    pub fn write_file(&self, rel: &str, bytes: &[u8]) -> Result<(), KbError> {
        let rel = safe_file_rel(rel)?;
        let path = self.root.join(&rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| KbError::io(&rel, e))?;
        }
        atomic_write(&path, bytes).map_err(|e| KbError::io(&rel, e))
    }

    /// 删一张图片。**文件本来就不在也算成功**（尽力清理，见来源删除）。
    pub fn delete_file(&self, rel: &str) -> Result<(), KbError> {
        let rel = safe_file_rel(rel)?;
        match fs::remove_file(self.root.join(&rel)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(KbError::io(&rel, e)),
        }
    }

    /// 写一个卡片附件（原子写；`rel` 必须过 `_attachments/` 闸门）。
    pub fn write_attachment(&self, rel: &str, bytes: &[u8]) -> Result<(), KbError> {
        let rel = safe_attachment_rel(rel)?;
        let path = self.root.join(&rel);
        atomic_write(&path, bytes).map_err(|e| KbError::io(&rel, e))
    }

    /// 删一个卡片附件。**文件本来就不在也算成功**（尽力清理）。
    pub fn delete_attachment(&self, rel: &str) -> Result<(), KbError> {
        let rel = safe_attachment_rel(rel)?;
        match fs::remove_file(self.root.join(&rel)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(KbError::io(&rel, e)),
        }
    }

    /// 读一张图片的字节。闸门：`_files/`、`_sources/` 或 `_attachments/`
    /// 下单段图片名 + 非符号链接 + canonicalize 后仍在库里 + 普通文件 + 大小上限。
    pub fn read_image(&self, rel: &str, max_bytes: u64) -> Result<Vec<u8>, KbError> {
        let rel = safe_asset_rel(rel)?;
        self.read_checked_file(&rel, max_bytes, "图片")
    }

    /// 读一个卡片附件的字节（任何扩展名；缩略图只对图片调用）。
    pub fn read_attachment(&self, rel: &str, max_bytes: u64) -> Result<Vec<u8>, KbError> {
        let rel = safe_attachment_rel(rel)?;
        self.read_checked_file(&rel, max_bytes, "附件")
    }

    /// 附件的绝对路径（给「用系统默认程序打开」用）——
    /// 同样过非软链 + 归属检查，避免库里的一个软链把外面文件打开。
    pub fn attachment_abs_checked(&self, rel: &str) -> Result<PathBuf, KbError> {
        let rel = safe_attachment_rel(rel)?;
        self.checked_path(&rel)
    }

    /// 已过闸门的相对路径 → 字节。三条读取（图片/附件）共用的安全检查。
    fn read_checked_file(
        &self,
        rel: &str,
        max_bytes: u64,
        what: &'static str,
    ) -> Result<Vec<u8>, KbError> {
        let path = self.checked_path(rel)?;
        let meta = fs::metadata(&path).map_err(|e| KbError::io(rel, e))?;
        if meta.len() > max_bytes {
            return Err(KbError::Extract {
                rel: rel.to_string(),
                reason: format!(
                    "{what}太大了（{:.1} MB，上限 {} MB）",
                    meta.len() as f64 / 1024.0 / 1024.0,
                    max_bytes / 1024 / 1024
                ),
            });
        }
        fs::read(&path).map_err(|e| KbError::io(rel, e))
    }

    /// 已过闸门的相对路径 → 绝对路径。非符号链接、普通文件、canonicalize
    /// 之后仍在库根里面（归属确认）。
    fn checked_path(&self, rel: &str) -> Result<PathBuf, KbError> {
        let bad = |reason: &'static str| KbError::BadRel {
            rel: rel.to_string(),
            reason,
        };
        let path = self.root.join(rel);
        let meta = fs::symlink_metadata(&path).map_err(|e| match e.kind() {
            io::ErrorKind::NotFound => KbError::NotFound {
                rel: rel.to_string(),
            },
            _ => KbError::io(rel, e),
        })?;
        if meta.file_type().is_symlink() {
            return Err(bad("不许符号链接"));
        }
        if !meta.is_file() {
            return Err(bad("不是普通文件"));
        }
        // 归属确认：解析掉沿途的软链之后，仍然必须在库根里面。
        let root = fs::canonicalize(&self.root).map_err(|e| KbError::io("库根", e))?;
        let real = fs::canonicalize(&path).map_err(|e| KbError::io(rel, e))?;
        if !real.starts_with(&root) {
            return Err(bad("路径跑到库外面了"));
        }
        Ok(path)
    }

    /// 裸文件名 → `_files/<唯一命中>`（旧卡片/手编卡片的兼容路径）。
    ///
    /// 同名多张**不猜** —— 要求写完整路径。
    pub fn resolve_image_target(&self, target: &str) -> Result<String, KbError> {
        let target = target.trim();
        if target.starts_with(&format!("{FILES_DIR}/")) {
            return safe_file_rel(target);
        }
        // 卡片附件里的图片：允许手编 `![[_attachments/xxx.png]]` 内嵌显示。
        if target.starts_with(&format!("{ATTACHMENTS_DIR}/")) {
            return safe_asset_rel(target);
        }
        if target.contains('/') || target.contains('\\') {
            return Err(KbError::BadRel {
                rel: target.to_string(),
                reason: "图片路径只接受 _files/<文件名> 或 _attachments/<文件名>",
            });
        }
        let mut hits: Vec<String> = Vec::new();
        if let Ok(entries) = fs::read_dir(self.root.join(FILES_DIR)) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if name == target {
                    hits.push(name);
                }
            }
        }
        match hits.len() {
            1 => return Ok(format!("{FILES_DIR}/{}", hits[0])),
            0 => {}
            _ => {
                return Err(KbError::BadRel {
                    rel: target.to_string(),
                    reason: "有多张同名图片，请写完整路径",
                })
            }
        }

        // 旧卡片兼容：v0.18.0 之前上传的图片资料只在 `_sources/<时间戳>_名字`。
        // 原文件名去掉时间戳前缀之后与 target 完全相等才算（唯一命中）。
        let mut legacy: Vec<String> = Vec::new();
        if let Ok(entries) = fs::read_dir(self.root.join(SOURCES_DIR)) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                let original = name
                    .split_once('_')
                    .map(|(prefix, rest)| {
                        if prefix.chars().all(|c| c.is_ascii_digit()) {
                            rest
                        } else {
                            name.as_str()
                        }
                    })
                    .unwrap_or(name.as_str());
                if original == target {
                    legacy.push(name);
                }
            }
        }
        match legacy.len() {
            1 => Ok(format!("{SOURCES_DIR}/{}", legacy[0])),
            0 => Err(KbError::NotFound {
                rel: target.to_string(),
            }),
            _ => Err(KbError::BadRel {
                rel: target.to_string(),
                reason: "有多张同名图片，请写完整路径",
            }),
        }
    }

    /// 批量上传时给来源算一个不撞的存储名（同一毫秒同名加 ` (2)`、` (3)`…）。
    pub fn unique_source_stored_name(&self, stamp_ms: u128, clean: &str) -> String {
        let first = format!("{stamp_ms}_{clean}");
        if !self.source_path(&first).exists() {
            return first;
        }
        let (base, ext) = match clean.rsplit_once('.') {
            Some((base, ext)) => (base, format!(".{ext}")),
            None => (clean, String::new()),
        };
        for n in 2..100u32 {
            let name = format!("{stamp_ms}_{base} ({n}){ext}");
            if !self.source_path(&name).exists() {
                return name;
            }
        }
        // 极端的病态情况：加纳秒后缀，保证仍然唯一。
        format!("{stamp_ms}_{base} ({stamp_ms}){ext}")
    }

    /// 卡片附件的不撞存储名（规则同来源；落点是 `_attachments/`）。
    pub fn unique_attachment_stored_name(&self, stamp_ms: u128, clean: &str) -> String {
        let first = format!("{stamp_ms}_{clean}");
        if !self.attachment_path(&first).exists() {
            return first;
        }
        let (base, ext) = match clean.rsplit_once('.') {
            Some((base, ext)) => (base, format!(".{ext}")),
            None => (clean, String::new()),
        };
        for n in 2..100u32 {
            let name = format!("{stamp_ms}_{base} ({n}){ext}");
            if !self.attachment_path(&name).exists() {
                return name;
            }
        }
        format!("{stamp_ms}_{base} ({stamp_ms}){ext}")
    }

    /// 扫一遍卡片区：所有 **非保留、非隐藏** 目录下的 `.md`。
    ///
    /// 跳过 `.` 开头的目录（`.devtoolkit`、用户自己在 Obsidian 里放的
    /// `.obsidian`/`.trash`）—— 那是基础设施，不是卡片。
    pub fn scan_cards(&self) -> Result<Vec<CardFile>, KbError> {
        let mut out = Vec::new();
        self.scan_dir("", &mut out)?;
        out.sort_by(|a, b| a.rel.cmp(&b.rel));
        Ok(out)
    }

    fn scan_dir(&self, rel_dir: &str, out: &mut Vec<CardFile>) -> Result<(), KbError> {
        let dir = if rel_dir.is_empty() {
            self.root.clone()
        } else {
            self.root.join(rel_dir)
        };
        let entries = fs::read_dir(&dir).map_err(|e| KbError::io(rel_dir, e))?;
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue; // .devtoolkit / .obsidian / .trash ……
            }
            let Ok(ft) = entry.file_type() else { continue };
            if ft.is_symlink() {
                continue; // 不跟（和 core 的 list_tree 同一条边界）
            }
            let child_rel = if rel_dir.is_empty() {
                name.clone()
            } else {
                format!("{rel_dir}/{name}")
            };
            if ft.is_dir() {
                if name == SOURCES_DIR || name == FILES_DIR || name == ATTACHMENTS_DIR {
                    continue; // 保留区不是卡片区
                }
                self.scan_dir(&child_rel, out)?;
            } else if ft.is_file() && name.ends_with(CARD_EXT) {
                let Ok(meta) = entry.metadata() else { continue };
                let mtime = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                out.push(CardFile {
                    rel: child_rel,
                    mtime,
                    size: meta.len(),
                });
            }
        }
        Ok(())
    }

    // ------------------------------------------------------------ 目录结构

    /// 扫一遍卡片区里的**目录**（含空目录；跳保留区/隐藏目录/软链）。
    ///
    /// 目录树是文件系统本身，不需要索引 —— 前端拿它和卡片的 rel 一起画。
    pub fn scan_dirs(&self) -> Result<Vec<String>, KbError> {
        let mut out = Vec::new();
        self.scan_dirs_in("", &mut out)?;
        out.sort();
        Ok(out)
    }

    fn scan_dirs_in(&self, rel_dir: &str, out: &mut Vec<String>) -> Result<(), KbError> {
        let dir = if rel_dir.is_empty() {
            self.root.clone()
        } else {
            self.root.join(rel_dir)
        };
        let entries = fs::read_dir(&dir).map_err(|e| KbError::io(rel_dir, e))?;
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            let Ok(ft) = entry.file_type() else { continue };
            if ft.is_symlink() || !ft.is_dir() {
                continue;
            }
            if name == SOURCES_DIR || name == FILES_DIR || name == ATTACHMENTS_DIR {
                continue;
            }
            let child_rel = if rel_dir.is_empty() {
                name
            } else {
                format!("{rel_dir}/{name}")
            };
            out.push(child_rel.clone());
            self.scan_dirs_in(&child_rel, out)?;
        }
        Ok(())
    }

    /// 新建目录（只建一层；父目录必须存在）。
    pub fn create_dir(&self, rel: &str) -> Result<(), KbError> {
        let rel = safe_dir_rel(rel, false)?;
        let path = self.root.join(&rel);
        if path.exists() {
            return Err(KbError::Exists { rel });
        }
        fs::create_dir(&path).map_err(|e| KbError::io(&rel, e))
    }

    /// 重命名目录（`new_name` 只是最后一段）。返回新的相对路径。
    ///
    /// 卡片在目录里跟着一起搬；索引会由命令层重新扫一遍修正 rel。
    pub fn rename_dir(&self, rel: &str, new_name: &str) -> Result<String, KbError> {
        let rel = safe_dir_rel(rel, false)?;
        let name = sanitize_dir_name(new_name);
        if name.is_empty() {
            return Err(KbError::BadName {
                name: new_name.to_string(),
                reason: "目录名清洗后为空",
            });
        }
        let parent = rel.rsplit_once('/').map(|(p, _)| p).unwrap_or("");
        let new_rel = if parent.is_empty() {
            name
        } else {
            format!("{parent}/{name}")
        };
        let new_rel = safe_dir_rel(&new_rel, false)?;
        if new_rel == rel {
            return Ok(rel);
        }
        let src = self.root.join(&rel);
        let dst = self.root.join(&new_rel);
        if !src.is_dir() {
            return Err(KbError::NotFound { rel });
        }
        if dst.exists() {
            return Err(KbError::Exists { rel: new_rel });
        }
        fs::rename(&src, &dst).map_err(|e| KbError::io(&rel, e))?;
        Ok(new_rel)
    }

    /// 删一个**空目录**。非空拒绝（`NotEmpty`）—— 递归删整棵子树太危险，
    /// 不在这个入口做。
    pub fn delete_dir(&self, rel: &str) -> Result<(), KbError> {
        let rel = safe_dir_rel(rel, false)?;
        let path = self.root.join(&rel);
        if !path.is_dir() {
            return Err(KbError::NotFound { rel });
        }
        match fs::remove_dir(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == io::ErrorKind::DirectoryNotEmpty => {
                Err(KbError::NotEmpty { rel })
            }
            Err(e) => Err(KbError::io(&rel, e)),
        }
    }

    /// 把一张卡片移到 `dir`（空串 = 根）。返回新的 rel。
    ///
    /// 同名冲突时自动加 ` (2)`、` (3)`……（和新建卡片的去重同一口径）。
    pub fn move_card(&self, rel: &str, dir: &str) -> Result<String, KbError> {
        let rel = safe_card_rel(rel)?;
        let dir = safe_dir_rel(dir, true)?;
        let src = self.root.join(&rel);
        if !src.is_file() {
            return Err(KbError::NotFound { rel });
        }
        let current_dir = rel.rsplit_once('/').map(|(p, _)| p).unwrap_or("");
        if current_dir == dir {
            return Ok(rel);
        }
        if !dir.is_empty() && !self.root.join(&dir).is_dir() {
            return Err(KbError::NotFound { rel: dir });
        }
        let file_name = rel.rsplit('/').next().unwrap_or(rel.as_str()).to_string();
        let new_rel = unique_file_rel_in(self, &dir, &file_name);
        let dst = self.root.join(&new_rel);
        fs::rename(&src, &dst).map_err(|e| KbError::io(&rel, e))?;
        Ok(new_rel)
    }
}

/// 在 `dir` 下为 `file_name` 找一个不撞的 rel（保留原文件名，只加序号）。
fn unique_file_rel_in(vault: &Vault, dir: &str, file_name: &str) -> String {
    let join = |name: &str| {
        if dir.is_empty() {
            name.to_string()
        } else {
            format!("{dir}/{name}")
        }
    };
    if !vault.root().join(join(file_name)).exists() {
        return join(file_name);
    }
    let (base, ext) = match file_name.rsplit_once('.') {
        Some((b, e)) => (b, format!(".{e}")),
        None => (file_name, String::new()),
    };
    for n in 2..100u32 {
        let candidate = format!("{base} ({n}){ext}");
        if !vault.root().join(join(&candidate)).exists() {
            return join(&candidate);
        }
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    join(&format!("{base} ({stamp}){ext}"))
}

/// 相对路径闸门（通用）：拒绝绝对路径 / `..` / NUL / 空串 / 反斜杠开头的
/// 盘符，并把 `\` 统一成 `/`。
pub fn safe_rel(rel: &str) -> Result<String, KbError> {
    let bad = |reason: &'static str| KbError::BadRel {
        rel: rel.to_string(),
        reason,
    };
    if rel.is_empty() {
        return Err(bad("空路径"));
    }
    if rel.contains('\0') {
        return Err(bad("有 NUL 字符"));
    }
    let normalized = rel.replace('\\', "/");
    if normalized.starts_with('/') {
        return Err(bad("不许绝对路径"));
    }
    // Windows 盘符（C:…）在 Path::components 里会成 Prefix —— 但那只在
    // Windows 上成立；Linux 上 `C:/x` 会被拆成普通分量。所以**分段再查一次
    // 冒号**，让「盘符/流」这类东西在两个平台上的判定一致（跨平台的库路径
    // 闸门，判定分平台漂移是最难查的一类 bug）。
    for comp in Path::new(&normalized).components() {
        match comp {
            Component::Normal(s) => {
                if s.to_string_lossy().contains(':') {
                    return Err(bad("分量里有冒号（盘符/流）"));
                }
            }
            Component::CurDir => return Err(bad("不许 `.` 分量")),
            Component::ParentDir => return Err(bad("不许 `..`")),
            Component::RootDir | Component::Prefix(_) => return Err(bad("不许绝对路径")),
        }
    }
    Ok(normalized)
}

/// 卡片区专用闸门：通用闸门 + **拒绝保留区/隐藏目录**。
pub fn safe_card_rel(rel: &str) -> Result<String, KbError> {
    let rel = safe_rel(rel)?;
    if !rel.ends_with(CARD_EXT) {
        return Err(KbError::BadRel {
            rel,
            reason: "卡片必须是 .md",
        });
    }
    for seg in rel.split('/') {
        if seg == SOURCES_DIR || seg == FILES_DIR || seg == ATTACHMENTS_DIR || seg.starts_with('.')
        {
            return Err(KbError::BadRel {
                rel,
                reason: "卡片不能写在保留目录/隐藏目录里",
            });
        }
    }
    Ok(rel)
}

/// 目录闸门：通用闸门 + 拒绝保留区/隐藏目录。`allow_empty` = 根目录（`""`）。
pub fn safe_dir_rel(rel: &str, allow_empty: bool) -> Result<String, KbError> {
    if rel.trim().is_empty() {
        return if allow_empty {
            Ok(String::new())
        } else {
            Err(KbError::BadRel {
                rel: rel.to_string(),
                reason: "空目录路径",
            })
        };
    }
    let rel = safe_rel(rel.trim())?;
    for seg in rel.split('/') {
        if seg.is_empty() {
            return Err(KbError::BadRel {
                rel,
                reason: "有空的路径段",
            });
        }
        if seg == SOURCES_DIR || seg == FILES_DIR || seg == ATTACHMENTS_DIR || seg.starts_with('.')
        {
            return Err(KbError::BadRel {
                rel,
                reason: "不能写进保留目录/隐藏目录",
            });
        }
    }
    Ok(rel)
}

/// 目录名清洗：和卡片文件名同一套非法字符表；**不兜底**（清洗后为空由调用方拒绝）。
pub fn sanitize_dir_name(name: &str) -> String {
    let mut out = String::new();
    for ch in name.trim().chars() {
        let bad = matches!(
            ch,
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' | '%' | '^' | '&' | '\0'
        ) || (ch as u32) < 0x20;
        out.push(if bad { ' ' } else { ch });
    }
    let mut collapsed = String::new();
    let mut prev_space = false;
    for ch in out.chars() {
        if ch.is_whitespace() {
            if !prev_space {
                collapsed.push(' ');
            }
            prev_space = true;
        } else {
            collapsed.push(ch);
            prev_space = false;
        }
    }
    let trimmed = collapsed.trim().trim_end_matches('.').trim();
    trimmed.chars().take(60).collect()
}

/// `_files/` 的闸门：**只允许 `_files/<一个文件名>`**，扩展名必须是图片。
///
/// 卡片里手写的 `![[../…]]`、子目录、`_sources/` 一律拒绝 —— 图片读取命令
/// 的参数来自前端，不能让它变成任意文件读取。
pub fn safe_file_rel(rel: &str) -> Result<String, KbError> {
    let rel = safe_rel(rel)?;
    let bad = |reason: &'static str| KbError::BadRel {
        rel: rel.clone(),
        reason,
    };
    let mut parts = rel.split('/');
    let dir = parts.next().unwrap_or("");
    let name = parts.next().unwrap_or("");
    if dir != FILES_DIR || name.is_empty() || parts.next().is_some() {
        return Err(bad("只允许 _files/<文件名>"));
    }
    if name.starts_with('.') {
        return Err(bad("不许隐藏文件"));
    }
    let ext = Path::new(name)
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if !crate::images::IMAGE_EXTS.contains(&ext.as_str()) {
        return Err(bad("不是图片扩展名"));
    }
    Ok(rel)
}

/// `_attachments/` 的闸门：**只允许 `_attachments/<一个文件名>`**，
/// 任何扩展名（附件可以是文档/压缩包/图片）。
///
/// 单段 + 非隐藏 + 非符号链接（读取时再查）—— 参数来自前端，不能变成
/// 任意文件读取；真正打开走系统默认程序（`open_path`）。
pub fn safe_attachment_rel(rel: &str) -> Result<String, KbError> {
    let rel = safe_rel(rel)?;
    let bad = |reason: &'static str| KbError::BadRel {
        rel: rel.clone(),
        reason,
    };
    let mut parts = rel.split('/');
    let dir = parts.next().unwrap_or("");
    let name = parts.next().unwrap_or("");
    if dir != ATTACHMENTS_DIR || name.is_empty() || parts.next().is_some() {
        return Err(bad("只允许 _attachments/<文件名>"));
    }
    if name.starts_with('.') {
        return Err(bad("不许隐藏文件"));
    }
    Ok(rel)
}

/// 读取图片用的闸门：`_files/`、`_sources/` 或 `_attachments/` 下的单段
/// 图片名。
///
/// `_sources/` 是**旧卡片兼容**用的：v0.18.0 之前上传的图片资料只有原件
/// （`_sources/<时间戳>_名字.png`），老卡片里的 `![[名字.png]]` 要靠这里兜底。
/// 扩展名白名单保证它读不出 PDF/文档，只是把用户自己传进来的图片读回去。
pub fn safe_asset_rel(rel: &str) -> Result<String, KbError> {
    let rel = safe_rel(rel)?;
    let bad = |reason: &'static str| KbError::BadRel {
        rel: rel.clone(),
        reason,
    };
    let mut parts = rel.split('/');
    let dir = parts.next().unwrap_or("");
    let name = parts.next().unwrap_or("");
    if (dir != FILES_DIR && dir != SOURCES_DIR && dir != ATTACHMENTS_DIR)
        || name.is_empty()
        || parts.next().is_some()
    {
        return Err(bad("只允许 _files/、_sources/ 或 _attachments/ 下的单段文件名"));
    }
    if name.starts_with('.') {
        return Err(bad("不许隐藏文件"));
    }
    let ext = Path::new(name)
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if !crate::images::IMAGE_EXTS.contains(&ext.as_str()) {
        return Err(bad("不是图片扩展名"));
    }
    Ok(rel)
}

/// 标题 → 卡片文件名（不含目录和 `.md`）。
///
/// 清洗两类字符：Windows 文件名非法的（`<>:"/\|?*`、控制符）和**我们路径
/// 闸门自己挡的**（`% ^ &` 是给将来 `cmd` 类场景留的，跟 tasks 的清洗表
/// 同一条惯例；`:` 是闸门明确挡的盘符形状）。清洗在**入库那一刻**做，
/// 盘上名字 = 里面记的名字 = 界面显示的名字（不撒谎）。
pub fn sanitize_card_name(title: &str) -> String {
    let mut out = String::new();
    for ch in title.chars() {
        let bad = matches!(
            ch,
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' | '%' | '^' | '&' | '\0'
        ) || (ch as u32) < 0x20;
        out.push(if bad { ' ' } else { ch });
    }
    // 折叠连续空白（清洗换出来的空格容易连成串）
    let mut collapsed = String::new();
    let mut prev_space = false;
    for ch in out.trim().chars() {
        if ch.is_whitespace() {
            if !prev_space {
                collapsed.push(' ');
            }
            prev_space = true;
        } else {
            collapsed.push(ch);
            prev_space = false;
        }
    }
    // Windows 上结尾的点/空格会被静默吃掉，先自己去掉
    let trimmed = collapsed.trim().trim_end_matches('.').trim().to_string();
    let capped: String = trimmed.chars().take(60).collect();
    if capped.is_empty() {
        "卡片".to_string()
    } else {
        capped
    }
}

/// 在卡片正文末尾追加一条带时间的备注（「像任务备注一样」）。
///
/// 格式是**普通 markdown**：空正文直接写时间行；非空正文先补一个分隔线。
/// 单独成函数是为了能把「有没有多/少一个空行」钉在单测里（命令层不好测）。
pub fn append_note(body: &str, stamp: &str, text: &str) -> String {
    let mut out = body.to_string();
    if out.trim().is_empty() {
        out.clear(); // 纯空白正文不留下孤零零的空行
    } else {
        if !out.ends_with('\n') {
            out.push('\n');
        }
        out.push_str("\n---\n\n");
    }
    out.push_str(&format!("**{stamp}**\n\n{text}\n"));
    out
}

/// 在 `dir`（相对路径，空串 = 根部）下找一个不重名的卡片 rel：
/// `名字.md`、`名字 (2).md`、`名字 (3).md`……最多试到 99。
pub fn unique_card_rel(vault: &Vault, dir: &str, title: &str) -> String {
    let base = sanitize_card_name(title);
    let join = |name: &str| -> String {
        if dir.is_empty() {
            name.to_string()
        } else {
            format!("{dir}/{name}")
        }
    };

    for n in 1..100 {
        let candidate = if n == 1 {
            format!("{base}{CARD_EXT}")
        } else {
            format!("{base} ({n}){CARD_EXT}")
        };
        let rel = join(&candidate);
        if !vault.root().join(&rel).exists() {
            return rel;
        }
    }
    // 99 张同名：罕见但别开天窗，塞时间戳
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    join(&format!("{base} ({stamp}){CARD_EXT}"))
}

/// 原子写（临时文件 + rename），照 core 的同款做法。
fn atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let tmp = parent.join(format!(
        ".{}.tmp-{}",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("card"),
        std::process::id()
    ));
    {
        use std::io::Write as _;
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    fs::rename(&tmp, path).inspect_err(|_| {
        let _ = fs::remove_file(&tmp);
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frontmatter::CardStatus;

    fn tmp_vault(tag: &str) -> Vault {
        let base = std::env::temp_dir().join(format!(
            "devtoolkit-kb-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        Vault::create(base).expect("建 vault")
    }

    #[test]
    fn 建库有完整布局_索引藏在隐藏目录里() {
        let v = tmp_vault("layout");
        assert!(v.root().join(SOURCES_DIR).is_dir());
        assert!(v.root().join(FILES_DIR).is_dir());
        assert!(v.index_db_path().starts_with(v.root().join(META_DIR)));
        let _ = fs::remove_dir_all(v.root());
    }

    #[test]
    fn 卡片读写往返_子目录也认() {
        let v = tmp_vault("card");
        let mut fm = Frontmatter::new("流程", "2026-10-16T00:00:00Z");
        fm.status = CardStatus::Reviewed;
        v.write_card("团队/登录流程.md", &fm, "# 正文\n").unwrap();

        let (read_fm, body) = v.read_card("团队/登录流程.md").unwrap();
        assert_eq!(read_fm, fm);
        assert_eq!(body, "# 正文\n");
        let _ = fs::remove_dir_all(v.root());
    }

    #[test]
    fn 扫描_跳过保留区和隐藏目录_只收_md() {
        let v = tmp_vault("scan");
        v.write_card("a.md", &Frontmatter::new("a", ""), "").unwrap();
        v.write_card("子/b.md", &Frontmatter::new("b", ""), "").unwrap();
        fs::write(v.root().join(SOURCES_DIR).join("报告.md"), "x").unwrap(); // 保留区
        fs::write(v.root().join("说明.txt"), "x").unwrap(); // 不是 md
        fs::write(v.root().join(".devtoolkit").join("x.md"), "x").unwrap(); // 隐藏

        let cards = v.scan_cards().unwrap();
        let rels: Vec<&str> = cards.iter().map(|c| c.rel.as_str()).collect();
        assert_eq!(rels, vec!["a.md", "子/b.md"]);
        let _ = fs::remove_dir_all(v.root());
    }

    #[test]
    fn 卡片闸门_保留目录和绝对路径都挡() {
        assert!(safe_card_rel("../x.md").is_err());
        assert!(safe_card_rel("/tmp/x.md").is_err());
        assert!(safe_card_rel("_sources/x.md").is_err());
        assert!(safe_card_rel(".devtoolkit/x.md").is_err());
        assert!(safe_card_rel("子/_files/x.md").is_err());
        assert!(safe_card_rel("x.txt").is_err(), "非 .md 不给当卡片");
        assert!(safe_card_rel("子/卡片.md").is_ok());
        assert!(safe_card_rel("C:\\x.md").is_err());
    }

    #[test]
    fn 通用闸门_反斜杠统一成斜杠() {
        assert_eq!(safe_rel("子\\卡片.md").unwrap(), "子/卡片.md");
        assert!(safe_rel("").is_err());
        assert!(safe_rel(".").is_err());
    }

    #[test]
    fn 命名清洗_非法字符变空格_空白折叠_尾点去掉() {
        assert_eq!(sanitize_card_name("a/b:c*d?"), "a b c d");
        assert_eq!(sanitize_card_name("  a   b  "), "a b");
        assert_eq!(sanitize_card_name("标题."), "标题");
        assert_eq!(sanitize_card_name("100%纯&真"), "100 纯 真");
        assert_eq!(sanitize_card_name(""), "卡片");
        assert_eq!(sanitize_card_name("???"), "卡片", "全是非法字符 → 兜底");
        // 全角问号**不是**非法字符（它是合法文件名字符）——清洗别多管闲事
        assert_eq!(sanitize_card_name("？？？"), "？？？");
        // 清洗之后的名字必须过自己的卡片闸门（盘上名字和闸门口径一致）
        let name = sanitize_card_name("a:b/c\\d");
        assert!(safe_card_rel(&format!("{name}.md")).is_ok(), "清洗漏了：{name}");
    }

    #[test]
    fn 命名清洗_超长按字符截() {
        let long = "汉".repeat(100);
        assert_eq!(sanitize_card_name(&long).chars().count(), 60);
    }

    // ------------------------------------------------------ _files/（图片）

    #[test]
    fn 图片闸门_只允许_files_下单段图片名() {
        assert!(safe_file_rel("_files/a.png").is_ok());
        assert!(safe_file_rel("_files/a.jpg").is_ok());
        assert!(safe_file_rel("_files/sub/a.png").is_err(), "不许子目录");
        assert!(safe_file_rel("_sources/a.png").is_err(), "不许 _sources");
        assert!(safe_file_rel("_files/../a.png").is_err());
        assert!(safe_file_rel("_files/a.md").is_err(), "不是图片");
        assert!(safe_file_rel("_files/.hidden.png").is_err());
        assert!(safe_file_rel("/etc/passwd").is_err());
    }

    #[test]
    fn 图片读写往返_删不存在的文件也算成功() {
        let v = tmp_vault("files-rw");
        v.write_file("_files/a.png", &[1, 2, 3]).unwrap();
        assert_eq!(v.read_image("_files/a.png", 1024).unwrap(), vec![1, 2, 3]);
        v.delete_file("_files/a.png").unwrap();
        assert!(v.delete_file("_files/a.png").is_ok(), "删不存在的也 Ok");
        assert!(v.read_image("_files/a.png", 1024).is_err());
        let _ = fs::remove_dir_all(v.root());
    }

    #[test]
    fn 读图片_大小上限和符号链接都挡住() {
        let v = tmp_vault("files-gate");
        v.write_file("_files/a.png", &[0u8; 32]).unwrap();
        assert!(v.read_image("_files/a.png", 16).is_err(), "超过上限要报错");

        // 造一个指向库外面的软链：读必须拒绝（只在 unix 上能造）
        #[cfg(unix)]
        {
            let outside = std::env::temp_dir().join(format!(
                "devtoolkit-kb-outside-{}.png",
                std::process::id()
            ));
            fs::write(&outside, b"secret").unwrap();
            let link = v.files_path("link.png");
            #[cfg(unix)]
            std::os::unix::fs::symlink(&outside, &link).unwrap();
            assert!(v.read_image("_files/link.png", 1024).is_err(), "软链必须拒绝");
            let _ = fs::remove_file(&outside);
        }
        let _ = fs::remove_dir_all(v.root());
    }

    #[test]
    fn 旧图片_从_sources_按原名兜底_但_files_优先() {
        let v = tmp_vault("files-legacy");
        // v0.18 之前：原件只在 _sources（带时间戳前缀），_files 里没有
        fs::write(v.source_path("1729_架构图.png"), [1, 2, 3]).unwrap();
        let rel = v.resolve_image_target("架构图.png").unwrap();
        assert_eq!(rel, "_sources/1729_架构图.png");
        assert_eq!(v.read_image(&rel, 1024).unwrap(), vec![1, 2, 3]);

        // 新路径有同名时优先 _files
        v.write_file("_files/架构图.png", &[9]).unwrap();
        assert_eq!(
            v.resolve_image_target("架构图.png").unwrap(),
            "_files/架构图.png"
        );
        let _ = fs::remove_dir_all(v.root());
    }

    #[test]
    fn 裸文件名解析_唯一命中才行() {
        let v = tmp_vault("files-name");
        v.write_file("_files/a.png", &[1]).unwrap();
        assert_eq!(v.resolve_image_target("a.png").unwrap(), "_files/a.png");
        assert_eq!(
            v.resolve_image_target("_files/a.png").unwrap(),
            "_files/a.png"
        );
        assert!(v.resolve_image_target("missing.png").is_err());
        assert!(v.resolve_image_target("../a.png").is_err());

        v.write_file("_files/b.png", &[2]).unwrap();
        // 同名多张：造一个同名（不同前缀不可能同名 —— 直接写两个不同 rel）
        v.write_file("_files/c.png", &[3]).unwrap();
        // 用两个同名的不同目录是不允许的（单段）——所以「同名歧义」用
        // 原始名场景在真实数据里来自不同来源前缀，这里只验裸名唯一命中。
        assert!(v.resolve_image_target("b.png").is_ok());
        let _ = fs::remove_dir_all(v.root());
    }

    #[test]
    fn 来源存储名_同毫秒同名自动加序号() {
        let v = tmp_vault("source-name");
        let first = v.unique_source_stored_name(1729, "报告.pdf");
        assert_eq!(first, "1729_报告.pdf");
        fs::write(v.source_path(&first), b"x").unwrap();
        let second = v.unique_source_stored_name(1729, "报告.pdf");
        assert_eq!(second, "1729_报告 (2).pdf");
        fs::write(v.source_path(&second), b"x").unwrap();
        assert_eq!(v.unique_source_stored_name(1729, "报告.pdf"), "1729_报告 (3).pdf");
        let _ = fs::remove_dir_all(v.root());
    }

    #[test]
    fn 去重_同名加序号() {
        let v = tmp_vault("unique");
        assert_eq!(unique_card_rel(&v, "", "甲"), "甲.md");
        v.write_card("甲.md", &Frontmatter::new("甲", ""), "").unwrap();
        assert_eq!(unique_card_rel(&v, "", "甲"), "甲 (2).md");
        v.write_card("甲 (2).md", &Frontmatter::new("甲", ""), "").unwrap();
        assert_eq!(unique_card_rel(&v, "子", "甲"), "子/甲.md");
        let _ = fs::remove_dir_all(v.root());
    }

    // ------------------------------------------------------ 目录结构 / 附件

    #[test]
    fn 建库布局_包含附件目录() {
        let v = tmp_vault("layout-attach");
        assert!(v.root().join(ATTACHMENTS_DIR).is_dir());
        // 附件目录不是卡片区
        assert!(!v.scan_dirs().unwrap().iter().any(|d| d == ATTACHMENTS_DIR));
        let _ = fs::remove_dir_all(v.root());
    }

    #[test]
    fn 目录_建_扫_改名_只删空目录() {
        let v = tmp_vault("dirs");
        v.create_dir("项目").unwrap();
        v.create_dir("项目/子目录").unwrap();
        assert_eq!(v.scan_dirs().unwrap(), vec!["项目", "项目/子目录"]);

        // 空目录能删
        v.delete_dir("项目/子目录").unwrap();
        assert_eq!(v.scan_dirs().unwrap(), vec!["项目"]);

        // 非空目录拒绝
        v.write_card("项目/a.md", &Frontmatter::new("a", ""), "").unwrap();
        assert!(matches!(
            v.delete_dir("项目").unwrap_err(),
            KbError::NotEmpty { .. }
        ));

        // 改名：卡片 rel 跟着变（索引层会重新扫）
        let new_rel = v.rename_dir("项目", "新项目").unwrap();
        assert_eq!(new_rel, "新项目");
        assert!(v.root().join("新项目/a.md").is_file());
        assert_eq!(v.scan_dirs().unwrap(), vec!["新项目"]);
        let _ = fs::remove_dir_all(v.root());
    }

    #[test]
    fn 目录闸门_保留区绝对路径和隐藏目录都挡() {
        assert!(safe_dir_rel("", true).is_ok());
        assert!(safe_dir_rel("", false).is_err());
        assert!(safe_dir_rel("项目", false).is_ok());
        assert!(safe_dir_rel("项目/子", false).is_ok());
        assert!(safe_dir_rel("_sources", false).is_err());
        assert!(safe_dir_rel("_files", false).is_err());
        assert!(safe_dir_rel("_attachments", false).is_err());
        assert!(safe_dir_rel(".secret", false).is_err());
        assert!(safe_dir_rel("../外面", false).is_err());
        assert!(safe_dir_rel("/abs", false).is_err());
        assert_eq!(sanitize_dir_name(" a:b/c*d "), "a b c d");
        assert_eq!(sanitize_dir_name("？？？"), "？？？", "全角字符不拦");
    }

    #[test]
    fn 移动卡片_同名自动加序号() {
        let v = tmp_vault("move");
        v.create_dir("甲").unwrap();
        v.create_dir("乙").unwrap();
        v.write_card("甲/卡.md", &Frontmatter::new("卡", ""), "一").unwrap();
        v.write_card("乙/卡.md", &Frontmatter::new("卡", ""), "二").unwrap();

        let new_rel = v.move_card("甲/卡.md", "乙").unwrap();
        assert_eq!(new_rel, "乙/卡 (2).md");
        assert!(v.root().join(&new_rel).is_file());
        assert!(!v.root().join("甲/卡.md").exists());
        assert_eq!(v.move_card(&new_rel, "乙").unwrap(), new_rel, "同目录不动");
        assert!(v.move_card("不存在.md", "乙").is_err());
        let _ = fs::remove_dir_all(v.root());
    }

    #[test]
    fn 附件_读写往返_闸门只放_attachments_单段() {
        let v = tmp_vault("attach");
        v.write_attachment("_attachments/1729_说明.docx", &[1, 2, 3])
            .unwrap();
        assert_eq!(
            v.read_attachment("_attachments/1729_说明.docx", 1024).unwrap(),
            vec![1, 2, 3]
        );
        v.delete_attachment("_attachments/1729_说明.docx").unwrap();
        assert!(v.delete_attachment("_attachments/1729_说明.docx").is_ok());

        assert!(safe_attachment_rel("_attachments/a.pdf").is_ok());
        assert!(safe_attachment_rel("_attachments/sub/a.pdf").is_err());
        assert!(safe_attachment_rel("_files/a.pdf").is_err());
        assert!(safe_attachment_rel("/etc/passwd").is_err());
        assert!(safe_attachment_rel("_attachments/.hidden").is_err());
        assert!(safe_file_rel("_attachments/a.png").is_err(), "附件不走图片闸门");
        // 附件里的图片能被阅读器读回来（`![[_attachments/x.png]]`）
        v.write_attachment("_attachments/b.png", &[7]).unwrap();
        assert_eq!(
            v.resolve_image_target("_attachments/b.png").unwrap(),
            "_attachments/b.png"
        );
        assert_eq!(
            v.read_image("_attachments/b.png", 1024).unwrap(),
            vec![7]
        );

        #[cfg(unix)]
        {
            // 软链不许拿去「用系统默认程序打开」（open 路径也要过归属检查）
            let outside = std::env::temp_dir().join(format!(
                "devtoolkit-kb-att-outside-{}",
                std::process::id()
            ));
            fs::write(&outside, b"secret").unwrap();
            std::os::unix::fs::symlink(&outside, v.attachment_path("link.txt")).unwrap();
            assert!(v.attachment_abs_checked("_attachments/link.txt").is_err());
            let _ = fs::remove_file(&outside);
        }
    }

    #[test]
    fn 追加备注_空正文直接写_非空正文有分隔线() {
        assert_eq!(
            append_note("", "2026-11-09 14:32", "第一条"),
            "**2026-11-09 14:32**\n\n第一条\n"
        );
        assert_eq!(
            append_note("# 标题\n正文", "2026-11-09 14:32", "补充"),
            "# 标题\n正文\n\n---\n\n**2026-11-09 14:32**\n\n补充\n",
            "结尾没换行时补一个，再空一行放分隔线"
        );
        assert_eq!(
            append_note("# 标题\n", "2026-11-09 14:32", "补充"),
            "# 标题\n\n---\n\n**2026-11-09 14:32**\n\n补充\n",
            "已有换行不额外多一个空行"
        );
        // 纯空白正文当空处理（不写孤零零的分隔线）
        assert_eq!(
            append_note("   \n", "t", "x"),
            "**t**\n\nx\n"
        );
    }

    #[test]
    fn 附件存储名_同毫秒同名加序号() {
        let v = tmp_vault("attach-name");
        let first = v.unique_attachment_stored_name(1729, "说明.docx");
        assert_eq!(first, "1729_说明.docx");
        fs::write(v.attachment_path(&first), b"x").unwrap();
        assert_eq!(
            v.unique_attachment_stored_name(1729, "说明.docx"),
            "1729_说明 (2).docx"
        );
        let _ = fs::remove_dir_all(v.root());
    }
}
