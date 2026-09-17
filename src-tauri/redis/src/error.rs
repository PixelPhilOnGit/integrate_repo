//! Redis 侧的错误类型。
//!
//! 和 `devtoolkit-core::CoreError` 一个路子：**手写 `Display` + 中文文案**，
//! 不引入 thiserror。理由是文案集中在一处、依赖树里少一个 proc-macro crate，
//! 而错误变体本来就不多。
//!
//! 注意这里**没有**「服务器返回了错误」这个变体 —— 那是 [`crate::Reply::Error`] 的事。
//! 本类型只描述「这次操作在传输层失败了」。

use std::fmt;

#[derive(Debug)]
pub enum RedisError {
    /// 连接参数本身就没法用（空主机名、端口非法、db 为负……）
    BadConfig { reason: String },

    /// 尝试连接时失败：拒绝连接、DNS 查不到、握手超时
    Connect { address: String, reason: String },

    /// 服务器**明确拒绝**了这个操作（`SELECT 9999` 报库号越界之类）。
    ///
    /// 和 `Transport` 分开：连接是好的，只是这次操作不合法。
    /// 前端该弹个提示，而不是把连接标成断开。
    Rejected { reason: String },

    /// 这个 id 上没有活动连接（没连过，或者已经断开了）
    NotConnected { id: String },

    /// 连接在使用过程中坏掉了（对端关闭、IO 错误、响应超时）
    Transport { id: String, reason: String },

    /// 内部连接表的锁坏了。只会在别的线程持锁时 panic 才发生，
    /// 但那时候整个进程已经不正常了，所以直接报出来而不是 unwrap 掉。
    Poisoned,
}

impl fmt::Display for RedisError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RedisError::BadConfig { reason } => {
                write!(f, "连接参数不合法：{reason}")
            }
            RedisError::Connect { address, reason } => {
                write!(
                    f,
                    "连接 Redis（{address}）失败：{reason}。\
                     请确认地址和端口正确、服务已启动、防火墙放行。"
                )
            }
            RedisError::Rejected { reason } => {
                write!(f, "服务器拒绝了这次操作：{reason}")
            }
            RedisError::NotConnected { id } => {
                write!(f, "连接 “{id}” 当前不在活动状态，请先连接。")
            }
            RedisError::Transport { id, reason } => {
                write!(f, "连接 “{id}” 已中断：{reason}。请重新连接。")
            }
            RedisError::Poisoned => {
                write!(f, "内部连接状态已损坏（可能由先前的一次崩溃导致），请重启应用。")
            }
        }
    }
}

impl std::error::Error for RedisError {}
