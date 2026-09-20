//! MongoDB 的集成测试：**用 Docker 起一个真服务端**。
//!
//! 和 ClickHouse 那组同一个理由（官方分发就是容器，见 `clickhouse.rs` 的文件头），
//! 兜底也一样：**没有 Docker 就明确失败并说怎么装**，不静默跳过。
//!
//! # 数据是怎么进去的
//!
//! 后端的这条路**只读**（只有 `find`，没有写入 —— 见 `mongo.rs` 的模块头），
//! 所以测试直接拿驱动往里插几条，再从注册表那条路读回来。这不叫"绕过被测代码"：
//! 被测的是**读**的那条路（命令 JSON → 文档 → 表格形状）✓

mod common;

use std::process::{Child, ChildStdin, Command, Stdio};
use std::time::Duration;

use devtoolkit_sql::{ConnectionConfig, ConnectionRegistry, SqlKind};
use mongodb::bson::{doc, Binary, Bson};
use mongodb::options::ClientOptions;
use mongodb::Client;

const IMAGE: &str = "mongo:7";
const READY_TIMEOUT: Duration = Duration::from_secs(90);

fn docker_ready() -> Result<(), String> {
    match Command::new("docker").arg("info").stdout(Stdio::null()).stderr(Stdio::null()).status() {
        Ok(status) if status.success() => Ok(()),
        _ => Err(format!(
            "这组测试要 Docker（用来起一个真的 MongoDB），但 `docker info` 跑不通。\n\
             装一个：https://docs.docker.com/engine/install/ （Windows/macOS 用 Docker Desktop）\n\
             装完确认 `docker ps` 能跑。\n\
             ⚠️ 刻意**不静默跳过** —— 跳过了这些用例就永远不跑，而没人会知道。"
        )),
    }
}

struct Container {
    _stdin: ChildStdin,
    child: Child,
    name: String,
    port: u16,
}

impl Container {
    fn start() -> Container {
        docker_ready().unwrap_or_else(|help| panic!("{help}"));

        let port = common::free_port();
        let name = format!("devtoolkit-test-mg-{}-{}", std::process::id(), port);
        // 不挂数据卷：容器删了数据就没了，正是测试要的
        // ⚠️ `-v` 是必须的：mongo 镜像的 Dockerfile 声明了 `VOLUME /data/db`，
        // 于是**每次 `docker run` 都会新建一个匿名卷**，而 `docker rm` **不删卷**。
        // 漏一个卷就是几百 MB —— 这台机器上真被这么吃满过：十几个孤儿容器攒下
        // 44 个卷（4.4GB），根分区 100%，连 mongod 自己都起不来（WiredTiger 写
        // 不了数据目录直接 abort，报的还是 `StorageEngineImpl::loadCatalog` 崩溃，
        // 看不出跟磁盘有关）。
        let script = format!(
            "docker run --rm --name {name} -p 127.0.0.1:{port}:27017 {IMAGE} &\n\
             cat > /dev/null\n\
             docker rm -f -v {name}\n"
        );

        let mut child = Command::new("sh")
            .arg("-c")
            .arg(&script)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("起 docker 的 shell 失败");
        let stdin = child.stdin.take().expect("应该是 piped 的");

        wait_until_serving(port);

        Container { _stdin: stdin, child, name, port }
    }
}

/// **整个测试二进制共用一个容器。**
///
/// 为什么不是每条用例起一个：ClickHouse / Mongo 起来要十几秒，五条用例就是
/// 一分多钟，而它们之间没有互相干扰（各自的库/表名不同）。这和 pg / mysql
/// 那两组是同一个理由（见 `common/mod.rs` 的说明）。
///
/// 收尾靠那个经典的技巧：**容器由一个 shell 挂着，shell 一直读 stdin；
/// 测试进程一退出（正常结束、panic、被杀都算）管道 EOF，shell 醒来把它删掉**。
/// `static` 不会被 drop，所以不能指望 `Drop`。
fn shared() -> &'static Container {
    static ONCE: std::sync::OnceLock<Container> = std::sync::OnceLock::new();
    static ATTEMPTS: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

    ONCE.get_or_init(|| {
        // ⚠️ 启动失败之后**不再重试**：`OnceLock::get_or_init` 在闭包 panic 之后
        // 不会缓存，于是每个后续用例都会再起一个容器 —— 这台机器上真发生过：
        // 一次启动失败留下五个 mongo 容器（和 pg / mysql 那边是同一个坑，
        // 见 `common/mod.rs` 的 `shared`）。
        if ATTEMPTS.fetch_add(1, std::sync::atomic::Ordering::SeqCst) > 0 {
            panic!("{IMAGE} 测试容器之前启动失败过，不再重试（避免把机器拖垮）");
        }
        Container::start()
    })
}


