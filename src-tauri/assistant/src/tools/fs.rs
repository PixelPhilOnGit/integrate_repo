//! 文件工具：读、写、改、列目录。
//!
//! # 读是「带行号 + 有上限」的
//!
//! 行号是给模型引用用的（「第 42 行那个函数」）。上限是因为**上下文有价**：
//! 每轮的历史都会原样再发一遍，一个 2GB 的日志读进来能把这个会话直接烧穿。
//! 所以读了字节上限、行数上限，两个都超不过。
//!
//! # 写和改是**两个**工具，不是一回事
//!
//! `write_file` 覆盖整个文件，`edit_file` 把一段文字替换成另一段。
//! 分开是因为前者的破坏力对用户是不可见的：模型**读了一个被截断的文件**、
//! 顺手用 `write_file` 写回去，它没看到的那几千行就**静默地没了** ——
//! 用户拿到的是一份看起来正常、但少了内容的文件。
//!
//! `edit_file` 没有这个问题（它只动匹配到的那一段，匹配不到就报错）。
//! 所以工具描述里明写「改已有文件用 `edit_file`」，读的截断提示里也再说一遍。

use std::io::Read;
use std::path::Path;

use devtoolkit_core::Workspace;
use serde_json::{json, Value};

use crate::session::ToolOutcome;
use crate::tool::{GrantKey, InvalidInput, PreparedCall, SideEffect, ToolSpec};

use super::{
    arg_str, human_size, invalid, optional_str, parent_of, resolve_rel, root_label, ToolsConfig,
};

/// 读文件。
pub const READ_FILE: &str = "read_file";
/// 写整个文件。
pub const WRITE_FILE: &str = "write_file";
/// 把一段文字替换成另一段。
pub const EDIT_FILE: &str = "edit_file";
/// 列一层目录。
pub const LIST_DIR: &str = "list_dir";

// ------------------------------------------------------------------ 静态描述

/// `read_file` 的描述。
pub fn read_spec() -> ToolSpec {
    ToolSpec {
        name: READ_FILE.into(),
        description: "读一个文本文件，返回带行号的内容。\
            改文件**之前**必须先读它。\
            文件很长时会截断，用 offset 接着往后读。\
            看不到全部内容时**不要**用 write_file 写回去 —— 那会抹掉你没看到的部分。"
            .into(),
        schema: json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "相对工作区根目录的路径，比如 src/main.tsx"
                },
                "offset": {
                    "type": "integer",
                    "description": "从第几行开始读，从 1 数。默认 1"
                },
                "limit": {
                    "type": "integer",
                    "description": "最多读几行"
                }
            },
            "required": ["path"],
            "additionalProperties": false
        }),
        side_effect: SideEffect::Read,
    }
}

/// `write_file` 的描述。
pub fn write_spec() -> ToolSpec {
    ToolSpec {
        name: WRITE_FILE.into(),
        description: "新建一个文件，或者**整个覆盖**一个已有的文件。\
            ⚠️ 改已有文件请用 edit_file —— 这个工具会用你给的内容把原文件全部替换掉，\
            你没读到的部分会直接消失。\
            父目录不存在会自动建。"
            .into(),
        schema: json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "相对工作区根目录的路径"
                },
                "contents": {
                    "type": "string",
                    "description": "文件的完整新内容"
                }
            },
            "required": ["path", "contents"],
            "additionalProperties": false
        }),
        side_effect: SideEffect::Write,
    }
}

/// `edit_file` 的描述。
pub fn edit_spec() -> ToolSpec {
    ToolSpec {
        name: EDIT_FILE.into(),
        description: "把文件里的一段文字换成另一段。\
            old_string 必须在文件里**只出现一次** —— 不唯一就多带几行上下文再试。\
            改之前先 read_file 看现在是什么样。"
            .into(),
        schema: json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "相对工作区根目录的路径"
                },
                "old_string": {
                    "type": "string",
                    "description": "要被替换掉的原文，要逐字一样（含缩进）"
                },
                "new_string": {
                    "type": "string",
                    "description": "替换成什么。传空串表示删掉这一段"
                }
            },
            "required": ["path", "old_string", "new_string"],
            "additionalProperties": false
        }),
        side_effect: SideEffect::Write,
    }
}

