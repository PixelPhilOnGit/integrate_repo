//! 活着的 pane 表。
//!
//! 分工和 SSH 那边一样：**会话档案（工作目录、命令、标题）归前端持有并持久化，
//! Rust 侧只活着的进程**。所以这里没有「列出所有会话」这种命令 —— 那等于同一份
//! 真相存两遍，迟早漂移。
//!
//! 包一层 `Arc` 的理由也和 SSH 一样：**读线程和等待线程要活到会话结束**，
//! 而它们结束的时候要回头把会话从表里摘掉（[`AgentRegistry::forget`]），
//! 所以它们得拿到一份能搬进线程的句柄。
//!
//! # 代次（generation）
//!
//! 和 SSH 那边同一条教训：收尾是**异步**发生的，它结束的时候那个 id 完全可能
//! 已经属于一个新会话了（用户关掉又立刻重开）。不校验代次的话，死掉的旧会话
//! 会把**活着的新会话**从表里摘掉 —— 表现是窗格还在，但每一次输入都报
//! 「会话不在活动状态」，而且再也关不掉了。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use tokio::sync::mpsc;

use crate::error::AgentError;
use crate::pty::{self, OpenedPty, PtyConfig, PtyEvent, PtySession};

/// 活着的 pane 表。用 `std::sync::Mutex` 而不是 tokio 的：临界区里只有
/// HashMap 操作，**没有 await**。
#[derive(Default)]
pub struct AgentRegistry {
    sessions: Mutex<HashMap<String, Arc<PtySession>>>,
    generation: AtomicU64,
}

impl AgentRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    fn next_generation(&self) -> u64 {
        self.generation.fetch_add(1, Ordering::Relaxed) + 1
    }

    /// 起一个 pane。
    ///
    /// 同一个 id 再开一次是**替换**，不是并存 —— 给「前端刷新了但 Rust 侧还挂着
    /// 旧会话」兜底，不然会留下一个用户看不见也关不掉的进程（它还占着工作目录）。
    pub fn open(&self, id: &str, cfg: &PtyConfig) -> Result<OpenedPty, AgentError> {
        self.close(id);

        let generation = self.next_generation();
        let opened = pty::spawn(id, cfg, generation)?;
        self.insert(id, Arc::clone(&opened.session));
        Ok(opened)
    }

    fn insert(&self, id: &str, session: Arc<PtySession>) {
        let mut map = self.lock();
        map.insert(id.to_string(), session);
    }

    /// 取出一个会话的句柄。锁在这个函数里就释放了（返回的是克隆出来的 `Arc`），
    /// 所以调用方可以放心地在后面阻塞。
    fn get(&self, id: &str) -> Result<Arc<PtySession>, AgentError> {
        let map = self.lock();
        map.get(id)
            .cloned()
            .ok_or_else(|| AgentError::NotConnected { id: id.to_string() })
    }

    /// 往 pane 里发键盘输入。
    ///
    /// ⚠️ **前端必须串行调用**（和 `ssh_write` 同一条约定）：每次是独立的
    /// invoke，两次没 await 的调用到达顺序不保证，打字会乱序成 `sl`。
    pub fn write(&self, id: &str, bytes: &[u8]) -> Result<(), AgentError> {
        self.get(id)?.write(bytes)
    }

    /// 告诉里面的程序窗口大小变了。
    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), AgentError> {
        self.get(id)?.resize(cols, rows)
    }

    /// 关掉一个 pane。**幂等**：不存在也算成功。
    ///
    /// **先从表里摘掉再关**：反过来的话，关的过程中别的任务还能拿到这个正要死的
    /// 会话往里写。摘掉之后写就会得到 `NotConnected`，那是个准确的答复。
    ///
    /// 刻意**不返回 `Result`**：关一个本来就不存在的 pane 不是错误，
    /// 而关的过程里那几步失败也无所谓（用户点「关窗格」的时候它可能早就自己
    /// 退出了，这时候报错只会弹出没人能处理的提示）。
    pub fn close(&self, id: &str) {
        let session = {
            let mut map = self.lock();
            map.remove(id)
        };
        if let Some(session) = session {
            session.close();
        }
    }

    /// 关掉全部 pane。给两件事用：
    ///
    /// 1. 前端重新加载了（webview 一刷新，它那边的回调 id 全没了，但 Rust 侧的
    ///    pane 还活着 —— 用户在新界面上**看不见也关不掉**它们）。
    /// 2. **应用退出**。这一条是硬要求：关掉应用还留着一屏 agent 在跑，
    ///    用户下次打开会看到一堆他以为早就关掉的东西。
    pub fn close_all(&self) {
        let all: Vec<Arc<PtySession>> = {
            let mut map = self.lock();
            map.drain().map(|(_, s)| s).collect()
        };
        for session in all {
            session.close();
        }
    }

    /// 事件流结束之后把会话从表里摘掉（带代次做身份校验，见模块头）。
    pub fn forget(&self, id: &str, generation: u64) {
        let mut map = self.lock();
        if map.get(id).map(|s| s.generation()) == Some(generation) {
            map.remove(id);
        }
    }

    /// 当前活着的 pane 数。测试用，也用来给「有没有泄漏」做断言。
    pub fn len(&self) -> usize {
        self.lock().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<PtySession>>> {
        // 锁中毒只可能来自别的线程持锁时 panic。这里的数据是个 HashMap，
        // 被中断的操作不会让它处于不一致状态，取出内部值继续用
        self.sessions.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// 把事件流转发到一个同步的出口，直到窗格结束。
///
/// 放在 crate 里而不是 `agent_commands.rs` 里，是为了**能测** ——
/// Tauri 那层只是把一个 `Channel` 包成闭包，逻辑全在这里
/// （和 `devtoolkit_ssh::forward` 同一个形状、同一个理由）。
///
/// 返回最后一个 `Exit` 事件里带的退出码（有的话）。
pub async fn forward<F>(mut rx: mpsc::Receiver<PtyEvent>, mut sink: F) -> Option<i32>
where
    F: FnMut(PtyEvent),
{
    let mut code = None;
    while let Some(event) = rx.recv().await {
        let is_exit = match &event {
            PtyEvent::Exit { code: c } => {
                code = *c;
                true
            }
            PtyEvent::Data { .. } => false,
        };
        sink(event);
        // 靠 `Exit` 而不是靠通道 `None` 收工：sink 那边可能已经没人听了
        // （用户关掉了窗格、webview 重载了），那时候继续读下去只是空转
        if is_exit {
            break;
        }
    }
    code
}
