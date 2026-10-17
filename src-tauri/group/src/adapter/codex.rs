//! Codex（`codex exec --json`）的适配器。
//!
//! # 和 claude 的三个形状差异
//!
//! 1. **正文是多段拼起来的**：每条 `item.completed` + `agent_message` 是一段，
//!    要 `push_str`；claude 那边是「增量 + 权威终稿覆盖」。
//! 2. **工具事件按 item 来**：`item.started` / `item.completed`，用 `item.id` 配对。
//! 3. **必须带 `--skip-git-repo-check`**：群的工作目录不一定是 git 仓库，
//!    少了它 codex 会直接拒绝启动 —— 这是最容易在真机才发现的坑。
//!
//! ⚠️ 本机 `codex exec --help` 已核对（2026-10-17）：`-s read-only|workspace-write|
//! danger-full-access`、`--json`、`-m`、`--skip-git-repo-check` 都在。
//! 事件字段名按本机实跑抓到的 `agent_message` / `turn.completed` 写；命令执行
//! 的字段（`command` / `exit_code`）按官方 JSONL 形状做**防御性解析**：缺字段就
//! 退回不带细节的文案，不 panic。

use serde_json::Value;

use super::{base_plan, Adapter, AdapterEvent, CliKind, CommandPlan, Permission, RunSpec};
use crate::error::GroupError;

pub struct CodexAdapter;

pub static CODEX: CodexAdapter = CodexAdapter;

impl Adapter for CodexAdapter {
    fn kind(&self) -> CliKind {
        CliKind::Codex
    }

    fn plan(&self, spec: &RunSpec) -> Result<CommandPlan, GroupError> {
        let mut args: Vec<String> = vec![
            "exec".into(),
            "--json".into(),
            // ⚠️ 群的工作目录不一定是 git 仓库；少了它 codex 直接不启动。
            "--skip-git-repo-check".into(),
        ];

        match spec.member.permission {
            Permission::ReadOnly => {
                args.push("-s".into());
                args.push("read-only".into());
            }
            Permission::WorkspaceWrite => {
                args.push("-s".into());
                args.push("workspace-write".into());
            }
            // ⚠️ 极危险：跳过所有审批和沙箱。UI 上 full 档必须红色警告。
            Permission::Full => args.push("--dangerously-bypass-approvals-and-sandbox".into()),
        }

        if !spec.member.model.trim().is_empty() {
            args.push("-m".into());
            args.push(spec.member.model.trim().to_string());
        }

        args.extend(spec.member.extra_args.iter().cloned());
        base_plan(spec, args)
    }

    fn parse_line(&self, line: &str) -> Vec<AdapterEvent> {
        parse_codex_line(line)
    }
}

fn parse_codex_line(line: &str) -> Vec<AdapterEvent> {
    let Ok(v) = serde_json::from_str::<Value>(line) else {
        return Vec::new();
    };

    let mut out = Vec::new();
    match v["type"].as_str() {
        Some("thread.started") => {
            if let Some(id) = v["thread_id"].as_str() {
                out.push(AdapterEvent::SessionId(id.to_string()));
            }
        }
        Some("item.started") => {
            let item = &v["item"];
            if let Some(ev) = codex_item_event(item, false) {
                out.push(ev);
            }
        }
        Some("item.completed") => {
            let item = &v["item"];
            match item["type"].as_str() {
                // 正文是**一段段**来的：每段都追加（运行层负责拼接）。
                Some("agent_message") => {
                    if let Some(text) = item["text"].as_str() {
                        out.push(AdapterEvent::TextDelta(text.to_string()));
                    }
                }
                Some("file_change") => {
                    // 文件改动只有一个完成事件：补一条 Started，前端才有行可收尾。
                    out.push(AdapterEvent::ToolStarted {
                        tool_id: item["id"].as_str().map(str::to_string),
                        name: "file_change".into(),
                        display: codex_file_display(item),
                    });
                    out.push(AdapterEvent::ToolFinished {
                        tool_id: item["id"].as_str().map(str::to_string),
                        name: "file_change".into(),
                        is_error: item["status"].as_str() == Some("failed"),
                        display: codex_file_display(item),
                    });
                }
                _ => {
                    if let Some(ev) = codex_item_event(item, true) {
                        out.push(ev);
                    }
                }
            }
        }
        Some("turn.completed") => {
            if let Some(u) = v.get("usage") {
                out.push(AdapterEvent::Usage(
                    serde_json::json!({ "usage": u }).to_string(),
                ));
            }
        }
        Some("error") => {
            if let Some(msg) = v["message"].as_str() {
                out.push(AdapterEvent::Notice(msg.to_string()));
            }
        }
        Some("turn.failed") => {
            let msg = v["error"]["message"].as_str().unwrap_or("这一轮失败了");
            out.push(AdapterEvent::Notice(msg.to_string()));
        }
        _ => {}
    }
    out
}

