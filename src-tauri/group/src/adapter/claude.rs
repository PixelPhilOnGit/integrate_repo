//! Claude Code / csc（深信服 CoStrict）的适配器。
//!
//! csc 官方文档确认无头模式与 Claude 同构：
//! `csc -p "…" --output-format stream-json --verbose`，事件形状也是同一套。
//! 所以两者**共用一份解析器**，只有默认程序名不同。
//!
//! ⚠️ csc 的细节（权限 flag 是否完全一致、prompt 是否接受 stdin）**还没在真机
//! 验过** —— 这台开发机上没装 csc。真机若不一致，只改这里的 `plan()`，
//! 不要动事件协议（前端和存储都按协议写好了）。
//!
//! # claude 的正文有三份，别加错
//!
//! * `stream_event` 的 `text_delta`：实时增量（用它显示「正在打字」）；
//! * `assistant` 里的 `text`：整段重复，**忽略**（只取里面的 `tool_use`）；
//! * `result.result`：**权威终稿**（运行层收到后覆盖累积文本）。
//!
//! 三份都追加的话，界面上同一句话会出现三次。

use serde_json::Value;

use super::{
    base_plan, tool_display, Adapter, AdapterEvent, CliKind, CommandPlan, Permission, RunSpec,
};
use crate::error::GroupError;

/// claude 和 csc 共用这一个实现，`kind` 只决定默认程序名。
pub struct ClaudeAdapter {
    kind: CliKind,
}

pub static CLAUDE: ClaudeAdapter = ClaudeAdapter { kind: CliKind::Claude };
pub static CSC: ClaudeAdapter = ClaudeAdapter { kind: CliKind::Csc };

impl Adapter for ClaudeAdapter {
    fn kind(&self) -> CliKind {
        self.kind
    }

    fn plan(&self, spec: &RunSpec) -> Result<CommandPlan, GroupError> {
        let mut args: Vec<String> = vec![
            "-p".into(),
            "--output-format".into(),
            "stream-json".into(),
            // ⚠️ stream-json 必须配 --verbose（本机实跑抓到的：漏了直接失败）
            "--verbose".into(),
            "--include-partial-messages".into(),
        ];

        match spec.member.permission {
            // `-p` 模式下，不在 allowlist 里的工具会因为「没人能回答审批」
            // 而被自动拒绝 —— 这就是 read-only 的实现方式。
            Permission::ReadOnly => {
                args.push("--allowedTools".into());
                args.push("Read,Glob,Grep".into());
            }
            Permission::WorkspaceWrite => {
                args.push("--allowedTools".into());
                // ⚠️ **不含 Bash**：v1 只承诺「能改文件」，不承诺「能跑任意命令」。
                // 要跑命令的成员自己开 full，或者在 extra_args 里显式加。
                args.push("Read,Glob,Grep,Edit,Write".into());
            }
            Permission::Full => args.push("--dangerously-skip-permissions".into()),
        }

        if !spec.member.model.trim().is_empty() {
            args.push("--model".into());
            args.push(spec.member.model.trim().to_string());
        }

        // 逃生口放最后：用户可以覆盖/追加任何参数。csc 的 `--bare` 也走这里。
        args.extend(spec.member.extra_args.iter().cloned());

        base_plan(spec, args)
    }

    fn parse_line(&self, line: &str) -> Vec<AdapterEvent> {
        parse_claude_line(line)
    }
}

