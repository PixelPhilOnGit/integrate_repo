//! 智能体会话侧的错误类型。
//!
//! 和 `devtoolkit-core` / `redis` / `sql` / `ssh` 一个路子：**手写 `Display` +
//! 中文文案**，不引入 thiserror。命令层直接把 `to_string()` 的结果给前端，
//! 所以这里的每一句话都是**用户会读到的那一句**，要写清楚「下一步该做什么」。
//!
//! # 为什么分成这三个域
//!
//! `Spawn`（起进程）、`Events`（事件目录）、`Integration`（改配置文件）是三条
//! 完全不同的失败路径，用户要做的事也完全不同：查工作目录 / 查磁盘权限 /
//! 查那个配置文件的格式。合成一个 `Io { reason }` 的话，报错就只能说
//! 「操作失败：Permission denied (os error 13)」—— 用户拿着这句话没地方下手。

use std::fmt;

#[derive(Debug)]
pub enum AgentError {
    /// 参数本身就没法用：工作目录不是绝对路径、不存在、shell 路径是空的……
    ///
    /// ⚠️ 这一条会变成前端那句「起不来：……」，所以要**具体到能照着改**。
    BadConfig { reason: String },

    /// 起进程失败：PTY 建不出来、shell 不在、权限不够
    Spawn { id: String, reason: String },

    /// 这个 id 上没有活动会话（没开过，或者已经结束了）
    NotConnected { id: String },

    /// 会话已经关掉了（pane 关了，或者进程没了）
    Closed,

    /// 往 pane 里写失败
    Write { reason: String },

    /// 改窗口大小失败
    Resize { reason: String },

    /// 事件目录读不了 / 建不出来
    Events { dir: String, reason: String },

    /// 集成配置读不了 / 写不了 / 格式我们不认识
    ///
    /// `path` 单独带出来：这一域的失败**全是关于某个具体文件的**，
    /// 而用户往往需要自己去打开它看一眼
    Integration { path: String, reason: String },

    /// 内部会话表的锁坏了。只会在别的线程持锁时 panic 才发生，
    /// 但那时候整个进程已经不正常了，直接报出来而不是 unwrap 掉
    Poisoned,
}

impl fmt::Display for AgentError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AgentError::BadConfig { reason } => write!(f, "起不来：{reason}"),

            AgentError::Spawn { id, reason } => {
                write!(f, "会话 {id} 起不来：{reason}")
            }

            AgentError::NotConnected { id } => {
                write!(f, "会话 {id} 不在活动状态（已经退出，或者被关掉了）")
            }

            AgentError::Closed => write!(f, "这个窗格已经关掉了"),

            AgentError::Write { reason } => {
                write!(f, "往窗格里写失败：{reason}")
            }

            AgentError::Resize { reason } => {
                write!(f, "调整窗格大小失败：{reason}")
            }

            AgentError::Events { dir, reason } => write!(
                f,
                "事件目录（{dir}）用不了：{reason}。\
                 状态钩子靠往这个目录里写文件来汇报，它不可写的话状态点不会更新。"
            ),

            AgentError::Integration { path, reason } => {
                write!(f, "改不了 {path}：{reason}")
            }

            AgentError::Poisoned => write!(f, "内部状态损坏（有线程在持锁时 panic 了）"),
        }
    }
}

impl std::error::Error for AgentError {}
