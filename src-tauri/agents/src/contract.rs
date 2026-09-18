//! IPC 契约。
//!
//! # 为什么这组测试非有不可
//!
//! 前端和 Rust 之间那条缝**两边的测试都盖不到**：
//!
//! - 浏览器版 e2e 走 `services/web.ts` 的假实现，**根本不经过 serde**；
//! - Rust 的集成测试在 Rust 里构造 `PtyConfig`，**不经过反序列化**。
//!
//! 所以字段名对不上这种错会一路溜到真机才炸，报的还是
//! `missing field '...'` 这种让人摸不着头脑的话。SSH 那边已经踩过一次
//! （枚举上的 `rename_all` 不改变体内部的字段名，见 HANDOFF 的「踩过的坑」）。
//!
//! 规矩：**拿前端实际会发出来的那个 JSON 字面量去反序列化，手写字段名**，
//! 不照着 Rust 结构体拼 —— 否则就变成自己跟自己对了。
//! 字面量的来源是 `src/modules/agents/core/types.ts` 和 `services/tauri.ts`。

use crate::events::{events_dir, RawEvent};
use crate::integration::{
    AgentPaths, IntegrationOutcome, IntegrationState, IntegrationStatus, IntegrationTarget,
};
use crate::pty::{PtyConfig, PtyEvent};
use base64::Engine as _;

/// `agent_open(id, config, channel)` 里前端发出来的 `config`。
///
/// 逐字照着前端会构造的那个对象写：全部字段都出现（包括 null 的 shell），
/// 因为那正是 `services/tauri.ts` 最容易写成「有值才带」的地方。
#[test]
fn 前端发来的开窗格参数能解出来() {
    let raw = r#"{
        "cwd": "D:\\work\\api",
        "shell": null,
        "command": "claude",
        "cols": 120,
        "rows": 30,
        "env": {
            "DEVTOOLKIT_PANE_ID": "pane_k3f9x2a1",
            "DEVTOOLKIT_EVENT_DIR": "C:\\Users\\me\\AppData\\Roaming\\com.devtoolkit.desktop\\agent-events"
        }
    }"#;

    let cfg: PtyConfig = serde_json::from_str(raw).expect("前端发来的形状必须能解出来");
    assert_eq!(cfg.cwd, "D:\\work\\api");
    assert_eq!(cfg.shell, None);
    assert_eq!(cfg.command, "claude");
    assert_eq!(cfg.cols, 120);
    assert_eq!(cfg.rows, 30);
    assert_eq!(
        cfg.env.get("DEVTOOLKIT_PANE_ID").map(String::as_str),
        Some("pane_k3f9x2a1")
    );
}

/// 可选字段整个**不出现**也要能解 —— 前端在「只是开个 shell」那条路上
/// 很可能不带 `shell` / `env`。缺了它们不该让整次调用失败。
#[test]
fn 少了可选字段也能解出来() {
    let raw = r#"{"cwd": "/tmp", "command": "", "cols": 80, "rows": 24}"#;
    let cfg: PtyConfig = serde_json::from_str(raw).expect("可选字段缺失不该让整次调用失败");
    assert_eq!(cfg.shell, None);
    assert!(cfg.env.is_empty());
}

/// 通道消息的形状。前端按 `kind` 判别联合处理。
#[test]
fn 通道消息对得上前端的判别联合() {
    let data = PtyEvent::Data {
        bytes: base64::engine::general_purpose::STANDARD.encode(b"hi"),
    };
    assert_eq!(
        serde_json::to_value(&data).expect("序列化"),
        serde_json::json!({ "kind": "data", "bytes": "aGk=" })
    );

    assert_eq!(
        serde_json::to_value(PtyEvent::Exit { code: Some(0) }).expect("序列化"),
        serde_json::json!({ "kind": "exit", "code": 0 })
    );

    // ⚠️ 被信号杀掉时退出码是 **null**，不是 0。
    // 前端要能区分「正常退出」和「被杀的」—— 写成 0 的话，
    // 「用户关掉的窗格」会被显示成「成功退出」
    assert_eq!(
        serde_json::to_value(PtyEvent::Exit { code: None }).expect("序列化"),
        serde_json::json!({ "kind": "exit", "code": null })
    );
}

/// `agent_take_events()` 的返回。
#[test]
fn 事件数组的字段名是_name_和_at() {
    let events = vec![RawEvent {
        name: "waiting.pane_k3f9x2a1".to_string(),
        at: 1_758_190_953_000,
    }];
    assert_eq!(
        serde_json::to_value(&events).expect("序列化"),
        serde_json::json!([{ "name": "waiting.pane_k3f9x2a1", "at": 1_758_190_953_000u64 }])
    );
}

