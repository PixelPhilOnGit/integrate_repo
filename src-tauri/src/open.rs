//! 「交给系统默认程序打开」这一件小事：文件（任务资料里的图片、文档）和链接。
//!
//! # 为什么不引 tauri-plugin-opener
//!
//! 它要拉一个新依赖进来，而这里真正要写的就三个平台各一行命令。仓库对
//! 「为一件小事加一件依赖」一直是省的（桌面端 HTTP 那笔账就是这么算的）。
//!
//! # 两个平台事实（都是踩过的形状，不是猜的）
//!
//! * **Windows 上从 GUI 进程 spawn 必须带 `CREATE_NO_WINDOW`**：不设它，
//!   每打开一次文件就闪一次黑框 —— 照抄 `devtoolkit-agents` 里杀进程的写法
//!  （`agents/src/job.rs` 的注释原话）。
//! * **文件走 `cmd /C start`、链接走 `rundll32`，是刻意分开的**：
//!   `cmd` 会对参数做变量展开（`%` 在引号里也挡不住），而**文件名的清洗表
//!   里本来就把 `% ^ &` 换掉了**（见 tasks 内核的 `sanitize_file_name`），
//!   所以在 `cmd` 里是安全的；但 URL 里 `%` 是**合法且常见**的（百分号编码，
//!   `https://x/a%20b`），洗不得 —— 于是链接那条走 `rundll32.exe
//!   url.dll,FileProtocolHandler`（`webbrowser` crate 的做法），不经过 shell，
//!   就没有展开这回事。
//!
//! # 为什么要专门开个线程等它
//!
//! 这几个命令（`open` / `xdg-open` / `cmd`）都是**撒手就没**的：起完不等它。
//! 但 `Child` 不 `wait()` 就会留成僵尸进程，所以起身之后丢给一个命名线程
//! 去收尸 —— 形状照 `agents/src/pty.rs` 收 PTY 的那段。退出码不看：
//! 「打开」这件事成没成，用户自己看得见。

use std::path::Path;
use std::process::{Command, Stdio};

/// 用系统默认程序打开一个**本地文件**。
pub fn open_path(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let (cmd, what) = {
        let mut c = Command::new("open");
        c.arg(path);
        (c, "open")
    };
    #[cfg(target_os = "linux")]
    let (cmd, what) = {
        let mut c = Command::new("xdg-open");
        c.arg(path);
        (c, "xdg-open")
    };
    #[cfg(windows)]
    let (cmd, what) = {
        let mut c = Command::new("cmd");
        // `start` 的第一个参数是窗口标题（占了就没位置放它，给个空的）；
        // 路径单独当一个参数 —— `Command` 会把带空格的参数自己引起来
        c.args(["/C", "start", ""]).arg(path);
        (no_window(c), "cmd /C start")
    };

    spawn_detached(cmd, what)
}

/// 用系统浏览器打开一个链接。**只放行 http/https**（见 [`validate_url`]）。
pub fn open_url(url: &str) -> Result<(), String> {
    let url = validate_url(url)?;

    #[cfg(target_os = "macos")]
    let (cmd, what) = {
        let mut c = Command::new("open");
        c.arg(url);
        (c, "open")
    };
    #[cfg(target_os = "linux")]
    let (cmd, what) = {
        let mut c = Command::new("xdg-open");
        c.arg(url);
        (c, "xdg-open")
    };
    #[cfg(windows)]
    let (cmd, what) = {
        // 见模块头：链接不过 cmd（% 是合法的百分号编码，不能被洗掉、也不该
        // 被 cmd 展开）。rundll32 直接 ShellExecute，没有 shell 解析这一层。
        // 绝对路径而不是靠 PATH —— 和 agents 那边杀进程一个理由
        let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
        let mut c = Command::new(format!("{root}\\System32\\rundll32.exe"));
        c.arg("url.dll,FileProtocolHandler").arg(url);
        (no_window(c), "打开链接")
    };

    spawn_detached(cmd, what)
}

/// 链接的检查。这是**唯一能带进任意用户内容**的入口（资料文字里贴什么网址
/// 都行），所以放在最前面：scheme 只认 http/https，别的（`file:`、`javascript:`…）
/// 一律拒掉；引号和控制字符（换行、制表）也不放 —— 它们进了命令行会改变
/// 参数边界。
fn validate_url(url: &str) -> Result<&str, String> {
    let url = url.trim();
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err(format!("只打开 http/https 的链接：{url}"));
    }
    if url.chars().any(|c| c.is_control() || c == '"') {
        return Err("这个链接里有不能带进命令行的字符（引号或换行）".to_string());
    }
    Ok(url)
}

/// 起完就撒手：不等退出码，但有人 `wait()` 收尸（见模块头）。
fn spawn_detached(mut cmd: Command, what: &str) -> Result<(), String> {
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("没调起系统程序（{what}）：{e}"))?;

    std::thread::Builder::new()
        .name("rd-open-wait".to_string())
        .spawn(move || {
            let _ = child.wait();
        })
        .ok();
    Ok(())
}

/// Windows：不设 `CREATE_NO_WINDOW` 就每开一次闪一个黑框（见模块头）
#[cfg(windows)]
fn no_window(mut cmd: Command) -> Command {
    use std::os::windows::process::CommandExt;
    /// 不设它的话，GUI 应用每杀一次就会闪一个黑框（agents/src/job.rs 的原话）
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 链接只放行_http_和_https() {
        assert!(validate_url("https://example.com/a?b=1&c=2").is_ok());
        assert!(validate_url("HTTP://example.com").is_ok(), "scheme 大小写不敏感");
        assert!(validate_url("  https://example.com  ").is_ok(), "两头空白先去掉");

        // 这几种都不许开
        assert!(validate_url("file:///etc/passwd").is_err());
        assert!(validate_url("javascript:alert(1)").is_err());
        assert!(validate_url("https://example.com/\"被引号打断").is_err());
        assert!(validate_url("https://example.com/\n换行").is_err());
        assert!(validate_url("").is_err());
    }

    #[test]
    fn 百分号编码原样留住() {
        // `%20` 是合法的 URL 编码 —— 校验这一层不许把它洗掉或拒掉
        //（清洗是给文件名用的，链接不走那条路）
        let url = "https://example.com/报告%20v2";
        assert_eq!(validate_url(url).unwrap(), url);
    }
}
