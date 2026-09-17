//! 浏览式界面的后端：库列表、key 列表、key 详情。
//!
//! 和 `exec.rs` 一样，每条测试自己起一个真 `redis-server`（见 `common`）。

mod common;

use std::collections::HashSet;

use common::RedisServer;
use devtoolkit_redis::{ConnectionConfig, ConnectionRegistry, RedisError, Reply};

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

async fn connected() -> (RedisServer, ConnectionRegistry) {
    let server = RedisServer::start();
    let registry = ConnectionRegistry::new();
    registry.connect(ID, &config(server.port())).await.unwrap();
    (server, registry)
}

fn args(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

/// 把 SCAN 一路翻到底，收集所有 key 名
async fn scan_all(registry: &ConnectionRegistry, pattern: &str) -> Vec<String> {
    let mut names = Vec::new();
    let mut cursor = 0u64;

    loop {
        let page = registry.scan(ID, pattern, cursor, 10).await.unwrap();
        names.extend(page.keys.into_iter().map(|k| k.key));
        cursor = page.cursor;
        if cursor == 0 {
            break;
        }
    }

    names.sort();
    names
}

// ------------------------------------------------------------------ 库列表

/// 全新实例上一个 key 都没有，但**所有库都该列出来** ——
/// 用户明确说过要能看到 db0、db1 这些。这是 `CONFIG GET databases` 的功劳，
/// 光靠 `INFO keyspace` 这里是空的。
#[tokio::test]
async fn keyspace_lists_empty_databases_too() {
    let (_server, registry) = connected().await;

    let dbs = registry.keyspace(ID).await.unwrap();

    assert_eq!(dbs.len(), 16, "默认配置是 16 个库");
    assert!(dbs.iter().all(|d| d.keys == 0), "全新实例不该有 key");
    assert_eq!(dbs[0].db, 0);
    assert_eq!(dbs[15].db, 15);
}

#[tokio::test]
async fn keyspace_counts_keys_per_database() {
    let (_server, registry) = connected().await;

    registry.exec(ID, &args(&["MSET", "a", "1", "b", "2"])).await.unwrap();
    registry.select(ID, 3).await.unwrap();
    registry.exec(ID, &args(&["SET", "only-in-3", "v"])).await.unwrap();

    let dbs = registry.keyspace(ID).await.unwrap();
    let count = |db: i64| dbs.iter().find(|d| d.db == db).map(|d| d.keys).unwrap();

    assert_eq!(count(0), 2);
    assert_eq!(count(3), 1);
    assert_eq!(count(1), 0, "没写过的库应该是 0");
}

#[tokio::test]
async fn select_switches_the_database() {
    let (_server, registry) = connected().await;

    registry.exec(ID, &args(&["SET", "k", "in-db0"])).await.unwrap();
    registry.select(ID, 2).await.unwrap();

    assert_eq!(
        registry.exec(ID, &args(&["GET", "k"])).await.unwrap(),
        Reply::Nil,
        "切库之后看不到 db0 的 key"
    );

    registry.exec(ID, &args(&["SET", "k", "in-db2"])).await.unwrap();
    registry.select(ID, 0).await.unwrap();
    assert_eq!(
        registry.exec(ID, &args(&["GET", "k"])).await.unwrap(),
        Reply::Bulk { text: "in-db0".into(), binary: false, bytes: 6 }
    );
}

/// 库号越界是「服务器拒绝」，不是「连接坏了」——
/// 前端该弹提示，而不是把连接标成断开。
#[tokio::test]
async fn select_out_of_range_is_rejected_not_a_transport_failure() {
    let (_server, registry) = connected().await;

    let err = registry.select(ID, 9999).await.expect_err("越界该报错");

    assert!(matches!(err, RedisError::Rejected { .. }), "实际是 {err:?}");
    assert!(err.to_string().contains("out of range"), "文案该带上服务端的原话：{err}");
    assert!(registry.is_connected(ID).unwrap(), "连接不该因为一次非法操作就被摘掉");
}

// ------------------------------------------------------------------ key 列表

#[tokio::test]
async fn scan_returns_types_alongside_names() {
    let (_server, registry) = connected().await;

    registry.exec(ID, &args(&["SET", "str", "v"])).await.unwrap();
    registry.exec(ID, &args(&["RPUSH", "list", "a"])).await.unwrap();
    registry.exec(ID, &args(&["HSET", "hash", "f", "v"])).await.unwrap();

    let page = registry.scan(ID, "*", 0, 100).await.unwrap();
    let by_name: Vec<(String, String)> = page
        .keys
        .iter()
        .map(|k| (k.key.clone(), k.key_type.clone()))
        .collect();

    assert!(by_name.contains(&("str".to_string(), "string".to_string())), "实际 {by_name:?}");
    assert!(by_name.contains(&("list".to_string(), "list".to_string())), "实际 {by_name:?}");
    assert!(by_name.contains(&("hash".to_string(), "hash".to_string())), "实际 {by_name:?}");
}

#[tokio::test]
async fn scan_filters_by_pattern() {
    let (_server, registry) = connected().await;

    registry.exec(ID, &args(&["MSET", "user:1", "a", "user:2", "b", "other", "c"])).await.unwrap();

    assert_eq!(scan_all(&registry, "user:*").await, vec!["user:1", "user:2"]);
    assert_eq!(scan_all(&registry, "user:?").await, vec!["user:1", "user:2"]);
    assert_eq!(scan_all(&registry, "other").await, vec!["other"]);
    assert_eq!(scan_all(&registry, "nothing:*").await, Vec::<String>::new());
}

/// 一路跟着游标翻，**该拿到的 key 一个都不能少**。
///
/// 断言的是这个不变量而不是「翻了几页」：`SCAN` 的 `COUNT` 只是**提示**，
/// 服务端可以一次返回多于一页的量，也可以返回空的中间页 ——
/// 拿页数做断言会写出随版本飘的测试。
#[tokio::test]
async fn scan_paginates_through_a_large_keyspace() {
    let (_server, registry) = connected().await;

    let expected: HashSet<String> = (0..250).map(|i| format!("key:{i:03}")).collect();
    for name in &expected {
        registry.exec(ID, &args(&["SET", name, "v"])).await.unwrap();
    }

    let found: HashSet<String> = scan_all(&registry, "key:*").await.into_iter().collect();

    assert_eq!(found, expected, "翻完所有页应该刚好拿到全部 250 个 key");
}

/// Redis 的 key 是二进制安全的，可能是非法 UTF-8。
/// 那种 key 要**带着原始字节**回给前端，否则点开详情时查不到。
#[tokio::test]
async fn scan_returns_raw_bytes_for_binary_keys() {
    let (_server, registry) = connected().await;

    // 命令参数只能是合法 UTF-8，所以借 Lua 造一个非法字节的 key
    registry
        .exec(ID, &args(&["EVAL", "redis.call('SET', '\\240\\040', 'v')", "0"]))
        .await
        .unwrap();

    let page = registry.scan(ID, "*", 0, 100).await.unwrap();
    let meta = page.keys.first().expect("应该扫到那个 key");

    let raw = meta.key_bytes.clone().expect("非法 UTF-8 的 key 必须带原始字节");
    assert_eq!(raw, vec![0xF0, 0x28]);

    // 拿那份字节去查详情，必须查得到（这就是带字节的意义）
    let detail = registry.key_detail(ID, &raw, 100, None).await.unwrap();
    assert_eq!(detail.key_type, "string");
    assert_eq!(detail.value, Reply::Bulk { text: "v".into(), binary: false, bytes: 1 });
}

// ------------------------------------------------------------------ key 详情

#[tokio::test]
async fn key_detail_for_string() {
    let (_server, registry) = connected().await;
    registry.exec(ID, &args(&["SET", "k", "hello"])).await.unwrap();

    let detail = registry.key_detail(ID, b"k", 100, None).await.unwrap();

    assert_eq!(detail.key, "k");
    assert_eq!(detail.key_bytes, None, "合法 UTF-8 的 key 不该带字节");
    assert_eq!(detail.key_type, "string");
    assert_eq!(detail.ttl, -1, "没设过期时间");
    assert_eq!(detail.size, Some(5));
    assert_eq!(detail.value, Reply::Bulk { text: "hello".into(), binary: false, bytes: 5 });
    assert!(!detail.truncated);
}

#[tokio::test]
async fn key_detail_reports_ttl_when_set() {
    let (_server, registry) = connected().await;
    registry.exec(ID, &args(&["SET", "k", "v", "EX", "100"])).await.unwrap();

    let detail = registry.key_detail(ID, b"k", 100, None).await.unwrap();
    assert!((95..=100).contains(&detail.ttl), "TTL 该在 100 附近，实际 {}", detail.ttl);
}

#[tokio::test]
async fn key_detail_for_missing_key() {
    let (_server, registry) = connected().await;

    let detail = registry.key_detail(ID, b"nope", 100, None).await.unwrap();

    assert_eq!(detail.key_type, "none");
    assert_eq!(detail.ttl, -2, "不存在的键 TTL 是 -2");
    assert_eq!(detail.size, None);
    assert_eq!(detail.value, Reply::Nil);
}

#[tokio::test]
async fn key_detail_for_containers() {
    let (_server, registry) = connected().await;

    registry.exec(ID, &args(&["RPUSH", "l", "a", "b", "c"])).await.unwrap();
    registry.exec(ID, &args(&["HSET", "h", "f1", "v1", "f2", "v2"])).await.unwrap();
    registry.exec(ID, &args(&["SADD", "s", "x"])).await.unwrap();
    registry.exec(ID, &args(&["ZADD", "z", "1", "a", "2", "b"])).await.unwrap();

    let list = registry.key_detail(ID, b"l", 100, None).await.unwrap();
    assert_eq!(list.key_type, "list");
    assert_eq!(list.size, Some(3));
    let Reply::Array { items } = &list.value else { panic!("list 的值该是数组：{:?}", list.value) };
    assert_eq!(items.len(), 3);

    // hash 的回复被拆掉了 SCAN 的信封，前端看到的是扁平的 [字段, 值, ...]
    let hash = registry.key_detail(ID, b"h", 100, None).await.unwrap();
    assert_eq!(hash.key_type, "hash");
    assert_eq!(hash.size, Some(2));
    let Reply::Array { items } = &hash.value else { panic!("hash 的值该是数组：{:?}", hash.value) };
    assert_eq!(items.len(), 4, "两个字段 = 四项（字段、值交替）");

    assert_eq!(registry.key_detail(ID, b"s", 100, None).await.unwrap().size, Some(1));

    let zset = registry.key_detail(ID, b"z", 100, None).await.unwrap();
    assert_eq!(zset.key_type, "zset");
    assert_eq!(zset.size, Some(2));
}

/// 大容器只取前 `limit` 项，并且**如实标记被截断了**。
#[tokio::test]
async fn key_detail_truncates_large_containers() {
    let (_server, registry) = connected().await;

    for i in 0..50 {
        registry.exec(ID, &args(&["RPUSH", "big", &i.to_string()])).await.unwrap();
    }

    let detail = registry.key_detail(ID, b"big", 10, None).await.unwrap();

    let Reply::Array { items } = &detail.value else { panic!("该是数组") };
    assert_eq!(items.len(), 10, "只取前 10 项");
    assert!(detail.truncated, "被截断了要标出来");
    assert_eq!(detail.size, Some(50), "但总数要如实报告");
}

#[tokio::test]
async fn key_detail_does_not_truncate_small_containers() {
    let (_server, registry) = connected().await;
    registry.exec(ID, &args(&["RPUSH", "small", "a", "b"])).await.unwrap();

    let detail = registry.key_detail(ID, b"small", 100, None).await.unwrap();
    assert!(!detail.truncated, "没到上限不该标截断");
}

// ------------------------------------------------ 类型提示（快路径 / 一次往返）

/// 带上类型提示走的是快路径（TTL + 值 + 总数一个管道），结果必须和慢路径**完全一致**。
///
/// 这条是快路径的守门测试：省一次往返的前提是不能改变语义。
#[tokio::test]
async fn type_hint_produces_the_same_result_as_the_slow_path() {
    let (_server, registry) = connected().await;

    registry.exec(ID, &args(&["SET", "s", "hello"])).await.unwrap();
    registry.exec(ID, &args(&["RPUSH", "l", "a", "b", "c"])).await.unwrap();
    registry.exec(ID, &args(&["HSET", "h", "f1", "v1", "f2", "v2"])).await.unwrap();
    registry.exec(ID, &args(&["SET", "with-ttl", "v", "EX", "100"])).await.unwrap();

    for (key, key_type) in [
        (&b"s"[..], "string"),
        (&b"l"[..], "list"),
        (&b"h"[..], "hash"),
        (&b"with-ttl"[..], "string"),
    ] {
        let hinted = registry.key_detail(ID, key, 100, Some(key_type)).await.unwrap();
        let unhinted = registry.key_detail(ID, key, 100, None).await.unwrap();

        assert_eq!(hinted.key_type, unhinted.key_type, "类型不一致：{key:?}");
        assert_eq!(hinted.ttl, unhinted.ttl, "TTL 不一致：{key:?}");
        assert_eq!(hinted.size, unhinted.size, "总数不一致：{key:?}");
        assert_eq!(hinted.value, unhinted.value, "值不一致：{key:?}");
        assert_eq!(hinted.truncated, unhinted.truncated, "截断标记不一致：{key:?}");
    }
}

/// 提示可能过时：用户从列表里看到类型之后，那个 key 被别人改成了别的类型。
///
/// 这时快路径会拿到 `WRONGTYPE`，**必须自动退回慢路径**，而不是把错误糊给用户。
#[tokio::test]
async fn stale_type_hint_falls_back_instead_of_failing() {
    let (_server, registry) = connected().await;

    registry.exec(ID, &args(&["SET", "k", "now-a-string"])).await.unwrap();

    // 传一个过时的提示：说它是 list，实际是 string
    let detail = registry.key_detail(ID, b"k", 100, Some("list")).await.unwrap();

    assert_eq!(detail.key_type, "string", "退回慢路径后应该拿到真实类型");
    assert_eq!(
        detail.value,
        Reply::Bulk { text: "now-a-string".into(), binary: false, bytes: 12 },
        "值也要是对的，不能是空壳"
    );
    assert_eq!(detail.size, Some(12));
}

/// 提示写了个根本不存在的类型时同样要能兜住
#[tokio::test]
async fn unknown_type_hint_falls_back() {
    let (_server, registry) = connected().await;
    registry.exec(ID, &args(&["SET", "k", "v"])).await.unwrap();

    let detail = registry.key_detail(ID, b"k", 100, Some("hyperloglog")).await.unwrap();

    assert_eq!(detail.key_type, "string");
    assert_eq!(detail.value, Reply::Bulk { text: "v".into(), binary: false, bytes: 1 });
}
