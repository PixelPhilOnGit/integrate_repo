//! 记账口子：跑的过程中顺带把「这一轮花了多少」记下来。
//!
//! # 为什么是同步的、而且不返回错误
//!
//! 调用点在循环里（每轮结束一次）。记账失败**不该让一个正在跑的任务停下来** ——
//! 用户要的是任务做完，不是日志完整。所以这个接口刻意做得「哑」：
//! 实现自己把错误咽下去（顶多往 stderr 说一声），循环这边当它永远成功。
//!
//! 也不是完全没有代价：记账就是一次 SQLite 单行插入，在本地磁盘上，
//! 量级是微秒。真慢到影响循环，那是库文件所在磁盘出了问题 —— 那时候
//! 任务本来也跑不下去。
//!
//! # 为什么不走 [`crate::session::RunEvent`]
//!
//! 事件出口是 `try_send`（满了就丢，见 [`crate::session::EventSink`] 的文档），
//! 而 **usage 是不能丢的那种数据** —— 它是「哪个上下文策略划算」唯一的来源，
//! 也是以后算钱的依据。丢了不报错，只是少一块数据，而少的那块要很久之后
//! 才有人发现（等到有人问「为什么这个月的统计对不上」）。
//!
//! 事件的定位是「告知前端」，丢了就丢了；这个口子的定位是「记账」，
//! 两者目标不同，所以是两个通道。

use crate::message::{StopReason, Usage};
use crate::session::{RunSpec, RunStatus};

/// 一次 run 在账本里的编号。
///
/// 由 [`Journal::start`] 给出来，后面每条记录都带着它。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct RunHandle(pub i64);

/// 记流水的地方。
///
/// 真实现是 [`crate::transcript::Transcript`] 的那个包装（见 `transcript.rs`）；
/// 测试里塞一个只往 `Vec` 里推的假实现即可 —— 不需要真开一个库文件。
///
/// ⚠️ 实现必须是 `Send + Sync + 'static`：它被 `Arc` 持有，跟着 run 到处走。
pub trait Journal: Send + Sync + std::fmt::Debug {
    /// 一次 run 开始了。
    fn start(&self, spec: &RunSpec) -> RunHandle;

    /// 一轮结束了。
    fn turn(&self, handle: &RunHandle, n: usize, usage: &Usage, stop: &StopReason);

    /// run 收尾了。
    ///
    /// ⚠️ **每一条退出路径都要走到这里**（完成 / 中止 / 取消 / 出错）。
    /// 漏一条的话，那条记录会永远停在「没有结束时间」的状态 ——
    /// 而统计时长的时候，它要么被当成无穷大，要么被静默跳过。
    fn finish(&self, handle: &RunHandle, status: &RunStatus);
}

/// 什么都不记。
///
/// 给「不想落盘」的场景用（比如测试、或者用户把记录关掉）。
#[derive(Debug, Clone, Copy, Default)]
pub struct NoJournal;

impl Journal for NoJournal {
    fn start(&self, _spec: &RunSpec) -> RunHandle {
        RunHandle(0)
    }
    fn turn(&self, _handle: &RunHandle, _n: usize, _usage: &Usage, _stop: &StopReason) {}
    fn finish(&self, _handle: &RunHandle, _status: &RunStatus) {}
}
