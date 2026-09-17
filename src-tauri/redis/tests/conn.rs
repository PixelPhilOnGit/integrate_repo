//! 连接生命周期：连、重连、断、以及各种「连不上 / 中途坏掉」。

mod common;

use std::time::{Duration, Instant};

use common::RedisServer;
use devtoolkit_redis::{ConnectionConfig, ConnectionRegistry, RedisError, Reply, CONNECT_TIMEOUT};

const ID: &str = "c1";

fn config(port: u16) -> ConnectionConfig {
    ConnectionConfig {
        host: "127.0.0.1".to_string(),
        port,
        db: 0,
        username: None,
        password: None,
    }
}

#[tokio::test]
async fn connect_reports_server_info() {
    let server = RedisServer::start();
    let registry = ConnectionRegistry::new();

    let info = registry.connect(ID, &config(server.port())).await.unwrap();

    assert_eq!(info.address, format!("127.0.0.1:{}", server.port()));
    assert_eq!(info.db, 0);
    assert!(registry.is_connected(ID).unwrap());

    // 版本来自 `INFO server`，真服务器一定有
    let version = info.version.expect("应该能从 INFO server 里解析出版本");
    assert!(
        version.starts_with('7') || version.starts_with('6') || version.starts_with('8'),
        "看起来不像个 Redis 版本号：{version:?}"
    );
}

/// 连不上的主机必须**很快**报错。这条是在守「界面不会一直转圈」。
#[tokio::test]
async fn unreachable_host_fails_within_the_connect_timeout() {
    let registry = ConnectionRegistry::new();
    let started = Instant::now();

    // 保留地址段里的一个黑洞 IP，连接会一直收不到回应直到超时
    let err = registry
        .connect(
            ID,
            &ConnectionConfig {
                host: "10.255.255.1".to_string(),
                port: 6379,
                ..config(0)
            },
        )
        .await
        .expect_err("连不上应该报错");

    let elapsed = started.elapsed();
    assert!(
        matches!(err, RedisError::Connect { .. }),
        "应该是 Connect 错误，实际是 {err:?}"
    );
    // 留 3 秒余量：真正的判据是「受超时约束」，不是精确到毫秒
    assert!(
        elapsed < CONNECT_TIMEOUT + Duration::from_secs(3),
        "应该在建连超时附近返回，实际花了 {elapsed:?}"
    );
}

#[tokio::test]
async fn connection_refused_is_reported_as_connect_error() {
    let registry = ConnectionRegistry::new();
    // 1 号端口上不会有人监听
    let err = registry
        .connect(ID, &ConnectionConfig { port: 1, ..config(1) })
        .await
        .expect_err("应该连不上");

    assert!(
        matches!(err, RedisError::Connect { .. }),
        "应该是 Connect 错误，实际是 {err:?}"
    );
    let text = err.to_string();
    assert!(text.contains("连接 Redis"), "错误文案应该是给用户看的中文：{text}");
    assert!(!registry.is_connected(ID).unwrap(), "连失败了就不该留下活动连接");
}

/// 同一个 id 再连一次 = 替换，不是叠加。这是「前端刷新后 Rust 还挂着旧连接」的兜底。
#[tokio::test]
async fn reconnecting_the_same_id_replaces_the_connection() {
    let server = RedisServer::start();
    let registry = ConnectionRegistry::new();

    registry.connect(ID, &config(server.port())).await.unwrap();
    registry.exec(ID, &[c("SET"), c("k"), c("v")]).await.unwrap();

    // 再连一次，数据还在（同一个 server、同一个 db），说明是替换不是新建另一个 id
    registry.connect(ID, &config(server.port())).await.unwrap();
    assert_eq!(
        registry.exec(ID, &[c("GET"), c("k")]).await.unwrap(),
        Reply::Bulk { text: "v".to_string(), binary: false, bytes: 1 }
    );
}