/// `agent_integration_status(target)` 的返回。
#[test]
fn 集成状态是_target_path_state_preview_四个字段() {
    let status = IntegrationStatus {
        target: IntegrationTarget::Claude,
        path: "/root/.claude/settings.json".to_string(),
        state: IntegrationState::Missing,
        preview: "……".to_string(),
    };
    assert_eq!(
        serde_json::to_value(&status).expect("序列化"),
        serde_json::json!({
            "target": "claude",
            "path": "/root/.claude/settings.json",
            "state": "missing",
            "preview": "……",
        })
    );
}

/// 五个状态名是**前端的判别依据**（`state === 'installed'` 这种），
/// 改一个字就是静默失效。
///
/// 尤其 `missing` / `absent` 这一对：用户看到的文案完全不同
/// （「还没建过配置」vs「配置在，但状态检测没开」），合并了就没法说清楚。
#[test]
fn 五个状态名逐字钉死() {
    for (state, want) in [
        (IntegrationState::Missing, "missing"),
        (IntegrationState::Absent, "absent"),
        (IntegrationState::Installed, "installed"),
        (IntegrationState::Modified, "modified"),
        (IntegrationState::Unusable, "unusable"),
    ] {
        assert_eq!(serde_json::to_value(state).expect("序列化"), want);
    }
}

/// `target` 是**唯一**能影响写哪个文件的东西，所以它的字面量必须钉死
/// （安全模型见 `integration` 模块头）。
#[test]
fn 目标枚举只认小写的_claude_和_codex() {
    assert_eq!(
        serde_json::from_str::<IntegrationTarget>("\"claude\"").expect("claude 是合法值"),
        IntegrationTarget::Claude
    );
    assert_eq!(
        serde_json::from_str::<IntegrationTarget>("\"codex\"").expect("codex 是合法值"),
        IntegrationTarget::Codex
    );
    // 大小写不对、或者别的字符串都不认 —— 拼错的时候**必须在边界上就失败**，
    // 不能悄悄落到某个默认路径上去
    assert!(serde_json::from_str::<IntegrationTarget>("\"Claude\"").is_err());
    assert!(serde_json::from_str::<IntegrationTarget>("\"/etc/passwd\"").is_err());
}

/// `agent_integration_apply` / `agent_integration_revert` 的返回。
///
/// ⚠️ **撤销返回的是同一个形状**（不是一句路径字符串）—— 前端那三个动作
/// 共用一个 `IntegrationOutcome` 类型，撤销时 `backupPath` 是 `null`。
#[test]
fn 应用结果是_target_path_backup_path_preview() {
    let applied = IntegrationOutcome {
        target: IntegrationTarget::Codex,
        path: "/root/.codex/config.toml".to_string(),
        backup_path: Some("/root/.codex/config.toml.devtoolkit-20260918-112233Z.bak".to_string()),
        preview: "……".to_string(),
    };
    assert_eq!(
        serde_json::to_value(&applied).expect("序列化"),
        serde_json::json!({
            "target": "codex",
            "path": "/root/.codex/config.toml",
            "backupPath": "/root/.codex/config.toml.devtoolkit-20260918-112233Z.bak",
            "preview": "……",
        })
    );

    // 没有备份时是 **null，不是空字符串**（两种情况：原文件本来就不存在、
    // 或者这是撤销）。空字符串会让前端显示「备份在 」
    let applied = IntegrationOutcome {
        target: IntegrationTarget::Codex,
        path: "/root/.codex/config.toml".to_string(),
        backup_path: None,
        preview: String::new(),
    };
    assert_eq!(
        serde_json::to_value(&applied).expect("序列化")["backupPath"],
        serde_json::json!(null)
    );
}

/// 事件目录是应用数据目录下的固定子目录 —— 前端要拿它去比对
/// `DEVTOOLKIT_EVENT_DIR` 是不是同一个地方。
#[test]
fn 事件目录在应用数据目录下面() {
    let dir = events_dir(std::path::Path::new("/data/app"));
    assert!(dir.starts_with("/data/app"));
    assert!(dir.ends_with("agent-events"));
}

/// 路径全由 Rust 算，前端只传枚举值。这条测试盯着**这件事本身**：
/// 三个路径都必须从 `AgentPaths` 的字段拼出来。
#[test]
fn 三个路径都从主目录和数据目录拼出来() {
    let paths = AgentPaths {
        home: std::path::PathBuf::from("/home/me"),
        data_dir: std::path::PathBuf::from("/data/app"),
    };
    assert_eq!(
        paths.claude_settings(),
        std::path::PathBuf::from("/home/me/.claude/settings.json")
    );
    assert_eq!(
        paths.codex_config(),
        std::path::PathBuf::from("/home/me/.codex/config.toml")
    );
    assert!(paths.hook_script().starts_with("/data/app"));
}
