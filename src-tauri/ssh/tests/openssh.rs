//! 打**真 OpenSSH** 的集成测试。
//!
//! # 为什么光有 `session.rs` 不够
//!
//! `session.rs` 那一组用的是 russh 自己的服务端实现。那能覆盖协议的细枝末节
//! （PTY 尺寸、resize、退出码），但它有一个结构性盲点：**两端都是 russh**，
//! 同一个库里的同一类理解偏差会在两边同时存在，测试照样绿。
//!
//! 这组测试回答的是另一个问题：**对着大家真正在用的那个 sshd，能不能连上、
//! 能不能拿到一个能用的 shell。**
//!
//! # 夹具是自包含的，但**要 root**
//!
//! sshd 需要一份自己的主机密钥、配置和 authorized_keys —— 全部现生成在一个
//! 临时目录里，不碰系统上任何已有配置，也不创建系统用户。用完 `Drop` 杀进程、
//! 删目录。
//!
//! ⚠️ 但它**必须跑在 root 下**：sshd 要切换用户身份，非 root 起不来。
//! 所以这组测试在 CI 上跑不了（GitHub runner 的 `cargo test` 不是 root），
//! 和 `devtoolkit-sql` 那组一样属于「本机验证」。
//! 缺 sshd 或不是 root 时**明确报错给做法，不静默跳过** ——
//! 静默跳过等于这些测试永远不跑而没人发现。

// 整个文件都是 Unix 的：要 sshd、要 `id -u`、要改文件权限、要进程组。
// 加这个 cfg 是为了在 Windows 上**编成一个空测试二进制**而不是编译失败 ——
// 仓库要出三平台的包，Windows 上 `cargo test` 不该因为一个跑不了的测试而挂掉。
// （这类测试本来就要 root，Windows 上无论如何都跑不了。）
#![cfg(unix)]

mod common;

use std::io::Read;
use std::os::unix::process::CommandExt as _;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use base64::Engine as _;
use common::TempDir;
use devtoolkit_ssh::{OpenOutcome, SshAuth, SshConfig, SshRegistry, TerminalEvent};

const WAIT: Duration = Duration::from_secs(15);

/// 找一个能用的 sshd。找不到就按仓库的约定**明确报错**，不静默跳过
fn sshd_binary() -> String {
    if let Ok(path) = std::env::var("SSHD") {
        return path;
    }
    for candidate in ["/usr/sbin/sshd", "/usr/local/sbin/sshd"] {
        if std::path::Path::new(candidate).exists() {
            return candidate.to_string();
        }
    }
    if let Ok(output) = Command::new("sh").arg("-c").arg("command -v sshd").output() {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() {
                return path;
            }
        }
    }
    panic!(
        "找不到 sshd，这组测试需要它。\n\
         装一个：sudo apt-get install -y openssh-server\n\
         或者用 SSHD=/path/to/sshd cargo test 指定路径。\n\
         （这类测试刻意不静默跳过 —— 跳过了就没人知道它没在跑。）"
    )
}

/// 当前是不是 root。用 `id -u` 而不是 extern libc ——
/// 为一个数字引入 unsafe 不值当
fn is_root() -> bool {
    Command::new("id")
        .arg("-u")
        .output()
        .map(|out| String::from_utf8_lossy(&out.stdout).trim() == "0")
        .unwrap_or(false)
}

/// 一个跑在随机端口上的真 sshd，外加一对现生成的密钥
struct Sshd {
    child: Child,
    port: u16,
    /// 主机私钥。测试用它算期望的指纹
    host_key: russh::keys::PrivateKey,
    /// 客户端私钥的路径。已经写进 authorized_keys 了
    client_key_path: String,
    _dir: TempDir,
}