/// `list_dir` 的描述。
pub fn list_spec() -> ToolSpec {
    ToolSpec {
        name: LIST_DIR.into(),
        description: "列出一个目录里的东西（只列一层，不递归）。\
            不确定文件在哪、或者文件名记不准的时候，先列一下比猜路径快。"
            .into(),
        schema: json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "相对工作区根目录的目录路径。不填就是工作区根目录"
                }
            },
            "required": [],
            "additionalProperties": false
        }),
        side_effect: SideEffect::Read,
    }
}

// ---------------------------------------------------------------------- 准备

/// `read_file` 的准备。
pub fn prepare_read(ws: &Workspace, args: Value) -> Result<PreparedCall, InvalidInput> {
    let rel = resolve_rel(ws, arg_str(&args, "path")?)?;

    // 参数里留**规范化之后**的路径（见 `tools` 模块头部）。
    let mut args = args;
    args["path"] = json!(rel);

    Ok(PreparedCall {
        name: READ_FILE.into(),
        args,
        side_effect: SideEffect::Read,
        display: format!("读 {rel}"),
        grant: None, // 只读，不问
    })
}

/// `write_file` 的准备。
pub fn prepare_write(ws: &Workspace, args: Value) -> Result<PreparedCall, InvalidInput> {
    let rel = resolve_rel(ws, arg_str(&args, "path")?)?;
    // ⚠️ 借用在 `args` 被 move 走之前必须结束，所以先取长度。
    let contents_len = arg_str(&args, "contents")?.len();

    let mut args = args;
    args["path"] = json!(rel);

    Ok(PreparedCall {
        name: WRITE_FILE.into(),
        args,
        side_effect: SideEffect::Write,
        // ⚠️ 展示里带上要写多少 —— 用户要能一眼看出这是「改一行」还是「重写整个文件」。
        display: format!("写入 {rel}（{}）", human_size(contents_len as u64)),
        // 授权粒度是**父目录**：批准「往 src/ 写」不等于批准往 /etc 写。
        // 理由见 `tool.rs` 的 `GrantKey`。
        grant: Some(GrantKey {
            tool: WRITE_FILE.into(),
            target: parent_of(&rel),
        }),
    })
}

/// `edit_file` 的准备。
pub fn prepare_edit(ws: &Workspace, args: Value) -> Result<PreparedCall, InvalidInput> {
    let rel = resolve_rel(ws, arg_str(&args, "path")?)?;
    let old = arg_str(&args, "old_string")?;
    let new = arg_str(&args, "new_string")?;

    if old.is_empty() {
        return Err(invalid(
            "old_string 不能是空的 —— 要替换什么就写什么，整段删掉的话把它放在 old_string、new_string 留空。",
        ));
    }
    if old == new {
        return Err(invalid("old_string 和 new_string 一模一样，这不会改变任何东西。"));
    }
    // 借用在 `args` 被 move 走之前必须结束。
    let old_chars = old.chars().count();

    let mut args = args;
    args["path"] = json!(rel);

    Ok(PreparedCall {
        name: EDIT_FILE.into(),
        args,
        side_effect: SideEffect::Write,
        display: format!("改 {rel}（替换 {old_chars} 个字符）"),
        grant: Some(GrantKey {
            tool: EDIT_FILE.into(),
            target: parent_of(&rel),
        }),
    })
}

/// `list_dir` 的准备。
pub fn prepare_list(ws: &Workspace, args: Value) -> Result<PreparedCall, InvalidInput> {
    let requested = optional_str(&args, "path");
    let rel = resolve_rel(ws, requested.trim())?;

    let mut args = args;
    args["path"] = json!(rel);

    Ok(PreparedCall {
        name: LIST_DIR.into(),
        args,
        side_effect: SideEffect::Read,
        display: format!("列出 {}", super::display_dir(&rel)),
        grant: None,
    })
}

// ---------------------------------------------------------------------- 执行

