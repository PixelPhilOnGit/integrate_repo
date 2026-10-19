//! 一次性 CLI runner：起 claude/codex 的**无头**进程、喂提示词、收结果。
//!
//! # 契约是实跑出来的，不是猜的（2026-10-16，本机两个 CLI 都装了）
//!
//! * `claude -p --output-format stream-json --verbose`：stdout 是 JSONL；
//!   ⚠️ **stderr 有噪音**（网关告警等），解析只看 stdout；result 事件里
//!   有正文 + `usage` + `total_cost_usd`。
//! * `codex exec -s read-only --json --skip-git-repo-check`：JSONL；`item.completed`（agent_message）
//!   是正文、`turn.completed.usage` 有用量。**prompt 走 stdin**（不带参数）。
//!
//! # 工程骨架抄谁
//!
//! `assistant/src/tools/exec.rs` 的四条：stdout/stderr **并发读**（顺序读会
//! 满缓冲死锁）、超时 kill、输出上限、`kill_on_drop`。差异：它的 stdin 是
//! null，这里要 **piped** 喂提示词。
//!
//! ⚠️ 已知上限（照抄 run_command 那条，HANDOFF 也记着）：超时/取消只杀得掉
//! **直接子进程**。claude/codex 是 node 程序，多数情况直接子进程就是它本体；
//! 彻底收尸要 Job Object / 进程组，那是后面的事。

use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::oneshot;

use crate::error::KbError;

/// 两家 CLI。字符串形式是前端传来传去的那个。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Cli {
    Claude,
    Codex,
}

impl Cli {
    pub fn parse(s: &str) -> Option<Cli> {
        match s.trim().to_ascii_lowercase().as_str() {
            "claude" => Some(Cli::Claude),
            "codex" => Some(Cli::Codex),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Cli::Claude => "claude",
            Cli::Codex => "codex",
        }
    }

    fn program(self) -> &'static str {
        self.as_str()
    }

    /// 探测装没装（`--version`，短超时）。**不复用 agents 的 `probe_environment`**：
    /// 那个的 claude 解析只在 Windows 下做（它是「窗格为什么起不来」的排障
    /// 工具，不是通用检测器）。
    pub async fn detect(self) -> Option<String> {
        let out = tokio::time::timeout(
            Duration::from_secs(5),
            Command::new(self.program())
                .arg("--version")
                .stdin(Stdio::null())
                .output(),
        )
        .await
        .ok()?
        .ok()?;
        if !out.status.success() {
            return None;
        }
        let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if text.is_empty() {
            None
        } else {
            Some(text)
        }
    }
}

/// 跑一次生成要的全部输入。
pub struct RunSpec {
    pub cli: Cli,
    /// **测试注入点**：桩程序的路径。生产留 `None` 走 PATH。
    pub program: Option<String>,
    pub prompt: String,
    /// 需要 CLI 自己读的文件（图片直读）的**绝对路径**。
    pub read_files: Vec<String>,
    pub timeout: Duration,
}

/// 流给前端的进度（一句话，前端原样显示）。
#[derive(Debug, Clone, PartialEq)]
pub struct Progress(pub String);

/// 跑完的产出。
#[derive(Debug, Clone)]
pub struct RunOutcome {
    /// 模型最终的整段文本（卡片 JSON 混在里面，由 `blocks::parse_generated` 切）
    pub text: String,
    /// 用量（JSON 字符串；claude 带 total_cost_usd、codex 带 tokens）——记账用
    pub usage: Option<String>,
}

/// 组装 argv（`argv[0]` 是程序名）。**纯函数**：选项形状是这个模块最容易
/// 悄悄错的地方（少一个 `--verbose` 就全盘失败），必须能拿字面量测。
pub fn build_argv(cli: Cli, program: &str, read_files: &[String]) -> Vec<String> {
    let mut argv = vec![program.to_string()];
    match cli {
        Cli::Claude => {
            argv.extend([
                "-p".to_string(),
                "--output-format".to_string(),
                "stream-json".to_string(),
                // ⚠️ stream-json **必须配 --verbose**（实跑验证：不配直接报错）
                "--verbose".to_string(),
            ]);
            if !read_files.is_empty() {
                // Read 工具要显式放行（-p 模式里权限弹不出来，默认会被拒），
                // 附件所在目录要 --add-dir 授权
                argv.push("--allowedTools".to_string());
                argv.push("Read".to_string());
                for file in read_files {
                    if let Some(parent) = std::path::Path::new(file).parent() {
                        argv.push("--add-dir".to_string());
                        argv.push(parent.display().to_string());
                    }
                }
            }
        }
        Cli::Codex => {
            argv.extend([
                "exec".to_string(),
                "-s".to_string(),
                "read-only".to_string(),
                "--json".to_string(),
                // ⚠️ 知识库的 vault 不一定是 git 仓库，而 codex 默认**拒绝**
                // 在非 git 目录里跑 —— 用户真机报过：生成卡片直接失败，
                // stderr 是「Not inside a trusted directory and
                // --skip-git-repo-check was not specified」。
                "--skip-git-repo-check".to_string(),
            ]);
            for file in read_files {
                argv.push("-i".to_string());
                argv.push(file.clone());
            }
        }
    }
    argv
}

