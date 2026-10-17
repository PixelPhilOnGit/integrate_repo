//! 进程层：**解析程序路径、起进程、把整棵进程树收掉**。
//!
//! 这是这个 crate 里**唯一允许 unsafe 的地方**（`lib.rs` 用 `deny(unsafe_code)`，
//! 本模块显式 allow）。原因：Unix 的 `killpg` / `PR_SET_PDEATHSIG` 和 Windows
//! 的 Job Object 都是 `unsafe` 的裸系统调用。
//!
//! # 为什么要整棵树
//!
//! 群成员是 `claude` / `codex` / `csc` 这类 CLI，它们底下还会起 node、git、
//! 编译器等孙子进程。`Child::kill()` 只杀直接子进程（Windows 上尤其如此），
//! 用户点了「停止」之后那些孙子还在后台改文件 —— 这是本模块最不能接受的失败方式。
//!
//! * **Unix**：spawn 前 `process_group(0)` 建一个新进程组，取消/超时时
//!   `killpg(pid, SIGKILL)`；再用 `PR_SET_PDEATHSIG` 保证 Devtoolkit 自己崩掉时
//!   直接子进程跟着死。
//! * **Windows**：Job Object + `KILL_ON_JOB_CLOSE`（照抄 `agents/src/job.rs` 的
//!   做法，那套在真机上磨过）。作业句柄一关，整个作业里的进程一起死 ——
//!   包括应用自己崩溃的情形。
//!
//! # ⚠️ Windows 的 `.cmd`
//!
//! npm 全局安装的 CLI 在 Windows 上是 `claude.cmd` / `codex.cmd`，而
//! `CreateProcess` **不能直接执行 `.cmd`**。所以 [`resolve_program`] 要做
//! PATHEXT 补全，并把 `.cmd/.bat` 换成 `cmd.exe /D /S /C <脚本>`。这是最容易
//! 在真机才发现的坑，Windows CI 有专门的测试。

#![allow(unsafe_code)]

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tokio::io::{AsyncRead, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::mpsc;

use crate::adapter::CommandPlan;
use crate::error::GroupError;

/// 一行输出的上限。超过就截断（JSONL 行正常只有几 KB）。
pub const MAX_LINE_BYTES: usize = 8 * 1024 * 1024;

/// 解析后的程序：真正要执行的程序 + 启动器前缀。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedProgram {
    pub program: String,
    pub prefix_args: Vec<String>,
}

/// 解析用户填的 program 到「真正能 spawn 的东西」。
///
/// * 含路径分隔符：按路径找（Windows 上没扩展名时按 PATHEXT 补）；
/// * 否则按 `PATH` 找；
/// * Windows 上 `.cmd/.bat` → `cmd.exe /D /S /C <脚本>`；
/// * 找不到 → 明确报错（**不要**把错误拖到 spawn 阶段变成一句系统错误码）。
pub fn resolve_program(raw: &str) -> Result<ResolvedProgram, GroupError> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err(GroupError::spawn("", "程序名是空的"));
    }

    let direct = Path::new(raw);
    let has_sep = raw.contains('/') || raw.contains('\\');
    let found = if has_sep {
        resolve_at(direct)
    } else {
        find_in_path(raw)
    };

    let Some(path) = found else {
        return Err(GroupError::spawn(
            raw,
            "找不到这个程序（按 PATH 和环境变量都没找到）",
        ));
    };

    #[cfg(windows)]
    {
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if ext == "cmd" || ext == "bat" {
            let root = std::env::var("SystemRoot")
                .unwrap_or_else(|_| "C:\\Windows".to_string());
            return Ok(ResolvedProgram {
                // 绝对路径，不靠 PATH —— 走这个分支时环境本来就不一定正常。
                program: format!("{root}\\System32\\cmd.exe"),
                prefix_args: vec![
                    "/D".to_string(),
                    "/S".to_string(),
                    "/C".to_string(),
                    path.display().to_string(),
                ],
            });
        }
    }

    Ok(ResolvedProgram {
        program: path.display().to_string(),
        prefix_args: Vec::new(),
    })
}

