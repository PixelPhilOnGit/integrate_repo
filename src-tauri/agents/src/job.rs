//! Windows 的 Job Object：唯一能保证「关窗格不留孤儿」的机制。
//!
//! # 为什么非得是它
//!
//! Windows 没有进程组这个东西（`CREATE_NEW_PROCESS_GROUP` 只影响
//! `GenerateConsoleCtrlEvent` 能发给谁，谁也不会因此被杀）。所以：
//!
//! * `portable_pty` 的 `Child::kill()` = `TerminateProcess(直接子进程)`
//!   （源码 `win/mod.rs`，就一行）。`claude` 底下的 node、`npm start` 底下的
//!   npm/node —— **一个都不死**，而且用户看不见它们。
//! * `taskkill /T /F /PID` 是另一条路，但它是**按父子关系**去遍历的：
//!   中间任何一层被重新挂靠过（服务、`start`、某些启动器）就断了，
//!   而且它是个独立进程，本身还可能失败。
//!
//! Job Object 是内核级的容器：进程一旦进作业，它**之后** fork 出来的所有进程
//! 都自动进同一个作业（除非显式 `CREATE_BREAKAWAY_FROM_JOB`）。
//! 再给作业加上 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`，语义就变成：
//! **句柄一关，作业里所有进程一起死**。
//!
//! 最后这条带来的好处比「关窗格」大得多：Devtoolkit 自己**崩了**（或者被任务
//! 管理器结束）的时候，内核会关掉它的句柄 —— 于是那一屏 agent 一起收尸。
//! 没有别的机制能在进程崩掉之后还管事。
//!
//! # 它**不**覆盖的情况
//!
//! 需要保留 `CREATE_BREAKAWAY_FROM_JOB` 才能逃出去的东西（少数安装器、
//! 某些沙箱），以及**已经在别的作业里且那个作业不允许嵌套**的情况。后面这条
//! 在 Win8 之后基本不存在（嵌套作业是支持的），但真失败了我们也不是没招 ——
//! 见 [`kill_by_pid`]。

use std::os::windows::io::RawHandle;

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

/// 一个作业对象。
///
/// 句柄的生命周期就是「这棵进程树该活着的时间」—— 把它和 pane 绑在一起，
/// 见 `PtySession::job`。
pub struct JobObject {
    handle: HANDLE,
}

// `HANDLE` 在 windows-sys 里是 `*mut c_void`，裸指针默认既不是 Send 也不是
// Sync。这里放宽是**有依据的**：句柄本身只是一个不透明的内核编号，
// 而 CloseHandle / TerminateJobObject 这类操作在内核里是线程安全且幂等的
// （double-close 才是问题，而那是所有权问题，由 Rust 这边的 `&self`/Drop 管住）。
unsafe impl Send for JobObject {}
unsafe impl Sync for JobObject {}

impl JobObject {
    /// 建一个「句柄关掉就杀光」的作业。
    ///
    /// 返回 `None` 表示这个机制用不上（创建或设置失败），调用方要退到
    /// [`kill_by_pid`] —— **默默当成功是不行的**，那样孤儿进程会一路留到
    /// 用户重启机器。
    pub fn create() -> Option<Self> {
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                return None;
            }

            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

            let ok = SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of_val(&info) as u32,
            );
            if ok == 0 {
                CloseHandle(handle);
                return None;
            }

            Some(Self { handle })
        }
    }

    /// 把一个刚起来的进程放进作业。**要在它自己去 fork 之前调**。
    ///
    /// ⚠️ 这里有个小窗口：`CreateProcessW` 返回之后、我们 assign 之前，
    /// 子进程理论上可以先起孙子进程，那些孙子就不在作业里。
    /// 消掉它要 `CREATE_SUSPENDED` + `ResumeThread`，而进程是 `portable_pty`
    /// 起的，不给我们插这一步的机会（wezterm 同样只做到这一步）。
    /// 实际上窗口是微秒级，而子进程（cmd.exe）光初始化就要几十毫秒。
    pub fn assign(&self, process: RawHandle) -> bool {
        unsafe { AssignProcessToJobObject(self.handle, process as HANDLE) != 0 }
    }

    /// 立刻干掉作业里所有进程。**不影响这个作业继续可用**。
    pub fn terminate(&self) {
        unsafe {
            TerminateJobObject(self.handle, 1);
        }
    }
}

impl Drop for JobObject {
    fn drop(&mut self) {
        unsafe {
            // 这一句就是 `KILL_ON_JOB_CLOSE` 的扳机：句柄是最后一个引用时关掉，
            // 作业里的进程全部终止。**不要**在这里先 terminate 再关 ——
            // terminate 是给「关窗格但进程还留着」用的，Drop 的场景是
            // 「这个句柄不该再存在了」，让内核顺手清干净就行。
            CloseHandle(self.handle);
        }
    }
}

/// 退路：作业用不上的时候，至少把整棵树按父子关系杀掉。
///
/// 用 `taskkill /T /F`。它比作业弱（重新挂靠过的进程会漏），但比
/// `TerminateProcess(直接子进程)` 强得多。走绝对路径而不是靠 PATH：
/// 这个分支本来就是「环境不对劲」时才走到的，不该再假设 PATH 是好的。
///
/// 故意**不等它结束**：这是收尾路径，调用方（关窗格、退出应用）
/// 不该为了看一眼 `taskkill` 的输出而卡住。
pub fn kill_by_pid(pid: u32) {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    /// `CREATE_NO_WINDOW`：不设它的话，GUI 应用每杀一次就会闪一个黑框
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
    let taskkill = format!("{root}\\System32\\taskkill.exe");

    let _ = Command::new(taskkill)
        .args(["/T", "/F", "/PID", &pid.to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn();
}
