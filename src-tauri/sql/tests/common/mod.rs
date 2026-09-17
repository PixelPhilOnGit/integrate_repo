//! 集成测试夹具：**自己拉起真的 PostgreSQL / MySQL**。
//!
//! 和 redis 那套一样：测试不依赖「外面已经跑着一个服务」，也不碰别人的库。
//!
//! # 两个引擎特有的麻烦
//!
//! 1. **它们拒绝以 root 身份运行**（redis-server 没这个限制）。所以要用
//!    `CommandExt::uid/gid` 降到 `postgres` / `mysql` 系统用户下跑，
//!    数据目录也要事先 chown 给那个用户。
//! 2. **初始化很慢**（`initdb` / `mysqld --initialize` 要十几秒），所以整个测试
//!    二进制**共用一个实例**，不是每条测试起一个。
//!
//! # 怎么做到不留孤儿进程
//!
//! 共用的实例要放在 static 里，而 **static 不会被 drop** —— 靠 `Drop` 收尾收不掉。
//! 所以让子进程是一个 shell：它把数据库挂到后台，然后**一直读 stdin**；
//! 测试进程一退出，管道 EOF，shell 醒过来杀掉数据库、删掉数据目录再退出。
//! 父进程正常结束、panic、被 kill，三种情况都成立。
//!
//! 数据目录的清理也交给那个 shell，因为 `TempDir` 的 `Drop` 在 static 场景下
//! 同样不会跑。

#![allow(dead_code)] // 每个测试二进制只用到这里的一部分

use std::net::TcpListener;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// 随机拿一个空闲端口
fn free_port() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").expect("应该能绑定一个临时端口");
    listener.local_addr().expect("应该能读到端口").port()
}

/// 建一个临时目录，返回路径（不负责清理 —— 清理交给那个 shell 脚本）
fn temp_dir(tag: &str) -> std::path::PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let path = std::env::temp_dir().join(format!(
        "devtoolkit-sql-test-{tag}-{}-{nanos}-{n}",
        std::process::id()
    ));
    std::fs::create_dir_all(&path).expect("应该能建临时目录");
    path
}

/// 系统用户的 uid / gid
fn lookup_user(name: &str) -> Option<(u32, u32)> {
    let content = std::fs::read_to_string("/etc/passwd").ok()?;
    for line in content.lines() {
        let fields: Vec<&str> = line.split(':').collect();
        if fields.len() > 3 && fields[0] == name {
            return Some((fields[2].parse().ok()?, fields[3].parse().ok()?));
        }
    }
    None
}

/// 数据库要降权到哪个用户；没有就报一条能照着做的错
fn service_user(name: &str, package: &str) -> (u32, u32) {
    lookup_user(name).unwrap_or_else(|| {
        panic!(
            "系统里没有 {name} 用户。{name} 拒绝以 root 运行，测试需要它来降权。\n\
             装一下：sudo apt-get install -y {package}"
        )
    })
}

/// 找不到可执行文件时给一条能照着做的提示。
///
/// **刻意 panic 而不是跳过**：静默跳过等于这些测试永远不跑而没人发现。
fn missing_help(binary: &str, e: &std::io::Error) -> String {
    format!(
        "找不到可执行的 {binary}（错误：{e}）。\n\
         \n\
         SQL 的集成测试需要真实的数据库实例，它们由测试自己拉起，不会静默跳过。\n\
         \n\
           Ubuntu/Debian：  sudo apt-get install -y postgresql mysql-server\n\
           macOS：          brew install postgresql mysql\n"
    )
}

/// 一个跑在随机端口上的数据库。
///
/// `_stdin` 是那个「父进程一死就收尾」的机制，**必须一直持有**。
struct Server {
    _stdin: ChildStdin,
    child: Child,
    port: u16,
}

impl Server {
    /// 启动一段 shell 脚本，降到指定用户下跑
    fn start(script: &str, uid: u32, gid: u32, port: u16, timeout: Duration, logfile: &Path, what: &str) -> Server {
        let mut child = Command::new("sh")
            .arg("-c")
            .arg(script)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            // 自成进程组：收尾时要能整组一起收拾（见 Drop）
            .process_group(0)
            .uid(uid)
            .gid(gid)
            .spawn()
            .unwrap_or_else(|e| panic!("启动 {what} 的 shell 失败：{e}"));

        let stdin = child.stdin.take().expect("应该是 piped 的");
        let server = Server { _stdin: stdin, child, port };

        if !wait_for_port(port, timeout) {
            let log = std::fs::read_to_string(logfile).unwrap_or_default();
            panic!("{what} 在 {timeout:?} 内没有就绪。日志：\n{log}");
        }

        server
    }

