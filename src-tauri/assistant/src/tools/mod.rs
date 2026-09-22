//! 真正干活的工具：文件四件套 + 跑命令。
//!
//! # 和 `tool.rs` 的分工
//!
//! `tool.rs` 是**纯逻辑**（schema 校验、审批判定、`GrantKey` 粒度），这个目录
//! 是**碰 IO 的那一半**：解析路径、读文件、起进程。前者的每个分支都能在毫秒级
//! 单测里穷举，后者靠集成测试和真机验。这个切法是刻意的 —— 最容易写错的
//! 「该不该问用户」「参数合不合法」两件事，不该和 `fs::read` 混在一个文件里。
//!
//! # 一条贯穿全部工具的规矩：**展示的就是执行的**
//!
//! [`Tools::prepare`] 产出的 `PreparedCall` 里那个 `args`，是**已经解析、已经
//! 规范化**的执行参数 —— 路径在这一步过完 [`Workspace::resolve`] 就被写回
//! `args`，展示给用户的 `display` 用的也是同一个值。
//!
//! [`Tools::execute`] 因此**只认 `args`，不回头去看模型给的原文**。
//! 「先渲染给用户看、执行时再解析一遍」是审批版的 TOCTOU：用户批准的和实际跑的
//! 可能不是一个东西，而这个缝在界面上看不见。
//!
//! # 路径闸门只有一道
//!
//! 所有路径都走 [`Workspace::resolve`]（`devtoolkit-core` 里那个唯一的闸门：
//! 字面检查 + `canonicalize` 解符号链接 + 归属确认）。这个文件里**没有第二份
//! 路径解析** —— 在安全边界上多写一份，就是多一个会漏的地方。
//!
//! ⚠️ 但路径闸门**管不住命令**：`Workspace::resolve` 保证的是「路径不出工作区」，
//! 而一个跑起来的程序可以用 `cd ..`、绝对路径、网络做任何事。所以
//! [`SideEffect::Execute`] 永远要人工确认，不能进任何自动放行名单 ——
//! 这条写在 `tool.rs` 的 [`SideEffect`] 文档里，这里只是再点一次。

use std::ffi::OsString;
use std::time::Duration;

use devtoolkit_core::Workspace;
use serde_json::Value;

use crate::session::{ToolOutcome, ToolRunner};
use crate::tool::{validate_input, InvalidInput, PreparedCall, ToolSpec};
use crate::turn::ToolCall;

pub mod exec;
pub mod fs;

/// 工具执行的各种上限。
///
/// 全是「有界」这件事本身：模型可能读一个 2GB 的日志、跑一条 `yes` 不回来的
/// 命令，而**上下文是有价的**（每一轮的历史都会原样发回去）。没有上限的话，
/// 一次失误就能把这个会话烧穿。
#[derive(Debug, Clone)]
pub struct ToolsConfig {
    /// 一次 `read_file` 最多给多少行。
    pub max_read_lines: usize,
    /// 一次 `read_file` 最多给多少字节。
    pub max_read_bytes: usize,
    /// 一个工具结果最多多少字节（stdout / stderr 各自算）。
    ///
    /// 超了就**头尾各留一半、中间报省略了多少** —— 命令的输出里，
    /// 开头有上下文、结尾有错误，中间往往是最不重要的那一段。
    pub max_output_bytes: usize,
    /// `list_dir` 一次最多列多少条。
    pub max_dir_entries: usize,
    /// 一条命令跑多久算超时。
    ///
    /// ⚠️ 给得宽是因为**构建就是慢**（`cargo build` 在冷机器上几分钟很正常），
    /// 而超时的代价是白跑一次。300 秒是「明显不对劲」和「正常慢」之间的位置。
    pub command_timeout: Duration,
    /// 给子进程的 PATH。
    ///
    /// ⚠️ **默认只抄当前进程的那一份，而那一份常常是「登录时的快照」** ——
    /// 桌面图标启动的应用拿到的是用户登录那一刻的环境，那之后装的 node /
    /// cargo / 新版本工具**都不在里面**。症状极其误导人：用户在**自己的终端里**
    /// 跑同样的命令一切正常，agent 跑就说「找不到」。
    ///
    /// `agents` 那边为 PTY 解过这道题（`pty.rs` 的 `effective_path`：Windows 上
    /// 把注册表里当前的 PATH 和进程自己那份合并、展开 `%VAR%`、去重）。
    /// 这里**留成参数**是因为那套逻辑现在还在 `agents` 里、且要读注册表；
    /// 命令层（`assistant_commands.rs`）接工具的时候把算好的那份传进来即可。
    /// 为 `None` 就完全不动环境变量。
    pub path: Option<OsString>,
}