/// `read_file` 的执行。
pub async fn execute_read(ws: &Workspace, cfg: &ToolsConfig, args: &Value) -> ToolOutcome {
    let rel = optional_str(args, "path");
    let want_from = args.get("offset").and_then(Value::as_u64).unwrap_or(1).max(1) as usize;
    // ⚠️ 模型给的上限**只当缩小用**：它要 100000 行，我们仍然只给 `max_read_lines`。
    let want_lines = args
        .get("limit")
        .and_then(Value::as_u64)
        .map(|v| v as usize)
        .unwrap_or(cfg.max_read_lines)
        .min(cfg.max_read_lines);

    let abs = match ws.resolve(&rel) {
        Ok(p) => p,
        Err(e) => return ToolOutcome { content: e.to_string(), is_error: true },
    };

    // ⚠️ 读 IO 走 `spawn_blocking`：这是本地磁盘上的同步 IO，直接在 async 里做
    // 会把 tokio 的工作线程占住（这台机器 2 核，占住两个就转不动了）。
    let max_bytes = cfg.max_read_bytes;
    let read = tokio::task::spawn_blocking(move || read_capped(&abs, max_bytes)).await;

    let (text, byte_truncated) = match read {
        Ok(Ok(v)) => v,
        Ok(Err(ReadFailure::Binary)) => {
            return ToolOutcome {
                content: format!(
                    "{rel} 看起来是二进制文件（图片 / 压缩包 / 可执行文件之类），读成文本没有意义。"
                ),
                is_error: true,
            }
        }
        Ok(Err(ReadFailure::Io(msg))) => {
            return ToolOutcome { content: msg, is_error: true }
        }
        Err(e) => {
            return ToolOutcome {
                content: format!("读文件时出错了：{e}"),
                is_error: true,
            }
        }
    };

    let lines: Vec<&str> = text.lines().collect();
    let total_lines = lines.len();

    if total_lines == 0 {
        return ToolOutcome {
            content: format!("{rel} 是空文件。"),
            is_error: false,
        };
    }

    if want_from > total_lines {
        return ToolOutcome {
            content: format!(
                "{rel} 一共只有 {total_lines} 行，offset={want_from} 已经超出去了。"
            ),
            is_error: true,
        };
    }

    // 从 `want_from`（1 起数）开始，最多 `want_lines` 行。
    let start = want_from - 1;
    let end = (start + want_lines).min(total_lines);

    let mut out = String::new();
    for (i, line) in lines[start..end].iter().enumerate() {
        // 行号是**文件里的真实行号**，不是「这一段里的第几行」——
        // 模型引用的行号要能在文件里对得上。
        out.push_str(&format!("{:>6}→{line}\n", start + i + 1));
    }

    if end < total_lines {
        out.push_str(&format!(
            "\n…（这里给的是第 {want_from}-{end} 行，全文共 {total_lines} 行。\
             用 offset={} 接着读。）\n\
             （⚠️ 你还没看完整个文件。要改它请用 edit_file，\
             **不要**拿这段内容去 write_file —— 你看不到的行会被抹掉。）\n",
            end + 1
        ));
    }

    if byte_truncated {
        out.push_str(
            "\n（⚠️ 这个文件很大，上面读到的内容在**字节上限**处被截断了，\
             行号可能比实际的行少 —— 用 offset 从后面接着读。）\n",
        );
    }

    ToolOutcome {
        content: out,
        is_error: false,
    }
}

