//! Devtoolkit 的智能体会话内核：**本机进程**、状态事件目录、集成配置读写。
//!
//! **不依赖 tauri** —— 所以能脱离 WebKit/GTK 跑测试（包括真起进程、真杀进程树的
//! 那些）。代价和 SSH 一样：事件出口不能直接用 `tauri::ipc::Channel`，
//! 只能是 [`PtyEvent`] 的 `mpsc` 流，由 `agent_commands.rs` 在 Tauri 那一层适配。
//!
//! # 这个模块和前四个的根本差别
//!
//! 顺序图操作文件，Redis/SQL 是请求-响应，SSH 是远端的长连接双向流 ——
//! 而这里是**在用户的机器上起进程**。三件事因此变成头等大事：
//!
//! 1. **不能留孤儿进程。** 关窗格、退出应用、甚至 Devtoolkit 自己崩掉，
//!    都不能让一屏 agent 继续在后台跑。见 [`pty`] 头注释和 [`job`]。
//! 2. **要动的文件在工作区之外**（`~/.claude/settings.json`、`~/.codex/config.toml`），
//!    沙箱套不上。所以换成「路径由 Rust 算、前端只传枚举值」，见 [`integration`]。
//! 3. **状态是从外面进来的**（agent 自己的钩子往目录里写文件），
//!    那是**不可信输入**，要按白名单过滤，见 [`events`]。
//!
//! # 三块的分工
//!
//! | 模块 | 干什么 | 出口 |
//! |---|---|---|
//! | [`pty`] | 起进程、流字节、改大小、杀干净 | [`PtyEvent`] 的 mpsc |
//! | [`events`] | 读走钩子写的事件文件（读完就删） | [`RawEvent`] 的 Vec |
//! | [`integration`] | 装/看/撤钩子配置，写包装脚本 | 状态 + 可读预览 |
//!
//! [`job`]: crate::job

pub mod error;
pub mod events;
#[cfg(windows)]
mod job;
pub mod integration;
pub mod pty;
pub mod registry;

/// IPC 契约测试。`#[cfg(test)]` 但**单独一个文件**：它测的不是某个模块的
/// 内部逻辑，而是**前端和 Rust 之间那条缝**（详见文件头）。
#[cfg(test)]
mod contract;

pub use error::AgentError;
pub use events::{events_dir, RawEvent, EVENT_STATES, EVENTS_DIR_NAME};
pub use integration::{
    AgentPaths, IntegrationOutcome, IntegrationState, IntegrationStatus, IntegrationTarget,
};
pub use pty::{PtyConfig, PtyEvent, PtySession};
pub use registry::AgentRegistry;
