//! 本地 PTY：起进程、全双工流字节、改窗口大小、**关掉时不留孤儿**。
//!
//! # 起的是 shell，不是 CLI
//!
//! [`PtyConfig::command`] 不在 argv 里 —— pane 里起的永远是一个**正常 shell**，
//! 那条命令是开好之后当**初始输入**敲进去的（见 [`spawn`] 的 `write`）。
//! 三个理由，都不是洁癖：
//!
//! 1. **Windows 上 npm 装的 CLI 直接 spawn 很容易找不到。** `claude` 在
//!    `%APPDATA%\npm\claude.cmd`，它是**批处理**不是可执行文件，`CreateProcess`
//!    起不来；而 `claude` 这个名字要靠 `PATHEXT` 去补后缀，那是 shell 的活儿。
//! 2. **用户 profile 里的 PATH / 别名 / 版本管理器要生效。** 用户在 `.zshrc`
//!    里 `nvm use` 过，或者用 pyenv 的 shim —— 只有走一遍用户的 shell 才拿得到。
//! 3. **agent 退出之后，用户该剩一个能用的 shell。** CLI 挂了 / Ctrl+C 掉，
//!    窗格里是提示符而不是一块死掉的屏幕，可以直接接着敲。
//!
//! # 事件出口为什么是 mpsc 而不是 `tauri::ipc::Channel`
//!
//! 这个 crate **不依赖 tauri**（那样就没有脱离 WebKit 的测试了），
//! 所以通道由 `agent_commands.rs` 在 Tauri 那一层适配过去 —— 和 SSH 一样。
//!
//! # ⚠️ 关 pane 不能只杀直接子进程
//!
//! `claude` 是 node 起的，底下还有一串；`bash -lc 'npm start'` 底下还有 npm/node。
//! 只杀直接子进程，那些孙进程会活下来接着占端口、接着写文件，而且**用户看不见**
//! —— 他以为窗格已经关掉了。所以：
//!
//! * Unix：**要杀两个进程组**，这一点和「杀掉那个子进程」的直觉不一样：
//!   子进程在 spawn 时 `setsid()` 过（portable-pty 干的），它是一个会话首进程、
//!   自己的进程组的组长（pgid == pid）；可它**开了作业控制之后**，跑在前台的那个
//!   命令（`claude` 本人）会被放进**另一个**进程组 —— 那才是 tty 的前台组。
//!   只杀前者的结果是「shell 死了、claude 还活着」，只杀后者则是反过来。
//!   所以两个都杀，见 [`PtySession::kill_tree`]。
//!
//!   > 有一个**故意不覆盖**的情况：自己 `setsid()` 逃出去的进程（`nohup`、daemon）
//!   > 不在任何我们能杀的进程组里 —— 那正是 `setsid` 的用途。所有终端模拟器
//!   > 都是这条边界，不是这里偷懒。
//! * Windows：**Job Object**，建的时候带 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`，
//!   子进程一 spawn 就 `AssignProcessToJobObject` 进去。见 [`crate::job`]。
//!   `portable-pty` 的 `Child::kill()` 在 Windows 上只有一句 `TerminateProcess`
//!   （源码 `win/mod.rs`），指望不上。作业对象比 Unix 那边**更彻底**：
//!   被作业圈住之后子进程再怎么 fork 都还在作业里（除非显式
//!   `CREATE_BREAKAWAY_FROM_JOB`）。

use std::collections::BTreeMap;
use std::io::{ErrorKind, Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::Duration;

use base64::Engine as _;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};

use crate::error::AgentError;

/// 一次从 pty 读多少字节。
///
/// **4KB，不是 8KB。** 判据不在原始字节上：这些字节要 **base64** 之后才过 IPC，
/// 4KB 会膨胀成约 5.5KB（8KB 会变成约 10.9KB）。Tauri 在 IPC 消息超过 8KB 时
/// 每条要多走一次 fetch 往返，所以按**编码后**的量算，4KB 才是那条线以下的最大值。
///
/// 本地 pty 的一次 `read` 本来就是把内核缓冲区里现有的都给你，所以这里不需要
/// SSH 那边的 8ms 合并窗口 —— 少一层延迟，也不会把两帧画面拼成一条。
const READ_BUF: usize = 4 * 1024;

