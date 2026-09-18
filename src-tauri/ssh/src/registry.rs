//! 活会话表。
//!
//! 分工和 redis/sql 一样：**档案（主机、用户名、密钥、已知主机指纹）归前端持有
//! 并持久化，Rust 侧只存活着的会话**。所以这里没有「列出所有连接」这种命令 ——
//! 那等于同一份真相存两遍，迟早漂移。
//!
//! 和前两个模块不同的是键：那边一个档案一个连接，键就是档案 id；这里**一个档案
//! 可以同时开好几个会话**（多标签），所以键是会话 id，档案 id 只是元数据。
//! 这么设计是有意的 —— 每个标签一条独立 TCP 连接，一条卡住不会冻结另一条。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use tokio::sync::mpsc;

use crate::error::SshError;
use crate::session::{self, Session, SshConfig, TerminalEvent, EVENT_BUFFER};
use crate::{OpenOutcome, OpenedSession, SshSessionInfo};

/// 活会话表。
///
/// 用 `std::sync::Mutex` 而不是 tokio 的：临界区里只有 HashMap 操作，
/// **没有 await**（有 await 的话必须用异步锁，而且 guard 跨 await 会让
/// future 不是 `Send`，编译直接不过）。这也是本文件里所有方法的写法：
/// 先在锁里把 `Arc` 克隆出来、锁当场释放，再去 await。
#[derive(Default)]
pub struct SshRegistry {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    /// 会话代次。单调递增、进程内不重复，用来做摘除时的身份校验
    generation: AtomicU64,
}