#[tokio::test]
async fn exec_without_a_connection_is_not_connected() {
    let registry = ConnectionRegistry::new();

    let err = registry
        .exec("never-connected", &[c("PING")])
        .await
        .expect_err("没连过就不该能执行");

    assert!(
        matches!(err, RedisError::NotConnected { .. }),
        "应该是 NotConnected，实际是 {err:?}"
    );
    assert!(err.to_string().contains("不在活动状态"), "文案不对：{err}");
}

#[tokio::test]
async fn disconnect_forgets_the_connection() {
    let server = RedisServer::start();
    let registry = ConnectionRegistry::new();

    registry.connect(ID, &config(server.port())).await.unwrap();
    assert!(registry.disconnect(ID).unwrap(), "第一次断开应该真的有连接被断掉");
    assert!(!registry.is_connected(ID).unwrap());
    // 再断一次是幂等的，不该炸
    assert!(!registry.disconnect(ID).unwrap());

    let err = registry.exec(ID, &[c("PING")]).await.expect_err("断开之后不能再执行");
    assert!(matches!(err, RedisError::NotConnected { .. }), "实际是 {err:?}");
}

/// 连接在使用中坏掉：必须是 Err（传输层失败），而且注册表要**忘掉**它 ——
/// 否则前端会一直显示「已连接」，而每条命令都失败。
#[tokio::test]
async fn server_dying_mid_session_is_a_transport_error() {
    let mut server = RedisServer::start();
    let registry = ConnectionRegistry::new();

    registry.connect(ID, &config(server.port())).await.unwrap();
    registry.exec(ID, &[c("PING")]).await.unwrap();

    server.kill();

    let err = registry
        .exec(ID, &[c("PING")])
        .await
        .expect_err("服务没了，命令必须失败");

    assert!(
        matches!(err, RedisError::Transport { .. }),
        "应该是 Transport 错误，实际是 {err:?}"
    );
    assert!(
        !registry.is_connected(ID).unwrap(),
        "传输失败之后必须把这条连接从注册表里摘掉，否则界面会一直显示「已连接」"
    );
}

/// 服务端要密码时，空密码必须**在建连阶段**就失败，
/// 而不是让用户对着一条 NOAUTH 的连接敲命令。
#[tokio::test]
async fn missing_password_fails_at_connect_time() {
    let server = RedisServer::start_with(&["--requirepass", "s3cret"]);
    let registry = ConnectionRegistry::new();

    let err = registry
        .connect(ID, &config(server.port()))
        .await
        .expect_err("服务端要密码，没给密码不该连上");

    assert!(
        matches!(err, RedisError::Connect { .. }),
        "应该是 Connect 错误，实际是 {err:?}"
    );
    assert!(
        err.to_string().contains("NOAUTH") || err.to_string().contains("Authentication"),
        "错误里应该带着服务端的原话，实际是 {err}"
    );
    assert!(!registry.is_connected(ID).unwrap());
}

#[tokio::test]
async fn correct_password_connects() {
    let server = RedisServer::start_with(&["--requirepass", "s3cret"]);
    let registry = ConnectionRegistry::new();

    let cfg = ConnectionConfig {
        password: Some("s3cret".to_string()),
        ..config(server.port())
    };
    registry.connect(ID, &cfg).await.expect("给了正确密码应该能连上");

    assert_eq!(
        registry.exec(ID, &[c("PING")]).await.unwrap(),
        Reply::Status { text: "PONG".to_string() }
    );
}

/// 空串密码必须当成「没给」，否则驱动会发出一条 `AUTH ""`。
#[tokio::test]
async fn blank_password_is_treated_as_absent() {
    let server = RedisServer::start_with(&["--requirepass", "s3cret"]);
    let registry = ConnectionRegistry::new();

    let cfg = ConnectionConfig {
        password: Some(String::new()),
        ..config(server.port())
    };
    let err = registry
        .connect(ID, &cfg)
        .await
        .expect_err("空串密码 == 没给密码，服务端要密码就该连不上");

    assert!(matches!(err, RedisError::Connect { .. }), "实际是 {err:?}");
}

fn c(s: &str) -> String {
    s.to_string()
}
