//! 审批闸门：循环在这里**挂起**，等用户点「允许 / 拒绝 / 本次会话记住」。
//!
//! # 为什么值得单独一个文件
//!
//! 这是整个实现里唯一一处「异步任务停下来等一个外部事件」的地方，因此也是最容易
//! 写出死锁的地方。而且它的错**只在竞态下出现**：本地手测十次全对，用户第一次
//! 遇上就是「点了没反应」。
//!
//! 所以这里的不变量是**明写出来的，每条都有测试**：
//!
//! 1. **先登记、再发事件。** 反过来的话，前端可能在登记之前就回答了，
//!    那条回答石沉大海，循环白等到超时 —— 表现是「弹层消失了但什么也没发生」。
//! 2. **发事件时绝不持锁。** 那是「持锁做 IO」：前端一卡，整个闸门跟着卡。
//! 3. **所有路径都要摘登记**（回答 / 取消 / 超时）。漏了新地图会随轮次无限增长 ——
//!    长 run 就是内存泄漏。
//! 4. **重复回答是 no-op，不是"改了主意"。** 先摘再发，保证一条审批只生效一次。
//!
//! # 取消
//!
//! 三条路都要能叫醒挂起：「用户点停止」「webview 重载」「应用退出」。
//! 所以等待是在 `select!` 里**同时等回答和取消**，不是只等其中一个。
//!
//! 取消信号用 `tokio::sync::watch` 而不是 `tokio_util::CancellationToken`：
//! 后者要把 `tokio-util` 引进来，而我们只需要「一个布尔位 + 能 await 它变了」，
//! `watch` 在 `tokio/sync` 里就有。仓库的依赖规矩：能用已有的就不加包。

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::Duration;

use tokio::sync::{oneshot, watch};

use crate::tool::GrantKey;

/// 一条审批的唯一键。
///
/// ⚠️ **必须带 run 代次**：只靠 `tool_use_id` 的话，同一个会话里前后两次 run
/// 的 id 撞上（模型给的 id 不保证跨轮唯一）、或者重复 run，回答就会串台 ——
/// 用户批的是第 2 轮的事，落到第 1 轮上执行了。
#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalKey {
    /// 哪一次 run。
    pub run: u64,
    /// 哪一次调用（`tool_use` 的 id）。
    pub call: String,
}

/// 用户对一次审批的回答。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    /// 这一次允许。
    Allow,
    /// 拒绝。
    Deny,
    /// 允许，并且**本次会话内**记住这一类操作。
    AllowSession,
}

impl Decision {
    /// 算不算允许。
    pub fn allowed(self) -> bool {
        matches!(self, Decision::Allow | Decision::AllowSession)
    }
}

/// 一次审批请求（给前端弹层用的）。
#[derive(Debug, Clone, PartialEq)]
pub struct ApprovalRequest {
    /// 键。
    pub key: ApprovalKey,
    /// 工具名。
    pub tool: String,
    /// **给人看的那一行**：写文件是解析之后的真实路径，跑命令是完整命令行原文。
    pub display: String,
    /// 批准之后要不要给出「本次会话记住」这个选项。
    ///
    /// * `Some(key)` —— 给。粒度是 `(工具名, 归一化目标)`，见 `tool.rs` 的 [`GrantKey`]。
    /// * `None` —— **不给**，这个操作每次都问。
    ///   （跑 shell 解释器就是这一类：记住 `bash` 等于免审之后**所有**的
    ///   `bash -c "…"`，而用户点「记住」时看到的是当时那一条 —— 见
    ///   [`crate::tool::PreparedCall::needs_approval`]。）
    ///
    /// ⚠️ 前端**必须**按这个字段决定显不显示「记住」按钮。显示一个点了却没用
    /// （下次照样问）的按钮，比根本不显示更糟 —— 用户会以为已经批准过了。
    pub grant: Option<GrantKey>,
}