impl Default for ToolsConfig {
    fn default() -> Self {
        ToolsConfig {
            max_read_lines: 2000,
            max_read_bytes: 256 * 1024,
            max_output_bytes: 64 * 1024,
            max_dir_entries: 500,
            command_timeout: Duration::from_secs(300),
            path: std::env::var_os("PATH"),
        }
    }
}

/// 实现 [`ToolRunner`] 的那一组工具。
///
/// 一个会话一个（它绑死了那个工作区）。`Workspace` 内部就一个 `PathBuf`，
/// 克隆很便宜。
#[derive(Debug, Clone)]
pub struct Tools {
    ws: Workspace,
    cfg: ToolsConfig,
}

impl Tools {
    /// 用默认配置建一组。
    pub fn new(ws: Workspace) -> Self {
        Tools {
            ws,
            cfg: ToolsConfig::default(),
        }
    }

    /// 带配置建。
    pub fn with_config(ws: Workspace, cfg: ToolsConfig) -> Self {
        Tools { ws, cfg }
    }

    /// 工作区（命令层要用它算展示用的根目录名）。
    pub fn workspace(&self) -> &Workspace {
        &self.ws
    }

    /// 这一组工具的静态描述（喂给模型的 `tools` 字段）。
    ///
    /// ⚠️ **顺序必须稳定**：工具定义是请求前缀的第一段，顺序一变整个 prompt
    /// 缓存就废了。这里靠 [`crate::tool::ToolSet::new`] 按名字排序来保证。
    pub fn specs(&self) -> Vec<ToolSpec> {
        vec![
            fs::read_spec(),
            fs::write_spec(),
            fs::edit_spec(),
            fs::list_spec(),
            exec::run_spec(),
        ]
    }

    /// 按名字找描述。
    fn spec_of(&self, name: &str) -> Option<ToolSpec> {
        self.specs().into_iter().find(|s| s.name == name)
    }
}

impl ToolRunner for Tools {
    fn prepare(&self, call: &ToolCall) -> Result<PreparedCall, InvalidInput> {
        // ⚠️ 认不出的工具名要**报错**，不能静默忽略：模型幻觉出一个工具时，
        // 我们需要回一条「没有这个工具」让它改 —— 什么都不回的话它会一直重试。
        let spec = self.spec_of(&call.name).ok_or_else(|| InvalidInput {
            reason: format!(
                "没有叫 `{}` 的工具。可用的有：{}。",
                call.name,
                self.specs()
                    .iter()
                    .map(|s| s.name.as_str())
                    .collect::<Vec<_>>()
                    .join("、")
            ),
        })?;

        // 严格解析 + 按 schema 校验。截断的参数**经常仍能解析成一个看着合法的
        // 部分对象**，所以「解析成功」不等于「可以用」—— 必须再过一遍 schema。
        let args = validate_input(&spec.schema, call.args_text())?;

        match call.name.as_str() {
            fs::READ_FILE => fs::prepare_read(&self.ws, args),
            fs::WRITE_FILE => fs::prepare_write(&self.ws, args),
            fs::EDIT_FILE => fs::prepare_edit(&self.ws, args),
            fs::LIST_DIR => fs::prepare_list(&self.ws, args),
            exec::RUN_COMMAND => exec::prepare_run(&self.ws, args),
            // `spec_of` 已经保证了名字在集合里，走不到这儿。
            other => Err(InvalidInput {
                reason: format!("工具 `{other}` 还没有实现"),
            }),
        }
    }

    async fn execute(&self, call: &PreparedCall) -> ToolOutcome {
        // ⚠️ 只看 `call.args`（`prepare` 规范化过的那份），**绝不去看模型的原文**。
        match call.name.as_str() {
            fs::READ_FILE => fs::execute_read(&self.ws, &self.cfg, &call.args).await,
            fs::WRITE_FILE => fs::execute_write(&self.ws, &call.args).await,
            fs::EDIT_FILE => fs::execute_edit(&self.ws, &call.args).await,
            fs::LIST_DIR => fs::execute_list(&self.ws, &self.cfg, &call.args).await,
            exec::RUN_COMMAND => exec::execute_run(&self.ws, &self.cfg, &call.args).await,
            other => ToolOutcome {
                content: format!("工具 `{other}` 还没有实现"),
                is_error: true,
            },
        }
    }
}