impl Drop for Container {
    fn drop(&mut self) {
        // ⚠️ 杀 `docker run` 那个客户端**不会**停容器，必须按名字删（见 clickhouse.rs 头）
        // ⚠️ `-v` 一起删卷 —— 理由见 `Container::start` 里那段
        let _ = Command::new("docker")
            .args(["rm", "-f", "-v", &self.name])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// ⚠️ **端口能连上不等于服务好了**（docker 的转发先 accept ✗）—— 所以拿驱动
/// 自己 `ping` 一下才算数。和 ClickHouse 那边一个道理（见 `clickhouse.rs`）。
/// 等它真的开始服务。
///
/// ⚠️ **同步外壳 + 新线程**：`Container::start()` 是同步的（它就是起个 docker），
/// 而调用它的用例是 `#[tokio::test]`（**已经在运行时里**）。所以这里不能直接
/// `block_on` —— 会 panic：`Cannot start a runtime from within a runtime`
/// （真机上就是这么红的）。把探测丢到一个新线程上，那上面没有运行时，随便 block。
fn wait_until_serving(port: u16) {
    let name = format!("mongo-ready-{port}");
    let handle = std::thread::Builder::new()
        .name(name)
        .spawn(move || {
            // ⚠️ 这个线程上**没有**运行时（用例那个 `#[tokio::test]` 的运行时是
            // 线程局部的），所以在它上面可以自己建一个来 block。
            //
            // ⚠️⚠️ **不 block 等于没等**：这里原来只写了 `probe_until_serving(port)`，
            // 那是**造了一个 Future 然后扔掉** —— 线程立刻结束，容器还在拉起来
            // 测试就开始了。表现是「整体偶发地连不上」（容器起得快就侥幸过），
            // 而真机上就是这么红的。
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("建探测用的运行时")
                .block_on(probe_until_serving(port))
        })
        .expect("起探测线程");
    if handle.join().is_err() {
        panic!("等待 {IMAGE} 就绪的线程挂了（端口 {port}）");
    }
}

async fn probe_until_serving(port: u16) {
    let deadline = std::time::Instant::now() + READY_TIMEOUT;
    while std::time::Instant::now() < deadline {
        let mut options = ClientOptions::parse(format!("mongodb://127.0.0.1:{port}"))
            .await
            .expect("解析地址");
        options.server_selection_timeout = Some(Duration::from_secs(2));

        // ping 通了才算「服务好了」—— 端口能连上只是 docker 的转发先 accept 了
        let ok = match Client::with_options(options) {
            Ok(client) => client
                .database("admin")
                .run_command(doc! { "ping": 1 })
                .await
                .is_ok(),
            Err(_) => false,
        };
        if ok {
            return;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    panic!("{IMAGE} 在 {READY_TIMEOUT:?} 内没有开始服务（端口 {port}）");
}

fn config(port: u16, database: Option<&str>) -> ConnectionConfig {
    ConnectionConfig {
        kind: SqlKind::Mongodb,
        host: "127.0.0.1".to_string(),
        port,
        // ⚠️ 用户名**允许为空**：本地常常不开鉴权，空就是无凭据连接
        username: String::new(),
        password: None,
        database: database.map(str::to_string),
    }
}

/// 直接拿驱动往里插几条（后端只读，见文件头）。
///
/// ⚠️ **库名要显式写、而且和连接对上**：后端列集合走的是**连接上那个库**
/// （没配库时驱动的默认是 `test`）—— 插到别的库里就永远列不出来。
///
/// ⚠️ **每条用例用自己的集合名**：容器是整个二进制共用的，而 cargo 默认并发跑
/// 用例 —— 都往 `users` 里插的话，一条用例插三次、另一条看到的就不是三条了。
async fn seed(port: u16, database: &str, collection: &str) {
    let options = ClientOptions::parse(format!("mongodb://127.0.0.1:{port}"))
        .await
        .expect("解析地址");
    let client = Client::with_options(options).expect("建客户端");
    let users = client.database(database).collection::<mongodb::bson::Document>(collection);

    users
        .insert_many(vec![
            doc! { "name": "张三", "age": 30 },
            doc! { "name": "李四", "age": 20 },
            doc! { "name": "王五", "age": 40, "blob": Binary { subtype: mongodb::bson::spec::BinarySubtype::Generic, bytes: vec![0xff, 0xfe] } },
        ])
        .await
        .expect("插测试数据");
}

#[tokio::test]
async fn 连上_列库_列集合() {
    let container = shared();
    let registry = ConnectionRegistry::new();

    let info = registry.connect("m", &config(container.port, None)).await.expect("应当连上");
    assert_eq!(info.kind, "mongodb");
    assert!(!info.version.is_empty(), "版本号应当拿得到（握手之后顺手查的 buildInfo）");
    assert_eq!(info.database, "test", "没配库时按驱动的默认");

    // ⚠️ 这条连接**没配库**，所以下面列集合列的是默认库 `test` 里的 ——
    // 数据就得往那儿插（插到 `app` 里就永远列不出来，这条踩过）
    seed(container.port, "test", "users_for_tables").await;

    let databases = registry.databases("m").await.expect("列库");
    assert!(databases.contains(&"app".to_string()), "库列表里该有 app：{databases:?}");

    // 集合：⚠️ schema 字段给的是**库名**（四个引擎的契约统一成 schema + name + kind）
    let collections = registry.tables("m").await.expect("列集合");
    let users = collections
        .iter()
        .find(|c| c.name == "users_for_tables")
        .expect("刚建的那个集合应当列出来");
    assert_eq!(users.schema, "test", "没选库时列的是默认库里的集合");
    assert_eq!(users.kind, "collection");
}

#[tokio::test]
async fn 查文档_形状按契约来() {
    let container = shared();
    let registry = ConnectionRegistry::new();
    registry.connect("m", &config(container.port, Some("app"))).await.expect("连上");
    seed(container.port, "app", "users_shape").await;

    let result = registry
        .query("m", r#"{"collection":"users_shape","filter":{"age":{"$gt":25}},"sort":{"age":1}}"#)
        .await
        .expect("应当查成功");

    assert!(result.error.is_none());
    // ⚠️ 契约：一列，名字 document、类型 json（前端那个标签页靠它认）
    assert_eq!(result.columns.len(), 1);
    assert_eq!(result.columns[0].name, "document");
    assert_eq!(result.columns[0].type_name, "json");
    assert_eq!(result.rows.len(), 2, "30 和 40 那两条");

    // 每行是一段**美化过的** JSON 文本
    let first = result.rows[0][0].text.clone().expect("有文本");
    assert!(first.contains('\n'), "契约要求美化过，前端不再自己缩进");
    let parsed: serde_json::Value = serde_json::from_str(&first).expect("必须是合法 JSON");
    assert_eq!(parsed["name"], "张三");
    assert_eq!(parsed["age"], 30);
    // _id 按 bson 的扩展 JSON 给（Mongo 世界的通用写法）
    assert!(parsed["_id"]["$oid"].is_string(), "ObjectId 要给 $oid：{first}");
    assert_eq!(result.affected, None, "Mongo 没有影响行数");
}

#[tokio::test]
async fn 二进制值按契约用_binary_加_base64() {
    let container = shared();
    let registry = ConnectionRegistry::new();
    registry.connect("m", &config(container.port, Some("app"))).await.expect("连上");
    seed(container.port, "app", "users_binary").await;

    let result = registry
        .query("m", r#"{"collection":"users_binary","filter":{"name":"王五"}}"#)
        .await
        .expect("查成功");

    let text = result.rows[0][0].text.clone().expect("有文本");
    let parsed: serde_json::Value = serde_json::from_str(&text).expect("合法 JSON");
    // 契约：`{"$binary": "<base64>"}` —— 不是 bson 那一层嵌套的 {base64, subType}
    let encoded = parsed["blob"]["$binary"].as_str().expect("按 $binary 给");
    assert_eq!(encoded, "//4=", "0xff 0xfe 的 base64");
}

#[tokio::test]
async fn limit_和截断标记() {
    let container = shared();
    let registry = ConnectionRegistry::new();
    registry.connect("m", &config(container.port, Some("app"))).await.expect("连上");
    seed(container.port, "app", "users_limit").await;

    let result = registry.query("m", r#"{"collection":"users_limit","limit":2}"#).await.expect("查成功");
    assert_eq!(result.rows.len(), 2);
    assert!(result.truncated, "还有第三条没取，要标出来");
}

#[tokio::test]
async fn 查询写错时是结果不是断连() {
    let container = shared();
    let registry = ConnectionRegistry::new();
    registry.connect("m", &config(container.port, Some("app"))).await.expect("连上");

    // filter 不是对象：解析阶段就能报，而且要点名是哪个字段
    let result = registry.query("m", r#"{"collection":"users","filter":"张三"}"#).await.expect("往返成功");
    let error = result.error.expect("应当把错误带回来");
    assert!(error.contains("filter"), "要点名是哪儿写错了：{error}");
    assert!(registry.is_connected("m").expect("查状态"), "连接必须还在");

    // 集合不存在：服务端拒绝，同样是结果
    let result = registry.query("m", r#"{"collection":"没有这个集合"}"#).await.expect("往返成功");
    assert!(result.error.is_some(), "集合不存在要报出来");
    assert!(registry.is_connected("m").expect("查状态"), "连接必须还在");
}

#[tokio::test]
async fn 连不上的地址在超时内报错() {
    let registry = ConnectionRegistry::new();
    let error = registry
        .connect("m", &config(common::free_port(), None))
        .await
        .expect_err("应当连不上");
    let text = error.to_string();
    assert!(text.contains("失败"), "错误文案要说清楚是连接失败：{text}");
}

#[test]
fn 无凭据连接的配置是对的() {
    // 本地常常不开鉴权：用户名为空就是「不带凭据」，不是「空用户名」
    let config = config(27017, None);
    assert!(config.username.is_empty());
    assert!(config.password.is_none());
    // 顺带盯一眼 Bson 的用法没写错（上面那个 seed 用的形状）
    let _ = Bson::Binary(Binary {
        subtype: mongodb::bson::spec::BinarySubtype::Generic,
        bytes: vec![1],
    });
}