/// 给定路径（可能没有扩展名）：存在就返回。
fn resolve_at(path: &Path) -> Option<PathBuf> {
    if path.is_file() {
        return Some(path.to_path_buf());
    }
    #[cfg(windows)]
    {
        for ext in windows_extensions() {
            let candidate = path.with_extension(ext.trim_start_matches('.'));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// 在 PATH 里找。Windows 按 PATHEXT 补后缀，**优先 .exe/.com**。
fn find_in_path(name: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    let exts: Vec<String> = {
        #[cfg(windows)]
        {
            windows_extensions()
        }
        #[cfg(not(windows))]
        {
            vec![String::new()]
        }
    };

    // 有扩展名的先原样试；没有的按扩展名顺序试（.exe 优于 .cmd）。
    let mut candidates: Vec<String> = Vec::new();
    if Path::new(name).extension().is_some() {
        candidates.push(name.to_string());
    } else {
        for ext in &exts {
            candidates.push(format!("{name}{ext}"));
        }
    }

    for dir in std::env::split_paths(&path_var) {
        for candidate in &candidates {
            let path = dir.join(candidate);
            if path.is_file() {
                return Some(path);
            }
        }
    }
    None
}

#[cfg(windows)]
fn windows_extensions() -> Vec<String> {
    // 顺序就是优先级：.exe/.com 是真可执行，.cmd/.bat 要走 cmd.exe 启动器。
    let raw = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
    let mut out: Vec<String> = raw
        .split(';')
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .collect();
    out.sort_by_key(|ext| match ext.as_str() {
        ".com" | ".exe" => 0,
        ".cmd" | ".bat" => 1,
        _ => 2,
    });
    out
}

/// 起来的进程 + 它的「杀树开关」。
pub struct Spawned {
    pub child: Child,
    pub killer: Arc<TreeKiller>,
}

/// 杀掉一棵进程树。**必须是线程安全的**：`group_stop` 从命令线程直接调，
/// 不依赖运行中的那一轮是否还活着。
pub struct TreeKiller {
    #[cfg(unix)]
    pid: u32,
    #[cfg(windows)]
    pid: u32,
    #[cfg(windows)]
    job: Option<JobHandle>,
    alive: AtomicBool,
}

unsafe impl Send for TreeKiller {}
unsafe impl Sync for TreeKiller {}

impl TreeKiller {
    /// 幂等：第一次调用真的杀，之后是空操作（避免 pid 复用后误杀无关进程）。
    pub fn kill(&self) {
        if !self.alive.swap(false, Ordering::SeqCst) {
            return;
        }
        self.kill_now();
    }

    /// 收尸之后调用：之后 `kill()` 不会再有动作。
    pub fn mark_reaped(&self) {
        self.alive.store(false, Ordering::SeqCst);
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    #[cfg(unix)]
    fn kill_now(&self) {
        if self.pid <= 1 {
            return;
        }
        unsafe {
            // 进程组（spawn 时 process_group(0) 建的）：整棵树一起。
            libc::killpg(self.pid as i32, libc::SIGKILL);
            // 兜底：万一进程组没建起来（或 pgid 不是 pid），至少杀掉直接子进程。
            libc::kill(self.pid as i32, libc::SIGKILL);
        }
    }

    #[cfg(windows)]
    fn kill_now(&self) {
        match &self.job {
            Some(job) => job.terminate(),
            None => kill_by_pid(self.pid),
        }
    }

    #[cfg(not(any(unix, windows)))]
    fn kill_now(&self) {}
}

impl Drop for TreeKiller {
    fn drop(&mut self) {
        // Windows 的 Job 句柄在 JobHandle::drop 里关 —— KILL_ON_JOB_CLOSE 会
        // 顺手收掉还活着的孙子进程。Unix 不做无条件清理（进程组可能还有
        // 用户故意留下的后台进程），取消/超时那条路已经显式 kill 过了。
    }
}

/// 起一个成员进程。stdin/stdout/stderr 全 piped；Windows 上不弹黑框。
pub async fn spawn(plan: &CommandPlan) -> Result<Spawned, GroupError> {
    let resolved = resolve_program(&plan.program)?;

    let mut cmd = Command::new(&resolved.program);
    cmd.args(&resolved.prefix_args);
    cmd.args(&plan.prefix_args);
    cmd.args(&plan.args);
    cmd.current_dir(&plan.cwd);
    for (key, value) in &plan.env {
        cmd.env(key, value);
    }
    cmd.stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    #[cfg(unix)]
    {
        cmd.process_group(0);
        unsafe {
            use std::os::unix::process::CommandExt;
            cmd.as_std_mut().pre_exec(|| {
                // 应用崩掉时，直接子进程跟着死（否则群成员会在后台继续改文件）。
                libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL);
                // 竞态：fork 之后、prctl 之前父进程没了 —— getppid 会变成 1。
                if libc::getppid() == 1 {
                    libc::_exit(1);
                }
                Ok(())
            });
        }
    }

    let mut child = cmd.spawn().map_err(|e| GroupError::Spawn {
        program: resolved.program.clone(),
        reason: e.to_string(),
    })?;

    // prompt 走 stdin：单独一个任务写 + 关掉（不等它，避免大 prompt 卡住主流程）。
    if let Some(prompt) = plan.stdin.clone() {
        if let Some(mut stdin) = child.stdin.take() {
            tokio::spawn(async move {
                use tokio::io::AsyncWriteExt;
                let _ = stdin.write_all(prompt.as_bytes()).await;
                let _ = stdin.shutdown().await;
            });
        }
    }

    let pid = child.id().unwrap_or(0);

    #[cfg(windows)]
    let job = {
        // ⚠️ 先 assign、后返回 —— 窗口是微秒级（见 agents/src/job.rs 的注释）。
        let job = JobHandle::create();
        if let Some(j) = &job {
            match child.raw_handle() {
                Some(handle) if j.assign(handle) => {}
                _ => {
                    // 分配失败就退到 taskkill（kill_now 里按 job=None 走）。
                    return Ok(Spawned {
                        child,
                        killer: Arc::new(TreeKiller {
                            pid,
                            job: None,
                            alive: AtomicBool::new(true),
                        }),
                    });
                }
            }
        }
        job
    };

    Ok(Spawned {
        child,
        killer: Arc::new(TreeKiller {
            pid,
            #[cfg(windows)]
            job,
            alive: AtomicBool::new(true),
        }),
    })
}

/// 一次读一行（可能不是合法 UTF-8），**带上限**。
///
/// ⚠️ 不能用 `AsyncBufReadExt::lines()`：它在非 UTF-8 行上直接报错，而且没有
/// 长度上限（一个坏掉的 CLI 吐一行几个 GB 就能把内存吃穿）。这里用 `fill_buf`
/// 自己切，超限的部分消费掉但不要。
pub async fn next_line<R: AsyncRead + Unpin>(
    reader: &mut BufReader<R>,
) -> std::io::Result<Option<String>> {
    use tokio::io::AsyncBufReadExt;

    let mut out: Vec<u8> = Vec::new();
    let mut overflow = false;
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            if out.is_empty() {
                return Ok(None);
            }
            break;
        }
        match available.iter().position(|&b| b == b'\n') {
            Some(pos) => {
                let take = &available[..=pos];
                if out.len() + take.len() <= MAX_LINE_BYTES {
                    out.extend_from_slice(take);
                } else {
                    overflow = true;
                }
                reader.consume(pos + 1);
                break;
            }
            None => {
                let len = available.len();
                if out.len() + len <= MAX_LINE_BYTES {
                    out.extend_from_slice(available);
                } else {
                    overflow = true;
                }
                reader.consume(len);
            }
        }
    }

    while matches!(out.last(), Some(b'\n') | Some(b'\r')) {
        out.pop();
    }
    let mut text = String::from_utf8_lossy(&out).into_owned();
    if overflow {
        text.push_str("…（这一行太长，已截断）");
    }
    Ok(Some(text))
}

/// 探测一个 CLI 能不能跑：执行 `<program> --version`，5 秒超时。
///
/// 返回给人看的一行（stdout 优先，其次 stderr）。**不改用户环境**、不传 prompt。
/// 配置面板的「探测」按钮用它回答「这个成员到底装没装、路径对不对」。
pub async fn probe(program: &str, timeout: std::time::Duration) -> Result<String, GroupError> {
    let resolved = resolve_program(program)?;
    let mut cmd = Command::new(&resolved.program);
    cmd.args(&resolved.prefix_args);
    cmd.arg("--version");
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let output = tokio::time::timeout(timeout, cmd.output())
        .await
        .map_err(|_| GroupError::spawn(program, "探测超时（5 秒）"))?
        .map_err(|e| GroupError::spawn(program, e.to_string()))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let text = if !stdout.is_empty() { stdout } else { stderr };
    if text.is_empty() {
        return Err(GroupError::spawn(
            program,
            format!(
                "程序能起来，但 --version 什么都没输出（退出码 {}）",
                output.status.code().unwrap_or(-1)
            ),
        ));
    }
    // 只留第一行：有些 CLI 的 --version 会打一大段。
    Ok(text.lines().next().unwrap_or("").trim().to_string())
}

/// 把 stdout / stderr 同时读掉（顺序读会死锁：管道缓冲满了子进程就不写了）。
pub fn collect_streams(
    child: &mut Child,
) -> (
    mpsc::UnboundedReceiver<String>,
    mpsc::UnboundedReceiver<String>,
) {
    let (out_tx, out_rx) = mpsc::unbounded_channel();
    let (err_tx, err_rx) = mpsc::unbounded_channel();

    if let Some(stdout) = child.stdout.take() {
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            while let Ok(Some(line)) = next_line(&mut reader).await {
                if out_tx.send(line).is_err() {
                    break;
                }
            }
        });
    }
    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr);
            while let Ok(Some(line)) = next_line(&mut reader).await {
                if err_tx.send(line).is_err() {
                    break;
                }
            }
        });
    }
    (out_rx, err_rx)
}

