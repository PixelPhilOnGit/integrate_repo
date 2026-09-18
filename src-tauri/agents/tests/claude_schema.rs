//! 拿**真的 Claude Code** 校验我们生成的 `settings.json`。
//!
//! # 为什么这组测试值得单独存在
//!
//! 别的地方验的都是「我们自己觉得对」：字段名前后端对得上（`contract` 测试）、
//! 合并逻辑对（`integration` 测试）。但**钩子的 JSON 结构是不是 Claude Code
//! 认的那个**，只有它自己能回答。写错的后果是静默失效 —— 配置在文件里躺着、
//! 界面上显示「已启用」、状态点永远不动。
//!
//! `claude doctor` 会读 `~/.claude/settings.json` 并把不合法的地方逐条列出来
//! （`Invalid settings` 那一段），正好是现成的校验器：
//!
//! ```text
//! $ HOME=<临时目录> claude doctor
//! Invalid settings
//! - .../settings.json › hooks.Stop.0.hooks.0.type: Unknown hook type "shell"; ...
//! ```
//!
//! 所以这个文件做的事就是：**用我们自己的代码往一个临时 HOME 里装一遍，
//! 然后让真 Claude Code 去读它**。
//!
//! # ⚠️ 这组测试**不在 CI 里**
//!
//! 它要求机器上装了 Claude Code（CI 的 runner 上没有），所以在
//! `.github/workflows/release.yml` 里是**显式列出测试目标**跑的，
//! 和 SSH 那组打真 `sshd` 的同一个待遇。
//!
//! 手工跑：
//!
//! ```bash
//! cd src-tauri && cargo test -p devtoolkit-agents --test claude_schema
//! ```
//!
//! 没装的时候它**明确失败并给出安装命令**，不静默跳过 —— 静默跳过等于这条
//! 测试永远不跑，而没人会发现（这是这个仓库的约定）。

mod common;

use std::path::Path;
use std::process::Command;

use common::TempDir;
use devtoolkit_agents::integration::{apply, AgentPaths, IntegrationTarget};

/// claude 可执行文件的绝对路径。找不到就**明确失败**。
fn claude_bin() -> String {
    let finder = if cfg!(windows) { "where" } else { "which" };
    let out = Command::new(finder)
        .arg("claude")
        .output()
        .unwrap_or_else(|e| panic!("调不动 {finder}：{e}"));

    if !out.status.success() {
        panic!(
            "这台机器上没有 Claude Code，跑不了这组测试。装一个：\n\
             \x20   npm install -g @anthropic-ai/claude-code\n\
             （CI 上不跑它 —— 见文件头。刻意不静默跳过：跳过了就没人知道它没跑。）"
        );
    }

    let path = String::from_utf8_lossy(&out.stdout);
    let first = path
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or_else(|| panic!("{finder} 说找到了 claude，但没给出路径"));
    first.to_string()
}

/// 用真的 CLI 读一遍那个临时 HOME 里的 settings.json。
fn doctor(home: &Path) -> String {
    let out = Command::new(claude_bin())
        .arg("doctor")
        .env("HOME", home)
        // 免得继承到调用者自己的配置目录，那会让这组测试读错文件
        .env_remove("CLAUDE_CONFIG_DIR")
        .output()
        .expect("跑 claude doctor");

    format!(
        "{}\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    )
}

/// 我们生成的钩子配置，真 Claude Code 认。
#[test]
fn 生成的_hooks_能被真_claude_接受() {
    let base = TempDir::new("claude-schema");
    let home = base.path().join("home");
    let paths = AgentPaths {
        home: home.clone(),
        data_dir: base.path().join("data"),
    };
    std::fs::create_dir_all(&home).expect("建临时主目录");

    apply(&paths, IntegrationTarget::Claude).expect("装上钩子");

    let text = doctor(&home);
    assert!(
        !text.contains("Invalid settings"),
        "Claude Code 说我们写的配置不合法：\n{text}"
    );

    // 光看「没有 Invalid settings」是不够的 —— doctor 要是根本没读到文件
    // （HOME 没生效、路径不对），这条测试会**假绿**。所以要确认它真的跑起来了
    assert!(
        text.contains("Claude Code doctor"),
        "doctor 没跑起来，这组断言就没意义：\n{text}"
    );
}

/// ⚠️ **反向验证：`doctor` 真的会报错。**
///
/// 上面那条测试的全部价值在于「doctor 会挑毛病」。所以要证明它**挑得出来** ——
/// 不然它可能只是个永远打印「No installation issues found」的程序，
/// 而我们会一直以为自己是对的。
///
/// 这也是 HANDOFF 里那条教训的正身：`type` 只能是 `command`，写成别的
/// （比如很多人会写的 `shell`）就是无效条目 —— 而**无效条目是被忽略的**，
/// 钩子不生效但也不报错。
#[test]
fn doctor_真的会挑出坏配置() {
    let base = TempDir::new("claude-schema-negative");
    let home = base.path().join("home");
    std::fs::create_dir_all(home.join(".claude")).expect("建 .claude");

    std::fs::write(
        home.join(".claude").join("settings.json"),
        r#"{
  "hooks": {
    "Stop": [ { "hooks": [ { "type": "shell", "command": "/bin/true" } ] } ]
  }
}"#,
    )
    .expect("写坏配置");

    let text = doctor(&home);
    assert!(
        text.contains("Invalid settings") && text.contains("Unknown hook type"),
        "doctor 没挑出这个明显错的配置，那上面那条测试就是假绿的：\n{text}"
    );
}
