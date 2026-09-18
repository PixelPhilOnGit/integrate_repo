//! SSH 侧的错误类型。
//!
//! 和 `devtoolkit-redis::RedisError` / `devtoolkit-sql::SqlError` 一个路子：
//! **手写 `Display` + 中文文案**，不引入 thiserror。
//!
//! # 这里为什么**没有**主机密钥的变体
//!
//! 「这台机器的密钥没见过」和「密钥变了」都不是错误 —— 它们是**一次成功的
//! 往返得出的结论**，属于 [`crate::SshOpenOutcome`]。判反了的后果很具体：
//! 如果它们走 `Err`，前端拿到的只有一句字符串，就没法区分「要不要弹 TOFU 弹窗」
//! 和「直接显示错误」，而这两件事要做的事完全不同。
//!
//! 本类型只描述「这次操作**没做成**，而且除了把原因显示出来没别的可做」。

use std::fmt;

#[derive(Debug)]
pub enum SshError {
    /// 参数本身就没法用（空主机名、端口非法、认证方式缺字段……）
    BadConfig { reason: String },

    /// 建立连接时失败：拒绝连接、DNS 查不到、握手超时、协议谈不拢
    Connect { address: String, reason: String },

    /// 认证没通过。
    ///
    /// 单独一个变体而不是并进 `Connect`：用户看到这句话要做的动作完全不同 ——
    /// 「网络不通」要去查网络，「认证失败」要去查用户名/密码/密钥。
    /// 而且认证失败**不代表主机密钥不可信**，两者绝不能混为一谈
    /// （混了的后果见 `session.rs` 里关于 `UnknownKey` 的那段注释）。
    Auth { address: String, reason: String },

    /// 私钥文件读不了或者解不开
    KeyFile { path: String, reason: String },

    /// 这个 id 上没有活动会话（没开过，或者已经结束了）
    NotConnected { id: String },

    /// 会话在使用过程中坏掉了（对端关闭、IO 错误）
    Transport { id: String, reason: String },

    /// 内部会话表的锁坏了。只会在别的线程持锁时 panic 才发生，
    /// 但那时候整个进程已经不正常了，所以直接报出来而不是 unwrap 掉。
    Poisoned,
}

impl fmt::Display for SshError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SshError::BadConfig { reason } => {
                write!(f, "连接参数不合法：{reason}")
            }
            SshError::Connect { address, reason } => {
                write!(
                    f,
                    "连接 SSH（{address}）失败：{reason}。\
                     请确认地址和端口正确、服务已启动、防火墙放行。"
                )
            }
            SshError::Auth { address, reason } => {
                write!(
                    f,
                    "登录 {address} 失败：{reason}。\
                     请确认用户名、密码或私钥是否正确。"
                )
            }
            SshError::KeyFile { path, reason } => {
                write!(
                    f,
                    "读取私钥文件（{path}）失败：{reason}。\
                     请确认路径正确、文件格式是 OpenSSH 私钥、口令正确。"
                )
            }
            SshError::NotConnected { id } => {
                write!(f, "会话 “{id}” 已经不在活动状态了。")
            }
            SshError::Transport { id, reason } => {
                write!(f, "会话 “{id}” 已中断：{reason}。")
            }
            SshError::Poisoned => {
                write!(f, "内部会话状态已损坏（可能由先前的一次崩溃导致），请重启应用。")
            }
        }
    }
}

impl std::error::Error for SshError {}