/// 跑的界面。`on_progress` 从读循环里同步调（命令层适配成 Channel）。
pub async fn run(
    spec: RunSpec,
    on_progress: impl Fn(Progress) + Send + Sync + 'static,
    mut cancel: oneshot::Receiver<()>,
) -> Result<RunOutcome, KbError> {
    let program = spec
        .program
        .clone()
        .unwrap_or_else(|| spec.cli.program().to_string());
    let argv = build_argv(spec.cli, &program, &spec.read_files);

    let mut cmd = Command::new(&argv[0]);
    cmd.args(&argv[1..])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = cmd.spawn().map_err(|e| KbError::Extract {
        rel: program.clone(),
        reason: format!("起不来（{e}）——装了吗？"),
    })?;
    on_progress(Progress(format!("{} 已启动", spec.cli.as_str())));

    // stdin：写完就丢（关掉 = 告诉 CLI 输入结束）。单独一个任务，
    // 不能在主流程 await —— 大提示词写不进去时对方可能还没开始读
    let mut stdin = child.stdin.take().expect("piped stdin");
    let prompt = spec.prompt.clone();
    let writer = tokio::spawn(async move {
        let _ = stdin.write_all(prompt.as_bytes()).await;
        let _ = stdin.shutdown().await;
    });

    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");

    let cli = spec.cli;
    let on_progress = Arc::new(on_progress);
    let progress_out = Arc::clone(&on_progress);

    // 两条管道并发读（⚠️ 顺序读会满缓冲死锁 —— exec.rs 的同款注释）
    let out_task = tokio::spawn(async move { read_stdout(stdout, cli, progress_out.as_ref()).await });
    let err_task = tokio::spawn(async move { read_tail(stderr).await });

    let status = tokio::select! {
        r = tokio::time::timeout(spec.timeout, child.wait()) => match r {
            Ok(Ok(status)) => status,
            Ok(Err(e)) => {
                return Err(KbError::Extract { rel: program, reason: format!("等子进程失败：{e}") });
            }
            Err(_) => {
                on_progress(Progress("超时，收掉进程".to_string()));
                let _ = child.kill().await;
                return Err(KbError::Extract {
                    rel: program,
                    reason: "跑太久了（超过上限），已收掉".to_string(),
                });
            }
        },
        _ = &mut cancel => {
            on_progress(Progress("已取消".to_string()));
            let _ = child.kill().await;
            return Err(KbError::Extract { rel: program, reason: "被取消了".to_string() });
        }
    };

    let _ = writer.await;
    let parsed = out_task
        .await
        .map_err(|e| KbError::Extract { rel: program.clone(), reason: format!("读输出失败：{e}") })??;
    let err_tail = err_task.await.unwrap_or_default();

    if !status.success() && parsed.text.trim().is_empty() {
        let tail: String = err_tail.chars().rev().take(300).collect::<String>().chars().rev().collect();
        return Err(KbError::Extract {
            rel: program,
            reason: format!("退出码 {:?}，stderr 末尾：{tail}", status.code()),
        });
    }

    Ok(parsed)
}

/// stdout 的累积器（两家共用一个结构，字段各自用）。
#[derive(Default)]
struct Acc {
    text: String,
    usage: Option<String>,
    events: usize,
}

async fn read_stdout(
    stdout: tokio::process::ChildStdout,
    cli: Cli,
    on_progress: &(dyn Fn(Progress) + Send + Sync),
) -> Result<RunOutcome, KbError> {
    let mut lines = BufReader::new(stdout).lines();
    let mut acc = Acc::default();

    while let Some(line) = lines.next_line().await.map_err(|e| KbError::Extract {
        rel: "stdout".to_string(),
        reason: e.to_string(),
    })? {
        parse_line(cli, &line, &mut acc);
        acc.events += 1;
        // 每来几条报一次进度（别每个事件都刷）
        if acc.events % 5 == 0 {
            on_progress(Progress(format!("生成中…（已收到 {} 个事件）", acc.events)));
        }
    }

    Ok(RunOutcome {
        text: acc.text,
        usage: acc.usage,
    })
}

