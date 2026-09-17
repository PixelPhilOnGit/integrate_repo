//! 命令执行：拿真 Redis 打。
//!
//! 这里每条测试都自己起一个 `redis-server`（见 `common`），随机端口、不落盘。

mod common;

use common::RedisServer;
use devtoolkit_redis::{ConnectionConfig, ConnectionRegistry, Reply};

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

/// 起服务 + 连上，返回 (服务, 注册表)。服务要一直活着，所以交回给调用方。
async fn connected() -> (RedisServer, ConnectionRegistry) {
    let server = RedisServer::start();
    let registry = ConnectionRegistry::new();
    registry
        .connect(ID, &config(server.port()))
        .await
        .expect("应该能连上刚起的 redis-server");
    (server, registry)
}

fn exec_args(args: &[&str]) -> Vec<String> {
    args.iter().map(|s| s.to_string()).collect()
}

#[tokio::test]
async fn ping_comes_back_as_a_status_reply() {
    let (_server, registry) = connected().await;
    let reply = registry.exec(ID, &exec_args(&["PING"])).await.unwrap();
    assert_eq!(reply, Reply::Status { text: "PONG".to_string() });
}

#[tokio::test]
async fn set_get_del_roundtrip() {
    let (_server, registry) = connected().await;

    assert_eq!(
        registry.exec(ID, &exec_args(&["SET", "k", "v"])).await.unwrap(),
        Reply::Status { text: "OK".to_string() }
    );
    assert_eq!(
        registry.exec(ID, &exec_args(&["GET", "k"])).await.unwrap(),
        Reply::Bulk { text: "v".to_string(), binary: false, bytes: 1 }
    );
    // 不存在的 key → nil
    assert_eq!(
        registry.exec(ID, &exec_args(&["GET", "nope"])).await.unwrap(),
        Reply::Nil
    );
    assert_eq!(
        registry.exec(ID, &exec_args(&["DEL", "k"])).await.unwrap(),
        Reply::Integer { value: 1 }
    );
}

/// 这条是 crate 的核心语义守门测试。
///
/// 服务器说 `-ERR unknown command` 的时候，命令**执行完了**，只是结果是个错误。
/// 它必须是 `Ok(Reply::Error)` —— 如果这里变成 `Err`，前端就会在外壳顶部弹红色
/// 错误条，而用户只是在命令台里敲错了一个命令。
///
/// 同时验证连接没被这次错误弄坏：后面还能继续用。
#[tokio::test]
async fn unknown_command_is_a_reply_not_a_failure() {
    let (_server, registry) = connected().await;

    let reply = registry
        .exec(ID, &exec_args(&["THIS_IS_NOT_A_COMMAND"]))
        .await
        .expect("服务器报错不该让 exec 返回 Err");

    let Reply::Error { message } = &reply else {
        panic!("期望是 Reply::Error，实际是 {reply:?}");
    };
    assert!(
        message.contains("unknown command"),
        "错误文案应该来自服务器，实际是 {message:?}"
    );

    // 连接仍然可用
    assert_eq!(
        registry.exec(ID, &exec_args(&["PING"])).await.unwrap(),
        Reply::Status { text: "PONG".to_string() },
        "一次命令错误之后连接必须还能用"
    );
}

#[tokio::test]
async fn integer_replies() {
    let (_server, registry) = connected().await;

    assert_eq!(
        registry.exec(ID, &exec_args(&["INCR", "n"])).await.unwrap(),
        Reply::Integer { value: 1 }
    );
    assert_eq!(
        registry.exec(ID, &exec_args(&["INCR", "n"])).await.unwrap(),
        Reply::Integer { value: 2 }
    );
    assert_eq!(
        registry.exec(ID, &exec_args(&["DECR", "n"])).await.unwrap(),
        Reply::Integer { value: 1 }
    );

    // 对非数字做 INCR：又是一条「错误回复」，不是执行失败
    registry.exec(ID, &exec_args(&["SET", "s", "abc"])).await.unwrap();
    let reply = registry.exec(ID, &exec_args(&["INCR", "s"])).await.unwrap();
    assert!(
        matches!(reply, Reply::Error { .. }),
        "对字符串 INCR 应该是错误回复，实际是 {reply:?}"
    );
}

#[tokio::test]
async fn array_replies() {
    let (_server, registry) = connected().await;

    registry.exec(ID, &exec_args(&["MSET", "a", "1", "b", "2"])).await.unwrap();

    let reply = registry.exec(ID, &exec_args(&["KEYS", "*"])).await.unwrap();
    let Reply::Array { items } = reply else {
        panic!("KEYS 应该返回数组，实际是 {reply:?}");
    };
    assert_eq!(items.len(), 2, "写进去两个 key，应该回来两个");

    // 空数组和 nil 是两回事
    registry.exec(ID, &exec_args(&["FLUSHDB"])).await.unwrap();
    let empty = registry.exec(ID, &exec_args(&["KEYS", "*"])).await.unwrap();
    assert_eq!(empty, Reply::Array { items: vec![] });
}