    fn port(&self) -> u16 {
        self.port
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        // **必须杀整个进程组**，不能只杀那个 `sh`：
        // 数据库是它 `&` 出来的子进程，杀 sh 会让数据库变成孤儿继续吃内存。
        // （真踩过：一次测试跑挂之后留下 6 个 mysqld，把 3.6G 的机器拖到只剩 500M。）
        //
        // 注意**不能**写 `Command::new("kill").arg("-KILL").arg("-12345")` ——
        // procps 的 kill 会把 `-12345` 当成选项解析，结果一个都没杀掉
        // （真踩过：以为修好了，重跑一次又漏了 12 个 mysqld）。
        // 借 shell 内建的 kill，它按约定把负数当进程组。
        let pgid = self.child.id();
        let _ = Command::new("sh")
            .arg("-c")
            .arg(format!("kill -9 -{pgid} 2>/dev/null; true"))
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();

        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn wait_for_port(port: u16, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    false
}

/// 那段「起服务 → 等 stdin EOF → 收尾」的脚本
fn reaper_script(start_command: &str, pid_var: &str, dir: &Path) -> String {
    format!(
        "{start_command} &\n\
         {pid_var}=$!\n\
         cat > /dev/null\n\
         kill -TERM ${pid_var} 2>/dev/null\n\
         sleep 1\n\
         kill -KILL ${pid_var} 2>/dev/null\n\
         rm -rf {dir}\n",
        dir = dir.display(),
    )
}

// ------------------------------------------------------------------ PostgreSQL

pub struct Postgres {
    server: Server,
}

impl Postgres {
    pub fn port(&self) -> u16 {
        self.server.port()
    }

    fn start() -> Postgres {
        let (uid, gid) = service_user("postgres", "postgresql");
        let dir = temp_dir("pg");
        let data_dir = dir.join("data");
        let logfile = dir.join("pg.log");

        let initdb = find_pg_binary("initdb");
        let postgres = find_pg_binary("postgres");

        std::fs::create_dir_all(&data_dir).expect("应该能建数据目录");
        // initdb 要求目录属主是它要降到的那个用户
        let chowned = Command::new("chown")
            .arg("-R")
            .arg("postgres:postgres")
            .arg(&dir)
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !chowned {
            panic!("把数据目录 chown 给 postgres 失败");
        }

        // initdb 是十几秒的一次性工作，放在 shell 外面同步跑，这样能立刻看到错误
        let status = Command::new(&initdb)
            .args(["-D"])
            .arg(&data_dir)
            .args(["-U", "postgres", "--auth=trust", "--encoding=UTF8"])
            .uid(uid)
            .gid(gid)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap_or_else(|e| panic!("{}", missing_help(&initdb, &e)));

        if !status.success() {
            panic!("initdb 失败了（{status}）");
        }

        let port = free_port();
        let start = format!(
            "{postgres} -D {data} -p {port} -k {dir} \
             -c fsync=off -c synchronous_commit=off -c full_page_writes=off \
             -c listen_addresses=127.0.0.1 > {log} 2>&1",
            data = data_dir.display(),
            dir = dir.display(),
            log = logfile.display(),
        );

        let server = Server::start(
            &reaper_script(&start, "PG", &dir),
            uid,
            gid,
            port,
            Duration::from_secs(40),
            &logfile,
            "PostgreSQL",
        );

        Postgres { server }
    }

    /// 测试进程共用的那一个实例。
    ///
    /// 启动失败之后**不再重试**：`OnceLock::get_or_init` 在闭包 panic 之后不会缓存，
    /// 于是每个后续用例都会再起一个实例 —— 上次就是这样起了一串互相抢内存的服务。
    pub fn shared() -> &'static Postgres {
        static SHARED: std::sync::OnceLock<Postgres> = std::sync::OnceLock::new();
        static ATTEMPTS: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

        SHARED.get_or_init(|| {
            if ATTEMPTS.fetch_add(1, std::sync::atomic::Ordering::SeqCst) > 0 {
                panic!("PostgreSQL 测试实例之前启动失败过，不再重试（避免把机器拖垮）");
            }
            Postgres::start()
        })
    }
}

/// 在 PATH 或 `/usr/lib/postgresql/*/bin` 里找 pg 的可执行文件
/// （apt 装的 pg 不会把这些放进 PATH，这是很常见的一个坑）
fn find_pg_binary(name: &str) -> String {
    if Command::new(name).arg("--version").output().is_ok() {
        return name.to_string();
    }

    if let Ok(entries) = std::fs::read_dir("/usr/lib/postgresql") {
        let mut versions: Vec<std::path::PathBuf> =
            entries.filter_map(|e| e.ok()).map(|e| e.path()).collect();
        versions.sort();
        versions.reverse(); // 目录名是 16 / 15 这种，倒序取最新的
        for dir in versions {
            let candidate = dir.join("bin").join(name);
            if candidate.exists() {
                return candidate.to_string_lossy().into_owned();
            }
        }
    }

    panic!(
        "{}",
        missing_help(
            name,
            &std::io::Error::other("不在 PATH，也不在 /usr/lib/postgresql/*/bin")
        )
    );
}

// ------------------------------------------------------------------ MySQL

pub struct Mysql {
    server: Server,
}

impl Mysql {
    pub fn port(&self) -> u16 {
        self.server.port()
    }

