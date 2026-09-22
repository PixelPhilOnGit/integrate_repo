//! 跑命令。
//!
//! # 为什么**不过 shell**
//!
//! 参数是 `program` + `args[]`，直接 spawn，中间没有 `sh -c`。三个理由，按重要性：
//!
//! 1. **过 shell 的话，审批粒度就没有了。** 用户的授权是按 `argv[0]` 记的
//!    （批准 `git` 不等于批准 `curl`，见 [`crate::tool::GrantKey`]），
//!    而 `sh -c "…"` 的 `argv[0]` 永远是 `sh` —— 「记住」于是变成
//!    「记住一切」。
//! 2. **这是仓库一贯的规矩**：命令参数逐个塞进 `Cmd` / 走驱动 API，
//!    绝不拼字符串（见 HANDOFF 的「设计决定」）。拼字符串就要处理引号、
//!    空格、通配符、`$VAR`，而每一处处理错都是一个洞或一个 bug。
//! 3. **不过 shell 就不用猜用户的 shell。** Windows 上可能是 cmd、PowerShell、
//!    Git Bash 里的任意一个（取决于装没装 Git Bash），同一个字符串的语义**不一样**。
//!
//! 代价写清楚：管道、重定向、`&&`、通配符展开、环境变量赋值都用不了。
//! 模型想要这些的时候，正确做法是分几次调用（agent 本来就是多轮的）。
//!
//! # 那为什么还有一张「像 shell 的程序」名单
//!
//! 因为名单里的程序**语义就是「把一段文本当命令跑」**（`bash` / `cmd` /
//! `pwsh` / `env` / `xargs` / `timeout` …）。批准「记住 `git`」是批准一个
//! **有边界**的工具；批准「记住 `bash`」是批准**任意代码** —— 用户点「记住」时
//! 看到的是当时那一条命令，他不可能知道自己在给什么签字。
//!
//! 所以名单里的人**照跑不误，只是不给「记住」**（[`PreparedCall::grant`] 是
//! `None`，于是每次都问）。
//!
//! ⚠️ **这张名单永远不完备**，而且不必完备：`python -c`、`node -e`、`make`、
//! `awk` 都能执行任意代码。它要挡住的是「顺手把最常见的那条路变成万能钥匙」，
//! 不是「禁止代码执行」—— 后者在这个功能里做不到，也不必做（模型是用户自己选的，
//! 不是攻击者）。真正的防线是**每次都要问**这条默认方向，不是名单本身。

use std::process::Stdio;
use std::time::Duration;

use devtoolkit_core::Workspace;
use serde_json::{json, Value};
use tokio::io::AsyncReadExt;

use crate::session::ToolOutcome;
use crate::tool::{GrantKey, InvalidInput, PreparedCall, SideEffect, ToolSpec};

use super::{arg_str, human_size, invalid, optional_str, resolve_rel, ToolsConfig};

/// 跑一个程序。
pub const RUN_COMMAND: &str = "run_command";

/// 语义是「执行任意代码」的程序。**在里面照跑，但不给「记住」。**
///
/// 判断用的是**基础名**（`/bin/bash`、`bash.exe`、`C:\…\Bash.EXE` 都算 `bash`），
/// 而且**统一转小写** —— 这里的归一化方向和 [`GrantKey`] 相反：
/// 漏掉一个写法等于少拦一个，所以宁可多拦。
const SHELL_LIKE: &[&str] = &[
    // 正经的 shell
    "sh", "bash", "zsh", "fish", "csh", "tcsh", "ksh", "dash", "ash", "busybox",
    // Windows 上的两个
    "cmd", "powershell", "pwsh", "wsl",
    // 本身不是 shell，但能把任意命令包进去跑
    "env", "xargs", "nohup", "setsid", "timeout", "nice", "ionice", "stdbuf", "watch",
];