// ------------------------------------------------------------------ Windows

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[cfg(windows)]
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
#[cfg(windows)]
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

/// Job 句柄的所有权包装（`Drop` 关句柄 = KILL_ON_JOB_CLOSE 的扳机）。
#[cfg(windows)]
struct JobHandle(HANDLE);

#[cfg(windows)]
unsafe impl Send for JobHandle {}
#[cfg(windows)]
unsafe impl Sync for JobHandle {}

#[cfg(windows)]
impl JobHandle {
    fn create() -> Option<Self> {
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
            Some(Self(handle))
        }
    }

    fn assign(&self, process: std::os::windows::io::RawHandle) -> bool {
        unsafe { AssignProcessToJobObject(self.0, process as HANDLE) != 0 }
    }

    fn terminate(&self) {
        unsafe {
            TerminateJobObject(self.0, 1);
        }
    }
}

#[cfg(windows)]
impl Drop for JobHandle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

/// 退路：作业建不起来时，按父子关系杀整棵树。
#[cfg(windows)]
pub fn kill_by_pid(pid: u32) {
    if pid == 0 {
        return;
    }
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
    let _ = Command::new(format!("{root}\\System32\\taskkill.exe"))
        .args(["/T", "/F", "/PID", &pid.to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 空程序名给明确错误() {
        let err = resolve_program("  ").expect_err("空名字该报错");
        assert!(matches!(err, GroupError::Spawn { .. }));
    }

    #[test]
    fn 找不到的程序给明确错误_而不是系统错误码() {
        let err = resolve_program("definitely-not-a-real-program-xyz").expect_err("该报错");
        match err {
            GroupError::Spawn { reason, .. } => assert!(reason.contains("找不到")),
            other => panic!("该是 Spawn：{other:?}"),
        }
    }

    #[cfg(unix)]
    #[test]
    fn unix_能按绝对路径解析到_sh() {
        let resolved = resolve_program("/bin/sh").expect("解析 /bin/sh");
        assert_eq!(resolved.program, "/bin/sh");
        assert!(resolved.prefix_args.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn unix_能按_path_解析到_sh() {
        let resolved = resolve_program("sh").expect("在 PATH 里找 sh");
        assert!(resolved.program.ends_with("sh"));
    }
}