/// `command_execution` 的 started/finished 两种状态。
fn codex_item_event(item: &Value, finished: bool) -> Option<AdapterEvent> {
    if item["type"].as_str() != Some("command_execution") {
        return None;
    }
    let id = item["id"].as_str().map(str::to_string);
    let command = item["command"].as_str().unwrap_or("");
    let display = if command.is_empty() {
        "运行命令".to_string()
    } else {
        format!("运行 {command}")
    };
    Some(if finished {
        AdapterEvent::ToolFinished {
            tool_id: id,
            name: "command".into(),
            is_error: item["exit_code"].as_i64().is_some_and(|c| c != 0),
            display,
        }
    } else {
        AdapterEvent::ToolStarted {
            tool_id: id,
            name: "command".into(),
            display,
        }
    })
}

/// 文件改动：`changes` 里取第一个路径（缺了就只说「改文件」）。
fn codex_file_display(item: &Value) -> String {
    let path = item["changes"]
        .as_array()
        .and_then(|changes| changes.first())
        .and_then(|c| c["path"].as_str());
    path.map(|p| format!("改 {p}")).unwrap_or_else(|| "改文件".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapter::MemberSpec;

    fn spec(permission: Permission) -> RunSpec {
        RunSpec {
            member: MemberSpec {
                id: "m1".into(),
                name: "乙".into(),
                kind: CliKind::Codex,
                command: String::new(),
                model: String::new(),
                role_prompt: String::new(),
                permission,
                extra_args: vec![],
            },
            workspace: std::path::PathBuf::from("/work"),
            prompt: "你好".into(),
            timeout: std::time::Duration::from_secs(10),
            turn_id: "t1".into(),
            program_override: None,
        }
    }

    #[test]
    fn argv_必须带_skip_git_repo_check() {
        let plan = CODEX.plan(&spec(Permission::ReadOnly)).unwrap();
        assert_eq!(plan.program, "codex");
        assert_eq!(&plan.args[..2], ["exec", "--json"]);
        assert!(plan.args.iter().any(|a| a == "--skip-git-repo-check"));
        assert!(!plan.args.iter().any(|a| a == "你好"));
    }

    #[test]
    fn 权限三档_逐字面量() {
        let ro = CODEX.plan(&spec(Permission::ReadOnly)).unwrap();
        assert!(ro.args.windows(2).any(|w| w == ["-s", "read-only"]));

        let rw = CODEX.plan(&spec(Permission::WorkspaceWrite)).unwrap();
        assert!(rw.args.windows(2).any(|w| w == ["-s", "workspace-write"]));

        let full = CODEX.plan(&spec(Permission::Full)).unwrap();
        assert!(full
            .args
            .iter()
            .any(|a| a == "--dangerously-bypass-approvals-and-sandbox"));
    }

    // 本机实跑抓到的形状（knowledge/runner.rs 同源）
    const AGENT_LINE: &str = r#"{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"你好"}}"#;
    const TURN_LINE: &str = r#"{"type":"turn.completed","usage":{"input_tokens":11255,"output_tokens":18}}"#;

    #[test]
    fn 解析正文_逐段追加() {
        assert_eq!(
            CODEX.parse_line(AGENT_LINE),
            vec![AdapterEvent::TextDelta("你好".into())]
        );
    }

    #[test]
    fn 解析用量() {
        match &CODEX.parse_line(TURN_LINE)[0] {
            AdapterEvent::Usage(u) => assert!(u.contains("input_tokens")),
            other => panic!("该是 Usage：{other:?}"),
        }
    }

    #[test]
    fn 命令执行_started_和_completed_按_id_配对() {
        let started = r#"{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"ls -la"}}"#;
        let finished = r#"{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"ls -la","exit_code":0}}"#;
        assert_eq!(
            CODEX.parse_line(started),
            vec![AdapterEvent::ToolStarted {
                tool_id: Some("item_1".into()),
                name: "command".into(),
                display: "运行 ls -la".into(),
            }]
        );
        assert_eq!(
            CODEX.parse_line(finished),
            vec![AdapterEvent::ToolFinished {
                tool_id: Some("item_1".into()),
                name: "command".into(),
                is_error: false,
                display: "运行 ls -la".into(),
            }]
        );
    }

    #[test]
    fn 非零退出算失败() {
        let failed = r#"{"type":"item.completed","item":{"id":"i","type":"command_execution","command":"false","exit_code":1}}"#;
        match &CODEX.parse_line(failed)[0] {
            AdapterEvent::ToolFinished { is_error, .. } => assert!(is_error),
            other => panic!("该是 ToolFinished：{other:?}"),
        }
    }

    #[test]
    fn 线程事件带_session_id() {
        assert_eq!(
            CODEX.parse_line(r#"{"type":"thread.started","thread_id":"th_1"}"#),
            vec![AdapterEvent::SessionId("th_1".into())]
        );
    }

    #[test]
    fn 非_json_行静默跳过() {
        assert!(CODEX.parse_line("普通输出").is_empty());
    }
}