/// `run_command` 的描述。
pub fn run_spec() -> ToolSpec {
    ToolSpec {
        name: RUN_COMMAND.into(),
        description: "在工作区里跑一个程序，等它结束，把输出拿回来。\
            ⚠️ **不经过 shell** —— 程序和参数要分开给（program 和 args），\
            不要写管道、重定向、`&&` 这些 shell 语法：它们会被当成普通参数传给程序，\
            不会生效。要在别的目录里跑就设 cwd，不要用 cd。\
            要看文件内容用 read_file，不要用 cat。"
            .into(),
        schema: json!({
            "type": "object",
            "properties": {
                "program": {
                    "type": "string",
                    "description": "程序名，比如 git、cargo、node。不要带参数"
                },
                "args": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "参数，一个元素一个，比如 [\"status\", \"--short\"]"
                },
                "cwd": {
                    "type": "string",
                    "description": "在哪个子目录里跑（相对工作区根目录）。默认工作区根目录"
                }
            },
            "required": ["program"],
            "additionalProperties": false
        }),
        side_effect: SideEffect::Execute,
    }
}

// ---------------------------------------------------------------------- 准备

/// `run_command` 的准备。
pub fn prepare_run(ws: &Workspace, args: Value) -> Result<PreparedCall, InvalidInput> {
    let program = arg_str(&args, "program")?.trim().to_string();
    if program.is_empty() {
        return Err(invalid("program 不能是空的 —— 要跑什么就写什么。"));
    }

    // ⚠️ `args` 的每个元素必须是字符串。我们的 schema 子集**不递归校验数组元素**
    // （见 `tool.rs` 的 `check`），所以这一步不能省：模型给 `[1, 2]` 的话，
    // 到 `Command::args` 那儿才炸，而那时的报错和参数长什么样毫无关系。
    let mut argv: Vec<String> = Vec::new();
    if let Some(list) = args.get("args") {
        let arr = list
            .as_array()
            .ok_or_else(|| invalid("args 要是一个数组，比如 [\"status\"]。"))?;
        for (i, v) in arr.iter().enumerate() {
            match v.as_str() {
                Some(s) => argv.push(s.to_string()),
                None => {
                    return Err(invalid(format!(
                        "args 里的第 {} 个不是字符串（是 {}）。参数要一个一个给，都写成字符串。",
                        i + 1,
                        kind_word(v)
                    )))
                }
            }
        }
    }

    // 跑在哪个目录。空 / 没给就是工作区根目录。
    let cwd_rel = optional_str(&args, "cwd");
    let cwd_rel = if cwd_rel.trim().is_empty() {
        String::new()
    } else {
        resolve_rel(ws, cwd_rel.trim())?
    };

    // ⚠️ 授权目标是 **program 的原文**，不做任何归一化。
    //
    // 归一化（取基础名、去扩展名、转小写）看着更「友好」，但它**只会扩大授权**：
    // `/tmp/evil/curl` 归一成 `curl` 之后，用户之前批准的真 `curl` 会让它免审。
    // 不归一化的代价是「`git` 和 `/usr/bin/git` 要各批准一次」—— 那只是多点一次，
    // 方向是对的。
    let grant = if is_shell_like(&program) {
        None // 每次都问，不给「记住」（理由见模块头部）
    } else {
        Some(GrantKey {
            tool: RUN_COMMAND.into(),
            target: program.clone(),
        })
    };

    let mut args = args;
    // 写回规范化之后的参数 —— 执行时只看这一份。
    args["program"] = json!(program);
    args["args"] = json!(argv);
    args["cwd"] = json!(cwd_rel);

    Ok(PreparedCall {
        name: RUN_COMMAND.into(),
        args,
        side_effect: SideEffect::Execute,
        display: format!("运行 {}", render_command(&program, &argv)),
        grant,
    })
}

/// 一个值是什么类型（报错文案里用）。
fn kind_word(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "布尔值",
        Value::Number(_) => "数字",
        Value::String(_) => "字符串",
        Value::Array(_) => "数组",
        Value::Object(_) => "对象",
    }
}

/// 这个程序是不是「执行器」（见 [`SHELL_LIKE`]）。
fn is_shell_like(program: &str) -> bool {
    let base = base_name(program);
    SHELL_LIKE.contains(&base.as_str())
}

