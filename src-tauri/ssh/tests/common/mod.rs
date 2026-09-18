//! 测试用的**进程内 SSH 服务端**。
//!
//! # 为什么自己当服务端，而不是起一个真 sshd
//!
//! russh 既能当客户端也能当服务端，所以能在一个进程里把整条链路跑通：
//! 真的 TCP、真的密钥交换、真的认证、真的通道。好处有三条，都很实在：
//!
//! 1. **零系统依赖** —— 不需要机器上装了 sshd、不需要 root、不碰系统用户。
//!    所以这些测试能进 CI，而打真 sshd 的那组不行。
//! 2. **能制造真实环境几乎造不出来的情况** —— 尤其**「主机密钥变了」**：
//!    换一把主机密钥重启就行。真 sshd 要复现这个得去改服务器配置。
//! 3. **能断言服务端到底收到了什么** —— PTY 报的尺寸、resize、原始输入字节。
//!    这些在真 sshd 那边只能从行为上反推。
//!
//! ⚠️ **但它不是「真服务器」**：两端都是 russh，同一个库里的同一类 bug 会
//! 在两边同时存在而测试照样绿。所以还有一组打真 OpenSSH 的测试
//! （`tests/openssh.rs`）—— 那个才负责回答「对真服务器能不能用」。
//!
//! # 一把主机密钥，一次会话，收摊
//!
//! 每个测试起一个自己的服务端，`Drop` 时 abort 掉任务、监听套接字随之关闭。
//! 端口用 `bind(:0)` 让内核分配 —— 比「先探测一个空闲端口再绑」少一个竞态。

#![allow(dead_code)] // 每个测试二进制只用到这里的一部分

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use russh::keys::{Algorithm, PrivateKey, PublicKey};
use russh::server::{Auth, Config, Handler, Msg, Server, Session};
use russh::{Channel, ChannelId, CryptoVec};

/// 服务端看见的东西。测试靠它断言「客户端到底发了什么」
#[derive(Debug, Default, Clone)]
pub struct Seen {
    /// 每一次密码认证尝试（用户名，密码），失败的也在
    pub password_attempts: Vec<(String, String)>,
    /// 每一次公钥认证尝试（公钥指纹）
    pub publickey_attempts: Vec<String>,
    /// PTY 请求的参数。收到过就是 `Some`
    pub pty: Option<PtyRequest>,
    /// 每一次 resize
    pub resizes: Vec<(u32, u32)>,
    /// 客户端发上来的原始字节
    pub input: Vec<u8>,
    /// shell 请求次数
    pub shells: usize,
    /// 收到过 EOF 的次数
    pub eofs: usize,
    /// 通道被关掉的次数
    pub closes: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PtyRequest {
    pub term: String,
    pub cols: u32,
    pub rows: u32,
}

impl Seen {
    /// 收到的输入按 UTF-8 解出来（测试里发的基本都是文本）
    pub fn input_text(&self) -> String {
        String::from_utf8_lossy(&self.input).into_owned()
    }
}

/// 服务端的行为开关
#[derive(Clone)]
pub struct Options {
    /// 接受的用户名和密码。`None` 表示不接受密码认证
    pub password: Option<(String, String)>,
    /// 接受的公钥。`None` 表示不接受公钥认证
    pub public_key: Option<PublicKey>,
    /// 收到 shell 请求时先吐一段横幅
    pub banner: String,
    /// 把客户端发的字节原样回显（模拟终端里的 echo）
    pub echo: bool,
    /// 收到 PTY 请求时回 `Failure` 而不是 `Success` ——
    /// 用来测「服务端禁用了终端」这条分支
    pub reject_pty: bool,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            password: Some(("tester".to_string(), "secret".to_string())),
            public_key: None,
            banner: "hello from the test server\r\n".to_string(),
            echo: true,
            reject_pty: false,
        }
    }
}

impl Options {
    pub fn with_password(user: &str, password: &str) -> Self {
        Self {
            password: Some((user.to_string(), password.to_string())),
            ..Default::default()
        }
    }

    pub fn no_password(mut self) -> Self {
        self.password = None;
        self
    }

    pub fn with_public_key(mut self, key: &PublicKey) -> Self {
        self.public_key = Some(key.clone());
        self
    }

    pub fn reject_pty(mut self) -> Self {
        self.reject_pty = true;
        self
    }

    pub fn silent(mut self) -> Self {
        self.banner = String::new();
        self.echo = false;
        self
    }
}