/// 子进程退出之后，还等读线程多久。
///
/// 这一小段是**为了不丢最后一批输出**：`claude` 退出前打的那句「Bye!」和它的
/// `Exit` 事件是两个线程分别送出来的，谁先到不确定。
///
/// 两个平台的表现不一样，值得说清楚：
/// * Unix：从端全关掉之后 master 上的 `read` 会返回 `EIO`/0，读线程**立刻**结束，
///   所以这 250ms 实际上不会被用完。
/// * Windows：ConPTY 的伪控制台是独立存在的，客户端进程死了**输出管道不会关**，
///   读线程会一直阻塞在那儿。所以这里一定是用满 250ms 才发 `Exit` ——
///   界面上的表现是「进程没了，状态点晚 0.25 秒才变」。可以接受，但它不是 bug。
const DRAIN_TIMEOUT: Duration = Duration::from_millis(250);

/// 事件通道的缓冲。和 SSH 那边同一个量级：够扛住一次满屏重绘，
/// 又不至于在没人读的时候把一堆输出攒在内存里。
pub const EVENT_BUFFER: usize = 64;

/// 开一个 pane 需要的全部参数。
///
/// 字段名就是前端的字段名（单个单词，camelCase 和 snake_case 一样），
/// 但**仍要写 `rename_all`** —— 以后加多词字段时它才是那道保险。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyConfig {
    /// 工作目录，**必须是绝对路径**。不存在就明确报错，不要静默落到别处 ——
    /// 用户以为 agent 在 `D:\work\api` 里跑，实际在 `C:\Windows\System32`，
    /// 那是很吓人的一件事
    pub cwd: String,
    /// 起好 shell 之后当初始输入敲进去的那条命令（`claude`、`codex`、空表示只是 shell）
    pub command: String,
    /// ⚠️ 用 `u32` 收、在 Rust 侧夹到 `u16`：pty 的尺寸上限就是 u16，但前端
    /// 那边算出来的值（除以字符宽、布局还没稳）完全可能越界 —— 让 serde
    /// 直接拒掉的话，用户看到的是一句 `invalid args ... out of range` 的英文，
    /// 而我们要的是「夹一下接着用」。前端也夹过一道（`clampSize`），这里是第二道。
    pub cols: u32,
    pub rows: u32,
    /// 空 = 平台默认（见 [`default_shell`]）
    #[serde(default)]
    pub shell: Option<String>,
    /// 原样注入给子进程的环境变量。Devtoolkit 用它塞
    /// `DEVTOOLKIT_PANE_ID` / `DEVTOOLKIT_EVENT_DIR`，钩子脚本靠它们认门
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}

/// 平台默认 shell。前端传 `shell: null` 时走这里。
///
/// * Unix：`$SHELL` → `/bin/sh`。⚠️ 从 Finder/Dock 启动时环境里**可能没有**
///   `SHELL`（GUI 启动不读登录 shell 的 profile），退到 `/bin/sh` —— 它一定在。
/// * Windows：**按顺序探测** `pwsh.exe`（PowerShell 7）→ `powershell.exe`（5.1，
///   系统自带，路径写死）→ `cmd.exe`。
///
/// # 为什么不是 `%COMSPEC%`
///
/// 用户要的是「原生 Windows（PowerShell / Git Bash）」—— `%COMSPEC%` 就是
/// `cmd.exe`，两者都不是，而且 cmd 还有代码页问题（中文输出可能乱）。
///
/// **自己解析成绝对路径**再传进去，不依赖 portable-pty 的 `search_path`：
/// 那条路要过注册表的 PATH，而注册表里的 PATH 未必等于这个进程看到的 PATH。
///
/// # 给 PowerShell 的那个 `-NoLogo`
///
/// 这是唯一一个参数，而且它**不是给 shell 用的功能**：PowerShell 交互启动会打
/// 一段「Windows PowerShell / Copyright…」横幅，每个窗格来一遍就是纯噪音。
/// `-NoLogo` 正好治它。
///
/// **刻意不加 `-NoProfile`**：加了用户的别名、`$env:PATH` 里那些 nvm/scoop 加的
/// 路径就全没了 —— 而「让用户的 profile 生效」正是我们起 shell 而不直接 spawn CLI
/// 的**两条理由之一**（另一条是 Windows 上的 `.cmd` 垫片）。profile 打出来的
/// 东西是用户自己的配置，那是他的选择。
pub fn default_shell() -> String {
    #[cfg(windows)]
    {
        for candidate in [
            // PowerShell 7（可能没装）
            "pwsh.exe",
            // Windows PowerShell 5.1：系统自带，位置写死，不用查 PATH
            r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
            // 最后的兜底：一定在
            "cmd.exe",
        ] {
            if let Some(found) = resolve_program(candidate) {
                return found;
            }
        }
        "cmd.exe".to_string()
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "/bin/sh".to_string())
    }
}