/// 取程序的基础名：`/bin/bash` / `bash.exe` / `C:\…\Bash.EXE` → `bash`。
///
/// ⚠️ 转小写是**故意**的：Windows 的路径不区分大小写，`Bash.exe` 和 `bash.exe`
/// 是同一个东西。漏掉一个写法就等于少拦一个（见 [`SHELL_LIKE`] 的说明）。
fn base_name(program: &str) -> String {
    let last = program
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(program)
        .to_lowercase();
    for ext in [".exe", ".cmd", ".bat", ".com", ".ps1"] {
        if let Some(stripped) = last.strip_suffix(ext) {
            return stripped.to_string();
        }
    }
    last
}

/// 把命令渲染成给人看的一行。
///
/// ⚠️ 这只是**展示**，不参与执行（执行走的是 `program` + `argv` 数组）。
/// 加引号是为了让用户一眼看出参数的边界 —— 参数里有空格时，
/// `rm -rf / tmp` 和 `rm "-rf /" tmp` 完全是两回事，不能让用户靠猜。
fn render_command(program: &str, args: &[String]) -> String {
    let mut out = quote(program);
    for a in args {
        out.push(' ');
        out.push_str(&quote(a));
    }
    out
}

fn quote(s: &str) -> String {
    if s.is_empty() {
        return "\"\"".to_string();
    }
    // 会出现歧义的字符：空白和 shell 元字符，加上引号本身。
    if s.chars().any(|c| c.is_whitespace() || "\"'`$\\|&;<>()*?[]{}#~!".contains(c)) {
        // Rust 的 Debug 转义就够用：它会把引号和反斜杠转义掉，而且不碰中文。
        format!("{s:?}")
    } else {
        s.to_string()
    }
}

// ---------------------------------------------------------------------- 执行