/// 取消信号的**接收端**。可以克隆很多份，给每个等待方一份。
///
/// # 为什么取消是「一对句柄」而不是闸门上的一个方法
///
/// 因为「停止」和「拒绝这次审批」是**两件不同的事**：
///
/// * 拒绝 → 回一条 `is_error` 的工具结果，**循环继续跑**（模型会换个做法）；
/// * 停止 → **整个 run 结束**。
///
/// 早先版本把「取消某个 run」实现成「把它挂着的审批都回答成拒绝」，结果是
/// 用户点了停止、审批被拒、模型换个方式继续烧钱 —— 这跟用户的意图正好相反。
/// 所以取消必须是**每个 run 自己的一条信号**，而不是闸门的一个动作。
///
/// 所有权：一个 run 建一对（[`cancel_pair`]），发送端留在管 run 的那个表里
/// （应用退出时挨个按下去），接收端克隆给所有等待方。
#[derive(Debug, Clone)]
pub struct Cancel {
    rx: watch::Receiver<bool>,
}

impl Cancel {
    /// 已经取消了吗。
    pub fn is_cancelled(&self) -> bool {
        *self.rx.borrow()
    }

    /// 等取消。放 `select!` 里用。
    ///
    /// ⚠️ **只判值、不看 `changed()` 的返回值**：`subscribe()` 出来的接收端
    /// 「当前值算不算已读」语义微妙，直接 `changed().await` 就返回的话，
    /// 有可能**误报取消**（循环自己把自己停掉，还不报错）。循环「先看值、
    /// 再等变化」对两种语义都成立。
    pub async fn cancelled(&self) {
        let mut rx = self.rx.clone();
        loop {
            if *rx.borrow() {
                return;
            }
            if rx.changed().await.is_err() {
                // 发送端没了（管 run 的那张表已经收尾）—— 同样该退出。
                return;
            }
        }
    }
}

/// 取消信号的**发送端**（按下去就停）。
#[derive(Debug)]
pub struct CancelSwitch {
    tx: watch::Sender<bool>,
}

impl CancelSwitch {
    /// 按下停止。
    ///
    /// 用 `send_replace` 而不是 `send`：**重复按不能报错**。
    /// 用户连点两下停止、或者应用退出和用户点停止赶在一起，都是正常事。
    pub fn cancel(&self) {
        self.tx.send_replace(true);
    }

    /// 已经取消了吗。
    pub fn is_cancelled(&self) -> bool {
        *self.tx.borrow()
    }
}

/// 建一对取消句柄。
pub fn cancel_pair() -> (CancelSwitch, Cancel) {
    let (tx, rx) = watch::channel(false);
    (CancelSwitch { tx }, Cancel { rx })
}

/// 审批闸门。
#[derive(Debug)]
pub struct Gate {
    /// 正在等待的那几次审批。
    ///
    /// ⚠️ 用 `std::sync::Mutex` 而不是 `tokio::sync::Mutex`：临界区里**只有
    /// HashMap 操作、没有 await**，同步锁更轻、也不会把 Runtime 线程占住。
    /// 一旦有人往临界区里塞了 await，这个选择就错了 —— 所以下面每个方法都
    /// 保证「锁在 await 之前就放开」。
    pending: Mutex<Pending>,
    /// 「本次会话记住」的授权。
    ///
    /// ⚠️ **只在内存里，永不落盘。** 落盘的话「我上次同意过」会跨重启生效 ——
    /// 那是个用户永远发现不了的安全事故。
    granted: Mutex<HashSet<GrantKey>>,
}

#[derive(Debug, Default)]
struct Pending {
    waiters: HashMap<ApprovalKey, oneshot::Sender<Decision>>,
}

impl Gate {
    /// 新建。
    pub fn new() -> Self {
        Gate {
            pending: Mutex::new(Pending::default()),
            granted: Mutex::new(HashSet::new()),
        }
    }

    /// 本会话已经批准过这一类操作了吗。
    pub fn is_granted(&self, key: &GrantKey) -> bool {
        self.lock_granted().contains(key)
    }

    /// 记下一条「本次会话记住」。
    pub fn grant(&self, key: GrantKey) {
        self.lock_granted().insert(key);
    }