/// 起 shell 时要带的额外参数。
///
/// 现在只有一条：PowerShell 的 `-NoLogo`（见 [`default_shell`] 的说明）。
/// **别往这里加功能性的参数** —— 用户 profile 里的东西不该被我们覆盖。
fn shell_args(shell: &str) -> Vec<&'static str> {
    let name = Path::new(shell)
        .file_name()
        .map(|n| n.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if name.starts_with("powershell") || name.starts_with("pwsh") {
        vec!["-NoLogo"]
    } else {
        Vec::new()
    }
}

/// 把一个程序名解析成绝对路径。找不到返回 `None`。
///
/// 自己扫 PATH 而不是靠 `CommandBuilder` 的 `search_path`：那条路在 Windows 上
/// 会走注册表，和这个进程眼里的 PATH 未必是一回事。
#[cfg(windows)]
fn resolve_program(program: &str) -> Option<String> {
    let path = Path::new(program);
    if path.is_absolute() {
        return path.exists().then(|| program.to_string());
    }

    let exts: Vec<String> = std::env::var("PATHEXT")
        .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string())
        .split(';')
        .filter(|s| !s.is_empty())
        .map(|s| s.to_ascii_lowercase())
        .collect();

    for dir in std::env::split_paths(&std::env::var_os("PATH")?) {
        let candidate = dir.join(program);
        if candidate.is_file() {
            return Some(candidate.display().to_string());
        }
        // 名字没带后缀时按 PATHEXT 补（`pwsh` → `pwsh.exe`）
        if path.extension().is_none() {
            for ext in &exts {
                let with_ext = dir.join(format!("{program}{ext}"));
                if with_ext.is_file() {
                    return Some(with_ext.display().to_string());
                }
            }
        }
    }
    None
}

/// 从 pane 里送出来的东西。**这个枚举就是 IPC 契约**（见 `contract` 测试）。
///
/// 字节走 base64，和 SSH 同一个理由：`Vec<u8>` 过 serde_json 会变成数字数组
/// （每个字节三四个字符），而按字符串传会在多字节 UTF-8 被块边界切断时
/// 变成一串 U+FFFD，而且丢的信息不可恢复。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PtyEvent {
    /// 终端输出（base64）
    Data { bytes: String },
    /// 进程没了。
    ///
    /// `code` 是 `null` 的两种情况：被信号杀掉（Unix 上没有「退出码」这个概念），
    /// 或者平台拿不到退出码。**不要把它当成 0**。
    Exit { code: Option<i32> },
}

/// [`spawn`] 的返回：会话句柄 + 事件流。
pub struct OpenedPty {
    pub session: Arc<PtySession>,
    /// 事件流。和 SSH 一样：**开失败时不会走到这里**（失败是 `Err`）。
    pub events: tokio::sync::mpsc::Receiver<PtyEvent>,
    /// 给 [`crate::registry::AgentRegistry::forget`] 做身份校验用
    pub generation: u64,
}

/// 一个活着的 pane。
///
/// 线程模型：**两个 std 线程**（读、等退出），不是 tokio 任务。
/// 理由是这里的两件事本质都是阻塞的（`read()` 和 `wait()`），
/// 丢进 tokio 只能靠 `spawn_blocking` 假装异步，还不如直接开线程说得清楚。
/// 代价是每个 pane 两个线程 —— 一屏十几个 pane 也就三十个线程，无所谓。
pub struct PtySession {
    /// `None` 表示已经关掉了（锁里的是 Option 就是为了这个）
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    /// 上一次报给内核的尺寸。**和 Windows 上那条「resize 会整屏重绘」直接相关**，
    /// 见 [`PtySession::resize`]
    last_size: Mutex<(u16, u16)>,
    /// 是不是**我们**把它杀掉的。等待线程靠它决定退出码报什么，见 [`spawn`] 里
    /// 关于「被杀的进程没有退出码」那段
    killed: Arc<AtomicBool>,
    /// 直接子进程的 pid。它就是会话首进程，**它的进程组号 == 它自己**
    /// （spawn 时 setsid 过），所以杀它那一组要用这个值。
    pid: Option<u32>,
    /// Job Object（Windows）。**它活着就等于那棵树被拴着**：
    /// 句柄一关（包括 Devtoolkit 自己崩掉时由内核关），整个作业一起没。
    #[cfg(windows)]
    job: Option<crate::job::JobObject>,
    /// 这次会话的代次。收尾时拿它确认「表里那个会话确实是我」，见
    /// [`crate::registry::AgentRegistry::forget`]
    generation: u64,
    closed: AtomicBool,
}