/// `run_command` 的执行。
pub async fn execute_run(ws: &Workspace, cfg: &ToolsConfig, args: &Value) -> ToolOutcome {
    let program = optional_str(args, "program");
    let argv: Vec<String> = args
        .get("args")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    let cwd_rel = optional_str(args, "cwd");

    let dir = if cwd_rel.is_empty() {
        ws.root().to_path_buf()
    } else {
        match ws.resolve(&cwd_rel) {
            Ok(p) => p,
            Err(e) => return ToolOutcome { content: e.to_string(), is_error: true },
        }
    };

    let mut cmd = tokio::process::Command::new(&program);
    cmd.args(&argv)
        .current_dir(&dir)
        // ⚠️ stdin 接到空设备上。不接的话子进程**继承我们的 stdin**，
        // 而一个交互式的命令（`npm init`、没给 `-m` 的 `git commit`、`read`）
        // 会挂在那儿等一个永远不会来的输入，一直等到超时 —— 用户看到的是
        // 「跑了 5 分钟然后说超时」，而真正的原因根本不是慢。
        // 接上之后它立刻读到 EOF，自己失败并说清楚要什么。
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // 这个 run 被取消 / 这一轮被丢掉时，别把进程留在那儿。⚠️ 只管得住
        // **直接子进程**（见下面「超时」那段）。
        .kill_on_drop(true);

    // ⚠️ 这个 PATH 可能是「登录时的快照」（见 `ToolsConfig::path` 的文档）。
    if let Some(path) = &cfg.path {
        cmd.env("PATH", path);
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return ToolOutcome {
                content: format!(
                    "跑不起来 `{program}`：{e}\n\
                     检查一下名字有没有拼错、它装了没有、在不在 PATH 里。"
                ),
                is_error: true,
            }
        }
    };

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    // ⚠️ 读**必须**和等待并发：管道缓冲区满了之后，子进程会阻塞在写上，
    // 而我们在等它结束 —— 那就是经典的「两边互相等」的死锁。
    let out_task = match stdout {
        Some(s) => Some(tokio::spawn(read_both_ends(s, cfg.max_output_bytes))),
        None => None,
    };
    let err_task = match stderr {
        Some(s) => Some(tokio::spawn(read_both_ends(s, cfg.max_output_bytes))),
        None => None,
    };

    let waited = tokio::time::timeout(cfg.command_timeout, child.wait()).await;

    let (status, timed_out) = match waited {
        Ok(Ok(s)) => (Some(s), false),
        Ok(Err(e)) => {
            return ToolOutcome {
                content: format!("等 `{program}` 结束时出错了：{e}"),
                is_error: true,
            }
        }
        Err(_) => {
            // ⚠️ **只杀得掉直接子进程。** 不过 shell（这个模块存在的理由之一）
            // 意味着直接子进程就是用户要跑的那个程序本身，所以多数情况下够了；
            // 但 `cargo` 底下的 `rustc`、`npm` 底下的 `node` 是它的**子进程**，
            // 会活下来。要连坐需要 Job Object（Windows）/ 进程组（Unix），
            // 那是 `agents` 的 `pty.rs` 在做的事（它还带着 portable-pty）。
            // 这里的取舍是：**先有上限，再有精确的收尸**。
            let _ = child.kill().await;
            let _ = child.wait().await;
            (None, true)
        }
    };

    let out_bytes = finish_capture(out_task).await;
    let err_bytes = finish_capture(err_task).await;

    let mut body = String::new();

    if timed_out {
        body.push_str(&format!(
            "⚠️ 命令跑了超过 {} 秒还没结束，已经把它中止了。\n\
             （只中止了直接起来的那个进程；它自己再起的子进程可能还在跑。）\n",
            cfg.command_timeout.as_secs()
        ));
    } else if let Some(s) = &status {
        match s.code() {
            Some(c) => body.push_str(&format!("退出码 {c}\n")),
            // Unix 上被信号杀掉时没有退出码 —— 说清楚，别显示「退出码 null」。
            None => body.push_str("进程被信号中止了（不是正常退出）\n"),
        }
    }

    let out_text = render_captured(&out_bytes);
    let err_text = render_captured(&err_bytes);

    if out_text.trim().is_empty() && err_text.trim().is_empty() {
        body.push_str("\n（没有任何输出）\n");
    } else {
        if !out_text.trim().is_empty() {
            body.push_str("\n");
            body.push_str(&out_text);
            if !body.ends_with('\n') {
                body.push('\n');
            }
        }
        if !err_text.trim().is_empty() {
            body.push_str("\n--- 标准错误 ---\n");
            body.push_str(&err_text);
            if !body.ends_with('\n') {
                body.push('\n');
            }
        }
    }

    ToolOutcome {
        content: body,
        // ⚠️ **退出码非 0 不是「工具失败」。** 那是一条结果（`grep` 没匹配到就是 1、
        // `git diff --quiet` 用退出码回答），和 Redis 的 `-ERR`、SQL 的表不存在
        // 是同一类东西 —— 内联显示，不弹外壳错误条。这条规矩仓库里四个模块都有
        // 守门测试盯着，这里是第五个。
        //
        // 超时则是另一回事：**我们没拿到结果**，模型该知道要换个做法。
        is_error: timed_out,
    }
}

/// 一个管道读到的内容。
#[derive(Default)]
struct Captured {
    head: Vec<u8>,
    tail: Vec<u8>,
    /// 实际读到的总字节数（可能远大于 `head + tail`）。
    total: usize,
}

/// 等读管道的任务收尾。
///
/// ⚠️ **带超时**：子进程被杀了，但它**自己再起的孙子进程**可能还攥着管道的写端
/// 不放 —— 那样读端永远等不到 EOF，这里会一直挂着。用户看到的是「点了停止没反应」。
async fn finish_capture(task: Option<tokio::task::JoinHandle<Captured>>) -> Captured {
    let Some(task) = task else {
        return Captured::default();
    };
    match tokio::time::timeout(Duration::from_secs(2), task).await {
        Ok(Ok(c)) => c,
        // 读任务 panic 了、或者超时了 —— 拿多少算多少，别把整个工具结果变成错误。
        _ => Captured::default(),
    }
}