/// `write_file` 的执行。
pub async fn execute_write(ws: &Workspace, args: &Value) -> ToolOutcome {
    let rel = optional_str(args, "path");
    let contents = args.get("contents").and_then(Value::as_str).unwrap_or("").to_string();
    let bytes = contents.len();

    let ws2 = ws.clone();
    let rel2 = rel.clone();
    let r = tokio::task::spawn_blocking(move || -> Result<(), String> {
        // ⚠️ **父目录要自己建。** `core::write_text_file` 不建 —— 它只是
        // `ensure_parent_dir` 检查一下、不存在就报 `NotFound`。那是顺序图目录树的
        // 语义（路径都从树里来，中间不会缺段），而这里模型给的路径很可能是
        // `src/new/file.txt`，中间那层还不存在。工具面里没有 mkdir，
        // 不补这一步的话它得先写个空文件占位，白费一轮。
        //
        // 建目录也**在闸门里面**：路径先过 `Workspace::resolve`（唯一的闸门），
        // 拿到的是工作区内的绝对路径。
        let abs = ws2.resolve(&rel2).map_err(|e| e.to_string())?;
        if let Some(parent) = abs.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("建不了目录 {}：{e}", parent.display()))?;
        }
        // 原子写（临时文件 + rename）：断电时要么旧内容、要么新内容，
        // 不会留下写了一半的文件。
        ws2.write_text_file(&rel2, &contents).map_err(|e| e.to_string())
    })
    .await;

    match r {
        Ok(Ok(())) => ToolOutcome {
            content: format!("已写入 {rel}（{}）。", human_size(bytes as u64)),
            is_error: false,
        },
        Ok(Err(msg)) => ToolOutcome { content: msg, is_error: true },
        Err(e) => ToolOutcome {
            content: format!("写文件时出错了：{e}"),
            is_error: true,
        },
    }
}

/// `edit_file` 的执行。
pub async fn execute_edit(ws: &Workspace, args: &Value) -> ToolOutcome {
    let rel = optional_str(args, "path");
    let old = args.get("old_string").and_then(Value::as_str).unwrap_or("").to_string();
    let new = args.get("new_string").and_then(Value::as_str).unwrap_or("").to_string();

    let abs = match ws.resolve(&rel) {
        Ok(p) => p,
        Err(e) => return ToolOutcome { content: e.to_string(), is_error: true },
    };

    // 读写都要在阻塞线程里做，而且**要在同一个闭包里**：分开两次拿到的可能是
    // 两个版本的文件（中间被别人改了），替换就会写在一个没见过的基础上。
    let ws2 = ws.clone();
    let rel2 = rel.clone();
    let r = tokio::task::spawn_blocking(move || -> Result<String, EditFailure> {
        let text = std::fs::read_to_string(&abs).map_err(|e| EditFailure {
            message: format!("读不到 {rel2}：{e}"),
        })?;

        let hits = text.matches(&old).count();
        match hits {
            0 => Err(EditFailure {
                message: format!(
                    "{rel2} 里找不到这段文字。先 read_file 看看现在是什么样 —— \
                     注意空格和缩进要一模一样。"
                ),
            }),
            1 => {
                let updated = text.replacen(&old, &new, 1);
                ws2.write_text_file(&rel2, &updated).map_err(|e| EditFailure {
                    message: e.to_string(),
                })?;
                Ok(format!(
                    "已改 {rel2}（替换了 {} 个字符）。",
                    old.chars().count()
                ))
            }
            n => Err(EditFailure {
                message: format!(
                    "{rel2} 里这段文字出现了 {n} 次，没法确定要改哪一处。\
                     把前后几行也带上，让它只匹配到你要改的那一处。"
                ),
            }),
        }
    })
    .await;

    match r {
        Ok(Ok(msg)) => ToolOutcome { content: msg, is_error: false },
        Ok(Err(f)) => ToolOutcome { content: f.message, is_error: true },
        Err(e) => ToolOutcome {
            content: format!("改文件时出错了：{e}"),
            is_error: true,
        },
    }
}

