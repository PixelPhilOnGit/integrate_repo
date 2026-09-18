//! 会话表：替换、摘除时的身份校验、批量收尾、事件转发。
//!
//! 这一层看着薄，但有两个地方出错会**很难查**：
//! 一是同 id 重开时旧会话没收干净（远端挂着看不见的登录），
//! 二是读循环收尾时把同 id 的**新**会话摘掉了（终端还在但敲什么都没反应）。

mod common;

use std::time::Duration;

use common::{Options, TestSshServer};
use devtoolkit_ssh::{forward, OpenOutcome, SshAuth, SshConfig, SshRegistry, TerminalEvent};

const WAIT: Duration = Duration::from_secs(5);

fn config(server: &TestSshServer) -> SshConfig {
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
        accept_new_host_key: true,
    }
}

async fn open(registry: &SshRegistry, id: &str, server: &TestSshServer) -> u64 {
    let opened = registry.open(id, &config(server)).await.expect("连接");
    assert!(
        matches!(opened.outcome, OpenOutcome::Ready(_)),
        "该连上却拿到了 {:?}",
        opened.outcome
    );
    opened.generation
}

#[tokio::test]
async fn 同一个_id_再开一次是替换不是并存() {
    let server = TestSshServer::start().await;
    let registry = SshRegistry::new();

    let first = open(&registry, "s1", &server).await;
    assert_eq!(registry.len(), 1);

    let second = open(&registry, "s1", &server).await;

    assert_eq!(registry.len(), 1, "同 id 重开不该变成两个会话");
    assert_ne!(first, second, "两次的会话代次必须不同");
}

/// ⚠️ 这条盯的是「读循环收尾时误摘新会话」那个 ABA 问题。
///
/// 真实触发路径：TOFU 弹窗里用户点了信任，前端用**同一个 id** 重新 `ssh_open`，
/// 而旧会话的读循环恰好在这时结束并去摘自己 —— 不校验代次的话，
/// 它摘掉的是刚建好的新会话。表现是：终端看着好好的，但敲什么都没反应，
/// 而且这个会话再也关不掉了（表里已经没有它）。
#[tokio::test]
async fn 过期的代次不能摘掉同_id_的新会话() {
    let server = TestSshServer::start().await;
    let registry = SshRegistry::new();

    let stale = open(&registry, "s1", &server).await;
    let current = open(&registry, "s1", &server).await;

    // 旧会话的读循环姗姗来迟，拿着自己那个已经过期的代次来摘
    registry.forget("s1", stale);

    assert_eq!(
        registry.len(),
        1,
        "过期代次的 forget 把新会话摘掉了 —— 终端会变成「看着在、敲不动」"
    );

    // 而且新会话确实还能用
    registry.write("s1", b"x").await.expect("新会话该还能写");

    // 自己来摘就摘得掉
    registry.forget("s1", current);
    assert_eq!(registry.len(), 0);
}

#[tokio::test]
async fn 关闭全部会把表清干净() {
    let server = TestSshServer::start().await;
    let registry = SshRegistry::new();

    open(&registry, "s1", &server).await;
    open(&registry, "s2", &server).await;
    open(&registry, "s3", &server).await;
    assert_eq!(registry.len(), 3);

    registry.close_all().await;
    assert_eq!(registry.len(), 0);

    // 关过之后写会明确报「没连着」，而不是静默丢弃
    assert!(registry.write("s1", b"x").await.is_err());
}

/// 分页是各自独立的连接：一条断了不影响另一条。
/// 这是多标签设计的主要理由之一，值得钉住。
#[tokio::test]
async fn 关掉一个会话不影响另一个() {
    let server = TestSshServer::start().await;
    let registry = SshRegistry::new();

    open(&registry, "s1", &server).await;
    open(&registry, "s2", &server).await;

    registry.close("s1").await;

    assert_eq!(registry.len(), 1);
    registry.write("s2", b"still here").await.expect("s2 该还活着");
}

#[tokio::test]
async fn 转发会把事件原样交出去并返回退出码() {
    let server = TestSshServer::start().await;
    let registry = SshRegistry::new();

    let opened = registry.open("s1", &config(&server)).await.expect("连接");
    let events = opened.events;

    registry.write("s1", b"exit\r").await.expect("写");

    let mut seen: Vec<TerminalEvent> = Vec::new();
    let code = tokio::time::timeout(
        WAIT,
        forward(events, |event| {
            seen.push(event);
        }),
    )
    .await
    .expect("转发该在退出时收工");

    assert_eq!(code, Some(7), "夹具回的退出码是 7");
    assert!(
        matches!(seen.last(), Some(TerminalEvent::Exit { .. })),
        "最后一条该是 Exit"
    );
    assert!(
        seen.iter().any(|e| matches!(e, TerminalEvent::Data { .. })),
        "中间该有输出"
    );
}

/// 转发要能处理「前端已经没人听了」的情况：sink 收到 Exit 就收工，
/// 不会因为接收端没了而挂住。
#[tokio::test]
async fn 没有输出时转发也会在会话结束时收工() {
    let server = TestSshServer::start_with(Options::default().silent()).await;
    let registry = SshRegistry::new();

    let opened = registry.open("s1", &config(&server)).await.expect("连接");
    let events = opened.events;

    registry.close("s1").await;

    // 关掉之后事件流会结束（要么来一条 Exit，要么直接关闭）
    let code = tokio::time::timeout(WAIT, forward(events, |_| {})).await;
    assert!(code.is_ok(), "转发该收工，而不是一直挂着");
}