/// 读完一个管道，**最多留 `cap` 字节：头一半、尾一半，中间丢掉**。
///
/// 为什么要头尾都要：命令的输出里，**开头**有上下文（在跑什么、从哪儿开始），
/// **结尾**有结论（错误、汇总、失败在哪）。中间那一段往往最不重要。
/// 只留头部的话，`cargo test` 失败时最关键的报错正好被切掉。
async fn read_both_ends<R>(mut r: R, cap: usize) -> Captured
where
    R: tokio::io::AsyncRead + Unpin,
{
    let half = cap / 2;
    let mut c = Captured::default();
    let mut buf = vec![0u8; 16 * 1024];

    loop {
        match r.read(&mut buf).await {
            Ok(0) => break,
            Ok(n) => {
                c.total += n;
                let chunk = &buf[..n];
                if c.head.len() < half {
                    let take = (half - c.head.len()).min(n);
                    c.head.extend_from_slice(&chunk[..take]);
                    push_tail(&mut c.tail, &chunk[take..], half);
                } else {
                    push_tail(&mut c.tail, chunk, half);
                }
            }
            // 读出错就算了 —— 管道上的问题和命令本身的结果是两回事，
            // 不该让整个工具调用变成「失败」。
            Err(_) => break,
        }
    }

    c
}

/// 往环形尾部塞一段，超了就从头丢。
fn push_tail(tail: &mut Vec<u8>, chunk: &[u8], cap: usize) {
    if chunk.is_empty() {
        return;
    }
    if chunk.len() >= cap {
        tail.clear();
        tail.extend_from_slice(&chunk[chunk.len() - cap..]);
        return;
    }
    let drop_n = (tail.len() + chunk.len()).saturating_sub(cap);
    if drop_n > 0 {
        tail.drain(..drop_n);
    }
    tail.extend_from_slice(chunk);
}

