//! CLI 适配层：**每家 CLI 的参数怎么拼、输出怎么读**，全部收在这里。
//!
//! # 为什么是一家一个 adapter
//!
//! 三家的无头模式长得像、细节全不一样：
//!
//! | | claude | csc（CoStrict） | codex |
//! |---|---|---|---|
//! | 入口 | `-p` | `-p`（与 Claude 同构） | `exec` |
//! | 输出 | `--output-format stream-json` | 同左 | `--json` |
//! | 沙箱 | 权限系统（`--allowedTools`） | 同左（待真机确认） | `-s read-only/workspace-write/…` |
//! | 正文 | `result.result` 是终稿 | 同左 | 多段 `agent_message` 拼接 |
//!
//! 所以解析器按「形状」分三份：claude/csc 共用一份（它们的 JSONL 是同一套），
//! codex 一份，custom（纯文本）一份。
//!
//! # 两条硬规矩
//!
//! * **prompt 只走 stdin**，绝不出现在 argv 里（避免命令行长度上限和引号问题，
//!   也让「参数里没有用户内容」这条安全性质成立）。
//! * 纯逻辑：`plan()` 和 `parse_line()` 都不碰 IO，毫秒级单测能穷举。

mod claude;
mod codex;
mod custom;

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::error::GroupError;

pub use claude::{CSC, CLAUDE};
pub use codex::CODEX;
pub use custom::CUSTOM;

/// 成员是哪一家 CLI。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CliKind {
    Claude,
    Csc,
    Codex,
    Custom,
}

impl CliKind {
    /// 没填 `command` 时用的程序名。
    pub fn default_program(self) -> &'static str {
        match self {
            CliKind::Claude => "claude",
            CliKind::Csc => "csc",
            CliKind::Codex => "codex",
            CliKind::Custom => "",
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            CliKind::Claude => "claude",
            CliKind::Csc => "csc",
            CliKind::Codex => "codex",
            CliKind::Custom => "custom",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "claude" => Some(CliKind::Claude),
            "csc" => Some(CliKind::Csc),
            "codex" => Some(CliKind::Codex),
            "custom" => Some(CliKind::Custom),
            _ => None,
        }
    }
}

/// 成员的权限档位。
///
/// ⚠️ **这不是安全边界，是各家 CLI 自己的权限配置**：
/// * codex 的 `workspace-write` 是真沙箱（系统级）；
/// * claude / csc 的 `--allowedTools` 是它们自己的权限系统 —— 能挡住工具调用，
///   但不是 OS 沙箱。
///
/// UI 必须把这句话写出来（HANDOFF 里也记了）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Permission {
    ReadOnly,
    WorkspaceWrite,
    Full,
}

impl Permission {
    pub fn as_str(self) -> &'static str {
        match self {
            Permission::ReadOnly => "read-only",
            Permission::WorkspaceWrite => "workspace-write",
            Permission::Full => "full",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "readOnly" | "read-only" => Some(Permission::ReadOnly),
            "workspaceWrite" | "workspace-write" => Some(Permission::WorkspaceWrite),
            "full" => Some(Permission::Full),
            _ => None,
        }
    }
}

/// 一轮的发言方式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TurnMode {
    /// 顺序接力：后发言的成员能看到**本轮**前面成员的回答。
    Sequential,
    /// 并行：本轮互相看不到（下一轮历史里能看到）。
    Parallel,
}

impl TurnMode {
    pub fn as_str(self) -> &'static str {
        match self {
            TurnMode::Sequential => "sequential",
            TurnMode::Parallel => "parallel",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "sequential" => Some(TurnMode::Sequential),
            "parallel" => Some(TurnMode::Parallel),
            _ => None,
        }
    }
}

/// 一个成员在一次运行里的**快照**（改配置只影响下一轮）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberSpec {
    pub id: String,
    pub name: String,
    pub kind: CliKind,
    /// 空 = 用 `kind.default_program()`；custom 必填。
    pub command: String,
    pub model: String,
    pub role_prompt: String,
    pub permission: Permission,
    /// 原样追加到 argv 末尾的逃生口（不经 shell）。csc 的 `--bare` 也走这里。
    pub extra_args: Vec<String>,
}

/// 测试注入点：把「要跑的程序」换成一个桩程序。生产永远 `None`。
///
/// `prefix_args` 放在真程序名之后、adapter 参数之前（Windows 的 `.cmd`
/// 启动器、测试桩都用它）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProgramOverride {
    pub program: String,
    pub prefix_args: Vec<String>,
}

/// 跑一个成员需要的一切。
#[derive(Debug, Clone)]
pub struct RunSpec {
    pub member: MemberSpec,
    pub workspace: PathBuf,
    pub prompt: String,
    pub timeout: std::time::Duration,
    pub turn_id: String,
    pub program_override: Option<ProgramOverride>,
    /// 额外环境变量（例如 csc 在 Windows 上需要的 `COSTRICT_GIT_BASH_PATH`）。
    pub env: Vec<(String, String)>,
}