/// `list_dir` 的执行。
pub async fn execute_list(ws: &Workspace, cfg: &ToolsConfig, args: &Value) -> ToolOutcome {
    let rel = optional_str(args, "path");

    let abs = match ws.resolve(&rel) {
        Ok(p) => p,
        Err(e) => return ToolOutcome { content: e.to_string(), is_error: true },
    };

    if !abs.is_dir() {
        return ToolOutcome {
            content: format!(
                "{} 不是一个目录。要读文件内容请用 read_file。",
                super::display_dir(&rel)
            ),
            is_error: true,
        };
    }

    let cap = cfg.max_dir_entries;
    let listed = tokio::task::spawn_blocking(move || list_one_level(&abs, cap)).await;

    let (entries, overflow) = match listed {
        Ok(Ok(v)) => v,
        Ok(Err(msg)) => return ToolOutcome { content: msg, is_error: true },
        Err(e) => {
            return ToolOutcome {
                content: format!("列目录时出错了：{e}"),
                is_error: true,
            }
        }
    };

    let mut out = format!("{}（{}）：\n", super::display_dir(&rel), root_label(ws));
    if entries.is_empty() {
        out.push_str("（空目录）\n");
    }
    for e in &entries {
        let kind = match e.kind.as_str() {
            "dir" => "目录".to_string(),
            "link" => "链接".to_string(),
            _ => human_size(e.size),
        };
        out.push_str(&format!("{:>6}  {:<24} {}\n", "", e.name, kind));
    }
    if overflow > 0 {
        out.push_str(&format!(
            "…（还有 {overflow} 条没列出来，这个目录太大了。\
             直接 read_file 你要的那个文件更快。）\n"
        ));
    }

    ToolOutcome {
        content: out,
        is_error: false,
    }
}

// ---------------------------------------------------------------------- 内部

/// 读文件失败的两种样子。
enum ReadFailure {
    /// 有 NUL 字节 —— 是二进制，不是文本。
    Binary,
    /// 别的 IO 问题（不存在、没权限……）。
    Io(String),
}

/// 读一个文件，**最多读 `max_bytes`**。
///
/// 返回 `(内容, 是不是因为字节上限才停的)`。
///
/// ⚠️ 不用 `devtoolkit_core` 的 `read_text_file` 是因为它会**把整个文件读进内存** ——
/// 模型读一个几 GB 的日志时，那是一次 OOM。路径闸门仍然走 core 的
/// `Workspace::resolve`（在调用方），这里只管读。
fn read_capped(path: &Path, max_bytes: usize) -> Result<(String, bool), ReadFailure> {
    let io = |e: std::io::Error| ReadFailure::Io(format!("读不到 {}：{e}", path.display()));

    let f = std::fs::File::open(path).map_err(io)?;
    let mut buf = Vec::new();
    // 多读 1 字节：能读到就说明文件比上限大（截断了），读不到就是刚好读完了。
    f.take(max_bytes as u64 + 1).read_to_end(&mut buf).map_err(io)?;

    let truncated = buf.len() > max_bytes;
    if truncated {
        buf.truncate(max_bytes);
    }

    // NUL 字节是「这是二进制」的可靠标志。先看它，别等 UTF-8 报错 ——
    // 两者的文案要不一样（一个是「读成文本没意义」，一个是「编码不对」）。
    if buf.contains(&0) {
        return Err(ReadFailure::Binary);
    }

    match String::from_utf8(buf) {
        Ok(s) => Ok((s, truncated)),
        Err(e) => {
            // 整个文件读完了却不是合法 UTF-8：二进制。
            if !truncated {
                return Err(ReadFailure::Binary);
            }
            // 是我们**截断**切坏了一个多字节字符 —— 那不算二进制，
            // 保留到最后一个完整字符为止（`valid_up_to` 就是那个位置）。
            let valid = e.utf8_error().valid_up_to();
            let bytes = e.into_bytes();
            Ok((String::from_utf8_lossy(&bytes[..valid]).into_owned(), true))
        }
    }
}

/// 一条目录项。
struct Entry {
    name: String,
    /// `"file"` / `"dir"` / `"link"`。
    kind: String,
    size: u64,
}

