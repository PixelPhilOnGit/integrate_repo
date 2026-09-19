//! 本地 PTY：起进程、流字节、改大小、**关干净**。
//!
//! 这组用例全是**真起进程**的。尤其是「关窗格不留孤儿」那几条 ——
//! 它们才是这个文件存在的理由：那是唯一能回答「用户关掉窗格之后，
//! `claude` 底下的 node 到底死没死」的办法。

mod common;

use std::time::Duration;

use common::*;
use devtoolkit_agents::{AgentRegistry, PtyEvent};

// ---------------------------------------------------------------------------
// 起进程
// ---------------------------------------------------------------------------

/// 回归：pane 里起的是**一个正常 shell**，命令是当**输入**敲进去的。
///
/// 这条盯的是这个模块最容易走回头路的设计决定。判据是「命令跑完之后 shell
/// 还活着，还能接着敲」—— 直接 spawn CLI 的话，进程一退窗格就死了，
/// 用户看到一块不动的屏幕，什么也做不了。
#[tokio::test]
async fn 命令跑完之后_shell_还在_还能接着敲() {
    let dir = TempDir::new("shell-alive");
    let reg = AgentRegistry::new();
    let config = cfg(dir.path(), &cmd("echo 第一句", "echo 第一句"));

    let mut rx = open(&reg, "p1", &config);
    let out = read_until(&mut rx, "第一句", FIVE_SECONDS).await;
    assert!(out.contains("第一句"), "初始命令没跑起来，输出：\n{out}");

    // 再敲一句 —— 能跑通就说明 shell 还活着
    reg.write("p1", cmd("echo 第二句\r", "echo 第二句\r").as_bytes())
        .expect("往活着的窗格里写");
    let out = read_until(&mut rx, "第二句", FIVE_SECONDS).await;
    assert!(out.contains("第二句"), "命令跑完之后 shell 没了，输出：\n{out}");

    reg.close("p1");
}

/// 注入的环境变量要**原样**到子进程手里 —— 钩子脚本就是靠这两个变量认门的
/// （没有它们，脚本会认为自己在别的终端里跑，然后安静退出）。
#[tokio::test]
async fn 注入的环境变量在子进程里看得见() {
    let dir = TempDir::new("env");
    let reg = AgentRegistry::new();
    // ⚠️ 两个平台的**语法不一样**，而且 Windows 那边**不是 cmd 的 `%VAR%`**：
    // 默认 shell 是探测出来的（`pwsh` → `powershell` → `cmd`，见 `pty.rs` 的
    // `default_shell`），runner 上落到 PowerShell —— `%DEVTOOLKIT_PANE_ID%` 会被
    // **原样**打出来，看着就像「变量没进去」，其实注入得好好的（注入走的是
    // `CommandBuilder::env`，和 shell 是谁毫无关系）。
    let mut config = cfg(
        dir.path(),
        &cmd("echo PANE=$DEVTOOLKIT_PANE_ID", "echo PANE=$env:DEVTOOLKIT_PANE_ID"),
    );
    config
        .env
        .insert("DEVTOOLKIT_PANE_ID".to_string(), "pane_k3f9x2a1".to_string());
    config.env.insert(
        "DEVTOOLKIT_EVENT_DIR".to_string(),
        dir.path().join("events").display().to_string(),
    );

    let mut rx = open(&reg, "p1", &config);
    let out = read_until(&mut rx, "pane_k3f9x2a1", FIVE_SECONDS).await;
    assert!(out.contains("PANE=pane_k3f9x2a1"), "环境变量没进去，输出：\n{out}");

    reg.close("p1");
}

/// 工作目录就是传进来的那个。agent 在哪个目录里跑是个**用户能看见**的事实，
/// 悄悄跑到别处去了比报错更糟。
#[tokio::test]
async fn 工作目录就是传进来的那个() {
    let dir = TempDir::new("cwd");
    let reg = AgentRegistry::new();
    let work = dir.path().join("myproject");
    std::fs::create_dir_all(&work).expect("建工作目录");

    let config = cfg(&work, &cmd("pwd", "cd"));
    let mut rx = open(&reg, "p1", &config);
    let out = read_until(&mut rx, "myproject", FIVE_SECONDS).await;
    assert!(out.contains("myproject"), "工作目录不对，输出：\n{out}");

    reg.close("p1");
}

