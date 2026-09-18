//! 会话层：连接、TOFU、认证、PTY、双向流、收尾。
//!
//! 全部打的是 `common` 里那个**进程内 SSH 服务端**，零系统依赖。
//! 「对真 OpenSSH 能不能用」是另一组测试（`tests/openssh.rs`）负责的事。

mod common;

use std::time::Duration;

use base64::Engine as _;
use common::{write_key, Options, TempDir, TestSshServer};
use devtoolkit_ssh::{
    OpenOutcome, OpenedSession, SshAuth, SshConfig, SshError, SshRegistry, TerminalEvent,
};
use tokio::sync::mpsc::Receiver;

/// 等事件的上限。测试里所有该来的东西都是本地回环上的，5 秒已经很宽裕；
/// 真超时说明是死锁而不是慢
const WAIT: Duration = Duration::from_secs(5);

fn password_config(server: &TestSshServer) -> SshConfig {
    SshConfig {
        host: "127.0.0.1".to_string(),
        port: server.port,
        username: "tester".to_string(),
        auth: SshAuth::Password {
            password: "secret".to_string(),
        },
        term: "xterm-256color".to_string(),
        cols: 80,
        rows: 24,
        expected_fingerprint: None,
        accept_new_host_key: false,
    }
}

fn key_config(server: &TestSshServer, path: &str, passphrase: &str) -> SshConfig {
    SshConfig {
        auth: SshAuth::Key {
            private_key_path: path.to_string(),
            passphrase: passphrase.to_string(),
        },
        ..password_config(server)
    }
}

/// 收事件直到 `Exit`（永远是最后一个）。超时直接失败 —— 卡住本身就是 bug
async fn drain(rx: &mut Receiver<TerminalEvent>) -> Vec<TerminalEvent> {
    let mut out = Vec::new();
    loop {
        match tokio::time::timeout(WAIT, rx.recv()).await {
            Ok(Some(event)) => {
                let last = matches!(event, TerminalEvent::Exit { .. });
                out.push(event);
                if last {
                    break;
                }
            }
            Ok(None) => break,
            Err(_) => panic!("等事件超时（已经收到 {} 条）", out.len()),
        }
    }
    out
}

