//! Devtoolkit 的**群组协作**内核：把本机多个 CLI 当群成员，在一条聊天时间线上协作。
//!
//! # 一句话模型
//!
//! **群成员 = 无头一次性 CLI 进程**。一轮 = 按顺序（默认）或并行跑选中的成员，
//! 把各自的 JSONL 事件汇进同一条时间线；成员通过提示词里的群聊记录看到彼此。
//!
//! ⚠️ 这**不是**「智能体会话」模块里的那个终端。那边是交互式 PTY（TUI 输出是
//! 转义序列，拼不成聊天记录），这边是无头模式（`claude -p` / `codex exec` /
//! `csc -p`）。同一个 CLI 的两种用法，别混。
//!
//! # 分层
//!
//! 和其它内核一样**不依赖 Tauri**（脱离 WebKit/GTK 跑测试），命令层只做搬运：
//!
//! * [`adapter`]：每家的命令构造 + JSONL 解析（claude/csc 共用，codex 一份，custom 一份）
//! * [`prompt`]：上下文预算 + 提示词组装（纯函数，可穷举）
//! * [`proc`]：起进程、并发读两条管道、超时/取消、**杀整棵进程树**（唯一 unsafe 区）
//! * [`store`]：SQLite（群/成员/轮次/消息），场景化文件名在命令层算
//! * [`turn`]：一轮的调度（顺序接力/并行、终态兜底）
//! * [`event`]：推给前端的事件协议（`seq` 严格递增，`turnFinished` 一定是最后一条）
//!
//! # 为什么不复用 knowledge 的 runner
//!
//! knowledge 的 `runner.rs` 是「跑完拿最终文本」，而群组要**逐事件**（正文增量、
//! 工具行、终稿）、要按成员分流、要并发取消和进程树回收。硬统一会把两种需求
//! 拧成一个四不像。knowledge 还带着整套文档解析依赖、又是 `forbid(unsafe_code)`
//! （杀进程组要 unsafe）。将来出现第三个消费者时，再把 `adapter`/`proc` 抽成
//! 共享 crate 单独评估 —— 现在不提前抽象。

// 只有 proc.rs 里需要 unsafe（killpg / pre_exec / Job Object 句柄）。
// 用 deny（不是 forbid）：允许那个模块显式 allow，其它模块仍然禁掉。
#![deny(unsafe_code)]

pub mod adapter;
pub mod error;
pub mod event;
pub mod proc;
pub mod prompt;
pub mod store;
pub mod turn;

pub use error::GroupError;

/// 接线自检用（照 assistant/knowledge 的做法：新 crate 漏加 `default-members`
/// 时这个测试根本不会跑，至少这里能提醒「加过 members 了吗」）。
pub fn version_marker() -> &'static str {
    "devtoolkit-group"
}

#[cfg(test)]
mod tests {
    #[test]
    fn 接线自检_这个_crate_真的在被测试() {
        assert_eq!(super::version_marker(), "devtoolkit-group");
    }
}