/// 一行 JSONL → 累积进 `acc`。**纯函数**（解析规则最容易悄悄错，拿真形状测）。
fn parse_line(cli: Cli, line: &str, acc: &mut Acc) {
    // ⚠️ 有些行不是 JSON（claude 的 stdout 前面可能混东西）——跳过，不报错
    let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
        return;
    };
    match cli {
        Cli::Claude => {
            match v["type"].as_str() {
                // 最终结果：正文 + 用量一起到
                Some("result") => {
                    if let Some(text) = v["result"].as_str() {
                        acc.text = text.to_string();
                    }
                    let mut usage = serde_json::Map::new();
                    if let Some(u) = v.get("usage") {
                        usage.insert("usage".to_string(), u.clone());
                    }
                    if let Some(c) = v.get("total_cost_usd") {
                        usage.insert("totalCostUsd".to_string(), c.clone());
                    }
                    if !usage.is_empty() {
                        acc.usage = Some(serde_json::Value::Object(usage).to_string());
                    }
                }
                // 中途的助手消息（stream 出来的一段段）——不进正文（result 才是
                // 权威终稿），只当进度
                Some("assistant") => {}
                _ => {}
            }
        }
        Cli::Codex => {
            match v["type"].as_str() {
                Some("item.completed") => {
                    if v["item"]["type"].as_str() == Some("agent_message") {
                        if let Some(text) = v["item"]["text"].as_str() {
                            // codex 的正文是**一段段来的**，拼起来才是终稿
                            acc.text.push_str(text);
                        }
                    }
                }
                Some("turn.completed") => {
                    if let Some(u) = v.get("usage") {
                        acc.usage = Some(serde_json::Value::Object(
                            [("usage".to_string(), u.clone())].into_iter().collect(),
                        ).to_string());
                    }
                }
                _ => {}
            }
        }
    }
}

/// stderr 只留尾巴（错误报告用）；**不当进度**（实跑见过网关告警刷屏）。
async fn read_tail(stderr: tokio::process::ChildStderr) -> String {
    let mut lines = BufReader::new(stderr).lines();
    let mut tail = String::new();
    while let Ok(Some(line)) = lines.next_line().await {
        tail.push_str(&line);
        tail.push('\n');
        // 留最后 4KB
        if tail.len() > 4096 {
            let cut = tail.len() - 4096;
            tail = tail[cut..].to_string();
        }
    }
    tail
}

#[cfg(test)]
mod tests {
    use super::*;