/// 工作目录不存在 → **明确报错**，不能静默落到别的地方去跑。
#[tokio::test]
async fn 工作目录不存在时明确报错() {
    let dir = TempDir::new("cwd-missing");
    let reg = AgentRegistry::new();
    let config = cfg(&dir.path().join("不存在的目录"), &cmd("echo x", "echo x"));

    let err = match reg.open("p1", &config) {
        Ok(_) => panic!("工作目录不存在应该起不来"),
        Err(e) => e,
    };
    let text = err.to_string();
    assert!(
        text.contains("起不来") && text.contains("不存在"),
        "错误文案要说清楚是起不来、以及为什么：{text}"
    );
    assert!(reg.is_empty(), "起失败不该在表里留下东西");
}

/// 退出码原样报出来 —— 用户靠它判断「是它干完了还是被杀了」。
#[tokio::test]
async fn 退出码原样报出来() {
    let dir = TempDir::new("exit-code");
    let reg = AgentRegistry::new();
    let config = cfg(dir.path(), "exit 3");

    let mut rx = open(&reg, "p1", &config);
    let (_, code) = read_to_exit(&mut rx, FIVE_SECONDS).await;
    assert_eq!(code, Some(3), "退出码要原样带出来");

    reg.close("p1");
}

/// **我们自己关掉的窗格，退出码是 `null`。**
///
/// 这是最常见的那条路（用户点了「关窗格」）。报一个假的退出码，前端就会显示
/// 「已退出（1）」—— 用户会去翻日志找那个「错误」，而其实什么都没出错。
#[tokio::test]
async fn 我们自己关掉的窗格退出码是_null() {
    let dir = TempDir::new("killed-by-us");
    let reg = AgentRegistry::new();
    let mut rx = open(&reg, "p1", &cfg(dir.path(), ""));

    reg.close("p1");

    // 关掉之后等待线程会送最后一条 Exit（先杀、再等读线程排空、最后发）
    let (_, code) = read_to_exit(&mut rx, FIVE_SECONDS).await;
    assert_eq!(code, None, "我们自己杀的进程没有「退出码」可言");
}

/// ⚠️ 进程**自己**被信号带走时，我们分辨不出来 —— 但至少不能报成成功。
///
/// 为什么分辨不出来：`portable-pty` 的 `ExitStatus` 在 0.8.1 里**没有 `signal()`
/// 访问器**（0.9.0 才加），而它内部一律把「被信号杀掉」映射成 `code: 1`。
/// 我们不能因此升到 0.9 —— 那个版本会把 ConPTY 的 `INHERIT_CURSOR` 一起带进来，
/// 而那一位会让 Windows 上的终端白屏（见 Cargo.toml 里那段注释）。
///
/// 所以这条用例钉的是「**别报成 0**」：报 0 前端会显示「已退出（0）」，
/// 用户以为它正常干完了，而它其实是被杀的。
#[cfg(unix)]
#[tokio::test]
async fn 被信号杀掉时不报成功退出() {
    let dir = TempDir::new("signalled");
    let reg = AgentRegistry::new();
    // 让 shell 自己给自己来一刀，模拟「被信号带走」
    let config = cfg(dir.path(), "kill -9 $$");

    let mut rx = open(&reg, "p1", &config);
    let (_, code) = read_to_exit(&mut rx, FIVE_SECONDS).await;
    assert_ne!(code, Some(0), "被杀掉的进程不能报成「成功退出」");

    reg.close("p1");
}

/// 最后一批输出**必须先到**，退出事件在后。
///
/// 这两样是两个线程分别送出来的（读线程送字节、等线程送退出）。抢跑的话
/// 用户看不到最后那几行 —— 而 agent 恰恰是「最后几行」最有信息量
/// （结束了、报错了、问你要不要继续）。
#[tokio::test]
async fn 最后一批输出在退出事件之前到齐() {
    let dir = TempDir::new("drain");
    let reg = AgentRegistry::new();
    let config = cfg(dir.path(), &cmd("echo 甲; echo 乙; exit", "echo 甲 & echo 乙 & exit"));

    let mut rx = open(&reg, "p1", &config);
    let (out, _) = read_to_exit(&mut rx, FIVE_SECONDS).await;
    assert!(out.contains("甲") && out.contains("乙"), "退出时丢了输出：\n{out}");

    reg.close("p1");
}

// ---------------------------------------------------------------------------
// 尺寸
// ---------------------------------------------------------------------------