impl PtySession {
    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// 往 pane 里写字节（键盘输入、粘贴、resize 通知都走这儿）。
    pub fn write(&self, bytes: &[u8]) -> Result<(), AgentError> {
        let mut guard = self.lock(&self.writer);
        let writer = guard.as_mut().ok_or(AgentError::Closed)?;
        writer
            .write_all(bytes)
            .and_then(|()| writer.flush())
            .map_err(|e| AgentError::Write {
                reason: e.to_string(),
            })
    }

    /// 告诉里面的程序窗口大小变了。
    ///
    /// # 两个平台的语义**不一样**，写清楚了免得按一边的经验去理解另一边
    ///
    /// * Unix：`ioctl(TIOCSWINSZ)` 改内核里记的 winsize，**内核顺手给该 tty 的
    ///   前台进程组发一个 SIGWINCH**（前提是子进程有控制终端 —— portable-pty
    ///   在 spawn 时做了 `TIOCSCTTY`，它源码里那句注释就是为这个）。
    ///   信号是异步、可合并的：连改三次可能只收到一个 SIGWINCH，
    ///   程序该收到信号之后自己去 `TIOCGWINSZ` 查当前值，而不是从信号里读尺寸。
    /// * Windows：`ResizePseudoConsole`。没有信号这回事 —— conhost 给挂在上面的
    ///   控制台程序发一个 `WINDOW_BUFFER_SIZE_EVENT`，Node 之类的运行时把它翻译成
    ///   自己的 resize 事件。**而且 ConPTY 会顺手重排已有的屏幕内容**（Unix 上
    ///   要不要重绘完全看程序自己）。像素尺寸两个平台都忽略，传 0。
    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), AgentError> {
        // 0 列/行会让全屏程序算出垃圾布局，夹一下。前端也夹过（`clampSize`），
        // 这里是第二道 —— 命令层的参数是外部输入，不该只有一个地方管。
        // **夹而不是截断**：越界的值来自计算（除以字符宽），夹一下接着用比报错好
        let (cols, rows) = (cols.max(1), rows.max(1));

        // ⚠️ **尺寸没变就别往下传。**
        //
        // Windows 上 `ResizePseudoConsole` 会让 ConPTY **重排并重绘整屏**，然后把
        // 重绘区域当新的 VT 输出推进管道 —— 也就是一次 resize 就是一次满屏流量。
        // 而用户拖分隔条会连发几十次（同一尺寸重复发是常态）。不挡掉的话，
        // 拖一下分隔条就是几十次整屏重绘。
        // Unix 上代价小一些（内核只是改 winsize + 发个 SIGWINCH），但同样没必要。
        {
            let mut last = self.lock(&self.last_size);
            if *last == (cols, rows) {
                return Ok(());
            }
            *last = (cols, rows);
        }

        let guard = self.lock(&self.master);
        let master = guard.as_ref().ok_or(AgentError::Closed)?;
        master
            .resize(PtySize {
                // ⚠️ `PtySize` 的字段顺序是 rows, cols, pixel_width, pixel_height
                // —— **rows 在前**。参数顺序是 (cols, rows) 的那些 API（比如 SSH 的
                // `window_change`）照抄过来必翻车，所以这里一律用具名字段
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| AgentError::Resize {
                reason: e.to_string(),
            })
    }

    /// 关掉这个 pane：**先杀整棵进程树，再收句柄**。幂等。
    ///
    /// 顺序不能反：先把 master 丢了的话，Windows 上 ConPTY 一关，子进程可能
    /// 被 conhost 直接干掉、也可能不会（取决于版本），而且这时候再去 `killpg`
    /// 已经找不到人了。**杀在前，收在后。**
    pub fn close(&self) {
        if self.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        self.kill_tree();

        // 输入方向先收掉（`UnixMasterWriter` 的 `Drop` 会往终端写一个 `\n` + EOT，
        // 那是它让 shell 自己退出的方式 —— 不过我们前面已经 SIGKILL 过了，
        // 这一步现在只是把句柄放掉）。
        let writer = self.lock(&self.writer).take();
        drop(writer);

        // 丢掉 master：Unix 上关掉 pty 主端的 fd（从端全没了的话内核会给前台
        // 进程组补一个 SIGHUP），Windows 上 ClosePseudoConsole —— 读线程就是在
        // 等这个（ConPTY 的输出管道是跟着伪控制台关掉的）。
        //
        // ⚠️ **放在另一个线程里丢。** `ClosePseudoConsole` 在 Win11 24H2
        // （build 26100）之前会**等所有客户端断开**，而这个等待没有上界
        // （MS 文档里 CreatePseudoConsole 那句 "cause the calling application to
        // hang" 是同一条路子）。在调用方的线程上丢，就等于把「关一个窗格」和
        // 「应用退出」都押在那个等待上 —— 而这条路的调用方是 Tauri 的运行时线程。
        //
        // 我们已经先把整棵树 SIGKILL 了，所以这里等不到人的情况基本不会发生；
        // 但「基本」不值得拿应用退出去赌。代价是最坏情况下留一个卡住的线程，
        // 那比卡住退出流程好。
        if let Some(master) = self.lock(&self.master).take() {
            let _ = std::thread::Builder::new()
                .name("pty-close".to_string())
                .spawn(move || drop(master));
        }
    }

    /// 杀整棵进程树。可以重复调。
    ///
    /// 头注释里那段「为什么要杀两个组」在这里落地：
    /// 前台组**现查现杀**（用户在 pane 里敲了命令之后，前台组就是那条命令的组，
    /// 和 spawn 的时候已经不一样了），会话首进程那一组用 spawn 时记下的 pid。
    fn kill_tree(&self) {
        // 先置位再动手：等待线程可能在我们动手的同一瞬间拿到退出状态，
        // 顺序反了的话它会报出一个假的退出码
        self.killed.store(true, Ordering::SeqCst);

        #[cfg(unix)]
        {
            let mut groups: Vec<libc::pid_t> = Vec::with_capacity(2);

            // ① 前台进程组：tty 上正在跑的那个（通常就是 claude 本尊）
            if let Some(master) = self.lock(&self.master).as_ref() {
                if let Some(fg) = master.process_group_leader() {
                    groups.push(fg);
                }
            }
            // ② 会话首进程自己的组：shell 就在这一组里
            //    （子进程 setsid() 过，所以 pgid == pid）
            if let Some(pid) = self.pid {
                groups.push(pid as libc::pid_t);
            }

            groups.dedup();
            for pgid in groups {
                // 0 和 1 是真会出事的：killpg(0, ...) 杀的是**我们自己**所在的
                // 进程组（Devtoolkit 整个进程一起死），killpg(1, ...) 是 init。
                // 正常情况下这两个值不可能从上面那两处拿到，但这是那种
                // 「一万次里错一次就把整个应用带走」的分支，值得一行防守
                if pgid <= 1 {
                    continue;
                }
                // SIGKILL 而不是 SIGTERM：这一步是「关窗格」和「应用退出」，
                // 用户已经决定了，不该再给程序讨价还价的机会（TERM 能被忽略，
                // 忽略之后我们就只能一直等）
                unsafe {
                    libc::killpg(pgid, libc::SIGKILL);
                }
            }
        }

        #[cfg(windows)]
        {
            match &self.job {
                // 作业里的进程一起死。就算这一步没做，`JobObject` 的 Drop
                // （关句柄 → KILL_ON_JOB_CLOSE）也会兜住。
                Some(job) => job.terminate(),
                // 作业没建起来（少见，但不是不可能）：退到 taskkill /T /F。
                // **不能就这么算了** —— 直接子进程底下的 node/子 shell 会活下来，
                // 而用户以为窗格已经关了
                None => {
                    if let Some(pid) = self.pid {
                        crate::job::kill_by_pid(pid);
                    }
                }
            }
        }

        // 这里**刻意不用** `ChildKiller`：
        // * Windows 上 `clone_killer()` 是坏的（wezterm#5107，`kill()` 会 panic），
        //   而且 `portable-pty` 的 `kill()` 本来也只有一句 `TerminateProcess(自己)`，
        //   杀了也留一堆孙进程；
        // * Unix 上按进程组杀已经覆盖了直接子进程。
        // 所以两条路都不需要它，`Child` 交给等待线程独占就行。
    }

    /// 锁中毒只可能来自别的线程持锁时 panic。这里锁里是句柄和通道，
    /// 没有会被中断破坏的复合状态，取出内部值继续用。
    fn lock<'a, T>(&self, m: &'a Mutex<T>) -> std::sync::MutexGuard<'a, T> {
        m.lock().unwrap_or_else(|e| e.into_inner())
    }
}

