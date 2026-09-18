//! 测试夹具：临时目录 + 「开一个窗格、把输出读出来」的小外壳。
//!
//! 这里的测试是**真起进程**的（不是 mock）：`sh` / `cmd.exe` 真的在跑，
//! 字节真的从 pty 上流过来。所以「关窗格会不会留孤儿」这种结论才是可信的 ——
//! 那是这一层最容易骗到自己的地方。

#![allow(dead_code)] // 每个测试二进制只用到这里的一部分

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use devtoolkit_agents::{AgentRegistry, PtyConfig, PtyEvent};
use tokio::sync::mpsc::Receiver;

pub const FIVE_SECONDS: Duration = Duration::from_secs(5);

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// 测试用的临时目录。`Drop` 时删掉 —— 漏清理的夹具会让 `/tmp` 攒下一堆垃圾
/// （core 那边漏过一次，跑了 32 次才发现）。
///
/// # ⚠️ 绝不要把**真实路径**喂给被测代码
///
/// `%APPDATA%`、`~/.claude`、`~/.codex` 这些只能在真机上由用户自己触发，
/// 测试里一律用临时目录。
///
/// 这不是洁癖，是踩过的：有一组用例为了验 Windows 路径的 TOML 转义，把
/// `C:\Users\me\AppData\Roaming\...` 直接当 data_dir 传了进去。在 Linux 上
/// 那是个**相对路径**，于是 `create_dir_all` 老老实实在 crate 目录里建出了一个
/// 叫这个名字的目录 —— 不报错、没人发现；而同样的代码在 Windows 上会**写进
/// 用户真实的 AppData**。现在库那边有 `AgentPaths::ensure_absolute` 拦着，
/// 但规矩还是这条：**临时目录，永远**。
pub struct TempDir {
    path: PathBuf,
}

impl TempDir {
    pub fn new(tag: &str) -> TempDir {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!(
            "devtoolkit-agents-test-{tag}-{}-{nanos}-{n}",
            std::process::id()
        ));
        std::fs::create_dir_all(&path).expect("创建临时目录");
        TempDir { path }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

/// 「跑一条命令」在两个平台上的写法不一样（cmd.exe 和 sh 的语法不同）。
///
/// 每个用例只写一遍，命令串按平台选 —— 否则跨平台的那几条只能二选一，
/// 而 CI 上跑的是 Windows，本机跑的是 Linux，两边都得能过。
pub fn cmd(unix: &str, windows: &str) -> String {
    if cfg!(windows) {
        windows.to_string()
    } else {
        unix.to_string()
    }
}

/// 测试里显式指定的 shell。
///
/// Unix 上一定要**显式**给 `/bin/sh`：默认走 `$SHELL`，而 CI 上的 `$SHELL`
/// 可能是任何东西（bash/zsh/dash），用例里那句命令的语法得能对上。
///
/// Windows 上给 `None` = 走产品那条默认路（`pty::default_shell`）。
/// ⚠️ **那不等于 cmd.exe**（这里原来写的「用 `%COMSPEC%`」是错的，产品的注释里
/// 明确说了为什么不用它）：默认 shell 是**探测**出来的 —— `pwsh.exe` →
/// `powershell.exe` → `cmd.exe`，runner 上是 PowerShell 7。
/// 所以下面 `cmd(unix, windows)` 里的 Windows 串要按 **PowerShell** 的语法写：
/// 变量是 `$env:NAME`，不是 `%NAME%`（后者会被原样打出来，看着像变量没进去）。
pub fn test_shell() -> Option<String> {
    if cfg!(windows) {
        None
    } else {
        Some("/bin/sh".to_string())
    }
}

/// 起一个窗格的默认参数：指定的工作目录 + 一条初始命令。
pub fn cfg(dir: &Path, command: &str) -> PtyConfig {
    PtyConfig {
        cwd: dir.display().to_string(),
        command: command.to_string(),
        cols: 80,
        rows: 24,
        shell: test_shell(),
        env: Default::default(),
    }
}

/// 起一个窗格，返回事件流和会话代次。
pub fn open(reg: &AgentRegistry, id: &str, config: &PtyConfig) -> Receiver<PtyEvent> {
    reg.open(id, config).expect("起窗格").events
}

/// base64 → 可读文本（测试里断言用，丢几个坏字节无所谓）。
pub fn text(bytes: &str) -> String {
    let raw = base64::engine::general_purpose::STANDARD
        .decode(bytes.as_bytes())
        .expect("事件里的字节必须是合法 base64");
    String::from_utf8_lossy(&raw).to_string()
}

/// 一直读到输出里出现 `needle`（或者超时/进程退出），返回累计的输出。
///
/// 「累计」很重要：pty 的输出会**被块边界切开**，`HELLO` 完全可能分两条事件
/// 到。只比对单条事件的话，测试会时绿时红。
pub async fn read_until(rx: &mut Receiver<PtyEvent>, needle: &str, timeout: Duration) -> String {
    let deadline = tokio::time::Instant::now() + timeout;
    let mut out = String::new();
    loop {
        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
        if left.is_zero() {
            return out;
        }
        match tokio::time::timeout(left, rx.recv()).await {
            Err(_) | Ok(None) => return out,
            Ok(Some(PtyEvent::Data { bytes })) => {
                out.push_str(&text(&bytes));
                if out.contains(needle) {
                    return out;
                }
            }
            Ok(Some(PtyEvent::Exit { .. })) => return out,
        }
    }
}

/// 读到进程退出，返回 `(全部输出, 退出码)`。
pub async fn read_to_exit(rx: &mut Receiver<PtyEvent>, timeout: Duration) -> (String, Option<i32>) {
    let deadline = tokio::time::Instant::now() + timeout;
    let mut out = String::new();
    loop {
        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
        if left.is_zero() {
            panic!("等退出事件超时了。到目前为止的输出：\n{out}");
        }
        match tokio::time::timeout(left, rx.recv()).await {
            Err(_) => panic!("等退出事件超时了。到目前为止的输出：\n{out}"),
            Ok(None) => panic!("事件通道关了，但没收到退出事件"),
            Ok(Some(PtyEvent::Data { bytes })) => out.push_str(&text(&bytes)),
            Ok(Some(PtyEvent::Exit { code })) => return (out, code),
        }
    }
}

/// 读到一个 pid。
///
/// ⚠️ **不能简单地「等 `KID=` 出现」**：pty 会把我们敲进去的那行**回显**出来，
/// `echo KID=$!` 里的 `KID=` 会先到，而它后面跟着的是 `$!` 不是数字。
/// 所以要等到「标记后面**真的跟着数字**」那一次 —— 那才是命令的输出。
///
/// （这正是这类测试最容易假绿的地方：拿到回显就当成功，然后拿着一串
/// 根本不是 pid 的东西去断言。）
pub async fn read_pid(
    rx: &mut Receiver<PtyEvent>,
    key: &str,
    timeout: Duration,
    out: &mut String,
) -> u32 {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if let Some(pid) = pid_in(out, key) {
            return pid;
        }
        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
        if left.is_zero() {
            panic!("等了 {timeout:?} 也没等到 {key}<数字>，实际输出：\n{out}");
        }
        match tokio::time::timeout(left, rx.recv()).await {
            Err(_) => panic!("等了 {timeout:?} 也没等到 {key}<数字>，实际输出：\n{out}"),
            Ok(None) => panic!("事件通道关了，还没等到 {key}<数字>。输出：\n{out}"),
            Ok(Some(PtyEvent::Data { bytes })) => out.push_str(&text(&bytes)),
            Ok(Some(PtyEvent::Exit { .. })) => {
                panic!("进程退出了，还没等到 {key}<数字>。输出：\n{out}")
            }
        }
    }
}