/// 一行 stream-json → 语义事件。**纯函数**（换行/时序之外的一切都在这里）。
fn parse_claude_line(line: &str) -> Vec<AdapterEvent> {
    // 有些行不是 JSON（stdout 前面可能混了别的东西）——跳过，不报错。
    let Ok(v) = serde_json::from_str::<Value>(line) else {
        return Vec::new();
    };

    let mut out = Vec::new();
    match v["type"].as_str() {
        Some("system") => {
            if v["subtype"].as_str() == Some("init") {
                if let Some(id) = v["session_id"].as_str() {
                    out.push(AdapterEvent::SessionId(id.to_string()));
                }
            }
        }
        Some("stream_event") => {
            let event = &v["event"];
            if event["type"].as_str() == Some("content_block_delta")
                && event["delta"]["type"].as_str() == Some("text_delta")
            {
                if let Some(text) = event["delta"]["text"].as_str() {
                    out.push(AdapterEvent::TextDelta(text.to_string()));
                }
            }
        }
        Some("assistant") => {
            // 只取工具调用 —— 正文以 stream_event / result 为准（见文件头）。
            if let Some(content) = v["message"]["content"].as_array() {
                for block in content {
                    if block["type"].as_str() != Some("tool_use") {
                        continue;
                    }
                    let name = block["name"].as_str().unwrap_or("tool").to_string();
                    out.push(AdapterEvent::ToolStarted {
                        tool_id: block["id"].as_str().map(str::to_string),
                        display: tool_display(&name, &block["input"]),
                        name,
                    });
                }
            }
        }
        Some("user") => {
            if let Some(content) = v["message"]["content"].as_array() {
                for block in content {
                    if block["type"].as_str() != Some("tool_result") {
                        continue;
                    }
                    out.push(AdapterEvent::ToolFinished {
                        tool_id: block["tool_use_id"].as_str().map(str::to_string),
                        name: String::new(),
                        is_error: block["is_error"].as_bool().unwrap_or(false),
                        display: String::new(),
                    });
                }
            }
        }
        Some("result") => {
            if let Some(text) = v["result"].as_str() {
                out.push(AdapterEvent::FinalText(text.to_string()));
            }
            if let Some(usage) = collect_usage(&v) {
                out.push(AdapterEvent::Usage(usage));
            }
        }
        _ => {}
    }
    out
}