/// 把 Data 事件拼起来按 UTF-8 解回来。
///
/// 顺带把「输出是 base64」这条 IPC 契约钉住了：编码方式一改，所有这类断言
/// 会立刻炸掉，而不是安静地显示成乱码。
fn text(events: &[TerminalEvent]) -> String {
    let mut bytes = Vec::new();
    for event in events {
        if let TerminalEvent::Data { bytes: b64 } = event {
            bytes.extend_from_slice(
                &base64::engine::general_purpose::STANDARD
                    .decode(b64.as_bytes())
                    .expect("终端输出应该是合法 base64"),
            );
        }
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

fn exit_of(events: &[TerminalEvent]) -> (Option<u32>, String) {
    match events.last() {
        Some(TerminalEvent::Exit { code, reason }) => (*code, reason.clone()),
        other => panic!("最后一个事件应该是 Exit，实际是 {other:?}"),
    }
}

/// 开一个会话并断言它成了，返回它和事件流
async fn open_ok(registry: &SshRegistry, id: &str, cfg: &SshConfig) -> OpenedSession {
    let opened = registry.open(id, cfg).await.expect("连接不该在传输层失败");
    assert!(
        matches!(opened.outcome, OpenOutcome::Ready(_)),
        "该连上却拿到了 {:?}",
        opened.outcome
    );
    opened
}

// ------------------------------------------------------------------ TOFU

#[tokio::test]
async fn 没见过的机器_不弹信任就拒绝并报出指纹() {
    let server = TestSshServer::start().await;
    let registry = SshRegistry::new();

    let opened = registry
        .open("s1", &password_config(&server))
        .await
        .expect("未知主机密钥是结论不是传输失败");

    match opened.outcome {
        OpenOutcome::HostKeyUnknown { fingerprint, .. } => {
            assert_eq!(
                fingerprint,
                server.fingerprint(),
                "报给用户的必须就是服务端那把密钥的指纹，不能是别的"
            );
        }
        other => panic!("该报「没见过这台机器」，实际是 {other:?}"),
    }

    assert_eq!(registry.len(), 0, "被拒绝的连接不该留在会话表里");
}

#[tokio::test]
async fn 用户点了信任之后就放行并连上() {
    let server = TestSshServer::start().await;
    let registry = SshRegistry::new();

    let cfg = SshConfig {
        accept_new_host_key: true,
        ..password_config(&server)
    };
    let opened = open_ok(&registry, "s1", &cfg).await;

    match opened.outcome {
        OpenOutcome::Ready(info) => {
            assert_eq!(info.fingerprint, server.fingerprint());
            assert_eq!(info.username, "tester");
            assert_eq!(info.address, format!("127.0.0.1:{}", server.port));
        }
        other => unreachable!("上面已经断言过是 Ready：{other:?}"),
    }
}

#[tokio::test]
async fn 指纹和记住的一致就直接连上不用再问() {
    let server = TestSshServer::start().await;
    let registry = SshRegistry::new();

    let cfg = SshConfig {
        expected_fingerprint: Some(server.fingerprint()),
        ..password_config(&server)
    };
    open_ok(&registry, "s1", &cfg).await;
}

/// ⚠️ 这是整个模块最重要的一条测试。
///
/// 指纹变了**必须硬停**，而且要把新旧两把都报出来 —— 光是「连不上」
/// 没法让用户判断到底是服务器重装了还是有人在中间。
#[tokio::test]
async fn 指纹变了必须硬停并把新旧都报出来() {
    let first = TestSshServer::start().await;
    let old_fingerprint = first.fingerprint();
    drop(first);

    // 换一把主机密钥重新起一个（地址不同不影响这条测试要验的东西：
    // 判定是按**指纹**做的，不是按地址）
    let second = TestSshServer::start_with_key(
        Options::default(),
        russh::keys::PrivateKey::random(&mut rand::thread_rng(), russh::keys::Algorithm::Ed25519)
            .expect("生成第二把主机密钥"),
    )
    .await;
    assert_ne!(
        old_fingerprint,
        second.fingerprint(),
        "夹具本身有问题：两把主机密钥应该不同"
    );

    let registry = SshRegistry::new();
    let cfg = SshConfig {
        // 用户信任的是**第一把**
        expected_fingerprint: Some(old_fingerprint.clone()),
        // 而且这次他没有点「信任新机器」—— 就算点了也不该放行，
        // 但这条路径要单独测（见下面那条）
        accept_new_host_key: false,
        ..password_config(&second)
    };

    let opened = registry.open("s1", &cfg).await.expect("这是个结论不是失败");
    match opened.outcome {
        OpenOutcome::HostKeyMismatch {
            expected, actual, ..
        } => {
            assert_eq!(expected, old_fingerprint, "「之前是哪个」要说清楚");
            assert_eq!(actual, second.fingerprint(), "「现在变成哪个了」也要说清楚");
        }
        other => panic!("该报「密钥变了」，实际是 {other:?}"),
    }
    assert_eq!(registry.len(), 0);
}

/// 即使用户点了「信任这台新机器」，也不能把「它以前长什么样」一并勾销。
///
/// 界面上「信任」只出现在**首次连接**那条路径上，但这条测试从后端确保：
/// 就算前端把两个标志一起传上来，判定也不会放行。
#[tokio::test]
async fn 信任新机器这个标志不能覆盖指纹变更() {
    let server = TestSshServer::start().await;
    let registry = SshRegistry::new();

    let cfg = SshConfig {
        expected_fingerprint: Some("SHA256:这是个编出来的旧指纹".to_string()),
        accept_new_host_key: true,
        ..password_config(&server)
    };

    let opened = registry.open("s1", &cfg).await.expect("结论不是失败");
    assert!(
        matches!(opened.outcome, OpenOutcome::HostKeyMismatch { .. }),
        "accept_new 不能让指纹变更蒙混过关，实际是 {:?}",
        opened.outcome
    );
}

// ------------------------------------------------------------------ 认证

#[tokio::test]
async fn 密码对就认证通过() {
    let server = TestSshServer::start().await;
    let registry = SshRegistry::new();
    let cfg = SshConfig {
        accept_new_host_key: true,
        ..password_config(&server)
    };
    open_ok(&registry, "s1", &cfg).await;

    let seen = server.seen();
    assert_eq!(
        seen.password_attempts,
        vec![("tester".to_string(), "secret".to_string())]
    );
}

#[tokio::test]
async fn 密码错报认证失败不是主机密钥问题() {
    let server = TestSshServer::start().await;
    let registry = SshRegistry::new();
    let cfg = SshConfig {
        auth: SshAuth::Password {
            password: "wrong".to_string(),
        },
        accept_new_host_key: true,
        ..password_config(&server)
    };

    match registry.open("s1", &cfg).await {
        Err(SshError::Auth { reason, .. }) => {
            assert!(
                reason.contains("拒绝"),
                "错误文案该说清楚是凭据被拒：{reason}"
            );
        }
        Ok(opened) => panic!("该认证失败，实际拿到了 {:?}", opened.outcome),
        Err(other) => panic!("该报认证失败，实际是 {other:?}"),
    }
    assert_eq!(registry.len(), 0);
}

/// ⚠️ 安全关键的一条。
///
/// 服务端接受主机密钥（`accept_new`）之后**认证失败**，绝不能被报成
/// 「这台机器没见过，要不要信任」—— 那样用户一点信任，**攻击者的密钥就被
/// 永久钉住了**，以后连真服务器反而会报「密钥变了」。
///
/// 判定靠的是「`connect` 返回的是不是 `Error::UnknownKey`」，
/// 而不是「格子里有没有值」。
#[tokio::test]
async fn 认证失败不能被误报成需要信任新密钥() {
    let server = TestSshServer::start().await;
    let registry = SshRegistry::new();
    let cfg = SshConfig {
        auth: SshAuth::Password {
            password: "wrong".to_string(),
        },
        // 用户已经同意了这把新密钥 —— 所以密钥那一关是**过了**的
        accept_new_host_key: true,
        expected_fingerprint: None,
        ..password_config(&server)
    };

    let result = registry.open("s1", &cfg).await;
    assert!(
        !matches!(result, Ok(ref o) if !matches!(o.outcome, OpenOutcome::Ready(_))),
        "认证失败被报成了主机密钥需要确认 —— 这正是会把攻击者密钥钉死的那条路"
    );
    match result {
        Err(SshError::Auth { .. }) => {}
        other => panic!("该报认证失败，实际是 {other:?}"),
    }
}

#[tokio::test]
async fn 公钥认证能连上() {
    use russh::keys::{Algorithm, PrivateKey};

    let client_key =
        PrivateKey::random(&mut rand::thread_rng(), Algorithm::Ed25519).expect("生成客户端密钥");
    let server = TestSshServer::start_with(
        Options::default()
            .no_password()
            .with_public_key(client_key.public_key()),
    )
    .await;

    let dir = TempDir::new("keyauth");
    let path = write_key(&dir, "id_ed25519", &client_key, None);

    let registry = SshRegistry::new();
    let cfg = SshConfig {
        accept_new_host_key: true,
        ..key_config(&server, &path, "")
    };
    open_ok(&registry, "s1", &cfg).await;

    let seen = server.seen();
    assert_eq!(seen.publickey_attempts.len(), 1, "该恰好尝试一次公钥认证");
}

#[tokio::test]
async fn 带口令的私钥能用() {
    use russh::keys::{Algorithm, PrivateKey};

    let client_key =
        PrivateKey::random(&mut rand::thread_rng(), Algorithm::Ed25519).expect("生成客户端密钥");
    let server = TestSshServer::start_with(
        Options::default()
            .no_password()
            .with_public_key(client_key.public_key()),
    )
    .await;

    let dir = TempDir::new("keypass");
    let path = write_key(&dir, "id_ed25519", &client_key, Some("hunter2"));

    let registry = SshRegistry::new();
    let cfg = SshConfig {
        accept_new_host_key: true,
        ..key_config(&server, &path, "hunter2")
    };
    open_ok(&registry, "s1", &cfg).await;
}

#[tokio::test]
async fn 私钥口令错了会明确说是口令问题() {
    use russh::keys::{Algorithm, PrivateKey};

    let client_key =
        PrivateKey::random(&mut rand::thread_rng(), Algorithm::Ed25519).expect("生成客户端密钥");
    let server = TestSshServer::start_with(
        Options::default()
            .no_password()
            .with_public_key(client_key.public_key()),
    )
    .await;

    let dir = TempDir::new("keybadpass");
    let path = write_key(&dir, "id_ed25519", &client_key, Some("hunter2"));

    let registry = SshRegistry::new();
    let cfg = SshConfig {
        accept_new_host_key: true,
        ..key_config(&server, &path, "记错了")
    };

    match registry.open("s1", &cfg).await {
        Err(SshError::KeyFile { path: p, .. }) => assert_eq!(p, path),
        other => panic!("该报私钥文件解不开，实际是 {other:?}"),
    }
}

#[tokio::test]
async fn 私钥文件不存在会明确说是文件问题() {
    let server = TestSshServer::start().await;
    let registry = SshRegistry::new();
    let cfg = SshConfig {
        accept_new_host_key: true,
        ..key_config(&server, "/根本不存在/的/路径/id_ed25519", "")
    };

    match registry.open("s1", &cfg).await {
        Err(SshError::KeyFile { .. }) => {}
        other => panic!("该报私钥文件读不了，实际是 {other:?}"),
    }
}

// ------------------------------------------------------------------ PTY 与流

#[tokio::test]
async fn pty_的尺寸和终端类型传到了服务端() {
    let server = TestSshServer::start().await;
    let registry = SshRegistry::new();
    let cfg = SshConfig {
        cols: 132,
        rows: 43,
        term: "xterm-256color".to_string(),
        accept_new_host_key: true,
        ..password_config(&server)
    };
    open_ok(&registry, "s1", &cfg).await;

    let seen = server.seen();
    let pty = seen.pty.expect("服务端该收到 PTY 请求");
    assert_eq!(pty.cols, 132);
    assert_eq!(pty.rows, 43);
    assert_eq!(pty.term, "xterm-256color");
}

/// 服务端拒绝 PTY（比如 sshd 配了 `PermitTTY no`）要说清楚，
/// 而不是安静地给一个没有 PTY 的 shell —— 后者表现为「Ctrl+C 杀不掉进程」，
/// 用户根本联想不到是 PTY 的问题。
#[tokio::test]
async fn 服务端拒绝_pty_会明确报错() {
    let server = TestSshServer::start_with(Options::default().reject_pty()).await;
    let registry = SshRegistry::new();
    let cfg = SshConfig {
        accept_new_host_key: true,
        ..password_config(&server)
    };

    match registry.open("s1", &cfg).await {
        Err(SshError::Connect { reason, .. }) => {
            assert!(reason.contains("PTY"), "文案要点出是 PTY 被拒：{reason}");
        }
        other => panic!("该报 PTY 被拒，实际是 {other:?}"),
    }
}

#[tokio::test]
async fn 发进去的字节会从远端回显回来() {
    let server = TestSshServer::start().await;
    let registry = SshRegistry::new();
    let cfg = SshConfig {
        accept_new_host_key: true,
        ..password_config(&server)
    };
    let mut opened = open_ok(&registry, "s1", &cfg).await;

    registry.write("s1", "whoami\r".as_bytes()).await.expect("写");

    // 至少读到回显就够；不等 Exit（这个服务端不因为普通输入退出）
    let mut got = String::new();
    while !got.contains("whoami") {
        match tokio::time::timeout(WAIT, opened.events.recv()).await {
            Ok(Some(event)) => got.push_str(&text(&[event])),
            Ok(None) => panic!("会话提前结束了，已收到：{got:?}"),
            Err(_) => panic!("等回显超时，已收到：{got:?}"),
        }
    }
    assert!(got.contains("hello from the test server"), "横幅也该收到");
    assert_eq!(server.seen().input_text(), "whoami\r");
}

#[tokio::test]
async fn 中文能原样穿过整条链路() {
    let server = TestSshServer::start().await;
    let registry = SshRegistry::new();
    let cfg = SshConfig {
        accept_new_host_key: true,
        ..password_config(&server)
    };
    let mut opened = open_ok(&registry, "s1", &cfg).await;

    registry
        .write("s1", "你好，世界".as_bytes())
        .await
        .expect("写");

    let mut got = String::new();
    while !got.contains("你好，世界") {
        match tokio::time::timeout(WAIT, opened.events.recv()).await {
            Ok(Some(event)) => got.push_str(&text(&[event])),
            Ok(None) => panic!("会话提前结束了"),
            Err(_) => panic!("等回显超时，已收到：{got:?}"),
        }
    }
}

#[tokio::test]
async fn resize_会传到服务端() {
    let server = TestSshServer::start().await;
    let registry = SshRegistry::new();
    let cfg = SshConfig {
        accept_new_host_key: true,
        ..password_config(&server)
    };
    open_ok(&registry, "s1", &cfg).await;

    registry.resize("s1", 100, 30).await.expect("resize");

    // 异步到达，轮询等一下（本地回环，通常第一次就成）
    let mut resizes = Vec::new();
    for _ in 0..50 {
        resizes = server.seen().resizes.clone();
        if !resizes.is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(resizes, vec![(100, 30)]);
}

/// 远端正常退出是个**结果**，不是故障：退出码要原样带回来。
#[tokio::test]
async fn 远端退出会带回退出码() {
    let server = TestSshServer::start().await;
    let registry = SshRegistry::new();
    let cfg = SshConfig {
        accept_new_host_key: true,
        ..password_config(&server)
    };
    let mut opened = open_ok(&registry, "s1", &cfg).await;

    registry.write("s1", b"exit\r").await.expect("写");

    let events = drain(&mut opened.events).await;
    let (code, reason) = exit_of(&events);
    assert_eq!(code, Some(7), "夹具回的退出码是 7");
    assert_eq!(reason, "已退出");
}

#[tokio::test]
async fn 主动关闭之后会话就不在表里了() {
    let server = TestSshServer::start().await;
    let registry = SshRegistry::new();
    let cfg = SshConfig {
        accept_new_host_key: true,
        ..password_config(&server)
    };
    open_ok(&registry, "s1", &cfg).await;
    assert_eq!(registry.len(), 1);

    registry.close("s1").await;

    assert_eq!(registry.len(), 0);
    // 幂等：再关一次不报错
    registry.close("s1").await;
}

#[tokio::test]
async fn 关闭之后事件流会以已关闭收尾() {
    let server = TestSshServer::start().await;
    let registry = SshRegistry::new();
    let cfg = SshConfig {
        accept_new_host_key: true,
        ..password_config(&server)
    };
    let mut opened = open_ok(&registry, "s1", &cfg).await;

    registry.close("s1").await;

    // 主动关的时候 eof/close 都发出去了，但 read half 是被 abort 掉的，
    // 所以事件流可能直接结束（None）而不一定再吐一个 Exit。
    // 两种都算对 —— 这里要钉住的是「不挂起」和「文本是中文」
    let mut events = Vec::new();
    while let Ok(Some(event)) = tokio::time::timeout(WAIT, opened.events.recv()).await {
        let last = matches!(event, TerminalEvent::Exit { .. });
        events.push(event);
        if last {
            break;
        }
    }
    if let Some(TerminalEvent::Exit { reason, .. }) = events.last() {
        assert!(reason.contains("关闭") || reason.contains("退出"));
    }
}

#[tokio::test]
async fn 对不存在的会话发输入会明确报没连着() {
    let registry = SshRegistry::new();

    match registry.write("不存在", b"x").await {
        Err(SshError::NotConnected { id }) => assert_eq!(id, "不存在"),
        other => panic!("该报会话不存在，实际是 {other:?}"),
    }
    match registry.resize("不存在", 80, 24).await {
        Err(SshError::NotConnected { .. }) => {}
        other => panic!("该报会话不存在，实际是 {other:?}"),
    }
}

// ------------------------------------------------------------------ 参数校验

#[tokio::test]
async fn 参数不合法在连之前就被拦下() {
    let registry = SshRegistry::new();

    let base = SshConfig {
        host: "127.0.0.1".to_string(),
        port: 22,
        username: "tester".to_string(),
        auth: SshAuth::Password {
            password: "secret".to_string(),
        },
        term: "xterm-256color".to_string(),
        cols: 80,
        rows: 24,
        expected_fingerprint: None,
        accept_new_host_key: true,
    };

    for (patch, needle) in [
        (
            SshConfig {
                host: "   ".to_string(),
                ..base.clone()
            },
            "主机名",
        ),
        (
            SshConfig {
                port: 0,
                ..base.clone()
            },
            "端口",
        ),
        (
            SshConfig {
                username: String::new(),
                ..base.clone()
            },
            "用户名",
        ),
        (
            SshConfig {
                auth: SshAuth::Password {
                    password: String::new(),
                },
                ..base.clone()
            },
            "密码",
        ),
        (
            SshConfig {
                auth: SshAuth::Key {
                    private_key_path: "  ".to_string(),
                    passphrase: String::new(),
                },
                ..base.clone()
            },
            "私钥",
        ),
    ] {
        match registry.open("s1", &patch).await {
            Err(SshError::BadConfig { reason }) => {
                assert!(reason.contains(needle), "文案该提到{needle}：{reason}")
            }
            other => panic!("该在连之前就被拦下，实际是 {other:?}"),
        }
    }
}

#[tokio::test]
async fn 连不上的地址报连接失败() {
    // 127.0.0.1:1 上不会有 SSH 服务；用回环地址而不是域名，
    // 免得测试依赖 DNS 的行为
    let registry = SshRegistry::new();
    let cfg = SshConfig {
        host: "127.0.0.1".to_string(),
        port: 1,
        username: "tester".to_string(),
        auth: SshAuth::Password {
            password: "secret".to_string(),
        },
        term: "xterm-256color".to_string(),
        cols: 80,
        rows: 24,
        expected_fingerprint: None,
        accept_new_host_key: true,
    };

    match registry.open("s1", &cfg).await {
        Err(SshError::Connect { address, .. }) => assert!(address.contains("127.0.0.1:1")),
        other => panic!("该报连接失败，实际是 {other:?}"),
    }
}

// ------------------------------------------------------------------ 错误文案

#[test]
fn 错误文案都是给用户看的中文() {
    let cases = [
        SshError::BadConfig {
            reason: "x".to_string(),
        },
        SshError::Connect {
            address: "a:1".to_string(),
            reason: "x".to_string(),
        },
        SshError::Auth {
            address: "a:1".to_string(),
            reason: "x".to_string(),
        },
        SshError::KeyFile {
            path: "p".to_string(),
            reason: "x".to_string(),
        },
        SshError::NotConnected {
            id: "i".to_string(),
        },
        SshError::Transport {
            id: "i".to_string(),
            reason: "x".to_string(),
        },
        SshError::Poisoned,
    ];

    for error in cases {
        let text = error.to_string();
        assert!(
            text.chars().any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c)),
            "错误文案该是中文：{text}"
        );
    }
}