/// 把读到的字节渲染成给模型看的文本。
fn render_captured(c: &Captured) -> String {
    let mut s = String::from_utf8_lossy(&c.head).into_owned();
    let shown = c.head.len() + c.tail.len();
    if c.total > shown {
        if !s.is_empty() && !s.ends_with('\n') {
            s.push('\n');
        }
        s.push_str(&format!(
            "…（中间省略了 {}）…\n",
            human_size((c.total - shown) as u64)
        ));
        s.push_str(&String::from_utf8_lossy(&c.tail));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tmp_ws() -> (Workspace, tempfile::TempDir) {
        let dir = tempfile::TempDir::new().unwrap();
        let ws = Workspace::open(dir.path()).unwrap();
        (ws, dir)
    }

    // ------------------------------------------------------------ 准备（纯逻辑）

    #[test]
    fn shell_like_programs_never_get_a_remember_key() {
        // ⚠️ 这条是安全边界：记住 `bash` 等于免审之后所有的 `bash -c "…"`，
        // 而用户点「记住」时看到的是当时那一条命令。
        let (ws, _d) = tmp_ws();
        for p in ["bash", "/bin/bash", "BASH", "bash.exe", r"C:\Program Files\Git\bin\bash.exe"] {
            let call = prepare_run(&ws, json!({"program": p, "args": ["-c", "echo hi"]})).unwrap();
            assert!(
                call.grant.is_none(),
                "{p} 是执行器，不该给「记住」选项"
            );
        }
    }

    #[test]
    fn ordinary_programs_do_get_one() {
        let (ws, _d) = tmp_ws();
        let call = prepare_run(&ws, json!({"program": "git", "args": ["status"]})).unwrap();
        assert_eq!(
            call.grant,
            Some(GrantKey {
                tool: "run_command".into(),
                target: "git".into()
            })
        );
    }

    #[test]
    fn the_grant_target_is_the_program_verbatim_not_its_base_name() {
        // ⚠️ 归一化只会**扩大**授权：`/tmp/evil/curl` 归一成 `curl` 之后，
        // 用户之前批准的真 curl 会让它免审。宁可多问一次。
        let (ws, _d) = tmp_ws();
        let call = prepare_run(&ws, json!({"program": "/tmp/evil/curl"})).unwrap();
        assert_eq!(
            call.grant.unwrap().target,
            "/tmp/evil/curl",
            "授权目标不能归一化"
        );
    }

    #[test]
    fn non_string_args_are_caught_before_spawning() {
        // 我们的 schema 子集不递归校验数组元素，所以这一步不能省 ——
        // 否则报错会出现在 `Command::args` 那儿，和参数长什么样毫无关系。
        let (ws, _d) = tmp_ws();
        let err = prepare_run(&ws, json!({"program": "git", "args": ["ok", 7]})).unwrap_err();
        assert!(err.reason.contains("第 2 个"), "{}", err.reason);
    }

    #[test]
    fn an_empty_program_is_rejected() {
        let (ws, _d) = tmp_ws();
        assert!(prepare_run(&ws, json!({"program": "   "})).is_err());
    }

    #[test]
    fn the_display_shows_argument_boundaries() {
        // 用户靠这一行判断自己在批准什么。`rm -rf / tmp` 和 `rm "-rf /" tmp`
        // 是两条完全不同的命令，不能让他靠猜。
        let (ws, _d) = tmp_ws();
        let call = prepare_run(&ws, json!({"program": "rm", "args": ["-rf /", "tmp"]})).unwrap();
        assert_eq!(call.display, r#"运行 rm "-rf /" tmp"#);

        let plain = prepare_run(&ws, json!({"program": "git", "args": ["status"]})).unwrap();
        assert_eq!(plain.display, "运行 git status");
    }

    #[test]
    fn a_cwd_outside_the_workspace_is_refused() {
        let (ws, _d) = tmp_ws();
        assert!(prepare_run(&ws, json!({"program": "ls", "cwd": "../.."})).is_err());
    }

    // ------------------------------------------------------------ 执行

    /// 跨平台一定有、又不会被 PATH 弄丢的程序：跑得起 `cargo test` 就装了 rustc。
    ///
    /// ⚠️ 别拿 `echo` / `cat` / `sleep` 这些来写「主路」的用例：`echo` 在 Windows 上
    /// 是 **cmd 的内建命令**（根本没有 `echo.exe`），`cat` / `sleep` 压根没有。
    /// 用它们的话这几条只能在 Linux 上跑，而 Windows 才是第一目标平台 ——
    /// 一套只在一个平台上绿的测试，比没有更让人放心不下。
    fn rustc() -> String {
        "rustc".to_string()
    }

    #[tokio::test]
    async fn a_normal_command_reports_its_exit_code_and_output() {
        let (ws, _d) = tmp_ws();
        let args = prepare_run(&ws, json!({"program": rustc(), "args": ["--version"]}))
            .unwrap()
            .args;

        let out = execute_run(&ws, &ToolsConfig::default(), &args).await;
        assert!(!out.is_error, "{}", out.content);
        assert!(out.content.contains("退出码 0"), "{}", out.content);
        assert!(out.content.contains("rustc"), "{}", out.content);
    }

    #[tokio::test]
    async fn a_nonzero_exit_is_a_result_not_a_tool_failure() {
        // ⚠️ 仓库的规矩：服务器/引擎报错是「一条结果」，不弹外壳错误条。
        // `git diff --quiet` 用退出码回答问题，那不能算工具执行失败。
        let (ws, _d) = tmp_ws();
        let args = prepare_run(&ws, json!({"program": rustc(), "args": ["--no-such-flag-xyz"]}))
            .unwrap()
            .args;

        let out = execute_run(&ws, &ToolsConfig::default(), &args).await;
        assert!(!out.is_error, "退出码非 0 不该算工具失败：{}", out.content);
        assert!(out.content.contains("退出码"), "{}", out.content);
        assert!(!out.content.contains("退出码 0"), "应该是非 0：{}", out.content);
    }

    #[tokio::test]
    async fn a_missing_program_gives_an_actionable_message() {
        let (ws, _d) = tmp_ws();
        let args = prepare_run(&ws, json!({"program": "definitely-not-installed-xyz"}))
            .unwrap()
            .args;

        let out = execute_run(&ws, &ToolsConfig::default(), &args).await;
        assert!(out.is_error);
        // PATH 那条提示很重要 —— 桌面应用拿到的是登录时的快照。
        assert!(out.content.contains("PATH"), "{}", out.content);
    }

    /// 一个「会跑很久」的命令。分平台挑：`sleep` 是 Unix 的，Windows 上最接近的
    /// 是 `ping -n 30`（它每秒打一行，连打 30 次）。
    fn slow_command() -> Value {
        if cfg!(windows) {
            json!({"program": "ping", "args": ["-n", "30", "127.0.0.1"]})
        } else {
            json!({"program": "sleep", "args": ["30"]})
        }
    }

    #[tokio::test]
    async fn a_command_that_never_exits_is_killed_by_the_timeout() {
        let (ws, _d) = tmp_ws();
        let cfg = ToolsConfig {
            command_timeout: Duration::from_millis(300),
            ..ToolsConfig::default()
        };
        let args = prepare_run(&ws, slow_command()).unwrap().args;

        let started = std::time::Instant::now();
        let out = execute_run(&ws, &cfg, &args).await;

        assert!(out.is_error, "超时要算失败：{}", out.content);
        assert!(out.content.contains("超过"), "{}", out.content);
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "没有真的中止，等了 {:?}",
            started.elapsed()
        );
    }

    // ⚠️ 下面两条**只在 Unix 上跑**：`cat` 和 `sh` 在 Windows 上都没有
    // （cmd 的 `more` 读 stdin 的方式不一样，行为不是同一个东西）。
    // 「stdin 接空设备」和「输出封顶」这两条真机验证记在 HANDOFF 的 Windows 清单里。
    #[cfg(unix)]
    #[tokio::test]
    async fn stdin_is_closed_so_an_interactive_command_fails_instead_of_hanging() {
        // ⚠️ 这条盯的是「继承 stdin 会挂死」那个坑：不接 /dev/null 的话，
        // 交互式命令会等一个永远不会来的输入，一直等到超时。
        // `cat` 没有参数就是「读 stdin 写 stdout」—— 立刻失败才是对的。
        let (ws, _d) = tmp_ws();
        let cfg = ToolsConfig {
            command_timeout: Duration::from_secs(10),
            ..ToolsConfig::default()
        };
        let args = prepare_run(&ws, json!({"program": "cat"})).unwrap().args;

        let started = std::time::Instant::now();
        let out = execute_run(&ws, &cfg, &args).await;

        assert!(
            started.elapsed() < Duration::from_secs(5),
            "cat 挂住了 —— stdin 没接空设备"
        );
        assert!(out.content.contains("退出码"), "{}", out.content);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_flood_of_output_is_capped_and_both_ends_survive() {
        // ⚠️ 一条 `yes` 能吐到天荒地老。读进内存就是 OOM，所以要**边读边丢**。
        // 而且头尾都要留：开头有上下文，结尾有结论。
        let (ws, _d) = tmp_ws();
        let cfg = ToolsConfig {
            max_output_bytes: 4096,
            command_timeout: Duration::from_secs(20),
            ..ToolsConfig::default()
        };
        // 打 200KB：开头一个字、结尾一个标记，中间全是填充。
        let args = prepare_run(
            &ws,
            json!({"program": "sh", "args": [
                "-c",
                "printf 'START'; head -c 200000 /dev/zero | tr '\\0' 'x'; printf 'END'"
            ]}),
        )
        .unwrap()
        .args;

        let out = execute_run(&ws, &cfg, &args).await;

        assert!(out.content.contains("START"), "头部应该留下：{}", &out.content[..200.min(out.content.len())]);
        assert!(out.content.contains("END"), "尾部应该留下");
        assert!(out.content.contains("省略"), "要说明截断了");
        assert!(out.content.len() < 20_000, "结果没有被限制住：{} 字节", out.content.len());
    }

    #[test]
    fn the_tail_ring_keeps_the_last_bytes() {
        let mut tail = Vec::new();
        for i in 0..10u8 {
            push_tail(&mut tail, &[i], 4);
        }
        assert_eq!(tail, vec![6, 7, 8, 9]);

        // 一次来一大块（比上限还长）时，只留它的尾巴。
        push_tail(&mut tail, &[1, 2, 3, 4, 5, 6, 7, 8], 4);
        assert_eq!(tail, vec![5, 6, 7, 8]);
    }
}