/// 用量：`usage` + `total_cost_usd` 一起带走（前端只展示，不解析）。
fn collect_usage(v: &Value) -> Option<String> {
    let mut map = serde_json::Map::new();
    if let Some(u) = v.get("usage") {
        map.insert("usage".to_string(), u.clone());
    }
    if let Some(c) = v.get("total_cost_usd") {
        map.insert("totalCostUsd".to_string(), c.clone());
    }
    if map.is_empty() {
        None
    } else {
        Some(Value::Object(map).to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(kind: CliKind, permission: Permission) -> RunSpec {
        RunSpec {
            member: super::super::MemberSpec {
                id: "m1".into(),
                name: "甲".into(),
                kind,
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
    fn argv_基础形状_以及_stream_json_必须带_verbose() {
        let plan = CLAUDE.plan(&spec(CliKind::Claude, Permission::ReadOnly)).expect("plan");
        assert_eq!(plan.program, "claude");
        assert_eq!(
            &plan.args[..5],
            ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"]
        );
        // prompt 只在 stdin，绝不出现在 argv 里
        assert!(!plan.args.iter().any(|a| a == "你好"));
        assert_eq!(plan.stdin.as_deref(), Some("你好"));
    }

    #[test]
    fn 权限三档_逐字面量() {
        let ro = CLAUDE.plan(&spec(CliKind::Claude, Permission::ReadOnly)).unwrap();
        assert!(ro.args.windows(2).any(|w| w == ["--allowedTools", "Read,Glob,Grep"]));

        let rw = CLAUDE.plan(&spec(CliKind::Claude, Permission::WorkspaceWrite)).unwrap();
        assert!(rw.args.windows(2).any(|w| w == ["--allowedTools", "Read,Glob,Grep,Edit,Write"]));
        // ⚠️ workspace-write 不含 Bash（只承诺改文件，不承诺跑命令）
        assert!(!rw.args.iter().any(|a| a.contains("Bash")));

        let full = CLAUDE.plan(&spec(CliKind::Claude, Permission::Full)).unwrap();
        assert!(full.args.iter().any(|a| a == "--dangerously-skip-permissions"));
        assert!(!full.args.iter().any(|a| a == "--allowedTools"));
    }

    #[test]
    fn csc_用同一个解析器_只是默认程序名不同() {
        let plan = CSC.plan(&spec(CliKind::Csc, Permission::ReadOnly)).unwrap();
        assert_eq!(plan.program, "csc");
        assert_eq!(plan.args[0], "-p");
        // 同一行 csc 输出，解析结果和 claude 完全一致
        let line = r#"{"type":"result","subtype":"success","result":"好"}"#;
        assert_eq!(CSC.parse_line(line), CLAUDE.parse_line(line));
    }

    #[test]
    fn 模型和额外参数_追加在最后() {
        let mut s = spec(CliKind::Claude, Permission::ReadOnly);
        s.member.model = "opus".into();
        s.member.extra_args = vec!["--bare".into()];
        let plan = CLAUDE.plan(&s).unwrap();
        assert_eq!(&plan.args[plan.args.len() - 3..], ["--model", "opus", "--bare"]);
    }

    #[test]
    fn 空命令时用默认程序名_自定义工具必须填命令() {
        let s = spec(CliKind::Custom, Permission::ReadOnly);
        let err = super::super::CUSTOM.plan(&s).expect_err("自定义工具没填命令该报错");
        assert!(matches!(err, GroupError::BadInput { .. }));
    }

    // 下面这些 JSON 是**本机实跑抓到形状的摘录**（和 knowledge/runner.rs 的夹具同源）。
    const INIT_LINE: &str = r#"{"type":"system","subtype":"init","session_id":"sess_123"}"#;
    const DELTA_LINE: &str = r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"正在"}}}"#;
    const TOOL_LINE: &str = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_1","name":"Read","input":{"file_path":"src/a.ts"}}]}}"#;
    const TOOL_RESULT_LINE: &str = r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_1","is_error":false}]}}"#;
    const RESULT_LINE: &str = r#"{"type":"result","subtype":"success","result":"终稿","total_cost_usd":0.1,"usage":{"input_tokens":100,"output_tokens":20}}"#;

    #[test]
    fn 解析_init_拿到_session_id() {
        assert_eq!(
            CLAUDE.parse_line(INIT_LINE),
            vec![AdapterEvent::SessionId("sess_123".into())]
        );
    }

    #[test]
    fn 解析正文增量_不碰_assistant_里的整段文本() {
        assert_eq!(
            CLAUDE.parse_line(DELTA_LINE),
            vec![AdapterEvent::TextDelta("正在".into())]
        );
        // assistant 里的 text 块被忽略（否则正文重复三次）
        let with_text = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"整段"}]}}"#;
        assert!(CLAUDE.parse_line(with_text).is_empty());
    }

    #[test]
    fn 解析工具调用与结果_按_tool_id_配对() {
        let started = CLAUDE.parse_line(TOOL_LINE);
        assert_eq!(
            started,
            vec![AdapterEvent::ToolStarted {
                tool_id: Some("toolu_1".into()),
                name: "Read".into(),
                display: "读 src/a.ts".into(),
            }]
        );
        let finished = CLAUDE.parse_line(TOOL_RESULT_LINE);
        assert_eq!(
            finished,
            vec![AdapterEvent::ToolFinished {
                tool_id: Some("toolu_1".into()),
                name: String::new(),
                is_error: false,
                display: String::new(),
            }]
        );
    }

    #[test]
    fn 解析终稿和用量() {
        let events = CLAUDE.parse_line(RESULT_LINE);
        assert_eq!(events[0], AdapterEvent::FinalText("终稿".into()));
        match &events[1] {
            AdapterEvent::Usage(u) => {
                assert!(u.contains("input_tokens"));
                assert!(u.contains("totalCostUsd"));
            }
            other => panic!("第二条该是 Usage：{other:?}"),
        }
    }

    #[test]
    fn 非_json_行静默跳过_不崩() {
        assert!(CLAUDE.parse_line("这是普通输出").is_empty());
        assert!(CLAUDE.parse_line("").is_empty());
        // 合法 JSON 但认不出的类型也不崩
        assert!(CLAUDE.parse_line(r#"{"type":"未来事件"}"#).is_empty());
    }
}