/// 嵌套结构：`CONFIG GET` 返回的是「键值对数组」这种嵌套形状。
///
/// 顺带覆盖了「嵌套里的 ServerError 不该让整条命令失败」那条路径 ——
/// 用 `query_async` 的话这里会因为 `extract_error()` 的递归行为出问题。
#[tokio::test]
async fn nested_array_replies() {
    let (_server, registry) = connected().await;

    let reply = registry
        .exec(ID, &exec_args(&["CONFIG", "GET", "maxmemory"]))
        .await
        .unwrap();

    let Reply::Array { items } = reply else {
        panic!("CONFIG GET 应该返回数组，实际是 {reply:?}");
    };
    assert_eq!(items.len(), 2, "应该是 [键, 值] 两项");
    assert_eq!(items[0], Reply::Bulk { text: "maxmemory".into(), binary: false, bytes: 9 });
}

/// 二进制值：redis 的 bulk string 是二进制安全的，拿回来的可能不是合法 UTF-8。
#[tokio::test]
async fn binary_values_are_flagged() {
    let (_server, registry) = connected().await;

    // 普通字符串不该被标成二进制
    registry.exec(ID, &exec_args(&["SET", "plain", "hello"])).await.unwrap();
    assert_eq!(
        registry.exec(ID, &exec_args(&["GET", "plain"])).await.unwrap(),
        Reply::Bulk { text: "hello".to_string(), binary: false, bytes: 5 }
    );

    // 非法 UTF-8 的字节序列用 Lua 造。绕这一圈是因为：我们发出去的命令参数是
    // String（只能是合法 UTF-8），但**服务端存的东西**可以是任意字节 ——
    // 而这正是要覆盖的情况。Lua 的 `\240` 是十进制转义，会变成裸字节 0xF0。
    registry
        .exec(ID, &exec_args(&[
            "EVAL",
            "redis.call('SET', KEYS[1], '\\240\\040\\140\\040')",
            "1",
            "bin",
        ]))
        .await
        .unwrap();

    let reply = registry.exec(ID, &exec_args(&["GET", "bin"])).await.unwrap();
    let Reply::Bulk { binary, bytes, .. } = reply else {
        panic!("GET 应该返回 bulk，实际是 {reply:?}");
    };
    assert!(binary, "非 UTF-8 的值得被标记成二进制");
    assert_eq!(bytes, 4, "原始字节数是 4（0xF0 0x28 0x8C 0x28）");
}

/// 选库要真的生效 —— 不同 db 之间的 key 不能串。
#[tokio::test]
async fn db_selection_is_honoured() {
    let server = RedisServer::start();
    let registry = ConnectionRegistry::new();

    registry.connect("db1", &ConnectionConfig { db: 1, ..config(server.port()) }).await.unwrap();
    registry.connect("db0", &ConnectionConfig { db: 0, ..config(server.port()) }).await.unwrap();

    registry.exec("db1", &exec_args(&["SET", "only-in-1", "v"])).await.unwrap();

    assert_eq!(
        registry.exec("db1", &exec_args(&["GET", "only-in-1"])).await.unwrap(),
        Reply::Bulk { text: "v".into(), binary: false, bytes: 1 }
    );
    assert_eq!(
        registry.exec("db0", &exec_args(&["GET", "only-in-1"])).await.unwrap(),
        Reply::Nil,
        "db0 里不该看得见 db1 写的 key"
    );
}

/// 越界的库号应该由**服务端**报错，而不是前端硬编码 0–15 拦下来 ——
/// Redis 的 `databases` 是可配的，写死会在别人的服务器上误伤。
#[tokio::test]
async fn out_of_range_db_is_reported_by_the_server() {
    let server = RedisServer::start();
    let registry = ConnectionRegistry::new();

    let err = registry
        .connect("bad", &ConnectionConfig { db: 9999, ..config(server.port()) })
        .await
        .expect_err("越界的库号应该连不上");

    // 建连时会先 PING，SELECT 的失败在这里就暴露出来
    let text = err.to_string();
    assert!(
        text.contains("DB index is out of range") || text.contains("out of range"),
        "错误文案应该带上服务端的原话，实际是 {text:?}"
    );
}

/// 参数必须是逐个打包成 bulk string 的，不能拼成一行 ——
/// 否则 `SET k "a\r\nFLUSHALL"` 这种值就能挟持连接。
#[tokio::test]
async fn arguments_are_not_interpreted_as_protocol() {
    let (_server, registry) = connected().await;

    let nasty = "a\r\nFLUSHALL\r\n";
    registry.exec(ID, &exec_args(&["SET", "k", nasty])).await.unwrap();

    assert_eq!(
        registry.exec(ID, &exec_args(&["GET", "k"])).await.unwrap(),
        Reply::Bulk { text: nasty.to_string(), binary: false, bytes: nasty.len() },
        "带换行的值应该原样存进去，而不是被当成协议分隔符"
    );
    // 如果真的被当成协议了，这里会看到 0（库被清空）
    assert_eq!(
        registry.exec(ID, &exec_args(&["DBSIZE"])).await.unwrap(),
        Reply::Integer { value: 1 }
    );
}

#[tokio::test]
async fn empty_command_is_rejected_before_hitting_the_wire() {
    let (_server, registry) = connected().await;

    let err = registry.exec(ID, &[]).await.expect_err("空命令应该被拒");
    assert!(err.to_string().contains("命令不能为空"), "实际是 {err}");

    let err = registry.exec(ID, &exec_args(&["   "])).await.expect_err("空白命令应该被拒");
    assert!(err.to_string().contains("命令不能为空"), "实际是 {err}");
}
