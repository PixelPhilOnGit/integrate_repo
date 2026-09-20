//! ClickHouse 的集成测试：**用 Docker 起一个真服务端**。
//!
//! # 为什么这里和 pg / mysql 那两组不一样
//!
//! 那两组是「自己拉起装在本机的服务端」（`initdb` / `mysqld --initialize`）——
//! 因为 apt 装完就有二进制。ClickHouse 不是：**它的官方分发就是容器**，
//! 让人为了跑测试往本机 apt 装一个 clickhouse-server 不现实。
//!
//! 所以这一组走 Docker（镜像 `clickhouse/clickhouse-server:24`），兜底逻辑和
//! 另外两组一个规矩：**没有 Docker 就明确失败并说怎么装**，不静默跳过 ——
//! 静默跳过等于这些测试永远不跑而没人发现。
//!
//! # 不留孤儿
//!
//! ⚠️ **杀 `docker run` 那个客户端不会停掉容器**（它只是发了个请求就走了），
//! 所以 `Drop` 里必须按**容器名** `docker rm -f`。`--rm` 只是第二道保险。

mod common;

use std::process::{Child, ChildStdin, Command, Stdio};
use std::time::Duration;

use devtoolkit_sql::{ConnectionConfig, ConnectionRegistry, SqlKind};

const IMAGE: &str = "clickhouse/clickhouse-server:24";
/// 就绪要十几秒（要起一个服务端进程 + 初始化），给宽一点
const READY_TIMEOUT: Duration = Duration::from_secs(90);

fn docker_ready() -> Result<(), String> {
    match Command::new("docker").arg("info").stdout(Stdio::null()).stderr(Stdio::null()).status() {
        Ok(status) if status.success() => Ok(()),
        _ => Err(format!(
            "这组测试要 Docker（用来起一个真的 ClickHouse），但 `docker info` 跑不通。\n\
             装一个：https://docs.docker.com/engine/install/ （Windows/macOS 用 Docker Desktop）\n\
             装完确认 `docker ps` 能跑。\n\
             ⚠️ 刻意**不静默跳过** —— 跳过了这些用例就永远不跑，而没人会知道。"
        )),
    }
}

/// 一个一次性的容器。
///
/// `child` 是那个**挂住容器的 shell**（不是 `docker run` 本身）：它跑
/// `docker run … &` 之后一直读 stdin，EOF（测试进程退出）时把容器删掉。
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
        let name = format!("devtoolkit-test-ch-{}-{}", std::process::id(), port);
        // ⚠️ `-v` 是必须的：clickhouse 镜像的 Dockerfile 声明了
        // `VOLUME /var/lib/clickhouse`，**每次 `docker run` 都会新建一个匿名卷**，
        // 而 `docker rm` **不删卷** —— 漏下来的卷会把磁盘吃满（Mongo 那边真发生过，
        // 见 `mongodb.rs` 里那段）。
        let script = format!(
            "docker run --rm --name {name} -p 127.0.0.1:{port}:8123 {IMAGE} &\n\
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
        // 一次启动失败留下五个容器（和 pg / mysql 那边是同一个坑，
        // 见 `common/mod.rs` 的 `shared`）。
        if ATTEMPTS.fetch_add(1, std::sync::atomic::Ordering::SeqCst) > 0 {
            panic!("{IMAGE} 测试容器之前启动失败过，不再重试（避免把机器拖垮）");
        }
        Container::start()
    })
}