impl Drop for PtySession {
    /// 兜底：注册表被丢掉（应用退出、或者谁把最后一个 Arc 放了）时也要杀干净。
    ///
    /// 显式的 [`PtySession::close`] 才是正常路径（它先杀再收），
    /// 这里只是保证「忘了调 close」不会变成一堆孤儿进程。
    fn drop(&mut self) {
        self.close();
    }
}

/// 起一个 pane。
///
/// 返回之后进程已经在跑了、事件流已经在推了、初始命令也已经敲进去了。
pub fn spawn(id: &str, cfg: &PtyConfig, generation: u64) -> Result<OpenedPty, AgentError> {
    // ⚠️ **这是这个模块里唯一一条真的路径穿越，而且它绕过 Rust 侧所有校验。**
    //
    // `id` 会被当环境变量注入进去，钩子脚本拿它**拼文件名**
    // （`> "$DEVTOOLKIT_EVENT_DIR/waiting.$DEVTOOLKIT_PANE_ID"`）。
    // 一个含 `/`、`\` 或者 `..` 的 id 就能让那句重定向**写到事件目录外面去**
    // —— 脚本是 shell，它不做任何校验。
    //
    // 所以拦在这里，而且要在注入环境变量**之前**。
    if !crate::events::valid_pane_id(id) {
        return Err(AgentError::BadConfig {
            reason: format!(
                "会话 id 只能是 [A-Za-z0-9_-] 里的 1..=64 个字符（拿到的是 {id:?}）—— \
                 它会进到钩子脚本拼出来的文件名里，所以不能带路径分隔符"
            ),
        });
    }

    let cwd = Path::new(&cfg.cwd);
    if !cwd.is_absolute() {
        return Err(AgentError::BadConfig {
            reason: format!("工作目录必须是绝对路径：{}", cfg.cwd),
        });
    }
    if !cwd.is_dir() {
        // 这条文案会直接进「起不来：……」的状态说明里，所以要说清楚是哪个目录
        return Err(AgentError::BadConfig {
            reason: format!("工作目录不存在或者不是目录：{}", cfg.cwd),
        });
    }

    // 尺寸在这里就夹好，后面（resize 去重）用的是同一个口径
    let (cols0, rows0) = (
        cfg.cols.clamp(1, u16::MAX as u32) as u16,
        cfg.rows.clamp(1, u16::MAX as u32) as u16,
    );

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            // ⚠️ `PtySize` 的字段顺序是 rows 在前（见 `resize` 里的注释）
            rows: rows0,
            cols: cols0,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| AgentError::Spawn {
            id: id.to_string(),
            reason: format!("创建 PTY 失败：{e}"),
        })?;

    let shell = cfg
        .shell
        .clone()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(default_shell);

    let mut cmd = CommandBuilder::new(&shell);
    for arg in shell_args(&shell) {
        cmd.arg(arg);
    }
    cmd.cwd(cwd);

    // ⚠️ **`TERM` 必须我们自己注入。**
    //
    // 应用是从桌面启动的，环境里通常**没有** `TERM` —— 子进程于是按「未知终端」
    // 处理：配色没了、TUI 降级成纯文本。而这个模块的核心就是「在窗格里跑
    // claude / codex 的 TUI」，没颜色等于废了一半，而且它**不报错**，
    // 只是「看起来怪怪的」，最容易拖到很晚才发现。
    //
    // 前端不管这件事：那是平台细节，而且它漏一次就漏一辈子。
    cmd.env("TERM", "xterm-256color");
    #[cfg(windows)]
    {
        // ConPTY 支持 24 位色，但不少 CLI 靠这个变量才肯开真彩色
        cmd.env("COLORTERM", "truecolor");
    }

    // 调用方传进来的环境变量（`DEVTOOLKIT_PANE_ID` / `DEVTOOLKIT_EVENT_DIR`）。
    //
    // ⚠️ 这两个值**不是从前端来的**：`agent_commands.rs` 用会话 id 和它自己算出来的
    // 事件目录覆盖掉前端传的那一份。理由是「事件往哪写」只能有一个来源 ——
    // 前端多传一个别的目录进来，状态的去向就跟着变了，而那条链路（脚本 → 文件 →
    // 我们读）出了偏差是**静默**的。
    for (k, v) in &cfg.env {
        cmd.env(k, v);
    }

    // ⚠️ **Windows 上要把 PATH 抢回来**（放在最后，谁也别想再盖掉它）。
    //
    // portable-pty 的 `CommandBuilder` 在 Windows 上会从注册表
    // （`HKLM\...\Session Manager\Environment`）读 PATH 并 **insert 盖掉**
    // 进程自己的 PATH（`cmdbuilder.rs` 的 `get_base_env`）。后果很具体：
    // nvm / fnm / volta / scoop 往当前会话里加的那些路径全丢 —— 用户用 nvm 装的
    // `claude` 就找不到了。表现是「在这个窗口里起不来，在我自己的终端里好好的」，
    // 而从注册表读回来的 PATH 看着还挺正常，很难往这儿想。
    #[cfg(windows)]
    {
        if let Some(path) = std::env::var_os("PATH") {
            cmd.env("PATH", path);
        }
    }

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| AgentError::Spawn {
            id: id.to_string(),
            reason: format!("启动 {shell} 失败：{e}"),
        })?;

    // ⚠️ 立刻丢掉从端。父进程手里留着一个从端的 fd 的话，**子进程全死光之后
    // 主端的 read 也不会返回 EOF** —— 读线程会挂在那儿，退出事件永远发不出去。
    // （Windows 上从端只是 Arc 的一份拷贝，丢它是为了两边行为一致。）
    drop(pair.slave);

    // 进程树的缰绳，必须在子进程自己去 fork 之前套上（下面 [0] 那段注释）。
    let pid = child.process_id();
    #[cfg(windows)]
    let job = {
        let job = crate::job::JobObject::create();
        // [0] 这里的窗口是「CreateProcess 返回」到「AssignProcessToJobObject」，
        // 子进程只来得及初始化，正常来不及再起孙子进程（cmd.exe 光是起来
        // 就要几十毫秒）。彻底消掉这个窗口要 CREATE_SUSPENDED + ResumeThread，
        // 而 portable-pty 不给我们插那一步的机会。wezterm 也是这么干的。
        let assigned = match (&job, child.as_raw_handle()) {
            (Some(j), Some(handle)) => j.assign(handle),
            _ => false,
        };
        // 没套上就当作「没有作业」：留一个空作业在这儿，kill_tree 会以为
        // 树已经拴住了（terminate 一个空作业什么也不干），于是**谁都杀不掉**。
        // 给 None，让 kill_tree 退到 taskkill /T /F
        if assigned {
            job
        } else {
            None
        }
    };

    let mut reader = pair.master.try_clone_reader().map_err(|e| AgentError::Spawn {
        id: id.to_string(),
        reason: format!("取 PTY 读端失败：{e}"),
    })?;
    let writer = pair.master.take_writer().map_err(|e| AgentError::Spawn {
        id: id.to_string(),
        reason: format!("取 PTY 写端失败：{e}"),
    })?;

    let (tx, rx) = tokio::sync::mpsc::channel(EVENT_BUFFER);
    let shared = Arc::new(Shared::default());
    // 「是我们杀的」这个事实要在会话和等待线程之间共享 —— 它决定了退出码报
    // `Some(n)` 还是 `None`。
    //
    // 为什么不直接用 `portable-pty` 的 `ExitStatus::signal()`：**那个 API 在
    // 0.8.1 上不存在**（0.9.0 才加的，0.8.1 的字段是私有的），而我们不能升到
    // 0.9 —— 0.9 的 ConPTY 多开了一个 `PSUEDOCONSOLE_INHERIT_CURSOR`，那会让
    // ConPTY 往输出流里插 `ESC[6n` 问终端光标位置、**不问到就不往下产出**
    // （wezterm#6783，2025-03 开到现在）。为了一个**只在 Unix 上被填、
    // Windows 上永远是 `None`** 的字段，去换主力平台「启动就白屏」的风险，
    // 不划算。我们要判断的其实只有「是不是我们自己杀的」，那个 `close()` 知道。
    let killed = Arc::new(AtomicBool::new(false));

    {
        let shared = Arc::clone(&shared);
        let tx = tx.clone();
        thread::Builder::new()
            .name(format!("pty-read-{id}"))
            .spawn(move || {
                let mut buf = vec![0u8; READ_BUF];
                loop {
                    match reader.read(&mut buf) {
                        // 0 = EOF。从端全关掉之后就是这个。
                        Ok(0) => break,
                        Ok(n) => {
                            let bytes = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                            // 接收端没了（前端重载、通道死了）就收工 ——
                            // 这时候继续读只是把字节丢掉
                            if tx.blocking_send(PtyEvent::Data { bytes }).is_err() {
                                break;
                            }
                        }
                        Err(e) if e.kind() == ErrorKind::Interrupted => continue,
                        // ⚠️ Linux 上从端全关掉之后 read 给的是 EIO 而不是 0。
                        // 把它当「正常结束」，不是错误 —— 当成错误的话每次正常
                        // 退出都会在日志里留一串噪音，久而久之就没人看日志了
                        Err(_) => break,
                    }
                }
                let mut st = shared.lock();
                st.reader_done = true;
                shared.cv.notify_all();
                drop(st);
                maybe_send_exit(&shared, &tx);
            })
            .map_err(|e| AgentError::Spawn {
                id: id.to_string(),
                reason: format!("起读线程失败：{e}"),
            })?;
    }

    {
        let shared = Arc::clone(&shared);
        let tx = tx.clone();
        let killed = Arc::clone(&killed);
        let id = id.to_string();
        thread::Builder::new()
            .name(format!("pty-wait-{id}"))
            .spawn(move || {
                let code = match child.wait() {
                    Ok(status) => {
                        if killed.load(Ordering::SeqCst) {
                            // 我们自己杀的 —— 那个退出码没有意义，报 `null`
                            // 比报一个假的 1 诚实
                            None
                        } else {
                            // 其余情况如实报。**这是一个已知的小谎**：
                            // 「被外部信号杀掉」在 Unix 上会被报成 `1`
                            // （见下面那段关于 0.8.1 的注释），和真的退出码 1
                            // 分不开。README 的「已知边界」里记着这条。
                            Some(status.exit_code() as i32)
                        }
                    }
                    Err(_) => None,
                };
                {
                    let mut st = shared.lock();
                    st.exited = true;
                    st.code = code;
                }
                shared.cv.notify_all();

                // 等读线程把最后一批输出送完（最多 DRAIN_TIMEOUT，理由见常量注释）
                // wait_timeout_while 会把 guard 收走、等完再还回来；
                // 还回来的那个直接丢掉就行（作用域的末尾）
                let st = shared.lock();
                let _ = shared
                    .cv
                    .wait_timeout_while(st, DRAIN_TIMEOUT, |s| !s.reader_done);

                maybe_send_exit(&shared, &tx);
            })
            .map_err(|e| AgentError::Spawn {
                id: id.to_string(),
                reason: format!("起等待线程失败：{e}"),
            })?;
    }

    let session = Arc::new(PtySession {
        master: Mutex::new(Some(pair.master)),
        writer: Mutex::new(Some(writer)),
        pid,
        last_size: Mutex::new((cols0, rows0)),
        killed,
        #[cfg(windows)]
        job,
        generation,
        closed: AtomicBool::new(false),
    });

    // 把命令当输入敲进去。
    //
    // 不等 shell 打出提示符再写：命令是写进 pty 的**输入缓冲区**的，
    // shell 起来之后自己会读到，早写不会有任何损失（行规程负责排队）。
    if !cfg.command.trim().is_empty() {
        let mut line = cfg.command.clone();
        // 补一个回车。`\r` 而不是 `\n` —— 终端的输入是「回车键」，
        // 两者的差别在裸行规程下是「执行」和「换行但不执行」
        if !line.ends_with('\r') && !line.ends_with('\n') {
            line.push('\r');
        }
        // 写失败不算致命：可能是 shell 起来就立刻退了（用户配的 shell 坏了）。
        // 真正的结局会由 Exit 事件说出来
        let _ = session.write(line.as_bytes());
    }

    Ok(OpenedPty {
        session,
        events: rx,
        generation,
    })
}