/// 在一段输出里找 `key` 后面紧跟的那串数字。
///
/// `out` 由调用方持有并**跨多次调用累加** —— 两条 pid 往往在同一条输出里
/// 一起到（脚本一次 `echo` 出来的），各自开一个新的缓冲区的话，
/// 第二条会被第一条连同它所在的那条事件一起吃掉，然后永远等不到。
fn pid_in(out: &str, key: &str) -> Option<u32> {
    for (idx, _) in out.match_indices(key) {
        let rest = &out[idx + key.len()..];
        let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
        if !digits.is_empty() {
            return digits.parse().ok();
        }
    }
    None
}

/// 进程还在不在。
#[cfg(unix)]
pub fn is_alive(pid: u32) -> bool {
    Path::new(&format!("/proc/{pid}")).exists()
}

/// 等到进程没了（最多 `timeout`），返回它最后还在不在。
///
/// 轮询而不是睡一下再看：SIGKILL 到内核真的把它回收掉之间有几十毫秒的窗口，
/// 直接断言会偶发地红。
pub fn wait_gone(pid: u32, timeout: Duration) -> bool {
    let deadline = std::time::Instant::now() + timeout;
    while std::time::Instant::now() < deadline {
        if !is_alive_pid(pid) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    !is_alive_pid(pid)
}

#[cfg(unix)]
fn is_alive_pid(pid: u32) -> bool {
    is_alive(pid)
}

/// Windows 上没有 `/proc`，用 `tasklist` 问。
///
/// `/FI "PID eq N"` 匹配不到时 tasklist 打的是「信息: 没有运行的任务…」，
/// 所以判据是输出里**有没有那个 pid 这个数字**。
#[cfg(windows)]
fn is_alive_pid(pid: u32) -> bool {
    let out = std::process::Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
        .output();
    match out {
        Ok(o) => {
            let s = String::from_utf8_lossy(&o.stdout).to_string();
            s.contains(&format!("\"{pid}\"")) || s.contains(&format!(",{pid},"))
        }
        // 问不出来就当它还在（宁可让用例等一下，也不要假装杀干净了）
        Err(_) => true,
    }
}

/// 收尾用：万一用例中途失败，别把 `sleep 60` 留在机器上。
pub struct KillOnDrop(pub u32);

impl Drop for KillOnDrop {
    fn drop(&mut self) {
        let pid = self.0.to_string();
        let (program, args): (&str, Vec<&str>) = if cfg!(windows) {
            ("taskkill", vec!["/F", "/PID", &pid])
        } else {
            ("kill", vec!["-9", &pid])
        };
        let _ = std::process::Command::new(program)
            .args(args)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
}
