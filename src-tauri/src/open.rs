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
//!   （`agents/src/job.rs` 的注释原话）。
//! * 三个平台都**起完就撒手**：不等退出码（「打开」成没成，用户自己看得见），
//!   但有人 `wait()` 收尸，不留僵尸（见 [`spawn_stop_reap`]）。
//!
//! # ⚠️ Windows 上的文件要走**三层退让**，这是真机 bug 换来的
//!
//! 2026-10-16 用户真机报过：「任务里点附件」报
//! **`没调起系统程序（cmd /C start）：请求的操作需要提升。 (os error 740)`**。
//!
//! 注意 740（`ERROR_ELEVATION_REQUIRED`）出在 **`CreateProcess` 这一步** ——
//! 连 `cmd` 都没被起起来（`spawn` 自己就失败了），不是 `start` 运行出错的。
//! 这常见于：**对该程序设过「以管理员身份运行」的兼容标记**、或者环境里用的是
//! 过滤/受限令牌 —— 那都不是我们进程里能修的东西。所以对策不是在 cmd 上较劲，
//! 而是**换一条不经过 cmd 的链路**，逐级退让：
//!
//! 1. `explorer.exe <路径>` —— **shell 本体**：替我们走双击那条路。
//!    从提升过的进程里调用它，打开的是**非提升**的那一份（这正是微软推荐
//!    「提升进程想以用户身份打开东西」的做法）。文件、目录都认。
//! 2. `rundll32.exe url.dll,FileProtocolHandler <路径>` —— 链接那条用的
//!    机制，不过 shell、不经 cmd（见下）。
//! 3. `cmd.exe /C start "" <路径>` —— 老路径，留着兜底。
//!
//! 三条全部 `spawn` 失败才报错，错误里带齐三条各自的 reason（下次再出这种
//! 事，用户贴回来的那一句就够定位）。
//!
//! # 为什么链接和文件命令不同
//!
//! `cmd` 会对参数做变量展开（`%` 在引号里也挡不住）。任务资料的文件名在入库时
//! 就被清洗过（`sanitize_file_name` 换掉了 `% ^ &`），所以在 cmd 里是安全的 ——
//! 但 **URL 里 `%` 是合法且常见的**（百分号编码，`https://x/a%20b`），洗不得，
//! 于是链接走 `rundll32 url.dll,FileProtocolHandler`（`webbrowser` crate 的做法）。
//! 文件那条现在也把它们放在前头，正是为了不再依赖清洗表这个前提。
//!
//! # ⚠️ 绝对路径而不是靠 PATH
//!
//! Windows 上三个程序全用 `%SystemRoot%\System32\` 下的绝对路径：这台机器上
//! 用户的 PATH 有自己的故事（Git 在 D 盘、System32 里还有 WSL 的 bash），
//! 让别人去解析 `cmd` / `explorer` 这种名字是我们控制不了的变量。
//! 这个理由和 agents 那边杀进程时用绝对路径 `taskkill` 是同一条。

use std::path::Path;
use std::process::{Command, Stdio};

/// 用系统默认程序打开一个**本地文件**（或目录）。
pub fn open_path(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let mut c = Command::new("open");
        c.arg(path);
        spawn_stop_reap(c, "open")
    }

    #[cfg(target_os = "linux")]
    {
        let mut c = Command::new("xdg-open");
        c.arg(path);
        spawn_stop_reap(c, "xdg-open")
    }

    #[cfg(windows)]
    {
        // 顺序即优先级，理由在模块头（740 那一段）。
        let mut explorer = Command::new(sys32("explorer.exe"));
        explorer.arg(path);

        let mut handler = Command::new(sys32("rundll32.exe"));
        handler.arg("url.dll,FileProtocolHandler").arg(path);

        let mut cmd_start = Command::new(sys32("cmd.exe"));
        // `start` 的第一个参数是窗口标题（占了就没位置放它，给个空的）；
        // 路径单独当一个参数 —— `Command` 会把带空格的参数自己引起来
        cmd_start.args(["/C", "start", ""]).arg(path);

        spawn_first_ok(vec![
            (no_window(explorer), "explorer.exe"),
            (no_window(handler), "rundll32 FileProtocolHandler"),
            (no_window(cmd_start), "cmd /C start"),
        ])
    }
}