/// 读线程和等待线程之间的共享状态。
#[derive(Default)]
struct Shared {
    inner: Mutex<SharedState>,
    cv: Condvar,
    /// 只在第一次发出去。两个线程都会试着发 ——
    /// 谁先到（Unix 上是读线程先看到 EOF，Windows 上一定是用等线程超时兜底）
    exit_sent: AtomicBool,
}

#[derive(Default)]
struct SharedState {
    exited: bool,
    code: Option<i32>,
    reader_done: bool,
}

impl Shared {
    fn lock(&self) -> std::sync::MutexGuard<'_, SharedState> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// 送 `Exit`，**只送一次**。两个线程都可能调到这里（读线程看到 EOF、
/// 等线程等到进程结束），靠一个原子位裁决。
///
/// ⚠️ 先看「进程真的退了吗」再抢那个位。反过来的话有一种漏法：
/// 读线程先看到 EOF（进程还活着，比如它只是把 stdout 关了）就把位抢走，
/// 等线程随后拿到退出码时发现位已经被占了，于是**退出事件谁也发不出去**,
/// 状态点永远停在「正在工作」。
fn maybe_send_exit(shared: &Shared, tx: &tokio::sync::mpsc::Sender<PtyEvent>) {
    let code = {
        let st = shared.lock();
        if !st.exited {
            return;
        }
        st.code
    };
    if shared.exit_sent.swap(true, Ordering::SeqCst) {
        return;
    }
    let _ = tx.blocking_send(PtyEvent::Exit { code });
}