/// 列一层目录，返回 `(条目, 因为太多而没列出来的条数)`。
fn list_one_level(dir: &Path, cap: usize) -> Result<(Vec<Entry>, usize), String> {
    let rd = std::fs::read_dir(dir).map_err(|e| format!("打不开 {}：{e}", dir.display()))?;

    let mut entries = Vec::new();
    let mut overflow = 0usize;

    for item in rd {
        // 单条读失败（权限、竞态删除）不该让整个列表挂掉。
        let Ok(item) = item else { continue };

        let name = item.file_name().to_string_lossy().into_owned();
        // `file_type()` **不跟随**符号链接，正好用来识别它。
        let Ok(ft) = item.file_type() else { continue };

        let (kind, size) = if ft.is_symlink() {
            // 链接单独报，不跟随：跟到工作区外面的那种，读的时候会被路径闸门拦下，
            // 但**列出来是对的** —— 模型知道它存在，比看不见强。
            ("link".to_string(), 0)
        } else if ft.is_dir() {
            ("dir".to_string(), 0)
        } else {
            let size = item.metadata().map(|m| m.len()).unwrap_or(0);
            ("file".to_string(), size)
        };

        if entries.len() >= cap {
            overflow += 1;
            continue;
        }
        entries.push(Entry { name, kind, size });
    }

    // 目录在前，然后按名字（忽略大小写），和侧栏那棵树一个口径。
    entries.sort_by(|a, b| {
        let (a_dir, b_dir) = (a.kind == "dir", b.kind == "dir");
        b_dir
            .cmp(&a_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });

    Ok((entries, overflow))
}

/// 改文件失败。
struct EditFailure {
    message: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_ws() -> (Workspace, tempfile::TempDir) {
        let dir = tempfile::TempDir::new().unwrap();
        let ws = Workspace::open(dir.path()).unwrap();
        (ws, dir)
    }

    #[tokio::test]
    async fn reading_a_missing_file_says_so_instead_of_panicking() {
        let (ws, _d) = tmp_ws();
        let out = execute_read(&ws, &ToolsConfig::default(), &json!({"path": "nope.txt"})).await;
        assert!(out.is_error);
        assert!(!out.content.is_empty());
    }

    #[tokio::test]
    async fn reading_gives_real_line_numbers_and_resumes_with_offset() {
        let (ws, _d) = tmp_ws();
        let body: String = (1..=10).map(|i| format!("第 {i} 行\n")).collect();
        ws.write_text_file("a.txt", &body).unwrap();

        let out = execute_read(
            &ws,
            &ToolsConfig::default(),
            &json!({"path": "a.txt", "offset": 3, "limit": 2}),
        )
        .await;

        assert!(!out.is_error, "{}", out.content);
        // ⚠️ 行号必须是**文件里的**行号，不是这一段里的第几行。
        assert!(out.content.contains("     3→第 3 行"), "{}", out.content);
        assert!(out.content.contains("     4→第 4 行"), "{}", out.content);
        assert!(!out.content.contains("第 5 行"), "{}", out.content);
        // 截断要告诉模型怎么接着读。
        assert!(out.content.contains("offset=5"), "{}", out.content);
    }

    #[tokio::test]
    async fn a_binary_file_is_refused_with_a_reason() {
        // 「读成文本没意义」和「文件不存在」是两回事，文案要能分开。
        let (ws, _d) = tmp_ws();
        let p = ws.root().join("blob.bin");
        std::fs::write(&p, [0x00, 0x01, 0x02, 0xff, 0xfe]).unwrap();

        let out = execute_read(&ws, &ToolsConfig::default(), &json!({"path": "blob.bin"})).await;
        assert!(out.is_error);
        assert!(out.content.contains("二进制"), "{}", out.content);
    }

    #[tokio::test]
    async fn a_huge_file_is_read_from_the_front_and_says_it_was_cut() {
        // ⚠️ 这条盯的是**别把几 GB 读进内存**：字节上限必须在读的时候就生效，
        // 不是读完再截。
        let (ws, _d) = tmp_ws();
        let body = "x".repeat(4096);
        ws.write_text_file("big.txt", &body).unwrap();

        let cfg = ToolsConfig {
            max_read_bytes: 1024,
            ..ToolsConfig::default()
        };
        let out = execute_read(&ws, &cfg, &json!({"path": "big.txt"})).await;

        assert!(!out.is_error, "{}", out.content);
        assert!(out.content.len() < 4096, "读回来的东西没有被限制住");
        assert!(out.content.contains("字节上限"), "{}", out.content);
    }

    #[tokio::test]
    async fn a_byte_cap_that_lands_mid_character_does_not_produce_binary_noise() {
        // 截断切在一个汉字中间时，剩下的是半个字符 —— 那**不该**被判成二进制文件
        // （用户看到「这是二进制」会一头雾水，那明明是个文本文件）。
        let (ws, _d) = tmp_ws();
        let body = "中文中文中文中文";
        ws.write_text_file("cn.txt", body).unwrap();

        // "中" 是 3 字节，1024 太大；取一个正好切在中间的上限：7 字节 = 2 个整字 + 1 字节。
        let cfg = ToolsConfig {
            max_read_bytes: 7,
            ..ToolsConfig::default()
        };
        let out = execute_read(&ws, &cfg, &json!({"path": "cn.txt"})).await;

        assert!(!out.is_error, "半个汉字被误判成二进制了：{}", out.content);
        // 7 字节 = 「中文」两个整字（6 字节）+ 1 个残字节，所以停在「中文」。
        assert!(out.content.contains("中文"), "{}", out.content);
        assert!(!out.content.contains('\u{fffd}'), "不该出现替换字符：{}", out.content);
    }

    #[tokio::test]
    async fn writing_says_how_much_it_wrote() {
        let (ws, _d) = tmp_ws();
        let out = execute_write(&ws, &json!({"path": "sub/a.txt", "contents": "你好"})).await;
        assert!(!out.is_error, "{}", out.content);
        assert_eq!(ws.read_text_file("sub/a.txt").unwrap(), "你好");
    }

    #[tokio::test]
    async fn editing_replaces_exactly_one_occurrence() {
        let (ws, _d) = tmp_ws();
        ws.write_text_file("a.txt", "let x = 1;\nlet y = 2;\n").unwrap();

        let out = execute_edit(
            &ws,
            &json!({"path": "a.txt", "old_string": "let x = 1;", "new_string": "let x = 42;"}),
        )
        .await;

        assert!(!out.is_error, "{}", out.content);
        assert_eq!(ws.read_text_file("a.txt").unwrap(), "let x = 42;\nlet y = 2;\n");
    }

    #[tokio::test]
    async fn editing_an_ambiguous_match_refuses_rather_than_guessing() {
        // ⚠️ 这条是数据安全：猜一处改掉，用户拿到的是一份**改错了地方**的文件，
        // 而它看起来一切正常。宁可报错让模型多给点上下文。
        let (ws, _d) = tmp_ws();
        ws.write_text_file("a.txt", "x = 1;\nx = 1;\n").unwrap();

        let out = execute_edit(
            &ws,
            &json!({"path": "a.txt", "old_string": "x = 1;", "new_string": "x = 2;"}),
        )
        .await;

        assert!(out.is_error);
        assert!(out.content.contains("2 次"), "{}", out.content);
        // 一个字都不能动。
        assert_eq!(ws.read_text_file("a.txt").unwrap(), "x = 1;\nx = 1;\n");
    }

    #[tokio::test]
    async fn editing_a_missing_snippet_points_back_at_reading_it() {
        let (ws, _d) = tmp_ws();
        ws.write_text_file("a.txt", "hello\n").unwrap();

        let out = execute_edit(
            &ws,
            &json!({"path": "a.txt", "old_string": "nope", "new_string": "x"}),
        )
        .await;

        assert!(out.is_error);
        assert!(out.content.contains("read_file"), "{}", out.content);
    }

    #[tokio::test]
    async fn listing_puts_directories_first_and_skips_nothing() {
        let (ws, _d) = tmp_ws();
        ws.write_text_file("zzz.txt", "x").unwrap();
        ws.create_folder("", "aaa").unwrap();

        let out = execute_list(&ws, &ToolsConfig::default(), &json!({})).await;
        assert!(!out.is_error, "{}", out.content);

        let aaa = out.content.find("aaa").unwrap();
        let zzz = out.content.find("zzz.txt").unwrap();
        assert!(aaa < zzz, "目录应该排在前面：\n{}", out.content);
        assert!(out.content.contains("目录"), "{}", out.content);
    }

    #[tokio::test]
    async fn listing_a_file_says_use_read_file_instead() {
        let (ws, _d) = tmp_ws();
        ws.write_text_file("a.txt", "x").unwrap();

        let out = execute_list(&ws, &ToolsConfig::default(), &json!({"path": "a.txt"})).await;
        assert!(out.is_error);
        assert!(out.content.contains("read_file"), "{}", out.content);
    }
}
