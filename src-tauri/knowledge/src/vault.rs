//! vault（知识库目录）的模型：布局、路径闸门、扫描、卡片的读写。
//!
//! # 布局（和 HANDOFF 里画的图一致）
//!
//! ```text
//! <vault>/
//! ├── .devtoolkit/index.db     ← 派生索引（删掉不丢知识，下次重建）
//! ├── 卡片.md / 子目录/卡片.md  ← 「卡片区」：任意层级的 .md
//! ├── _sources/…               ← 上传的原件拷贝（生成知识用）
//! └── _files/…                 ← 附件/图片（卡片的 ![[...]] 指向这里）
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

    /// 建出 `_sources/`、`_files/`、`.devtoolkit/`（幂等）。
    pub fn ensure_layout(&self) -> Result<(), KbError> {
        for dir in [SOURCES_DIR, FILES_DIR, META_DIR] {
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
                if name == SOURCES_DIR || name == FILES_DIR {
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
        if seg == SOURCES_DIR || seg == FILES_DIR || seg.starts_with('.') {
            return Err(KbError::BadRel {
                rel,
                reason: "卡片不能写在保留目录/隐藏目录里",
            });
        }
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
}