impl Sshd {
    async fn start() -> Self {
        if !is_root() {
            panic!(
                "这组测试要 root —— sshd 要切换用户身份，非 root 起不来。\n\
                 用 sudo cargo test -p devtoolkit-ssh 跑，\
                 或者只跑不需要 root 的那组：\n\
                 cargo test -p devtoolkit-ssh --test session"
            );
        }

        let binary = sshd_binary();
        let dir = TempDir::new("openssh");

        // 主机密钥和客户端密钥都**现生成** —— 仓库里不留任何写死的私钥。
        // 写死的话会被密钥扫描器报出来，还会让人犹豫它是不是真的
        let host_key = russh::keys::PrivateKey::random(
            &mut rand::thread_rng(),
            russh::keys::Algorithm::Ed25519,
        )
        .expect("生成主机密钥");
        let client_key = russh::keys::PrivateKey::random(
            &mut rand::thread_rng(),
            russh::keys::Algorithm::Ed25519,
        )
        .expect("生成客户端密钥");

        let host_key_path = dir.join("ssh_host_ed25519_key");
        std::fs::write(
            &host_key_path,
            host_key
                .to_openssh(russh::keys::ssh_key::LineEnding::LF)
                .expect("导出主机密钥"),
        )
        .expect("写主机密钥");
        // sshd 会检查主机私钥的权限，太松直接拒绝启动
        set_mode(&host_key_path, 0o600);

        let client_key_path = dir.join("client_key");
        std::fs::write(
            &client_key_path,
            client_key
                .to_openssh(russh::keys::ssh_key::LineEnding::LF)
                .expect("导出客户端私钥"),
        )
        .expect("写客户端私钥");
        set_mode(&client_key_path, 0o600);

        let authorized = dir.join("authorized_keys");
        std::fs::write(
            &authorized,
            client_key.public_key().to_openssh().expect("导出客户端公钥"),
        )
        .expect("写 authorized_keys");
        set_mode(&authorized, 0o600);

        let port = free_port();

        // 配置刻意压到最小：只要能验「连得上、有 shell」就够。
        // 密码认证关掉 —— 那个要系统用户和 PAM，会把测试变成有副作用的
        let config = format!(
            "Port {port}\n\
             ListenAddress 127.0.0.1\n\
             HostKey {host}\n\
             PidFile {pid}\n\
             AuthorizedKeysFile {authorized}\n\
             PasswordAuthentication no\n\
             KbdInteractiveAuthentication no\n\
             PubkeyAuthentication yes\n\
             PermitRootLogin prohibit-password\n\
             UsePAM no\n\
             StrictModes no\n\
             LogLevel VERBOSE\n\
             AllowUsers root\n",
            port = port,
            host = host_key_path.display(),
            pid = dir.join("sshd.pid").display(),
            authorized = authorized.display(),
        );
        let config_path = dir.join("sshd_config");
        std::fs::write(&config_path, config).expect("写 sshd 配置");

        let mut child = Command::new(&binary)
            .arg("-D") // 前台跑，不开守护进程，好收
            .arg("-e") // 日志走 stderr，起不来时能看到原因
            .arg("-f")
            .arg(&config_path)
            // 自己一个进程组：收尾时能整组杀干净，不留孤儿
            .process_group(0)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap_or_else(|e| panic!("起不了 {binary}：{e}"));

        // 等它真的开始监听。只看端口通不通不够 —— 端口通了但 sshd 可能已经在
        // 退出的路上（配置写错了），所以每轮都确认子进程还活着
        let mut ready = false;
        for _ in 0..120 {
            if let Ok(Some(status)) = child.try_wait() {
                let mut log = String::new();
                if let Some(stderr) = child.stderr.as_mut() {
                    let _ = stderr.read_to_string(&mut log);
                }
                panic!("sshd 起来就退了（{status}）。它的输出：\n{log}");
            }
            if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
                ready = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(ready, "等 sshd 监听 127.0.0.1:{port} 超时");

        Self {
            child,
            port,
            host_key,
            client_key_path: client_key_path.to_string_lossy().into_owned(),
            _dir: dir,
        }
    }

    fn fingerprint(&self) -> String {
        use russh::keys::HashAlg;
        self.host_key
            .public_key()
            .fingerprint(HashAlg::Sha256)
            .to_string()
    }

    fn config(&self) -> SshConfig {
        SshConfig {
            host: "127.0.0.1".to_string(),
            port: self.port,
            username: "root".to_string(),
            auth: SshAuth::Key {
                private_key_path: self.client_key_path.clone(),
                passphrase: String::new(),
            },
            term: "xterm-256color".to_string(),
            cols: 80,
            rows: 24,
            // 「已经信任过这台机器」—— 指纹是我们自己从主机密钥算出来的，
            // 能对上说明线上传的确实是同一把
            expected_fingerprint: Some(self.fingerprint()),
            accept_new_host_key: false,
        }
    }
}

impl Drop for Sshd {
    fn drop(&mut self) {
        // 杀整个进程组，不只杀那个 shell —— 交接文档里那段孤儿进程惨案
        // 就是只杀了外层 shell，留下一堆没人认领的子进程
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn set_mode(path: &std::path::Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode));
}

fn free_port() -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("探测空闲端口");
    listener.local_addr().expect("读端口").port()
}

/// 收输出直到出现 `needle`，或者超时
async fn read_until(events: &mut tokio::sync::mpsc::Receiver<TerminalEvent>, needle: &str) -> String {
    let mut text = String::new();
    let deadline = tokio::time::Instant::now() + WAIT;
    while !text.contains(needle) {
        match tokio::time::timeout_at(deadline, events.recv()).await {
            Ok(Some(TerminalEvent::Data { bytes })) => {
                let raw = base64::engine::general_purpose::STANDARD
                    .decode(bytes.as_bytes())
                    .expect("输出该是合法 base64");
                text.push_str(&String::from_utf8_lossy(&raw));
            }
            Ok(Some(TerminalEvent::Exit { reason, .. })) => {
                panic!("shell 提前退出了（{reason}），已收到：{text:?}")
            }
            Ok(None) => panic!("会话结束了，已收到：{text:?}"),
            Err(_) => panic!("等 {needle:?} 超时，已收到：{text:?}"),
        }
    }
    text
}

