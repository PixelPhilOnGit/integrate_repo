//! 健康日志：应用卡住之后，**事后**能看出堵在哪儿。
//!
//! # 为什么需要它
//!
//! Windows 真机上出过「开着跑一个多小时，界面完全没反应、连关闭窗口都不行，
//! 只能去任务管理器杀进程」。这种问题本机（Linux）复现不了，而**没有现场记录**
//! 的时候只能猜 —— 这个文件就是为了留一份记录。
//!
//! # 记什么（三样，第一样是主体）
//!
//! 1. **主线程心跳。** 每 15 秒那行汇总里带着「主线程上一次有反应是多少秒前」。
//!    那个数字一直涨就说明**主线程被堵住了** —— 窗口关不掉正是它的直接后果。
//!    心跳是**从主线程上**打的（`run_on_main_thread`），不是从后台打的：
//!    后台活着说明不了主线程没事，而这正是要区分的东西。
//! 2. **正在跑的操作。** 每次汇总都列出「此刻还没返回的操作」和已经跑了多久。
//!    写 PTY、杀进程树、resize 都在这条路上：卡住的会一直挂在这一行里，
//!    名字和窗格 id 都在。
//! 3. 定期一行：活着的会话数（agents / ssh）。
//!
//! # 为什么用 std 线程而不是 tokio 任务
//!
//! 要诊断的正是「运行时/主线程被堵住」这种情况。把写日志的活放进同一个运行时，
//! 它自己也一起停摆了 —— 那就什么也记不下来。
//!
//! # 位置和大小
//!
//! 写在应用日志目录下的 `health.log`，**有上限**：超过 1MB 换一份 `.old`
//! （只留两份，不会变成新的磁盘泄漏源）。启动时完整路径写在第一行里，
//! 方便直接找用户要这个文件。

use std::io::Write as _;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use devtoolkit_agents::AgentRegistry;
use devtoolkit_ssh::SshRegistry;

/// 汇总行的间隔。15 秒是「卡住之后不用等太久就能看到异常」和「日志不刷屏」
/// 之间的折中 —— 一次卡死至少留下三四行。
const EVERY: Duration = Duration::from_secs(15);

/// 文件上限。超了就把当前这份改名成 `.old`，重新开一份（只留两份）。
const MAX_BYTES: u64 = 1024 * 1024;

/// 日志文件（路径和句柄一起存，轮转时要用路径）
static FILE: OnceLock<Mutex<(PathBuf, std::fs::File)>> = OnceLock::new();
static START: OnceLock<Instant> = OnceLock::new();

/// 主线程最近一次心跳（相对进程启动的毫秒数）。0 = 还没有过
static BEAT_MS: AtomicU64 = AtomicU64::new(0);

/// 此刻还没返回的操作：`(名字, 细节, 开始时刻)`。
///
/// 用一张全局表而不是「超过多少毫秒就写一行」：**一直没返回**才是最想看到的
/// 那种，而只记时长的话，卡死在里面的那个永远等不到那一行。
static IN_FLIGHT: Mutex<Vec<(&'static str, String, Instant)>> = Mutex::new(Vec::new());

fn now_ms() -> u64 {
    START.get_or_init(Instant::now).elapsed().as_millis() as u64
}

/// 开日志。写不进去就算了（目录不可写之类）—— 诊断不该让应用起不来。
pub fn init(dir: &PathBuf) {
    let _ = std::fs::create_dir_all(dir);
    let path = dir.join("health.log");
    let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(&path) else {
        return;
    };
    let epoch = std::time::UNIX_EPOCH
        .elapsed()
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let _ = writeln!(
        file,
        "--- devtoolkit 健康日志 ---\n文件：{}\n启动：unix={epoch}（这份日志里的时间戳是「进程跑了多久」）",
        path.display(),
    );
    let _ = FILE.set(Mutex::new((path, file)));
}

/// 写一行。
pub fn line(kind: &str, message: &str) {
    let Some(file) = FILE.get() else { return };
    let Ok(mut guard) = file.lock() else { return };
    let (path, handle) = &mut *guard;

    let _ = writeln!(
        handle,
        "[+{:>7.1}s] {kind:<6} {message}",
        now_ms() as f64 / 1000.0
    );
    let _ = handle.flush();

    // 轮转：只在真超了才动，顺手把路径也换掉
    if handle.metadata().map(|m| m.len() > MAX_BYTES).unwrap_or(false) {
        let old = path.with_extension("log.old");
        let _ = std::fs::rename(&*path, &old);
        if let Ok(fresh) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&*path)
        {
            *handle = fresh;
            let _ = writeln!(handle, "--- 换了一份新的（上一份在 {}）", old.display());
        }
    }
}

/// 主线程的心跳。**必须从主线程上调**（见模块头部）。
pub fn beat() {
    BEAT_MS.store(now_ms(), Ordering::Relaxed);
}

/// 一个还在跑的操作。`drop` 时自己从表里摘掉。
///
/// 绑到变量上就行：`let _span = health::span("agent_write", &id);` ——
/// 中途 `return` / `?` 提前走掉也会正常摘掉（Rust 的 drop）。
pub struct Span {
    name: &'static str,
}

pub fn span(name: &'static str, detail: impl Into<String>) -> Span {
    if let Ok(mut list) = IN_FLIGHT.lock() {
        list.push((name, detail.into(), Instant::now()));
    }
    Span { name }
}

impl Drop for Span {
    fn drop(&mut self) {
        if let Ok(mut list) = IN_FLIGHT.lock() {
            // 从后往前找第一个同名的：同时可能有好几个在跑（多个窗格一起写），
            // 从后往前摘保证摘掉的是刚 push 的那个
            if let Some(at) = list.iter().rposition(|(name, _, _)| *name == self.name) {
                list.remove(at);
            }
        }
    }
}

/// 起看门狗：一个 std 线程，定期记汇总 + 请主线程打一次心跳。
pub fn start_watchdog(app: tauri::AppHandle, agents: Arc<AgentRegistry>, ssh: Arc<SshRegistry>) {
    let spawned = std::thread::Builder::new()
        .name("health".to_string())
        .spawn(move || loop {
            std::thread::sleep(EVERY);

            let running = match IN_FLIGHT.lock() {
                Ok(list) => list
                    .iter()
                    .map(|(name, detail, at)| {
                        format!("{name}({detail}) {:.1}s", at.elapsed().as_secs_f32())
                    })
                    .collect::<Vec<_>>(),
                Err(_) => Vec::new(),
            };

            line(
                "状态",
                &format!(
                    "会话 agents={} ssh={} | 主线程心跳 {:.1}s 前 | 在跑：{}",
                    agents.len(),
                    ssh.len(),
                    beat_age_secs(),
                    if running.is_empty() {
                        "没有".to_string()
                    } else {
                        running.join("，")
                    },
                ),
            );

            // 请主线程回一声。它被堵住的话，下一次汇总里那个「心跳 N 秒前」
            // 就会一直涨 —— 那就是我们要的证据
            let _ = app.run_on_main_thread(beat);
        });

    if let Err(e) = spawned {
        line("状态", &format!("看门狗线程没起来：{e}"));
    }
}

/// 主线程离上一次心跳过去多久（秒）。没心跳过就是进程跑到现在这么久。
fn beat_age_secs() -> f32 {
    let beat = BEAT_MS.load(Ordering::Relaxed);
    if beat == 0 {
        return now_ms() as f32 / 1000.0;
    }
    now_ms().saturating_sub(beat) as f32 / 1000.0
}