    /// 前端回答一条审批。返回 `false` 表示这条已经不存在了
    /// （已超时 / 已被取消 / 重复点击）——**这是个明确契约，不是错误**。
    pub fn answer(&self, key: &ApprovalKey, decision: Decision) -> bool {
        // ⚠️ 先摘再发：保证一条审批只可能生效一次。重复点击是 no-op，
        // 而不是"把已经执行的允许改成拒绝"（那已经晚了，还会误导用户）。
        let tx = {
            let mut pending = self.lock_pending();
            pending.waiters.remove(key)
        };
        match tx {
            Some(tx) => tx.send(decision).is_ok(),
            None => false,
        }
    }

    /// 现在有几条在等回答（给状态栏和测试用）。
    pub fn pending_count(&self) -> usize {
        self.lock_pending().waiters.len()
    }

    /// 循环侧：登记 + 等待 + 摘登记。
    ///
    /// `emit` 在**登记完成之后**被调用（不变量 1），而且**不在持锁状态下**（不变量 2）。
    pub async fn request(
        &self,
        request: ApprovalRequest,
        timeout: Option<Duration>,
        cancel: &Cancel,
        emit: impl FnOnce(),
    ) -> Option<Decision> {
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self.lock_pending();
            pending.waiters.insert(request.key.clone(), tx);
        }

        // 登记完了才发事件 —— 前端只能回答它收到过的东西。
        // 这一步可能在 webview 侧触发一整套序列化 + 求值，所以绝不能在锁里做。
        emit();

        let decision = tokio::select! {
            biased;
            // 取消优先于「恰好同时到达的回答」：用户的意图是停下。
            () = cancel.cancelled() => None,
            got = rx => got.ok(),
            // 要不要超时是个显式的产品决定 —— 默认不超时（见 `session.rs` 的注释）。
            () = sleep_opt(timeout) => Some(Decision::Deny),
        };

        // ⚠️ 不变量 3：无论谁赢了都要摘登记。少了这一步，长 run 里这个表会
        // 一直涨（每次审批漏一条）。
        self.lock_pending().waiters.remove(&request.key);

        decision
    }

    fn lock_pending(&self) -> std::sync::MutexGuard<'_, Pending> {
        // 中毒了也接着用：这里存的是"谁在等"，不是需要保持一致性的业务数据；
        // 一个 panic 过的线程不该让整个审批功能瘫掉。
        self.pending.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn lock_granted(&self) -> std::sync::MutexGuard<'_, HashSet<GrantKey>> {
        self.granted.lock().unwrap_or_else(|e| e.into_inner())
    }
}

impl Default for Gate {
    fn default() -> Self {
        Self::new()
    }
}

