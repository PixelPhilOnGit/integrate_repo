//! Devtoolkit 的 SSH 内核：连接、认证、主机密钥校验、PTY 会话。
//!
//! **不依赖 tauri** —— 所以能脱离 WebKit/GTK 跑测试，包括打真 `sshd` 的集成测试。
//! 代价是事件出口不能直接用 `tauri::ipc::Channel`，只能是 [`TerminalEvent`] 的
//! `mpsc` 流，由 `ssh_commands.rs` 在 Tauri 那一层适配过去。
//!
//! # 和前三个模块的根本差别
//!
//! 顺序图操作文件，Redis/SQL 是请求-响应，而 SSH 是**长连接上的双向流**：
//! 一个会话开起来之后，远端会不断地推字节上来，而写、resize、关闭是三条独立的
//! 命令。所以这里没有「执行一条命令拿一个结果」那种形状 —— 只有「开一个会话，
//! 然后往里灌 / 往外收」。
//!
//! # 安全上的两条硬约定
//!
//! 1. **主机密钥默认拒绝**（russh 的 `check_server_key` 默认就返回 false）。
//!    「静默接受任何主机密钥」这个状态在代码里不存在，不是靠约定避免的。
//!    见 [`hostkey`]。
//! 2. **指纹变了永远硬停** —— 即使用户点了「信任这台新机器」，
//!    也不能把「它以前长什么样」这件事一并勾销。见 [`hostkey::judge`] 的测试。

pub mod error;
pub mod hostkey;
pub mod registry;
pub mod session;

use serde::Serialize;

pub use error::SshError;
pub use registry::{forward, SshRegistry};
pub use session::{SshAuth, SshConfig, TerminalEvent};

/// 会话开成功之后回给前端的信息。
///
/// `fingerprint` 是这次握手**实际用的**那把主机密钥的指纹，不是档案里存的那个 ——
/// 两者在「首次信任」的那一次必然不同（档案里还没有）。前端要拿它写进已知主机，
/// 所以必须来自握手现场，不能来自输入。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshSessionInfo {
    pub address: String,
    pub username: String,
    /// `SHA256:` 开头的 base64（无填充），和 `ssh-keyscan` 的输出形式一致
    pub fingerprint: String,
    pub algorithm: String,
}

/// [`SshRegistry::open`] 的结局。
///
/// ⚠️ **主机密钥的两种拒绝是变体，不是 `Err`。** 理由有两条，都很实在：
///
/// 1. 前端要**分支处理**这三者（弹 TOFU 弹窗 / 弹密钥变更告警 / 直接开终端），
///    而 `Err` 那条路上只有一句字符串 —— `shared/platform/invoke.ts` 会把任何
///    非字符串的 reject 变成 `String(e)`，结构化信息到不了前端。
/// 2. 这本来就是仓库的既有教条：**服务器侧的结局是结果，不是故障**。
///    「这台机器的密钥变了」是一次成功的往返得出的结论。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum OpenOutcome {
    /// 连上了，会话已就绪
    #[serde(rename_all = "camelCase")]
    Ready(SshSessionInfo),
    /// 这台机器没见过，等用户拍板
    #[serde(rename_all = "camelCase")]
    HostKeyUnknown {
        host: String,
        port: u16,
        algorithm: String,
        fingerprint: String,
    },
    /// **指纹变了。** 可能是服务器重装了，也可能是中间人 —— 两者在协议上
    /// 长得一模一样，所以这里只能硬停，由用户去确认到底是哪一种
    #[serde(rename_all = "camelCase")]
    HostKeyMismatch {
        host: String,
        port: u16,
        algorithm: String,
        /// 我们信任的那把
        expected: String,
        /// 服务器这次报的
        actual: String,
    },
}

/// [`SshRegistry::open`] 的完整返回。
///
/// 把 `generation` 单独放在这里而不是塞进 [`OpenOutcome`]：它是 Rust 侧的
/// **内部记号**（用来在读循环收尾时确认「表里那个会话确实是我」），
/// 前端拿它没有任何用，放进 IPC 契约只会让两边多一个要对齐的字段。
#[derive(Debug)]
pub struct OpenedSession {
    pub outcome: OpenOutcome,
    /// 事件流。**开失败时也有**，只是那个发送端已经被丢掉了，`recv` 立刻返回 `None`
    pub events: tokio::sync::mpsc::Receiver<TerminalEvent>,
    /// 传给 [`SshRegistry::forget`] 做身份校验用
    pub generation: u64,
}

/// 把事件流的接收端交出去、同时保留会话本身的接口。
///
/// 单独一个类型而不是元组：三个字段里有俩是同类型的 `u64`/通道，
/// 元组在调用点读起来完全看不出谁是谁。
impl OpenedSession {
    pub fn is_ready(&self) -> bool {
        matches!(self.outcome, OpenOutcome::Ready(_))
    }
}
