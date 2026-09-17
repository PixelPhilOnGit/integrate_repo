//! SQL 侧的错误类型。
//!
//! 和 `devtoolkit-core` / `devtoolkit-redis` 一个路子：**手写 `Display` + 中文文案**，
//! 不引入 thiserror。
//!
//! 和 Redis 那边一样，这里**没有**「服务器返回了 SQL 错误」这个变体 ——
//! `SELECT * FROM 不存在的表` 是**一条正常的查询结果**（成功执行了，只是返回错误），
//! 它该内联显示在结果区里，而不是把连接标成断开。见 `result.rs` 的 `QueryResult`。

use std::fmt;

#[derive(Debug)]
pub enum SqlError {
    /// 连接参数不合法（类型不认识、主机名为空……）
    BadConfig { reason: String },

    /// 尝试连接时失败
    Connect { address: String, reason: String },

    /// 这个 id 上没有活动连接
    NotConnected { id: String },

    /// 连接在使用中坏掉了
    Transport { id: String, reason: String },

    /// 内部连接表的锁坏了（只会在别的线程持锁时 panic 才发生）
    Poisoned,
}

impl fmt::Display for SqlError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SqlError::BadConfig { reason } => {
                write!(f, "连接参数不合法：{reason}")
            }
            SqlError::Connect { address, reason } => {
                write!(
                    f,
                    "连接数据库（{address}）失败：{reason}。\
                     请确认地址、端口、库名和用户名密码正确，服务已启动。"
                )
            }
            SqlError::NotConnected { id } => {
                write!(f, "连接 “{id}” 当前不在活动状态，请先连接。")
            }
            SqlError::Transport { id, reason } => {
                write!(f, "连接 “{id}” 已中断：{reason}。请重新连接。")
            }
            SqlError::Poisoned => {
                write!(f, "内部连接状态已损坏（可能由先前的一次崩溃导致），请重启应用。")
            }
        }
    }
}

impl std::error::Error for SqlError {}