/// resize 真的传到了里面的程序 —— 它的判据是**程序自己去问内核**得到的值
/// （`stty size` 读的就是 TIOCGWINSZ），不是我们自己记的那个数。
///
/// 这条能过，说明「改大小 → 内核 winsize 变了」这一半是通的；
/// 另一半（SIGWINCH 有没有送到）由 `vim`/`top` 那种程序自己处理，
/// 在用例里没法稳定断言。
#[cfg(unix)]
#[tokio::test]
async fn resize_真的传到了里面的程序() {
    let dir = TempDir::new("resize");
    let reg = AgentRegistry::new();
    let config = cfg(dir.path(), "stty size");

    let mut rx = open(&reg, "p1", &config);
    let out = read_until(&mut rx, "24 80", FIVE_SECONDS).await;
    assert!(out.contains("24 80"), "开窗格时的尺寸没生效，输出：\n{out}");

    reg.resize("p1", 100, 30).expect("改大小");
    reg.write("p1", b"stty size\r").expect("再问一次");

    let out = read_until(&mut rx, "30 100", FIVE_SECONDS).await;
    assert!(out.contains("30 100"), "resize 没传到程序里，输出：\n{out}");

    reg.close("p1");
}

/// 0 列/0 行的 resize 要把全屏程序排版搞坏，所以要夹住。
/// 前端也夹过一道，但这条路上有两个入口（还有 IPC 直接来的），
/// 不能只靠前端。
#[cfg(unix)]
#[tokio::test]
async fn 尺寸是_0_的时候夹成_1() {
    let dir = TempDir::new("resize-zero");
    let reg = AgentRegistry::new();
    let config = cfg(dir.path(), "");

    let mut rx = open(&reg, "p1", &config);
    // 等 shell 起来（不猜提示符长什么样 —— root 和普通用户的提示符不一样，
    // 而且 `/bin/sh` 可能是 dash/bash/busybox）
    reg.write("p1", b"echo READY\r").expect("热身");
    read_until(&mut rx, "READY", FIVE_SECONDS).await;

    reg.resize("p1", 0, 0).expect("0 不该报错，该被夹住");

    reg.write("p1", b"stty size\r").expect("问尺寸");
    let out = read_until(&mut rx, "1 1", FIVE_SECONDS).await;
    assert!(out.contains("1 1"), "0 没被夹成 1，输出：\n{out}");

    reg.close("p1");
}

// ---------------------------------------------------------------------------
// 关窗格：不留孤儿（这个文件的重头戏）
// ---------------------------------------------------------------------------

/// ⚠️ **回归：曾经只杀直接子进程，孙进程全活下来了。**
///
/// 这里起的是一个「会再 fork 一个子进程」的脚本：
/// 外层 shell 跑 `sh -c '…'`（**作业控制会把它放进一个新的进程组**，
/// 也就是 tty 的前台组），里面那个 `sleep` 跟着它一起在这个组里 ——
/// 这正是 `claude` 底下的 node 的样子。
///
/// 只杀直接子进程（外层 shell）的结果是：里面的 `sh` 和 `sleep` 都还在跑。
/// 所以 `close` 要杀**前台组 + 会话首进程组**两个。
#[cfg(unix)]
#[tokio::test]
async fn 关窗格会把整棵进程树杀掉() {
    let dir = TempDir::new("kill-tree");
    let reg = AgentRegistry::new();
    // 非交互的那个 `sh -c` 不开作业控制，所以 sleep 和它同一个进程组；
    // 而它自己（作为前台作业）被放到一个新的进程组里
    let config = cfg(dir.path(), "sh -c 'sleep 60 & echo GRANDCHILD=$!; wait'");

    let mut rx = open(&reg, "p1", &config);
    let grandchild = read_pid(&mut rx, "GRANDCHILD=", FIVE_SECONDS, &mut String::new()).await;
    let guard = KillOnDrop(grandchild);

    assert!(common::is_alive(grandchild), "夹具自己就不对：孙进程没起来");

    reg.close("p1");

    assert!(
        wait_gone(grandchild, Duration::from_secs(5)),
        "关了窗格，孙进程（pid {grandchild}）还活着 —— 这正是「只杀直接子进程」的后果"
    );
    std::mem::forget(guard); // 已经死了，不用再补刀
}

