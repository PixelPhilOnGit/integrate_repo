//! 助手内核：自研 LLM agent（ReAct 循环 / 两套 provider / 工具 / 上下文策略）。
//!
//! # 三条和仓库其他内核一致的规矩
//!
//! * **不依赖 Tauri**。事件出口是一条 mpsc 流，`assistant_commands.rs` 在 Tauri
//!   那一层把它适配成 `tauri::ipc::Channel` —— 和 ssh / agents 两处同一个形状。
//!   这样它才能脱离 WebKit 跑 `cargo test -p devtoolkit-assistant`。
//! * **可能替换的第三方实现隔离在单文件里**（`transport.rs` 里的 HTTP/TLS、
//!   三期的 `vector/` 里的 LanceDB），照 `pty.rs` 只出现一个 `portable-pty` 的先例。
//! * **错误类型手写 `Display`、中文、可行动**，按失败域拆开 —— 命令层直接把
//!   `to_string()` 喂给前端，所以每一句都是用户会读到的。
//!
//! # ⚠️ 别和 `devtoolkit-agents` 搞混
//!
//! | | `devtoolkit-agents` | 这个 |
//! |---|---|---|
//! | 跑的是什么 | **别人的 CLI**（claude / codex） | **我们自己的循环** |
//! | 上下文谁管 | 那些 CLI 自己管 | 我们管（所以策略才可配） |
//! | 进程在哪 | 用户的 PTY 里 | 网络请求在进程内，工具跑在项目目录里 |
//!
//! 两者的名字只差一个 `s`，但**前端模块、命令前缀、类型前缀一律用 `assistant_` /
//! `Assistant*`**，不要去蹭 `agent*` 那个命名空间（那已经被占满了）。

#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod approval;
pub mod context;
pub mod loop_runner;
pub mod message;
pub mod provider;
pub mod provider_config;
pub mod session;
pub mod sse;
pub mod transport;
pub mod tool;
pub mod turn;

#[cfg(test)]
mod wiring {
    /// 接线自检：这个 crate 进了 workspace、也进了 `default-members`。
    ///
    /// 这条测试**故意写得没有意义** —— 它存在的唯一理由是让
    /// `cargo test -p devtoolkit-assistant` 在「刚建好目录」时就能跑起来，
    /// 从而证明 `src-tauri/Cargo.toml` 的 `members` / `default-members` 两处都加对了。
    /// 漏了 `default-members` 的话，这个 crate 的测试会**静默不跑**（README 点过名），
    /// 而那是最难发现的一类错。
    #[test]
    fn crate_is_wired_into_the_workspace() {
        assert_eq!(env!("CARGO_PKG_NAME"), "devtoolkit-assistant");
        // 版本号必须和其他 crate 一致：CI 用 `src-tauri/*/Cargo.toml` 那个 glob 做一致性检查。
        assert_eq!(env!("CARGO_PKG_VERSION"), "0.7.0");
    }
}