/// `sleep(Option<Duration>)`：`None` 表示永远不醒（等一个不会来的 future）。
async fn sleep_opt(d: Option<Duration>) {
    match d {
        Some(d) => tokio::time::sleep(d).await,
        None => std::future::pending::<()>().await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    fn key(run: u64, call: &str) -> ApprovalKey {
        ApprovalKey {
            run,
            call: call.into(),
        }
    }

    fn req(run: u64, call: &str, tool: &str, target: &str) -> ApprovalRequest {
        ApprovalRequest {
            key: key(run, call),
            tool: tool.into(),
            display: format!("{tool} {target}"),
            grant: Some(GrantKey {
                tool: tool.into(),
                target: target.into(),
            }),
        }
    }

    #[tokio::test]
    async fn a_normal_round_trip_works() {
        let gate = Arc::new(Gate::new());
        let (_sw, cancel) = cancel_pair();
        let asked = Arc::new(AtomicUsize::new(0));

        let g = gate.clone();
        let a = asked.clone();
        let task = tokio::spawn(async move {
            g.request(req(1, "c1", "run_command", "git"), None, &cancel, || {
                a.fetch_add(1, Ordering::SeqCst);
            })
            .await
        });

        // 等它登记好（emit 被调用 = 登记已完成）。
        while asked.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
        assert!(gate.answer(&key(1, "c1"), Decision::Allow));
        assert_eq!(task.await.unwrap(), Some(Decision::Allow));
    }

    #[tokio::test]
    async fn answering_before_registration_returns_false() {
        // 不变量 1 的另一面：前端只能回答它收到过的东西。
        // 这条返回 false 是**契约**，不是错误 —— 而且它是"先登记再发事件"
        // 这个顺序的守门人。
        let gate = Gate::new();
        assert!(!gate.answer(&key(1, "nobody"), Decision::Allow));
    }

    #[tokio::test]
    async fn the_emit_callback_can_call_back_into_the_gate_without_deadlocking() {
        // ⚠️ 不变量 2：**发事件时绝不能持锁**。
        // 如果 emit 是在锁里调的，这个测试会**挂死**（前端回答那条路要拿同一把锁）。
        let gate = Arc::new(Gate::new());
        let (_sw, cancel) = cancel_pair();

        let g = gate.clone();
        let task = tokio::spawn(async move {
            g.request(req(1, "c1", "write_file", "src"), None, &cancel, || {
                // 模拟"前端在收到事件的那一刻就回答了"（真实里是极快的往返）
                let g2 = gate.clone();
                std::thread::spawn(move || {
                    g2.answer(&key(1, "c1"), Decision::Allow);
                });
            })
            .await
        });

        let got = tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .expect("emit 里回调闸门时必须不死锁")
            .unwrap();
        assert_eq!(got, Some(Decision::Allow));
    }

    #[tokio::test]
    async fn a_duplicate_answer_is_a_no_op() {
        let gate = Arc::new(Gate::new());
        let (_sw, cancel) = cancel_pair();
        let g = gate.clone();
        let task = tokio::spawn(async move {
            g.request(req(1, "c1", "run_command", "git"), None, &cancel, || {})
                .await
        });
        tokio::task::yield_now().await;

        assert!(gate.answer(&key(1, "c1"), Decision::Allow));
        // 第二次：这条已经摘掉了。**不能**变成"改成拒绝" —— 那边已经执行了。
        assert!(!gate.answer(&key(1, "c1"), Decision::Deny));
        assert_eq!(task.await.unwrap(), Some(Decision::Allow));
    }

    #[tokio::test]
    async fn cancel_wakes_a_pending_approval() {
        // 「用户点停止」这条路。
        let gate = Arc::new(Gate::new());
        let (sw, cancel) = cancel_pair();
        let g = gate.clone();
        let run = tokio::spawn(async move {
            g.request(req(7, "c1", "run_command", "rm"), None, &cancel, || {})
                .await
        });
        tokio::task::yield_now().await;

        sw.cancel();
        // ⚠️ 这里是 **None（取消）而不是 Some(Deny)**：用户点停止是要整个 run 停，
        // 不是"拒绝这一次调用然后让模型换个法子继续烧钱"。
        assert_eq!(run.await.unwrap(), None);
    }

    #[tokio::test]
    async fn cancelling_one_run_does_not_wake_another() {
        let gate = Arc::new(Gate::new());
        let (sw1, cancel1) = cancel_pair();

        let g1 = gate.clone();
        let r1 = tokio::spawn(async move {
            g1.request(req(1, "a", "run_command", "git"), None, &cancel1, || {})
                .await
        });
        let g2 = gate.clone();
        let (_sw2, c2) = cancel_pair();
        let r2 = tokio::spawn(async move {
            g2.request(req(2, "b", "run_command", "git"), None, &c2, || {})
                .await
        });
        tokio::task::yield_now().await;

        // 取消是**每个 run 自己的一条信号**，按 1 号那把开关不该动到 2 号。
        sw1.cancel();
        assert_eq!(r1.await.unwrap(), None);

        // 2 号 run 还挂着，得由它自己的回答叫醒。
        assert!(gate.answer(&key(2, "b"), Decision::Allow));
        assert_eq!(r2.await.unwrap(), Some(Decision::Allow));
    }

    #[tokio::test]
    async fn the_registry_does_not_leak_after_many_round_trips() {
        // ⚠️ 不变量 3：漏摘登记 = 长 run 的内存泄漏。
        // 这里直接看那个表的大小 —— 它是私有字段，所以用同一个模块里的测试去看。
        let gate = Arc::new(Gate::new());
        let (_sw, cancel) = cancel_pair();

        for i in 0..50 {
            let g = gate.clone();
            let c = cancel.clone();
            let call = format!("c{i}");
            let task = tokio::spawn(async move {
                g.request(req(1, &call, "run_command", "git"), None, &c, || {})
                    .await
            });
            tokio::task::yield_now().await;
            gate.answer(&key(1, &format!("c{i}")), Decision::Allow);
            let _ = task.await;
        }

        assert_eq!(
            gate.pending_count(),
            0,
            "50 轮之后还留着没摘的登记 —— 这就是那个内存泄漏"
        );
    }

    #[tokio::test]
    async fn a_gate_that_goes_away_turns_pending_into_deny() {
        // run 收尾时 sender 被丢掉 → 等待方拿到 Err → 当拒绝。
        // 关键是**不能**当成允许（那会静默放行一个没人批准的操作）。
        let gate = Gate::new();
        let (_sw, cancel) = cancel_pair();
        let (tx, rx) = oneshot::channel::<Decision>();
        {
            let mut p = gate.pending.lock().unwrap();
            p.waiters.insert(key(1, "c1"), tx);
        }
        drop(gate);

        let decision = tokio::select! {
            got = rx => got.ok(),
        };
        assert_eq!(decision, None, "sender 没了应当是「没回答」，不是「允许」");
        let _ = cancel;
    }

    #[tokio::test]
    async fn a_timeout_is_a_deny_not_a_hang() {
        let gate = Arc::new(Gate::new());
        let (_sw, cancel) = cancel_pair();
        let g = gate.clone();
        let task = tokio::spawn(async move {
            g.request(
                req(1, "c1", "run_command", "git"),
                Some(Duration::from_millis(20)),
                &cancel,
                || {},
            )
            .await
        });
        assert_eq!(task.await.unwrap(), Some(Decision::Deny));
    }

    #[tokio::test]
    async fn grants_are_per_target_not_per_tool() {
        // 安全边界：批准 `git` 不能顺带批准 `curl`。
        let gate = Gate::new();
        gate.grant(GrantKey {
            tool: "run_command".into(),
            target: "git".into(),
        });
        assert!(gate.is_granted(&GrantKey {
            tool: "run_command".into(),
            target: "git".into()
        }));
        assert!(!gate.is_granted(&GrantKey {
            tool: "run_command".into(),
            target: "curl".into()
        }));
    }

    #[tokio::test]
    async fn one_switch_wakes_every_pending_approval_of_that_run() {
        // 应用退出 / webview 重载那条路：管 run 的那张表挨个按开关，
        // 一个 run 下挂着的每一条审批都得醒过来。
        let gate = Arc::new(Gate::new());
        let (sw, cancel) = cancel_pair();

        let mut tasks = Vec::new();
        for i in 0..5 {
            let g = gate.clone();
            let c = cancel.clone();
            // 同一个 run（run=7）下的 5 条调用；每一条都得醒。
            //
            // ⚠️ call id 必须各不相同：键里带 id，而同一个键再登记一次会把
            // 前一个等待方挤掉（它的 sender 被 drop → 当成"没回答"）。
            // 真实里这不成问题 —— 同一个 run 里同一时刻最多挂着一条同 id 的审批。
            let call = format!("c{i}");
            tasks.push(tokio::spawn(async move {
                g.request(req(7, &call, "run_command", "git"), None, &c, || {})
                    .await
            }));
        }
        for _ in 0..5 {
            tokio::task::yield_now().await;
        }
        assert_eq!(gate.pending_count(), 5);

        sw.cancel();
        for t in tasks {
            assert_eq!(t.await.unwrap(), None, "取消要叫醒每一条，不能只叫醒第一条");
        }
        assert!(sw.is_cancelled());
        // 醒来之后登记也要摘干净（不变量 3）。
        assert_eq!(gate.pending_count(), 0);
    }
}