    // 下面这些 JSON 是**本机实跑抓到形状的摘录**（2026-10-16），不是编的。
    const CLAUDE_ASSISTANT_LINE: &str = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"working"}]}}"#;
    const CLAUDE_RESULT_LINE: &str = r#"{"type":"result","subtype":"success","result":"{\"cards\":[{\"title\":\"甲\",\"blocks\":[{\"type\":\"text\",\"text\":\"正文\"}]}]}","total_cost_usd":0.1,"usage":{"input_tokens":100,"output_tokens":20}}"#;
    const CODEX_ITEM_LINE: &str = r#"{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"你好"}}"#;
    const CODEX_TURN_LINE: &str = r#"{"type":"turn.completed","usage":{"input_tokens":11255,"output_tokens":18}}"#;

    #[test]
    fn argv_形状_两家都对() {
        let claude = build_argv(Cli::Claude, "claude", &[]);
        assert_eq!(claude[0], "claude");
        assert!(claude.contains(&"-p".to_string()));
        assert!(claude.contains(&"stream-json".to_string()));
        assert!(claude.contains(&"--verbose".to_string()), "stream-json 必须配 --verbose（实跑教训）");

        // 图片直读：加允许 Read + 附件目录
        let with_file = build_argv(Cli::Claude, "claude", &["/data/kb/架构图.png".to_string()]);
        assert!(with_file.windows(2).any(|w| w == ["--allowedTools", "Read"]));
        assert!(with_file.windows(2).any(|w| w == ["--add-dir", "/data/kb"]));

        let codex = build_argv(Cli::Codex, "codex", &[]);
        assert_eq!(codex[1..3], ["exec".to_string(), "-s".to_string()]);
        assert!(codex.contains(&"--json".to_string()));
        // 回归（真机 2026-10-19）：vault 不是 git 仓库时 codex 直接拒绝启动，
        // 报「Not inside a trusted directory and --skip-git-repo-check was
        // not specified」。少了这个 flag，知识库生成在真机上全军覆没。
        assert!(
            codex.contains(&"--skip-git-repo-check".to_string()),
            "codex 必须跳过 git 仓库检查：{codex:?}"
        );
        let codex_img = build_argv(Cli::Codex, "codex", &["/x/a.png".to_string()]);
        assert!(codex_img.windows(2).any(|w| w == ["-i", "/x/a.png"]));
    }

    #[test]
    fn claude_的_result_事件是终稿_带用量() {
        let mut acc = Acc::default();
        parse_line(Cli::Claude, CLAUDE_ASSISTANT_LINE, &mut acc);
        assert!(acc.text.is_empty(), "中途的 assistant 段不进正文（result 才是权威）");
        parse_line(Cli::Claude, CLAUDE_RESULT_LINE, &mut acc);
        assert!(acc.text.contains("\"cards\""));
        assert!(acc.usage.as_deref().unwrap().contains("totalCostUsd"));
    }

    #[test]
    fn codex_的_agent_message_要拼起来() {
        let mut acc = Acc::default();
        parse_line(Cli::Codex, "not json at all", &mut acc); // 不炸
        parse_line(Cli::Codex, CODEX_ITEM_LINE, &mut acc);
        parse_line(Cli::Codex, CODEX_ITEM_LINE, &mut acc);
        assert_eq!(acc.text, "你好你好", "逐段拼接");
        parse_line(Cli::Codex, CODEX_TURN_LINE, &mut acc);
        assert!(acc.usage.as_deref().unwrap().contains("input_tokens"));
    }

    #[test]
    fn cli_名字解析_不认的给_none() {
        assert_eq!(Cli::parse("Claude"), Some(Cli::Claude));
        assert_eq!(Cli::parse(" codex "), Some(Cli::Codex));
        assert_eq!(Cli::parse("gpt"), None);
    }

    /// runner 端到端：用一个**桩程序**（unix 脚本）吐预设 stream。
    /// 真 claude/codex 不做自动化调用（要钱、要登录），真机手测一遍就够。
    #[cfg(unix)]
    #[tokio::test]
    async fn runner_跑桩程序_收到正文和用量() {
        use std::io::Write as _;
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join(format!("devtoolkit-kb-runner-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let stub = dir.join("claude-stub.sh");
        let mut f = std::fs::File::create(&stub).unwrap();
        // 读掉 stdin（证明我们是关掉 stdin 的），再吐两行流
        writeln!(f, "#!/bin/sh").unwrap();
        writeln!(f, "cat >/dev/null").unwrap();
        writeln!(f, r#"echo '{}'"#, CLAUDE_ASSISTANT_LINE.replace('\'', "'\\''") ).unwrap();
        writeln!(f, r#"echo '{}'"#, CLAUDE_RESULT_LINE.replace('\'', "'\\''") ).unwrap();
        drop(f);
        std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755)).unwrap();

        let progress: Arc<std::sync::Mutex<Vec<String>>> = Arc::new(std::sync::Mutex::new(vec![]));
        let p2 = Arc::clone(&progress);
        let (_tx, rx) = oneshot::channel();

        let outcome = run(
            RunSpec {
                cli: Cli::Claude,
                program: Some(stub.display().to_string()),
                prompt: "hi".to_string(),
                read_files: vec![],
                timeout: Duration::from_secs(20),
            },
            move |Progress(s)| p2.lock().unwrap().push(s),
            rx,
        )
        .await
        .expect("桩程序该跑通");

        assert!(outcome.text.contains("\"cards\""));
        assert!(outcome.usage.is_some());
        assert!(!progress.lock().unwrap().is_empty(), "至少要有启动/进度事件");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn runner_取消_能收掉长跑进程() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("devtoolkit-kb-cancel-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let stub = dir.join("hang.sh");
        std::fs::write(&stub, "#!/bin/sh\nsleep 60\n").unwrap();
        std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755)).unwrap();

        let (tx, rx) = oneshot::channel();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(300)).await;
            let _ = tx.send(());
        });

        let started = std::time::Instant::now();
        let err = run(
            RunSpec {
                cli: Cli::Codex,
                program: Some(stub.display().to_string()),
                prompt: "x".to_string(),
                read_files: vec![],
                timeout: Duration::from_secs(60),
            },
            |_| {},
            rx,
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("取消"), "拿到：{err}");
        assert!(started.elapsed() < Duration::from_secs(10), "取消要真的打断 wait");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