#[tokio::test]
async fn 能用私钥连上真_openssh_并跑命令() {
    let sshd = Sshd::start().await;
    let registry = SshRegistry::new();

    let opened = registry.open("s1", &sshd.config()).await.expect("连接");
    let info = match opened.outcome {
        OpenOutcome::Ready(info) => info,
        other => panic!("该连上却拿到了 {other:?}"),
    };

    // 握手上来的指纹和我们从主机密钥算的必须一致 ——
    // 不一致说明对面报的不是这把钥匙
    assert_eq!(info.fingerprint, sshd.fingerprint());
    assert!(
        info.algorithm.contains("ed25519"),
        "算法该是 ed25519，实际是 {}",
        info.algorithm
    );

    let mut events = opened.events;

    // 真的在远端跑一条命令。用一句**输出可辨认**的，
    // 免得和登录横幅或提示符里的字撞上
    registry
        .write("s1", "echo devtoolkit-真机验证\r".as_bytes())
        .await
        .expect("写");

    let text = read_until(&mut events, "devtoolkit-真机验证").await;
    assert!(
        text.contains("devtoolkit-真机验证"),
        "至少该看到一次命令的回显：{text:?}"
    );

    // 再跑一条，确认这个 shell 是**活着可交互**的，不是一次性回显
    registry.write("s1", "echo 第二条\r".as_bytes()).await.expect("写");
    let text = read_until(&mut events, "第二条").await;
    assert!(text.contains("第二条"), "shell 该还能继续用：{text:?}");

    registry.close("s1").await;
}

#[tokio::test]
async fn 真_openssh_上_pty_尺寸生效() {
    let sshd = Sshd::start().await;
    let registry = SshRegistry::new();

    let cfg = SshConfig {
        cols: 100,
        rows: 30,
        ..sshd.config()
    };
    let opened = registry.open("s1", &cfg).await.expect("连接");
    assert!(matches!(opened.outcome, OpenOutcome::Ready(_)));
    let mut events = opened.events;

    // `stty size` 直接读的就是 PTY 的尺寸，是「PTY 真的建起来了、
    // 而且尺寸是我们报的那个」最直接的证据 —— 比看提示符换行可靠得多
    registry.write("s1", "stty size\r".as_bytes()).await.expect("写");
    let text = read_until(&mut events, "30 100").await;
    assert!(
        text.contains("30 100"),
        "应输出「行 列」= 30 100，实际：{text:?}"
    );

    registry.close("s1").await;
}

#[tokio::test]
async fn 真_openssh_上退出码能带回来() {
    let sshd = Sshd::start().await;
    let registry = SshRegistry::new();

    let opened = registry.open("s1", &sshd.config()).await.expect("连接");
    assert!(matches!(opened.outcome, OpenOutcome::Ready(_)));
    let mut events = opened.events;

    // 让远端 shell 以 3 退出，客户端该拿到 3 而不是「连接断了」
    registry.write("s1", "exit 3\r".as_bytes()).await.expect("写");

    let deadline = tokio::time::Instant::now() + WAIT;
    loop {
        match tokio::time::timeout_at(deadline, events.recv()).await {
            Ok(Some(TerminalEvent::Exit { code, .. })) => {
                assert_eq!(code, Some(3), "远端 exit 3，客户端该拿到 3");
                break;
            }
            Ok(Some(TerminalEvent::Data { .. })) => continue,
            Ok(None) => panic!("事件流结束了却没给退出口"),
            Err(_) => panic!("等退出码超时"),
        }
    }
}

#[tokio::test]
async fn 指纹对不上时真_openssh_也会被拒绝() {
    let sshd = Sshd::start().await;
    let registry = SshRegistry::new();

    let cfg = SshConfig {
        // 故意换一个错的指纹，模拟「服务器换了密钥」
        expected_fingerprint: Some("SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".to_string()),
        ..sshd.config()
    };

    let opened = registry.open("s1", &cfg).await.expect("这是结论不是失败");
    match opened.outcome {
        OpenOutcome::HostKeyMismatch { actual, .. } => {
            assert_eq!(actual, sshd.fingerprint(), "要把服务器实际报的那把带出来");
        }
        other => panic!("该判成指纹变更，实际是 {other:?}"),
    }
    assert_eq!(registry.len(), 0, "被拒绝的连接不该留下会话");
}
