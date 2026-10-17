//! 一次性 exec（`exec_capture`）：远端目录浏览器的底座。
//!
//! 建连/认证/主机密钥判定走的是**和 PTY 会话同一份** `connect_authenticated`
//! —— 所以这里重点验两件事：exec 通道本身收得回输出和退出码，
//! 以及**两个信任拒绝态原样带出来**（前端复用同一套信任弹窗的那条契约）。

mod common;

use std::time::Duration;

use common::{Options, TestSshServer};
use devtoolkit_ssh::{exec_capture, ExecOutcome, SshAuth, SshConfig};

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
        accept_new_host_key: true, // 信任在测试里预置（TOFU 的判定归 session 那组）
    }
}

#[tokio::test]
async fn exec_收得到输出和退出码_服务端也记到了命令原文() {
    let server = TestSshServer::start_with(Options {
        exec_reply: Some("bin\netc\nhome\n".to_string()),
        ..Options::default()
    })
    .await;

    let outcome = exec_capture(
        &password_config(&server),
        "cd -- / && pwd && ls -ap",
        Duration::from_secs(10),
    )
    .await
    .expect("exec 该跑通");

    let ExecOutcome::Ready(out) = outcome else {
        panic!("预置信任之后不该再出信任态：{outcome:?}");
    };
    assert_eq!(out.exit_code, Some(0));
    assert_eq!(out.stdout_text(), "bin\netc\nhome\n");

    // 命令 → 原样到达服务端（拼命令的那层在 app 侧，这一层只负责搬运）
    let seen = server.seen();
    assert_eq!(seen.execs, vec!["cd -- / && pwd && ls -ap".to_string()]);
}

#[tokio::test]
async fn exec_的主机密钥未知_原样回_Unknown_态_共用信任路的证据() {
    let server = TestSshServer::start().await;

    // 没预置指纹、也不接受新钥匙 —— 第一次连就该停在「未知」
    let mut cfg = password_config(&server);
    cfg.accept_new_host_key = false;

    let outcome = exec_capture(&cfg, "pwd", Duration::from_secs(10))
        .await
        .expect("信任态是 Ok 变体，不是 Err");
    assert!(
        matches!(outcome, ExecOutcome::HostKeyUnknown(_)),
        "拿到：{outcome:?}"
    );
}

#[tokio::test]
async fn exec_认证失败给的是_Err_不是信任态() {
    let server = TestSshServer::start().await;

    let mut cfg = password_config(&server);
    cfg.auth = SshAuth::Password {
        password: "错的".to_string(),
    };

    let outcome = exec_capture(&cfg, "pwd", Duration::from_secs(10)).await;
    assert!(outcome.is_err(), "认证失败该是 Err：{outcome:?}");
}