/// 「要跑什么」的完整描述。`proc::spawn` 只认这个，不认识任何一家 CLI。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandPlan {
    pub program: String,
    /// 启动器前缀（Windows `.cmd` → `cmd.exe /D /S /C`；正常程序为空）。
    pub prefix_args: Vec<String>,
    pub args: Vec<String>,
    pub stdin: Option<String>,
    pub cwd: PathBuf,
    pub env: Vec<(String, String)>,
}

/// 解析一行 stdout 得到的语义事件。
///
/// ⚠️ `FinalText` 是**权威终稿**（claude 的 `result.result`）：收到之后，
/// 运行层用它覆盖已经流式累积的文本 —— 不要追加，否则正文会重复。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AdapterEvent {
    TextDelta(String),
    FinalText(String),
    SessionId(String),
    ToolStarted {
        tool_id: Option<String>,
        name: String,
        display: String,
    },
    ToolFinished {
        tool_id: Option<String>,
        name: String,
        is_error: bool,
        display: String,
    },
    /// 用量（JSON 字符串，原样给前端展示/存库）。
    Usage(String),
    /// 非致命提示（重试、降级、服务端警告）。
    Notice(String),
}

/// 一个 CLI 适配器。实现必须是纯逻辑（`plan` 不碰 IO、`parse_line` 不碰状态）。
pub trait Adapter: Send + Sync {
    fn kind(&self) -> CliKind;
    fn plan(&self, spec: &RunSpec) -> Result<CommandPlan, GroupError>;
    fn parse_line(&self, line: &str) -> Vec<AdapterEvent>;
}

pub fn adapter_for(kind: CliKind) -> &'static dyn Adapter {
    match kind {
        CliKind::Claude => &CLAUDE,
        CliKind::Csc => &CSC,
        CliKind::Codex => &CODEX,
        CliKind::Custom => &CUSTOM,
    }
}

/// 各 adapter 共用的骨架：程序怎么定、环境变量、stdin。
pub(crate) fn base_plan(spec: &RunSpec, args: Vec<String>) -> Result<CommandPlan, GroupError> {
    let (program, prefix_args) = match &spec.program_override {
        Some(o) => (o.program.clone(), o.prefix_args.clone()),
        None => {
            let configured = spec.member.command.trim();
            let program = if configured.is_empty() {
                spec.member.kind.default_program().to_string()
            } else {
                configured.to_string()
            };
            if program.is_empty() {
                return Err(GroupError::bad_input(format!(
                    "成员「{}」是自定义工具，必须填命令",
                    spec.member.name
                )));
            }
            (program, Vec::new())
        }
    };

    Ok(CommandPlan {
        program,
        prefix_args,
        args,
        stdin: Some(spec.prompt.clone()),
        cwd: spec.workspace.clone(),
        env: vec![
            (
                "DEVTOOLKIT_GROUP_MEMBER_ID".to_string(),
                spec.member.id.clone(),
            ),
            (
                "DEVTOOLKIT_GROUP_MEMBER_NAME".to_string(),
                spec.member.name.clone(),
            ),
            (
                "DEVTOOLKIT_GROUP_WORKSPACE".to_string(),
                spec.workspace.display().to_string(),
            ),
            (
                "DEVTOOLKIT_PERMISSION".to_string(),
                spec.member.permission.as_str().to_string(),
            ),
            (
                "DEVTOOLKIT_GROUP_TURN_ID".to_string(),
                spec.turn_id.clone(),
            ),
        ]
        .into_iter()
        .chain(spec.env.iter().cloned())
        .collect(),
    })
}

/// 把工具调用变成一行给人看的文案（消息里的工具行）。
///
/// 只认最常见的几类；认不出来就退回工具名 —— 宁可少说，不要编。
pub(crate) fn tool_display(name: &str, input: &serde_json::Value) -> String {
    let path = input["file_path"]
        .as_str()
        .or_else(|| input["path"].as_str())
        .or_else(|| input["notebook_path"].as_str());
    match name {
        "Read" | "read_file" => path.map(|p| format!("读 {p}")).unwrap_or_else(|| "读文件".into()),
        "Edit" | "edit_file" | "Write" | "write_file" | "MultiEdit" => {
            path.map(|p| format!("写 {p}")).unwrap_or_else(|| "写文件".into())
        }
        "Bash" | "run_command" => input["command"]
            .as_str()
            .map(|c| format!("运行 {c}"))
            .unwrap_or_else(|| "运行命令".into()),
        "Grep" => input["pattern"]
            .as_str()
            .map(|p| format!("搜索 {p}"))
            .unwrap_or_else(|| "搜索".into()),
        "Glob" => input["pattern"]
            .as_str()
            .map(|p| format!("找 {p}"))
            .unwrap_or_else(|| "找文件".into()),
        _ => name.to_string(),
    }
}