    fn start() -> Mysql {
        let (uid, gid) = service_user("mysql", "mysql-server");
        let dir = temp_dir("mysql");
        let data_dir = dir.join("data");
        let logfile = dir.join("mysql.log");
        let socket = dir.join("mysql.sock");

        std::fs::create_dir_all(&data_dir).expect("应该能建数据目录");
        let chowned = Command::new("chown")
            .arg("-R")
            .arg("mysql:mysql")
            .arg(&dir)
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !chowned {
            panic!("把数据目录 chown 给 mysql 失败");
        }

        // 初始化很慢（十几秒），同步跑，出错能立刻看见。
        // --initialize-insecure 建一个 root 无密码的实例，测试用正合适
        // （反正只监听 127.0.0.1）
        let status = Command::new("mysqld")
            .arg("--initialize-insecure")
            .arg(format!("--datadir={}", data_dir.display()))
            .uid(uid)
            .gid(gid)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap_or_else(|e| panic!("{}", missing_help("mysqld", &e)));

        if !status.success() {
            panic!("mysqld --initialize-insecure 失败了（{status}）");
        }

        let port = free_port();
        let start = format!(
            "mysqld --datadir={data} --port={port} --bind-address=127.0.0.1 \
             --socket={sock} --skip-mysqlx --skip-name-resolve > {log} 2>&1",
            data = data_dir.display(),
            sock = socket.display(),
            log = logfile.display(),
        );

        // 超时给得比 pg 长：MySQL 的初始化本来就慢
        let server = Server::start(
            &reaper_script(&start, "MY", &dir),
            uid,
            gid,
            port,
            Duration::from_secs(60),
            &logfile,
            "MySQL",
        );

        // 端口通了不等于能接受查询 —— 初始化没完时连得上但会被拒。
        // 注意这一段必须走 **unix socket**：`--initialize-insecure` 建的
        // root 是 `root@localhost`，只认 socket，TCP 会被 1130 拒掉
        wait_mysql_ready(&socket);

        // 建一个能从 TCP 连的账号。少了这一步，测试里所有走 127.0.0.1 的连接
        // 都会报 "Host '127.0.0.1' is not allowed to connect"
        mysql_exec_socket(
            &socket,
            "CREATE USER IF NOT EXISTS 'root'@'%' IDENTIFIED BY ''; \
             GRANT ALL PRIVILEGES ON *.* TO 'root'@'%' WITH GRANT OPTION; \
             FLUSH PRIVILEGES;",
        );

        Mysql { server }
    }

    /// 见 `Postgres::shared` 的说明：失败不重试
    pub fn shared() -> &'static Mysql {
        static SHARED: std::sync::OnceLock<Mysql> = std::sync::OnceLock::new();
        static ATTEMPTS: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

        SHARED.get_or_init(|| {
            if ATTEMPTS.fetch_add(1, std::sync::atomic::Ordering::SeqCst) > 0 {
                panic!("MySQL 测试实例之前启动失败过，不再重试（避免把机器拖垮）");
            }
            Mysql::start()
        })
    }
}

fn wait_mysql_ready(socket: &Path) {
    let deadline = Instant::now() + Duration::from_secs(60);
    let mut last = String::new();

    while Instant::now() < deadline {
        let output = Command::new("mysql")
            .arg(format!("--socket={}", socket.display()))
            .args(["-u", "root", "-e", "SELECT 1"])
            .output();

        match output {
            Ok(output) if output.status.success() => return,
            Ok(output) => last = String::from_utf8_lossy(&output.stderr).into_owned(),
            Err(e) => last = e.to_string(),
        }

        std::thread::sleep(Duration::from_millis(300));
    }

    panic!("MySQL 起来之后 60 秒内仍然不接受查询。最后一条错误：{last}");
}

/// 走 unix socket 执行一段 SQL（只有它能以 root@localhost 身份连上）
fn mysql_exec_socket(socket: &Path, sql: &str) {
    let output = Command::new("mysql")
        .arg(format!("--socket={}", socket.display()))
        .args(["-u", "root", "-e", sql])
        .output()
        .expect("应该能跑 mysql 客户端");

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        panic!("socket 上执行 SQL 失败：{sql}\n{stderr}");
    }
}

fn mysql_args(port: u16) -> Vec<String> {
    vec![
        "--protocol=TCP".into(),
        "-h".into(),
        "127.0.0.1".into(),
        "-P".into(),
        port.to_string(),
        "-u".into(),
        "root".into(),
    ]
}

/// 往服务里灌一段 SQL（走 mysql 命令行客户端）
pub fn mysql_exec(port: u16, sql: &str) {
    let output = Command::new("mysql")
        .args(mysql_args(port))
        .arg("-e")
        .arg(sql)
        .output()
        .expect("应该能跑 mysql 客户端");

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        panic!("灌数据失败：{sql}\n{stderr}");
    }
}