impl Drop for Container {
    fn drop(&mut self) {
        // ⚠️ 兜底：杀客户端**不会**停容器，必须按名字删（见文件头）。
        // 正常路径是上面那个 EOF 收尾，这一条是 panic / 被杀时的保险。
        // `-v` 一起删卷 —— 理由见 `Container::start` 里那段
        let _ = Command::new("docker")
            .args(["rm", "-f", "-v", &self.name])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// ⚠️ **端口能连上不等于服务好了。** docker 的端口转发在容器里那个进程真正
/// 开始服务之前就已经接得住连接了（转发的进程先 accept，连不上容器再断）——
/// 于是「等端口」会提前返回，紧接着的第一个请求直接 `SendRequest` 失败。
/// 所以要**真的敲一下** ClickHouse 自己的 `/ping`（它回一个 "Ok."）。
fn wait_until_serving(port: u16) {
    use std::io::{Read, Write};

    let deadline = std::time::Instant::now() + READY_TIMEOUT;
    while std::time::Instant::now() < deadline {
        if let Ok(mut socket) = std::net::TcpStream::connect(("127.0.0.1", port)) {
            let _ = socket.set_read_timeout(Some(Duration::from_secs(2)));
            if socket.write_all(b"GET /ping HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n").is_ok() {
                let mut answer = String::new();
                if socket.read_to_string(&mut answer).is_ok() && answer.contains("Ok.") {
                    return;
                }
            }
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    panic!("{IMAGE} 在 {READY_TIMEOUT:?} 内没有开始服务（端口 {port}）");
}

fn config(port: u16) -> ConnectionConfig {
    ConnectionConfig {
        kind: SqlKind::Clickhouse,
        host: "127.0.0.1".to_string(),
        port,
        username: "default".to_string(),
        password: None,
        database: None,
    }
}

#[tokio::test]
async fn 连上_查版本_列库_列表() {
    let container = shared();
    let registry = ConnectionRegistry::new();

    let info = registry.connect("ch", &config(container.port)).await.expect("应当连上");
    assert_eq!(info.kind, "clickhouse");
    assert!(!info.version.is_empty(), "版本号应当拿得到（握手就是查它）");
    assert_eq!(info.database, "default", "没填库名时落到 default");

    // 库：出厂就有一个 default 和一个 system
    let databases = registry.databases("ch").await.expect("列库");
    assert!(databases.contains(&"default".to_string()), "库列表里该有 default：{databases:?}");
    assert!(databases.contains(&"system".to_string()));

    // 表：先建一张，再列出来 —— ⚠️ **一次只能跑一条语句**，所以建和插要分开发
    registry.query("ch", "CREATE TABLE IF NOT EXISTS demo (id UInt32, name String) ENGINE = Memory").await.expect("建表");
    registry.query("ch", "INSERT INTO demo VALUES (1, '张三'), (2, '李四')").await.expect("插入");

    let tables = registry.tables("ch").await.expect("列表");
    let demo = tables.iter().find(|t| t.name == "demo").expect("demo 应当列出来");
    // ⚠️ schema 字段：前端拼 `"库"."表名"` 要用它（协调者定的契约）
    assert_eq!(demo.schema, "default");
    assert_eq!(demo.kind, "table", "Memory 引擎的表就是 table，不是 view");
}

#[tokio::test]
async fn select_的结果按_table_形状回来() {
    let container = shared();
    let registry = ConnectionRegistry::new();
    registry.connect("ch", &config(container.port)).await.expect("连上");

    let result = registry
        .query("ch", "SELECT 1 AS id, '张三' AS name, NULL AS nothing")
        .await
        .expect("应当执行成功");

    assert!(result.error.is_none());
    assert_eq!(result.columns.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["id", "name", "nothing"]);
    assert_eq!(result.rows[0][0].text.as_deref(), Some("1"));
    assert_eq!(result.rows[0][1].text.as_deref(), Some("张三"));
    assert_eq!(result.rows[0][2].text, None, "SQL 的 NULL");
}

#[tokio::test]
async fn ddl_和_insert_的执行结果是没有行而不是错误() {
    let container = shared();
    let registry = ConnectionRegistry::new();
    registry.connect("ch", &config(container.port)).await.expect("连上");

    let result = registry
        .query("ch", "CREATE TABLE IF NOT EXISTS ddl_only (x UInt8) ENGINE = Memory")
        .await
        .expect("DDL 应当成功");

    assert!(result.error.is_none(), "DDL 不是错误");
    assert!(result.rows.is_empty());
    // ⚠️ 影响行数拿不到（ClickHouse 把它放在响应头里，客户端不交出来）——
    // 契约是「说不了的不编」，所以这里就该是 None
    assert_eq!(result.affected, None);
}

#[tokio::test]
async fn 引擎拒绝一条_sql_时是结果不是断连() {
    // 这一条是整个模块最要紧的语义：表不存在**不能**把连接标成断开
    let container = shared();
    let registry = ConnectionRegistry::new();
    registry.connect("ch", &config(container.port)).await.expect("连上");

    let result = registry
        .query("ch", "SELECT * FROM 不存在的表")
        .await
        .expect("这条往返是成功的");

    let error = result.error.expect("应当把引擎的报错带回来");
    // ⚠️ **中文 SQL 这条拿不到引擎原话**，原因在 `extract_exception` 的文档里：
    // ClickHouse 回显 SQL 片段是按字节截的，半个汉字不是合法 UTF-8，而 crate 在
    // 这条路上用严格解码，失败就把整段正文丢掉、只留错误码。
    // 所以这里钉的是**兜底文案**：至少得是「错误码 + 人话」，不能光一个数字。
    assert!(error.contains("Code: 62"), "至少要带上错误码：{error}");
    assert!(error.contains("语法错误"), "错误码要翻成人话，别让用户对着数字发呆：{error}");
    assert!(registry.is_connected("ch").expect("查状态"), "连接必须还在");
}

/// 和上一条互补：**纯 ASCII 的 SQL 出错时引擎原话是拿得到的**（错误正文是合法
/// UTF-8）。钉住这一条，免得以后为了上面那个兜底把好路也一起改坏。
#[tokio::test]
async fn 纯_ascii_的_sql_出错能拿到引擎原话() {
    let container = shared();
    let registry = ConnectionRegistry::new();
    registry.connect("ch", &config(container.port)).await.expect("连上");

    let result = registry
        .query("ch", "SELECT * FROM no_such_table_here")
        .await
        .expect("这条往返是成功的");

    let error = result.error.expect("应当把引擎的报错带回来");
    assert!(error.contains("DB::Exception"), "要带上引擎的原话：{error}");
    assert!(error.contains("UNKNOWN_TABLE") || error.contains("60"), "要说清是哪类错：{error}");
    assert!(registry.is_connected("ch").expect("查状态"), "连接必须还在");
}

#[tokio::test]
async fn 连不上的地址在超时内报错() {
    let registry = ConnectionRegistry::new();
    // 没人监听的端口
    let error = registry
        .connect("ch", &config(common::free_port()))
        .await
        .expect_err("应当连不上");
    let text = error.to_string();
    assert!(text.contains("失败"), "错误文案要说清楚是连接失败：{text}");
}
