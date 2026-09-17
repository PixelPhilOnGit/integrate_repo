//! 集成测试夹具：**自己拉起一个真 `redis-server`**。
//!
//! 为什么不连一个「已经在跑的」Redis：
//!
//! * 测试要能独立跑，不能依赖开发者先手动起服务；
//! * 测试会写数据、会 `FLUSHDB`，绝不该碰别人的库；
//! * 需要制造「连接中途坏掉」这种场景，必须能随手把服务杀掉。
//!
//! 所以每个测试起一个自己的实例，**随机端口**、不落盘、`Drop` 时杀掉。
//!
//! 机器上没有 `redis-server` 时**明确报错并给出安装命令，不静默跳过** ——
//! 静默跳过等于这些测试永远不跑，而没有任何人会发现。

#![allow(dead_code)] // 每个测试二进制只用到这里的一部分

use std::io;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

/// 随机拿一个空闲端口。
///
/// 绑定 `:0` 让内核分配、读出端口号、立刻释放。严格说这里有个竞态窗口
/// （释放到 redis-server 真正绑定之间，端口可能被别人抢走），但实测足够可靠，
/// 而且真抢走了也只是这一条测试失败、报错信息很明确。
fn free_port() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").expect("应该能绑定一个临时端口");
    listener.local_addr().expect("应该能读到端口").port()
}

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// 手写临时目录。
///
/// 刻意不引入 `tempfile`：整个仓库的 Rust 侧只有 serde 一个运行时依赖，
/// 测试夹具沿用 `devtoolkit-core` 那套手写实现（那边有同样一份）——
/// 跨 crate 没法复用测试模块，但也没必要为此多一个依赖。
pub struct TempDir {
    path: PathBuf,
}

impl TempDir {
    pub fn new(tag: &str) -> TempDir {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "devtoolkit-redis-test-{tag}-{}-{nanos}-{n}",
            std::process::id()
        ));
        std::fs::create_dir_all(&path).expect("应该能建临时目录");
        TempDir { path }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

/// 一个跑在随机端口上的 `redis-server`，Drop 时被杀掉。
pub struct RedisServer {
    child: Child,
    port: u16,
    _dir: TempDir,
}

impl RedisServer {
    pub fn start() -> RedisServer {
        Self::start_with(&[])
    }

    /// `extra_args` 用来覆盖默认配置（比如设密码，测认证路径）。
    pub fn start_with(extra_args: &[&str]) -> RedisServer {
        let exe = std::env::var("REDIS_SERVER").unwrap_or_else(|_| "redis-server".to_string());
        let dir = TempDir::new("server");
        let port = free_port();

        let mut args: Vec<String> = vec![
            "--port".into(),
            port.to_string(),
            "--bind".into(),
            "127.0.0.1".into(),
            // 不落盘：测试不该在磁盘上留东西，也不该因为 RDB 落盘而卡顿
            "--save".into(),
            "".into(),
            "--appendonly".into(),
            "no".into(),
            "--dir".into(),
            dir.path().to_string_lossy().into_owned(),
        ];
        args.extend(extra_args.iter().map(|s| s.to_string()));

        let child = Command::new(&exe)
            .args(&args)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap_or_else(|e| panic!("{}", missing_server_help(&exe, &e)));

        let mut server = RedisServer {
            child,
            port,
            _dir: dir,
        };
        server.wait_ready();
        server
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn url(&self) -> String {
        format!("redis://127.0.0.1:{}", self.port)
    }

    /// 强行杀掉服务，用来测「连接在使用中断掉」。
    /// 杀完之后 `Drop` 再 kill 一次是无害的。
    pub fn kill(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }

    /// 轮询到服务真的能响应 PING 为止。
    ///
    /// 只探测 TCP 端口能连上是不够的：内核接受连接 ≠ Redis 已经初始化完，
    /// 那种写法会偶发地让第一条命令失败。
    fn wait_ready(&mut self) {
        let deadline = Instant::now() + Duration::from_secs(15);

        loop {
            // 进程提前退了就别等了，直接报出来
            if let Ok(Some(status)) = self.child.try_wait() {
                panic!("redis-server 启动后立刻退出（{status}），端口 {}", self.port);
            }

            if ping_once(self.port) {
                return;
            }

            if Instant::now() >= deadline {
                panic!("redis-server 在 15 秒内没有就绪（端口 {}）", self.port);
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

impl Drop for RedisServer {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// 探一次「服务已经在应答了吗」。
///
/// 刻意走**裸 TCP** 而不是 `redis::Client`：用客户端库发 PING 的话，
/// 服务器设了 `--requirepass` 时会回 `-NOAUTH`，而客户端会把它当失败 ——
/// 于是服务明明已经就绪，探测却永远不成功。
///
/// 这里的判据是「有没有字节回来」：`+PONG` 和 `-NOAUTH` 都能证明
/// 服务已经起来并且能解析 RESP 了。
fn ping_once(port: u16) -> bool {
    use std::io::{Read, Write};

    let Ok(mut stream) = std::net::TcpStream::connect(("127.0.0.1", port)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    if stream.write_all(b"*1\r\n$4\r\nPING\r\n").is_err() {
        return false;
    }
    let mut buf = [0u8; 64];
    matches!(stream.read(&mut buf), Ok(n) if n > 0)
}

/// 找不到 redis-server 时给一条能照着做的提示。
///
/// 这里刻意 panic 而不是跳过测试：**静默跳过等于这些测试永远不跑**。
fn missing_server_help(exe: &str, e: &io::Error) -> String {
    format!(
        "找不到可执行的 redis-server（试的是 “{exe}”，错误：{e}）。\n\
         \n\
         集成测试需要一个真实的 Redis 实例，它由测试自己拉起，不会静默跳过。\n\
         \n\
           Ubuntu/Debian：  sudo apt-get install -y redis-server\n\
           macOS：          brew install redis\n\
           或者自己指定：    REDIS_SERVER=/path/to/redis-server cargo test\n"
    )
}