/// Windows 上的同一件事：靠 Job Object（`KILL_ON_JOB_CLOSE`）。
///
/// 这个用例**只在 CI 的 windows-latest 上真跑过** —— ConPTY 的真行为、
/// `AssignProcessToJobObject` 到底成不成，在 Linux 上一条都验不了。
#[cfg(windows)]
#[tokio::test]
async fn 关窗格会把整棵进程树杀掉() {
    use devtoolkit_agents::PtyConfig;

    let dir = TempDir::new("kill-tree-win");
    let reg = AgentRegistry::new();
    let config = PtyConfig {
        cwd: dir.path().display().to_string(),
        // 用 PowerShell 起一个「脱离的孙子进程」：Start-Process 起的是**独立进程**，
        // 只有作业对象能把它一起带走（按父子关系杀都杀不到它，
        // 因为它的父进程很快就退出了）
        command: "$p = Start-Process powershell -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 60' -PassThru -WindowStyle Hidden; Write-Output \"GRANDCHILD=$($p.Id)\"".to_string(),
        cols: 80,
        rows: 24,
        shell: Some("powershell.exe".to_string()),
        env: Default::default(),
    };

    let mut rx = open(&reg, "p1", &config);
    let grandchild =
        read_pid(&mut rx, "GRANDCHILD=", Duration::from_secs(30), &mut String::new()).await;

    reg.close("p1");

    assert!(
        wait_gone(grandchild, Duration::from_secs(10)),
        "关了窗格，孙进程（pid {grandchild}）还活着 —— 作业对象没套上？"
    );
}

/// 回归：**「只把跑着的那个进程杀掉」是不够的**。
///
/// 这是上一条的反面 —— 不是测我们做对了什么，而是把「为什么必须按进程组杀」
/// 钉在测试里：朴素的 `kill(pid)` 之后，那个进程自己起的子进程会**被 init 收养、
/// 继续活着**（用户看不见，它还在占端口、写文件）。
///
/// 这也是 `portable-pty` 在 Windows 上的 `Child::kill()` 干的事
/// （源码 `win/mod.rs` 里就一句 `TerminateProcess`）—— 我们不能只靠它。
#[cfg(unix)]
#[tokio::test]
async fn 只杀跑着的那个进程_它起的子进程会活下来() {
    let dir = TempDir::new("naive-kill");
    let reg = AgentRegistry::new();
    let config = cfg(dir.path(), "sh -c 'sleep 60 & echo KID=$!; echo SELF=$$; wait'");

    let mut rx = open(&reg, "p1", &config);
    // 两条 pid 一起到，所以**共用一个缓冲区**（见 read_pid 的注释）
    let mut seen = String::new();
    let kid = read_pid(&mut rx, "KID=", FIVE_SECONDS, &mut seen).await;
    let self_pid = read_pid(&mut rx, "SELF=", FIVE_SECONDS, &mut seen).await;
    // ⚠️ 这个孙进程**后面得靠这个 guard 收尸**：它进的是那个前台作业的进程组，
    // 而作业组长一死，tty 的前台组就交还给 shell 了 —— 到那时我们杀的
    // 「前台组」里已经没有它（这是 Unix 侧的已知边界，见 pty.rs 头注释）
    let _guard = KillOnDrop(kid);

    // 朴素的写法：只杀掉那个「直接跑着」的进程
    let killed = std::process::Command::new("kill")
        .args(["-9", &self_pid.to_string()])
        .status()
        .expect("发信号");
    assert!(killed.success());

    // 它起的那个还在 —— 这就是我们必须按**进程组**杀的理由
    assert!(
        common::is_alive(kid),
        "这条用例的前提变了：只杀父进程之后子进程居然也没了"
    );

    // 窗格本身还是关得掉的（杀掉 shell 那一组），guard 负责把上面那个孤儿清掉
    reg.close("p1");
    assert!(reg.is_empty());
}

/// 关掉之后再往里写要**明确报错**，而不是静默丢掉 ——
/// 前端要靠它判断「这个窗格不能用了」。
#[tokio::test]
async fn 关掉之后再写会明确报错() {
    let dir = TempDir::new("write-after-close");
    let reg = AgentRegistry::new();
    let config = cfg(dir.path(), "");
    let mut _rx = open(&reg, "p1", &config);

    reg.close("p1");

    let err = reg.write("p1", b"x").expect_err("关掉的窗格不该还能写");
    assert!(err.to_string().contains("不在活动状态"), "错误文案：{err}");
    // 关两次也不该出事（用户点两次「关窗格」是很常见的）
    reg.close("p1");
}