/// 用系统浏览器打开一个链接。**只放行 http/https**（见 [`validate_url`]）。
pub fn open_url(url: &str) -> Result<(), String> {
    let url = validate_url(url)?;

    #[cfg(target_os = "macos")]
    {
        let mut c = Command::new("open");
        c.arg(url);
        spawn_stop_reap(c, "open")
    }

    #[cfg(target_os = "linux")]
    {
        let mut c = Command::new("xdg-open");
        c.arg(url);
        spawn_stop_reap(c, "xdg-open")
    }

    #[cfg(windows)]
    {
        // 见模块头：链接不过 cmd（% 是合法的百分号编码，不能被洗掉、也不该
        // 被 cmd 展开）。rundll32 直接走 shell 协议处理，没有 shell 解析这一层。
        let mut handler = Command::new(sys32("rundll32.exe"));
        handler.arg("url.dll,FileProtocolHandler").arg(url);

        // 兜底：explorer 也是 shell 本体，开链接等于双击。rundll32 被
        // 安全软件拦掉的机器上还有这一条路（740 那轮学到的教训：多备一条）。
        let mut explorer = Command::new(sys32("explorer.exe"));
        explorer.arg(url);

        spawn_first_ok(vec![
            (no_window(handler), "rundll32 FileProtocolHandler"),
            (no_window(explorer), "explorer.exe"),
        ])
    }
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
fn spawn_stop_reap(mut cmd: Command, what: &str) -> Result<(), String> {
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

/// 按顺序试，**第一个 spawn 成功的就算数**；全失败才报错，错误里带齐每条的原因。
///
/// 只看 `spawn` 的结果（能不能把进程起起来），不看退出码 —— 和
/// [`spawn_stop_reap`] 同一个理由：打开成没成，用户自己看得见。
#[cfg(windows)]
fn spawn_first_ok(attempts: Vec<(Command, &'static str)>) -> Result<(), String> {
    let mut failures: Vec<String> = Vec::new();
    for (cmd, what) in attempts {
        match spawn_stop_reap(cmd, what) {
            Ok(()) => return Ok(()),
            Err(e) => failures.push(e),
        }
    }
    Err(format!(
        "没调起系统程序（三条路都试过了，都没成）：{}",
        failures.join("；")
    ))
}

/// `%SystemRoot%\System32\<名字>` 的绝对路径（PATH 里的故事不归我们管，见模块头）。
#[cfg(windows)]
fn sys32(name: &str) -> std::path::PathBuf {
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
    Path::new(&root).join("System32").join(name)
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

    /// 三级退让的「全失败」聚合文案：下次再出 740 那种事，用户贴回来的一句
    /// 错误里要能同时看见三条路各自怎么了（本测试只在能跑 win 分支的机器上有意义，
    /// 函数本身也是 `#[cfg(windows)]`，这里跟着门控）。
    #[cfg(windows)]
    #[test]
    fn 全失败时报错带齐三条路的原因() {
        // 三条都指向不存在的程序 → spawn 必失败
        let missing = |what| {
            let mut c = Command::new("definitely-not-a-real-program-xyz");
            c.arg("--");
            (c, what)
        };
        let err = spawn_first_ok(vec![missing("explorer.exe"), missing("rundll32"), missing("cmd")]);
        let msg = err.expect_err("三条都失败还报成功？");
        assert!(msg.starts_with("没调起系统程序"));
        assert!(msg.contains("explorer.exe") && msg.contains("rundll32") && msg.contains("cmd"));
    }
}