// -------------------------------------------------------------------- 共用小工具

/// 取一个必填的字符串参数。
///
/// schema 已经保证它在了（`required` + `type: string`），所以这里的失败
/// **只可能是我们自己 schema 写错了** —— 但仍然报错而不是 `unwrap`，
/// 因为一个 panic 会把整个会话带下去。
pub(super) fn arg_str<'a>(args: &'a Value, key: &str) -> Result<&'a str, InvalidInput> {
    args.get(key).and_then(Value::as_str).ok_or_else(|| InvalidInput {
        reason: format!("参数 `{key}` 必须是一个字符串"),
    })
}

/// 把一个相对路径解析进工作区，并返回**规范化之后**的相对路径。
///
/// 返回值要写回 `args`（见模块头部「展示的就是执行的」）。
pub(super) fn resolve_rel(ws: &Workspace, rel: &str) -> Result<String, InvalidInput> {
    let abs = ws
        .resolve(rel)
        .map_err(|e| InvalidInput { reason: e.to_string() })?;
    ws.rel_path(&abs).map_err(|e| InvalidInput { reason: e.to_string() })
}

/// 一个路径的父目录（用来当写操作的授权粒度）。
///
/// 工作区根目录下的文件没有 `/`，那就归一成 `"."` —— 空字符串在界面上
/// 是一片空白，用户看不出自己批准了什么范围。
pub(super) fn parent_of(rel: &str) -> String {
    match rel.rsplit_once('/') {
        Some((dir, _)) if !dir.is_empty() => dir.to_string(),
        _ => ".".to_string(),
    }
}

/// 给模型看的工作区路径：空串（根目录）显示成一个能认出来的名字。
pub(super) fn display_dir(rel: &str) -> String {
    if rel.is_empty() {
        "工作区根目录".to_string()
    } else {
        format!("{rel}/")
    }
}

/// 把字节数写成人看的样子。
pub(super) fn human_size(bytes: u64) -> String {
    // ⚠️ **从大到小**。反过来写的话第一个命中的永远是 KB，
    // 3 MB 会显示成「3072.0 KB」（这个错犯过一次，有测试钉着）。
    const UNITS: [(&str, u64); 3] = [
        ("GB", 1024 * 1024 * 1024),
        ("MB", 1024 * 1024),
        ("KB", 1024),
    ];
    for (unit, scale) in UNITS {
        if bytes >= scale {
            // 保留一位小数就够看，别写 1.2345678 MB
            return format!("{:.1} {unit}", bytes as f64 / scale as f64);
        }
    }
    format!("{bytes} B")
}

/// `Workspace::root()` 的显示名（展示文案里用，比如「在工作区 xxx 里」）。
pub(super) fn root_label(ws: &Workspace) -> String {
    ws.root()
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| ws.root().display().to_string())
}

/// 造一条「参数不合法」的错误（`InvalidInput` 的字段是 pub 的，但构造点很多，
/// 给个短名字省得到处写结构体字面量）。
pub(super) fn invalid(reason: impl Into<String>) -> InvalidInput {
    InvalidInput {
        reason: reason.into(),
    }
}

/// 可选字符串参数（没给、或者给的不是字符串，都算空串）。
pub(super) fn optional_str(args: &Value, key: &str) -> String {
    args.get(key).and_then(Value::as_str).unwrap_or("").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_top_level_file_belongs_to_the_root_grant() {
        // 「批准往 src/ 写」不等于「批准往工作区根目录写」。根目录用 `.` 表示，
        // 不是空串 —— 空串在界面上是一片空白。
        assert_eq!(parent_of("a.txt"), ".");
        assert_eq!(parent_of("src/a.txt"), "src");
        assert_eq!(parent_of("src/deep/a.txt"), "src/deep");
    }

    #[test]
    fn sizes_read_like_a_person_wrote_them() {
        assert_eq!(human_size(512), "512 B");
        assert_eq!(human_size(2048), "2.0 KB");
        assert_eq!(human_size(3 * 1024 * 1024), "3.0 MB");
    }

    #[test]
    fn the_root_directory_has_a_name_in_display_text() {
        // 空串直接拼进文案会得到「列 」——用户看不出在列什么。
        assert_eq!(display_dir(""), "工作区根目录");
        assert_eq!(display_dir("src"), "src/");
    }
}