impl SshRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    fn next_generation(&self) -> u64 {
        self.generation.fetch_add(1, Ordering::Relaxed) + 1
    }

    /// 开一个会话。
    ///
    /// 事件流的接收端**开失败时也会给一个**（那个通道的发送端已经被丢掉了，
    /// 所以 `recv` 立刻返回 `None`）。调用方因此不用为失败分支写第二套代码。
    pub async fn open(&self, id: &str, cfg: &SshConfig) -> Result<OpenedSession, SshError> {
        // 同一个 id 再开一次是**替换**，不是并存。
        //
        // 这个兜底是给「前端刷新了但 Rust 侧还挂着旧会话」用的 —— 和 redis 的
        // `connect` 同 id 重连即替换是同一个理由。不先关掉旧的会留下一个
        // 用户看不见也关不掉的会话，远端那边还挂着一个登录着 shell 的 PTY。
        self.close(id).await;

        let generation = self.next_generation();
        let (tx, rx) = mpsc::channel(EVENT_BUFFER);

        let outcome = match session::open(cfg, generation, tx).await? {
            session::OpenResult::Ready(s) => {
                let session = Arc::new(*s);
                let info = SshSessionInfo {
                    address: session.address.clone(),
                    username: session.username.clone(),
                    fingerprint: session.fingerprint.clone(),
                    algorithm: session.algorithm.clone(),
                };
                self.insert(id, Arc::clone(&session));
                OpenOutcome::Ready(info)
            }
            session::OpenResult::HostKeyUnknown(key) => OpenOutcome::HostKeyUnknown {
                host: cfg.host.clone(),
                port: cfg.port,
                algorithm: key.algorithm,
                fingerprint: key.fingerprint,
            },
            session::OpenResult::HostKeyMismatch { expected, actual } => {
                OpenOutcome::HostKeyMismatch {
                    host: cfg.host.clone(),
                    port: cfg.port,
                    algorithm: actual.algorithm,
                    expected,
                    actual: actual.fingerprint,
                }
            }
        };

        Ok(OpenedSession {
            outcome,
            events: rx,
            generation,
        })
    }

    fn insert(&self, id: &str, session: Arc<Session>) {
        let mut map = self.lock();
        map.insert(id.to_string(), session);
    }

    /// 取出一个会话的句柄。
    ///
    /// 锁在这个函数里就释放了（返回的是克隆出来的 `Arc`），
    /// 所以调用方可以放心地在后面 await。
    fn get(&self, id: &str) -> Result<Arc<Session>, SshError> {
        let map = self.lock();
        map.get(id)
            .cloned()
            .ok_or_else(|| SshError::NotConnected { id: id.to_string() })
    }

    /// 往会话里发键盘输入
    pub async fn write(&self, id: &str, bytes: &[u8]) -> Result<(), SshError> {
        let session = self.get(id)?;
        session.write(bytes).await
    }

    /// 告诉远端窗口大小变了
    pub async fn resize(&self, id: &str, cols: u32, rows: u32) -> Result<(), SshError> {
        let session = self.get(id)?;
        session.resize(cols, rows).await
    }

    /// 关掉一个会话。**幂等**：不存在也当成功。
    ///
    /// **先从表里摘掉再去关**：反过来的话，`close().await` 期间别的任务
    /// 还能拿到这个正要死的会话往里写。摘掉之后写就会得到 `NotConnected`，
    /// 那是个准确的答复。
    ///
    /// 刻意**不返回 `Result`** —— 关一个本来就不存在的会话不是错误，
    /// 而关的过程里那几步失败也无所谓（用户点「关标签」的时候，
    /// 会话可能早就自己结束了，这时候报错只会弹出没人能处理的提示）。
    pub async fn close(&self, id: &str) {
        let session = {
            let mut map = self.lock();
            map.remove(id)
        };
        if let Some(session) = session {
            session.close().await;
        }
    }

    /// 读循环结束之后把会话从表里摘掉。
    ///
    /// ⚠️ **必须带代次做身份校验。** 读循环是异步收尾的，它结束的时候那个 id
    /// 完全可能已经属于一个新会话了（TOFU 重试、或者用户关掉又立刻重连）。
    /// 不校验的话，死掉的旧会话会把**活着的新会话**从表里摘掉 —— 表现是终端
    /// 还在，但每一次输入都报「会话已经不在活动状态」，而且再也关不掉了。
    pub fn forget(&self, id: &str, generation: u64) {
        let mut map = self.lock();
        if map.get(id).map(|s| s.generation()) == Some(generation) {
            map.remove(id);
        }
    }

    /// 关掉全部会话。
    ///
    /// 给「前端重新加载了」这个场景兜底：webview 一刷新，它那边的回调 id 全没了，
    /// 但 Rust 侧的会话还活着，用户在新界面上**看不见也关不掉**它们。
    /// 前端 `init()` 的时候调一次这个，等于把孤儿收干净。
    pub async fn close_all(&self) {
        let all: Vec<Arc<Session>> = {
            let mut map = self.lock();
            map.drain().map(|(_, s)| s).collect()
        };
        for session in all {
            session.close().await;
        }
    }

    /// 当前活着的会话数。测试用，也用来给「有没有泄漏」做断言
    pub fn len(&self) -> usize {
        self.lock().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<Session>>> {
        // 锁中毒只可能来自别的线程持锁时 panic。这里的数据是个 HashMap，
        // 被中断的操作不会让它处于不一致状态，取出内部值继续用
        self.sessions.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// 把事件流转发到一个同步的出口，直到会话结束。
///
/// 放在 crate 里而不是 `ssh_commands.rs` 里，是为了**能测** ——
/// Tauri 那层只是把一个 `Channel` 包成闭包，逻辑全在这里。
///
/// 返回最后一个 `Exit` 事件里带的退出码（有的话）。
pub async fn forward<F>(mut rx: mpsc::Receiver<TerminalEvent>, mut sink: F) -> Option<u32>
where
    F: FnMut(TerminalEvent),
{
    let mut code = None;
    while let Some(event) = rx.recv().await {
        let is_exit = match &event {
            TerminalEvent::Exit { code: c, .. } => {
                code = *c;
                true
            }
            TerminalEvent::Data { .. } => false,
        };
        sink(event);
        // Exit 永远是最后一个事件，发完就收工。
        // 靠它而不是靠 `None`：sink 那边可能已经没人听了（用户关掉了窗口），
        // 那时候继续读下去只是空转
        if is_exit {
            break;
        }
    }
    code
}