/// 跑着的测试服务端。`Drop` 时收摊
pub struct TestSshServer {
    pub port: u16,
    /// 服务端的主机密钥。测试要用它算期望的指纹
    pub host_key: PrivateKey,
    seen: Arc<Mutex<Seen>>,
    task: tokio::task::JoinHandle<()>,
}

impl TestSshServer {
    pub async fn start() -> Self {
        Self::start_with(Options::default()).await
    }

    pub async fn start_with(options: Options) -> Self {
        // 每次都新生成一把主机密钥而不是写死一个常量：
        // 测试之间因此天然互不干扰（「密钥变了」那组测试尤其依赖这一点，
        // 写死的话它们会互相污染）。rand 是从 russh 的依赖树里来的，
        // 没有为测试新增任何东西。
        let host_key = PrivateKey::random(&mut rand::thread_rng(), Algorithm::Ed25519)
            .expect("生成测试主机密钥");

        Self::start_with_key(options, host_key).await
    }

    /// 用指定的主机密钥起服务端。
    ///
    /// 「密钥变了」那组测试用它：先用密钥 A 连一次并信任，
    /// 再用密钥 B 起一个**同端口**的服务端重连。
    pub async fn start_with_key(options: Options, host_key: PrivateKey) -> Self {
        let config = Arc::new(Config {
            keys: vec![host_key.clone()],
            // 默认的 methods 只开公钥，密码认证会被直接拒掉 ——
            // 那样测出来的「认证失败」是假象，不是我们想测的东西
            methods: russh::MethodSet::all(),
            ..Default::default()
        });

        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("绑定测试端口");
        let port = listener
            .local_addr()
            .expect("读取测试端口")
            .port();

        let seen = Arc::new(Mutex::new(Seen::default()));
        let server = TestServer {
            options,
            seen: Arc::clone(&seen),
        };

        // run_on_socket 拿到的是我们**已经绑好**的监听套接字，
        // 所以端口是内核分配的那一刻就确定的，中间没有「先探测再绑定」的窗口。
        //
        // ⚠️ `server` 和 `listener` 必须**move 进**这个异步块，
        // 不能在外面声明再借进来 —— `run_on_socket` 会同时借这两样，
        // 借出来的 future 就得活到 `'static` 才塞得进 `tokio::spawn`。
        // 移进来之后借用关系全在块内，问题自然消失。
        let task = tokio::spawn(async move {
            let mut server = server;
            let running = server.run_on_socket(config, &listener);
            let _ = running.await;
        });

        Self {
            port,
            host_key,
            seen,
            task,
        }
    }

    pub fn seen(&self) -> Seen {
        self.seen.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// 服务端主机密钥的指纹，格式和 `ssh-keyscan` 一致
    pub fn fingerprint(&self) -> String {
        use russh::keys::HashAlg;
        self.host_key
            .public_key()
            .fingerprint(HashAlg::Sha256)
            .to_string()
    }
}

impl Drop for TestSshServer {
    fn drop(&mut self) {
        // abort 掉任务，监听套接字跟着关。
        // 不用「发个信号让它优雅退出」—— 测试里没有要保全的状态
        self.task.abort();
    }
}

// ------------------------------------------------------------------ 服务端

struct TestServer {
    options: Options,
    seen: Arc<Mutex<Seen>>,
}

impl Server for TestServer {
    type Handler = TestHandler;

    fn new_client(&mut self, _peer_addr: Option<SocketAddr>) -> Self::Handler {
        TestHandler {
            options: self.options.clone(),
            seen: Arc::clone(&self.seen),
            channel: None,
        }
    }
}

struct TestHandler {
    options: Options,
    seen: Arc<Mutex<Seen>>,
    /// 打开的会话通道。第一次 `channel_open_session` 时记下来，
    /// 后面 shell/pty/data 都往它上面回
    channel: Option<Channel<Msg>>,
}

impl TestHandler {
    fn record(&self, f: impl FnOnce(&mut Seen)) {
        let mut seen = self.seen.lock().unwrap_or_else(|e| e.into_inner());
        f(&mut seen);
    }
}

impl Handler for TestHandler {
    type Error = russh::Error;

    async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
        self.record(|s| {
            s.password_attempts
                .push((user.to_string(), password.to_string()))
        });

        match &self.options.password {
            Some((u, p)) if u == user && p == password => Ok(Auth::Accept),
            _ => Ok(Auth::reject()),
        }
    }

