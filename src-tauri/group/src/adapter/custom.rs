//! 自定义工具：任何**能读 stdin、把回答写到 stdout** 的命令行程序。
//!
//! 用途：用户机器上那些还没内置适配器的 CLI（`cs`、未来的新工具）。
//!
//! # 约定
//!
//! * 命令必填（`MemberSpec.command`）；参数全部走 `extra_args`（不经 shell）。
//! * prompt 从 stdin 进去，stdout 的**每一行都原样当正文**。
//! * ⚠️ 权限档位对自定义工具**没有强制力** —— 我们只能通过
//!   `DEVTOOLKIT_PERMISSION` 环境变量把意图告诉它，挡不挡由那个程序自己决定。
//!   UI 必须显示这条警告。

use super::{base_plan, Adapter, AdapterEvent, CliKind, CommandPlan, RunSpec};
use crate::error::GroupError;

pub struct CustomAdapter;

pub static CUSTOM: CustomAdapter = CustomAdapter;

impl Adapter for CustomAdapter {
    fn kind(&self) -> CliKind {
        CliKind::Custom
    }

    fn plan(&self, spec: &RunSpec) -> Result<CommandPlan, GroupError> {
        base_plan(spec, spec.member.extra_args.clone())
    }

    fn parse_line(&self, line: &str) -> Vec<AdapterEvent> {
        vec![AdapterEvent::TextDelta(format!("{line}\n"))]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapter::{MemberSpec, Permission};

    fn spec(command: &str) -> RunSpec {
        RunSpec {
            member: MemberSpec {
                id: "m1".into(),
                name: "丙".into(),
                kind: CliKind::Custom,
                command: command.into(),
                model: String::new(),
                role_prompt: String::new(),
                permission: Permission::ReadOnly,
                extra_args: vec!["--fast".into()],
            },
            workspace: std::path::PathBuf::from("/work"),
            prompt: "讲讲".into(),
            timeout: std::time::Duration::from_secs(10),
            turn_id: "t1".into(),
            program_override: None,
            env: vec![],
        }
    }

    #[test]
    fn argv_就是命令加额外参数_prompt_走_stdin() {
        let plan = CUSTOM.plan(&spec("my-agent")).unwrap();
        assert_eq!(plan.program, "my-agent");
        assert_eq!(plan.args, ["--fast"]);
        assert_eq!(plan.stdin.as_deref(), Some("讲讲"));
    }

    #[test]
    fn 每行原样成为正文_保留换行() {
        assert_eq!(
            CUSTOM.parse_line("第一行"),
            vec![AdapterEvent::TextDelta("第一行\n".into())]
        );
    }
}
