//! 拿**真的 Codex** 校验我们生成的 `config.toml`。
//!
//! 和 `claude_schema.rs` 是同一件事的两半：那边用 `claude doctor` 验 `settings.json`，
//! 这边用 `codex doctor` 验 `config.toml`。
//!
//! `codex doctor` 会读 `$CODEX_HOME/config.toml` 并把解析结果报出来：
//!
//! ```text
//! $ CODEX_HOME=<临时目录> codex doctor
//!   ✓ config       loaded
//!       config.toml            /tmp/.../config.toml
//!       config.toml parse      ok
//! ```
//!
//! 解析不了的时候是 `✗ config  config could not be loaded`。
//!
//! # 这条能抓到什么
//!
//! **TOML 的转义**。Windows 上路径里的 `\` 在 TOML 里是转义符 ——
//! `notify = ["C:\Users\me\hook.cmd"]` 是**非法 TOML**，整个配置文件读不出来。
//! 我们自己的测试能验字符串拼得对不对（`windows_路径的反斜杠会被转义`），
//! 但**只有真的解析器**能回答「这个文件 Codex 认不认」。
//!
//! # ⚠️ 这组测试**不在 CI 里**
//!
//! 它要求机器上装了 Codex（和 `claude_schema` 一样），CI 上是显式列测试目标跑的。
//! 没装的时候**明确失败并给安装命令**，不静默跳过。
//!
//! ```bash
//! cd src-tauri && cargo test -p devtoolkit-agents --test codex_schema
//! ```

mod common;

use std::path::Path;
use std::process::Command;

use common::TempDir;
use devtoolkit_agents::integration::{apply, AgentPaths, IntegrationTarget};

/// codex 可执行文件的绝对路径。找不到就**明确失败**。
fn codex_bin() -> String {
    let finder = if cfg!(windows) { "where" } else { "which" };
    let out = Command::new(finder)
        .arg("codex")
        .output()
        .unwrap_or_else(|e| panic!("调不动 {finder}：{e}"));

    if !out.status.success() {
        panic!(
            "这台机器上没有 Codex CLI，跑不了这组测试。装一个：\n\
             \x20   npm install -g @openai/codex\n\
             （CI 上不跑它 —— 见文件头。刻意不静默跳过：跳过了就没人知道它没跑。）"
        );
    }

    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or_else(|| panic!("{finder} 说找到了 codex，但没给出路径"))
        .to_string()
}

/// 让 Codex 读 `codex_home` 这个目录下的 config.toml。
fn doctor(codex_home: &Path) -> String {
    let out = Command::new(codex_bin())
        .arg("doctor")
        .env("CODEX_HOME", codex_home)
        .output()
        .expect("跑 codex doctor");

    format!(
        "{}\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    )
}

/// 我们生成的 `notify` 配置，真 Codex 能读。
#[test]
fn 生成的_notify_能被真_codex_接受() {
    let base = TempDir::new("codex-schema");
    let home = base.path().join("home");
    let paths = AgentPaths {
        home: home.clone(),
        data_dir: base.path().join("data"),
    };
    std::fs::create_dir_all(&home).expect("建临时主目录");

    // 用户的配置里已经有点东西（我们要保证插进去之后它照样能被读）
    let codex_home = paths.codex_config().parent().unwrap().to_path_buf();
    std::fs::create_dir_all(&codex_home).expect("建 .codex");
    std::fs::write(
        paths.codex_config(),
        "model = \"gpt-5\"\n\n[tui]\nnotifications = true\n",
    )
    .expect("写用户配置");

    apply(&paths, IntegrationTarget::Codex).expect("装上 notify");

    let text = doctor(&codex_home);
    assert!(
        !text.contains("could not be loaded"),
        "Codex 说我们写的 config.toml 读不了：\n{text}"
    );
    assert!(
        text.contains("parse") && text.contains("ok"),
        "doctor 没报解析结果，这条断言就没意义：\n{text}"
    );
}

/// ⚠️ **反向验证：`codex doctor` 真的会报错。**
///
/// 证明上面那条不是假绿 —— 一个坏掉的 config.toml 必须被它挑出来。
/// （坏法的选择也有讲究：`notify = [` 是**没闭合的数组**，正是我们最怕的那类
/// 手写错误；真出现的话 Codex 会整个配置读不出来，用户看到的是「Devtoolkit
/// 弄坏了我的 Codex」。）
#[test]
fn doctor_真的会挑出坏配置() {
    let base = TempDir::new("codex-schema-negative");
    let codex_home = base.path().join("home").join(".codex");
    std::fs::create_dir_all(&codex_home).expect("建 .codex");
    std::fs::write(codex_home.join("config.toml"), "notify = [\n").expect("写坏配置");

    let text = doctor(&codex_home);
    assert!(
        text.contains("could not be loaded"),
        "doctor 没挑出这个明显坏掉的 TOML，那上面那条测试就是假绿的：\n{text}"
    );
}