    async fn auth_publickey(
        &mut self,
        _user: &str,
        public_key: &PublicKey,
    ) -> Result<Auth, Self::Error> {
        use russh::keys::HashAlg;
        self.record(|s| {
            s.publickey_attempts
                .push(public_key.fingerprint(HashAlg::Sha256).to_string())
        });

        match &self.options.public_key {
            // 只比公钥本身；签名由 russh 自己验（它保证拒绝也是常数时间）
            Some(expected) if expected == public_key => Ok(Auth::Accept),
            _ => Ok(Auth::reject()),
        }
    }

    async fn channel_open_session(
        &mut self,
        channel: Channel<Msg>,
        _session: &mut Session,
    ) -> Result<bool, Self::Error> {
        self.channel = Some(channel);
        Ok(true)
    }

    async fn pty_request(
        &mut self,
        channel: ChannelId,
        term: &str,
        col_width: u32,
        row_height: u32,
        _pix_width: u32,
        _pix_height: u32,
        _modes: &[(russh::Pty, u32)],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.record(|s| {
            s.pty = Some(PtyRequest {
                term: term.to_string(),
                cols: col_width,
                rows: row_height,
            })
        });

        // want_reply 传了 true，就**必须**回一个成功或失败 ——
        // 不回的话客户端会一直等到超时
        if self.options.reject_pty {
            session.channel_failure(channel)?;
        } else {
            session.channel_success(channel)?;
        }
        Ok(())
    }

    async fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.record(|s| s.shells += 1);

        if !self.options.banner.is_empty() {
            session.data(channel, CryptoVec::from_slice(self.options.banner.as_bytes()))?;
        }
        session.channel_success(channel)?;
        Ok(())
    }

    async fn data(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.record(|s| s.input.extend_from_slice(data));

        if self.options.echo {
            session.data(channel, CryptoVec::from_slice(data))?;
        }

        // 收到 "exit" 就按正常退出走完整个流程：
        // 退出码 → 通道关闭。客户端那条链路（退出码显示、会话收尾）才有得测
        if contains(data, b"exit") {
            session.exit_status_request(channel, 7)?;
            session.close(channel)?;
        }
        Ok(())
    }

    async fn window_change_request(
        &mut self,
        _channel: ChannelId,
        col_width: u32,
        row_height: u32,
        _pix_width: u32,
        _pix_height: u32,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.record(|s| s.resizes.push((col_width, row_height)));
        Ok(())
    }

    async fn channel_eof(
        &mut self,
        _channel: ChannelId,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.record(|s| s.eofs += 1);
        Ok(())
    }

    async fn channel_close(
        &mut self,
        _channel: ChannelId,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.record(|s| s.closes += 1);
        Ok(())
    }
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

// ------------------------------------------------------------------ 辅助

/// 一个用完就删的临时目录。
///
/// 手写而不是拉 `tempfile`：和 `devtoolkit-redis` / `devtoolkit-sql` 的测试夹具
/// 保持一致 —— 那两处也是手写的，理由同样是「就为了这一个类型不值得加依赖」。
pub struct TempDir {
    pub path: std::path::PathBuf,
}

impl TempDir {
    pub fn new(tag: &str) -> Self {
        // 加进程 id 和纳秒：同一台机器上并行跑多个测试二进制时不撞车
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!(
            "devtoolkit-ssh-test-{tag}-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&path).expect("建临时目录");
        Self { path }
    }

    pub fn join(&self, name: &str) -> std::path::PathBuf {
        self.path.join(name)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

/// 把一把私钥写成文件，返回路径。
///
/// 客户端那条路收的是**路径**而不是密钥对象（真实使用就是从磁盘读的），
/// 所以测试也必须真落盘，不能绕过这一步 —— 绕过的话「路径写错」「口令不对」
/// 这两类错误的处理就没被覆盖。
pub fn write_key(dir: &TempDir, name: &str, key: &PrivateKey, passphrase: Option<&str>) -> String {
    use russh::keys::ssh_key::LineEnding;

    let pem = if let Some(pass) = passphrase {
        key.encrypt(&mut rand::thread_rng(), pass)
            .expect("加密测试私钥")
            .to_openssh(LineEnding::LF)
            .expect("导出加密私钥")
            .to_string()
    } else {
        key.to_openssh(LineEnding::LF)
            .expect("导出私钥")
            .to_string()
    };

    let path = dir.join(name);
    std::fs::write(&path, pem).expect("写私钥文件");
    path.to_string_lossy().into_owned()
}