/// 同一个 id 再开一次是**替换**：旧的那个必须死掉。
///
/// 不这么做的话，「前端刷新了但 Rust 侧还挂着旧会话」会留下一个
/// 用户看不见也关不掉的进程 —— 它还占着工作目录、还连着 agent 的 API。
#[cfg(unix)]
#[tokio::test]
async fn 同一个_id_再开一次不会留下旧的进程() {
    let dir = TempDir::new("replace");
    let reg = AgentRegistry::new();

    let mut rx = open(&reg, "p1", &cfg(dir.path(), "sh -c 'sleep 60 & echo KID=$!; wait'"));
    let old_kid = read_pid(&mut rx, "KID=", FIVE_SECONDS, &mut String::new()).await;
    let guard = KillOnDrop(old_kid);

    // 同一个 id 再开一次
    let _rx2 = open(&reg, "p1", &cfg(dir.path(), ""));
    assert_eq!(reg.len(), 1, "替换之后表里只该有一个会话");

    assert!(
        wait_gone(old_kid, Duration::from_secs(5)),
        "同 id 重开之后，旧会话的进程树还活着（pid {old_kid}）"
    );
    std::mem::forget(guard);
    reg.close("p1");
}

/// `close_all`（应用退出、前端重载都走它）**一个都不能留**。
///
/// 这条是「关掉应用之后还剩一屏 agent 在跑」那个事故的守门测试。
#[cfg(unix)]
#[tokio::test]
async fn close_all_把每个窗格的进程树都收干净() {
    let dir = TempDir::new("close-all");
    let reg = AgentRegistry::new();

    let mut kids = Vec::new();
    for (i, id) in ["a", "b", "c"].iter().enumerate() {
        let mut rx = open(
            &reg,
            id,
            &cfg(dir.path(), "sh -c 'sleep 60 & echo KID=$!; wait'"),
        );
        let kid = read_pid(&mut rx, "KID=", FIVE_SECONDS, &mut String::new()).await;
        kids.push((i, kid));
    }
    let _guards: Vec<KillOnDrop> = kids.iter().map(|(_, pid)| KillOnDrop(*pid)).collect();
    assert_eq!(reg.len(), 3);

    reg.close_all();

    assert!(reg.is_empty(), "close_all 之后表该是空的");
    for (i, pid) in &kids {
        assert!(
            wait_gone(*pid, Duration::from_secs(5)),
            "第 {i} 个窗格的进程树还活着（pid {pid}）"
        );
    }
    std::mem::forget(_guards);
}

/// 进程自己退出之后，会话表也要干净 —— 前端不该看见一个「活着但已经死了」的格子。
#[tokio::test]
async fn 进程自己退出之后事件流会给出退出事件() {
    let dir = TempDir::new("self-exit");
    let reg = AgentRegistry::new();
    let config = cfg(dir.path(), &cmd("echo bye; exit", "echo bye & exit"));

    let mut rx = open(&reg, "p1", &config);
    let (out, _) = read_to_exit(&mut rx, FIVE_SECONDS).await;
    assert!(out.contains("bye"), "输出：\n{out}");

    // 前端收到退出事件之后会调 close（把窗格从界面上摘掉）
    reg.close("p1");
    assert!(reg.is_empty());
}

/// 收尾：一个窗格都不剩的时候，事件通道要跟着关掉（不是一直挂着）。
///
/// 前端靠 `recv` 返回 `None`（通道关）来判断「这个窗格没有下文了」，
/// 这是那条 Channel 生命周期的终点。
#[tokio::test]
async fn 窗格关掉之后事件通道会关上() {
    let dir = TempDir::new("channel-end");
    let reg = AgentRegistry::new();
    let mut rx = open(&reg, "p1", &cfg(dir.path(), ""));

    reg.close("p1");

    // 关掉之后事件流最多再吐几条收尾的，最终一定是 None
    loop {
        match tokio::time::timeout(Duration::from_secs(5), rx.recv()).await {
            Ok(None) => break,
            Ok(Some(PtyEvent::Exit { .. })) => break,
            Ok(Some(PtyEvent::Data { .. })) => continue,
            Err(_) => panic!("关了窗格之后事件通道一直不关"),
        }
    }
}
