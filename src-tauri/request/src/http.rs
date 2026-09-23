//! HTTP 传输层：**任意方法**，响应体**一块一块**地送回来，响应头完整保留。
//!
//! # 和它上一个版本（在助手里时）的差别
//!
//! 那一版是给「POST 一段 JSON 拿 SSE 流」定制的：方法写死 POST、**响应头丢掉**、
//! 请求体只能是 UTF-8 字符串、TLS 强制校验。现在要同时服务「接口调试」模块，
//! 所以四样都泛化了 —— 但**默认值仍然是助手要的行为**，助手那边一个字没变。
//!
//! # Rust 侧只有一条路：永远流式
//!
//! 「整块拿到」是**消费者选择**（[`HttpResponse::read_all`]），不是另一条代码路径。
//! 两条路会漂移，而它们漂移的症状是「流式那边好好的、非流式那边少读了几块」。
//!
//! # 隔离边界
//!
//! 这是唯一碰 hyper / socket 的文件。TLS 在 [`crate::tls`]（HTTP 和 WS 共用），
//! SSE 解析在 [`crate::sse`]（纯字节状态机）。

use std::time::{Duration, Instant};

use tokio::sync::mpsc;

/// 响应体的一块字节，或者一个传输错误。
pub type Chunk = Result<Vec<u8>, HttpError>;

/// 流式响应里，**两块数据之间**最多等多久。
///
/// ⚠️ 这是「多久算对端不说话了」的分界线，**不是**「一次请求总共能跑多久」——
/// 一次长回答流好几分钟是正常的，不正常的是一直**没有任何新数据**。
/// 拿总时长当上限会把慢模型误杀成网络问题。
///
/// 90 秒是刻意宽松的：有些 OpenAI 兼容网关不是真流式（攒完整个回答才吐），
/// 首字节之前沉默几十秒很正常。
pub const DEFAULT_IDLE_TIMEOUT: Duration = Duration::from_secs(90);

/// 一次请求的可调项。**默认值 = 助手那一版的行为。**
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestOptions {
    /// 建连 + TLS 握手 + 等响应头 的上限。
    pub timeout: Duration,
    /// 响应体两块数据之间的上限。见 [`DEFAULT_IDLE_TIMEOUT`]。
    pub idle_timeout: Duration,
    /// 跟随 3xx 跳转。**默认关**（助手那版没有重定向，行为不变）。
    pub follow_redirects: bool,
    /// 最多跟几跳（`follow_redirects` 打开时才用）。
    pub max_redirects: u8,
    /// ⚠️ **跳过证书链验证。** 只给「自签证书的内网服务」这种显式场景用，
    /// 界面上要有红字提示。见 [`crate::tls::client_config`] —— 那里说明了
    /// 它**只跳过链、不跳过签名**。
    pub accept_invalid_certs: bool,
}

impl Default for RequestOptions {
    fn default() -> Self {
        RequestOptions {
            timeout: Duration::from_secs(30),
            idle_timeout: DEFAULT_IDLE_TIMEOUT,
            follow_redirects: false,
            max_redirects: 5,
            accept_invalid_certs: false,
        }
    }
}

/// 一个要发的请求。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpRequest {
    /// `"GET"` / `"post"` / … —— **大小写不敏感**，发出去之前规范成大写。
    ///
    /// ⚠️ **不认识的扩展方法照发**（`PROPFIND`、各家自己造的），只有
    /// 「不是合法 token」才报 [`ErrorKind::Invalid`]。理由写在
    /// [`normalize_method`] 上：白名单在这里只会挡住调试器该支持的东西。
    ///
    /// ⚠️ 用 `String` 而不是 `hyper::Method`：不让第三方类型出现在公开 API 上。
    pub method: String,
    /// 完整地址，比如 `https://api.anthropic.com/v1/messages`。
    pub url: String,
    /// 请求头。**顺序原样发出去**（有的网关对顺序敏感，而且确定性强一点没坏处）。
    /// **同名头允许多条**（`Set-Cookie` / `Accept` 那种）。
    pub headers: Vec<(String, String)>,
    /// 请求体，**任意字节**（调试器要发二进制、表单、文件）。空 = 不带 body。
    pub body: Vec<u8>,
    /// 可调项。
    pub options: RequestOptions,
}

impl HttpRequest {
    /// 两个 provider 用的那条捷径：POST 一段 UTF-8 文本。
    ///
    /// 泛化之后 `build_request` 只要改这一行 —— 这正是把它留成构造器的理由。
    pub fn post(url: impl Into<String>, headers: Vec<(String, String)>, body: String) -> Self {
        HttpRequest {
            method: "POST".into(),
            url: url.into(),
            headers,
            body: body.into_bytes(),
            options: RequestOptions::default(),
        }
    }
}

/// 一次跳转。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Redirect {
    /// 那一跳的状态码。
    pub status: u16,
    /// 从哪儿。
    pub from: String,
    /// 到哪儿。
    pub to: String,
}

/// 拿到响应头之后的一切。
#[derive(Debug)]
pub struct HttpResponse {
    /// 状态码。
    pub status: u16,
    /// 原因短语（`"OK"`）。拿不到就是空串。
    pub reason: String,
    /// 响应头。**保序，重复的都在**（调试器要原样看）。
    pub headers: Vec<(String, String)>,
    /// 跟随跳转之后的最终地址。
    pub final_url: String,
    /// 经过的每一跳（调试器要画出来）。
    pub redirects: Vec<Redirect>,
    /// `"HTTP/1.1"`。
    pub http_version: String,
    /// 从发出到响应头到手。
    pub ttfb: Duration,
    /// 响应体。**永远是流** —— 4xx/5xx 也有
    ///（「非 2xx 的 body 当成 error_body」是**助手**的判断，不是传输层的）。
    pub body: mpsc::Receiver<Chunk>,
}

impl HttpResponse {
    /// 2xx。
    pub fn is_ok(&self) -> bool {
        (200..300).contains(&self.status)
    }

    /// 第一个同名头（**大小写不敏感**）。
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    /// 全部同名头。
    pub fn headers_of<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a str> {
        self.headers
            .iter()
            .filter(move |(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    /// 这是一个 SSE 流吗（调试器据此决定要不要多显示一个「流式」页签）。
    pub fn is_sse(&self) -> bool {
        self.header("content-type")
            .is_some_and(|v| v.to_ascii_lowercase().contains("text/event-stream"))
    }

    /// **把流读干** —— 「整块拿到」就是这个（见模块文档）。
    ///
    /// `max` 是字节上限：到了就停手并标 `truncated`（**不再往下读**，
    /// 而不是读完再截 —— 后者会在一个 1 GB 的下载上把内存吃光）。
    pub async fn read_all(mut self, max: usize) -> Result<Body, HttpError> {
        let started = Instant::now();
        let mut bytes = Vec::new();
        let mut truncated = false;

        while let Some(chunk) = self.body.recv().await {
            let chunk = chunk?;
            if bytes.len() + chunk.len() > max {
                bytes.extend_from_slice(&chunk[..max.saturating_sub(bytes.len())]);
                truncated = true;
                break;
            }
            bytes.extend_from_slice(&chunk);
        }

        Ok(Body {
            bytes,
            truncated,
            elapsed: started.elapsed(),
        })
    }
}

/// [`HttpResponse::read_all`] 的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Body {
    /// 内容。
    pub bytes: Vec<u8>,
    /// 是不是撞上了上限。
    pub truncated: bool,
    /// 读它花了多久（不含等响应头那一段）。
    pub elapsed: Duration,
}

/// 出错的**种类**。
///
/// 分成枚举而不是一个 `retryable` 布尔：调用方除了「要不要重发」之外还想知道
/// 「该说什么」（调试器要把「证书不对」和「连不上」分开显示），而布尔装不下这件事。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorKind {
    /// 地址 / 方法 / 头不合法 —— 用户改一下就能好。
    Invalid,
    /// 连不上、连接被重置、DNS 解析不了。
    Connect,
    /// 证书不对 / 握手失败。
    Tls,
    /// 建连 / 等响应头超时。
    Timeout,
    /// 连上了，但对端不再发数据（见 [`DEFAULT_IDLE_TIMEOUT`]）。
    Idle,
    /// 跳转次数超了 / `Location` 看不懂。
    Redirect,
    /// 协议层错（对端不是 HTTP、chunked 坏了）。
    Protocol,
    /// 读响应体时断了。
    Body,
}

/// 传输层出错。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpError {
    /// 哪一类。
    pub kind: ErrorKind,
    /// 给用户看的一句话（中文，可直接显示）。
    pub message: String,
}

impl HttpError {
    /// 造一个（各 kind 的短构造器见下）。
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        HttpError {
            kind,
            message: message.into(),
        }
    }

    /// 地址 / 参数不合法。
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Invalid, message)
    }
    /// 连不上。
    pub fn connect(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Connect, message)
    }
    /// TLS 出问题。
    pub fn tls(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Tls, message)
    }
    /// 超时。
    pub fn timeout(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Timeout, message)
    }
    /// 对端不再发数据。
    pub fn idle(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Idle, message)
    }
    /// 跳转的问题。
    pub fn redirect(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Redirect, message)
    }
    /// 协议层错。
    pub fn protocol(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Protocol, message)
    }
    /// 读 body 时断了。
    pub fn body(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Body, message)
    }

    /// 值不值得重发。
    ///
    /// ⚠️ **这**是助手 `ProviderError.retryable` 的来源。判定依据从
    /// 「构造器选哪一个」变成「kind 是哪一个」—— 知识仍然只有一处。
    ///
    /// `Invalid` / `Tls` / `Redirect` **不重发**：地址写错了重发一百次也一样，
    /// 证书不对更是一样（而且那种错要说给用户听，不能靠重发掩盖）。
    pub fn is_retryable(&self) -> bool {
        matches!(
            self.kind,
            ErrorKind::Connect
                | ErrorKind::Timeout
                | ErrorKind::Idle
                | ErrorKind::Protocol
                | ErrorKind::Body
        )
    }
}

impl std::fmt::Display for HttpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for HttpError {}

/// 发请求的口子（真实现见 [`HyperTransport`]；测试里塞假的）。
pub trait HttpTransport: Send + Sync {
    /// 发一次，拿回响应头 + 一条响应体的流。
    fn send(
        &self,
        request: HttpRequest,
    ) -> impl std::future::Future<Output = Result<HttpResponse, HttpError>> + Send;
}

/// 状态码值不值得重发（429 / 5xx）。
///
/// ⚠️ 这是 **HTTP 状态**语义，和 [`HttpError::is_retryable`]（传输层语义）
/// 是两件事，两个可能都要用。
pub fn status_is_retryable(status: u16) -> bool {
    status == 429 || (500..600).contains(&status)
}

/// 真的发请求的那个实现。
#[derive(Debug, Clone, Default)]
pub struct HyperTransport;

impl HyperTransport {
    /// 建一个。
    pub fn new() -> Self {
        HyperTransport
    }
}

impl HttpTransport for HyperTransport {
    async fn send(&self, request: HttpRequest) -> Result<HttpResponse, HttpError> {
        // 跳转要重新发，所以整件事包在一个循环里 —— 但**每一跳都是完整的
        // 「建连 → 发 → 拿响应头」**，不是在同一连接上重来。
        let mut current = request;
        let mut redirects: Vec<Redirect> = Vec::new();

        loop {
            let response = send_once(&current).await?;

            // 不是 3xx（或者用户没开跳转）→ 到此为止。
            if !current.options.follow_redirects || !(300..400).contains(&response.status) {
                return Ok(HttpResponse {
                    redirects,
                    ..response
                });
            }

            let Some(location) = response.header("location").map(str::to_string) else {
                // 3xx 却没有 Location：当成最终响应交出去（有些服务端就是这么怪）
                return Ok(HttpResponse {
                    redirects,
                    ..response
                });
            };

            if redirects.len() >= current.options.max_redirects as usize {
                let chain: Vec<String> = redirects
                    .iter()
                    .map(|r| format!("{} → {}", r.from, r.to))
                    .collect();
                return Err(HttpError::redirect(format!(
                    "跳转超过 {} 次，停手了：{} → {}",
                    current.options.max_redirects,
                    chain.join("、"),
                    location
                )));
            }

            let from = current.url.clone();
            let to = resolve_location(&from, &location)?;
            redirects.push(Redirect {
                status: response.status,
                from: from.clone(),
                to: to.clone(),
            });

            // ⚠️ **跨主机跳转要丢掉凭据。**
            //
            // `Authorization` / `Cookie` 是发给**那一台**机器的，跟着跳到别处
            // 就是把用户的 token 交给第三方。curl 和 Postman 都这么做。
            // ⚠️ 这是个安全默认，有专门的测试盯着。
            let cross_host = host_of(&from) != host_of(&to);

            let mut headers: Vec<(String, String)> = current
                .headers
                .iter()
                .filter(|(k, _)| {
                    !cross_host
                        || !matches!(
                            k.to_ascii_lowercase().as_str(),
                            "authorization" | "cookie" | "proxy-authorization"
                        )
                })
                .cloned()
                .collect();

            // ⚠️ 301/302/303 按历史惯例改成 GET 并丢掉 body；
            // 307/308 是「原样再来一遍」，method 和 body 都不动。
            let (method, body) = match response.status {
                307 | 308 => (current.method.clone(), current.body.clone()),
                _ => {
                    headers.retain(|(k, _)| {
                        let k = k.to_ascii_lowercase();
                        k != "content-type" && k != "content-length"
                    });
                    ("GET".to_string(), Vec::new())
                }
            };

            current = HttpRequest {
                method,
                url: to,
                headers,
                body,
                options: current.options.clone(),
            };
        }
    }
}

/// 发**一次**（一跳），不处理重定向。
async fn send_once(request: &HttpRequest) -> Result<HttpResponse, HttpError> {
    let method = normalize_method(&request.method)?;
    let target = Endpoint::parse(&request.url)?;
    let options = &request.options;

    // ① 建连（带超时 —— 没有它的话，打到一个不通的地址会一直挂着）
    let stream = tokio::time::timeout(
        options.timeout,
        tokio::net::TcpStream::connect((target.host.as_str(), target.port)),
    )
    .await
    .map_err(|_| HttpError::timeout("连接超时"))?
    .map_err(|e| HttpError::connect(format!("连不上 {}：{e}", target.host)))?;

    // 关掉 Nagle：请求体一般一次写完，等它攒包只会让首字节更慢。
    let _ = stream.set_nodelay(true);

    // ② 需要的话套一层 TLS。⚠️ 配置从 `tls.rs` 来（HTTP 和 WS 共用那一份）。
    let io = if target.tls {
        let config = crate::tls::client_config(options.accept_invalid_certs)
            .map_err(HttpError::tls)?;
        let connector = tokio_rustls::TlsConnector::from(config);
        let server_name = rustls::pki_types::ServerName::try_from(target.host.clone())
            .map_err(|_| HttpError::invalid(format!("主机名不对：{}", target.host)))?;
        let stream = tokio::time::timeout(options.timeout, connector.connect(server_name, stream))
            .await
            .map_err(|_| HttpError::timeout("TLS 握手超时"))?
            .map_err(|e| HttpError::tls(format!("TLS 握手失败：{e}")))?;
        EitherIo::Tls(Box::new(stream))
    } else {
        EitherIo::Plain(stream)
    };

    // ③ 发。两条路的泛型不同但代码一样 —— 用宏而不是抄一遍（抄的话超时和
    //    错误文案迟早会走偏）。
    macro_rules! send_over {
        ($io:expr) => {{
            let io = hyper_util::rt::TokioIo::new($io);
            let (mut sender, conn) = hyper::client::conn::http1::handshake(io)
                .await
                .map_err(|e| HttpError::protocol(format!("握手失败：{e}")))?;

            // 连接必须有人驱动，否则请求发不出去。它随着 sender 一起结束。
            tokio::spawn(async move {
                let _ = conn.await;
            });

            let started = Instant::now();
            let mut builder = hyper::Request::builder()
                .method(method.clone())
                .uri(&target.path_and_query());

            // ⚠️ **Host 得自己加**（hyper 不会补，它只看 URI 里的路径）。
            // 少了这一条，真的服务端一律回
            // `400 Bad Request: missing required Host header`。
            //
            // ⚠️ 但**用户显式给的那条要覆盖我们算的**（调试器就是要测虚拟主机：
            // 同一个 IP、不同的 Host）。`builder.header` 是**追加**语义，
            // 所以有用户那条时**我们一个字都不写** —— 写下去就是两条 `Host`，
            // 而两条 Host 是请求走私那一类的东西，严格的服务端会直接拒。
            // 这个坑是 `request/tests/http_over_socket.rs` 里那条「用户给的 host」
            // 抓出来的（原来这里是先无条件加我们的、再追加用户的 ✗）。
            if !request
                .headers
                .iter()
                .any(|(k, _)| k.eq_ignore_ascii_case("host"))
            {
                builder = builder.header(hyper::header::HOST, target.host_header());
            }
            for (k, v) in sanitize_headers(&request.headers) {
                builder = builder.header(k, v);
            }
            let req = builder
                .body(make_body(&request.body))
                .map_err(|e| HttpError::invalid(format!("请求编不出来：{e}")))?;

            let response = tokio::time::timeout(options.timeout, sender.send_request(req))
                .await
                .map_err(|_| HttpError::timeout("等响应头超时"))?
                .map_err(|e| HttpError::protocol(format!("请求失败：{e}")))?;
            let ttfb = started.elapsed();

            let status = response.status().as_u16();
            let reason = response
                .status()
                .canonical_reason()
                .unwrap_or_default()
                .to_string();
            let http_version = format!("{:?}", response.version());
            // ⚠️ 保序 + 重复的都在（`append` 的语义就是这样）——
            // 调试器要把 `set-cookie` 那几条原样列出来。
            let headers: Vec<(String, String)> = response
                .headers()
                .iter()
                .map(|(k, v)| {
                    (
                        k.as_str().to_string(),
                        String::from_utf8_lossy(v.as_bytes()).into_owned(),
                    )
                })
                .collect();

            let (tx, rx) = mpsc::channel::<Chunk>(64);
            // ⚠️ 转发任务里**不能借 `options`** —— 它借的是 `request`，
            // 而 `request` 活不过这个函数（任务要求 `'static`）。
            // 把一个 `Duration` 拷进去，别整个 `RequestOptions`（没必要）。
            let idle_timeout = options.idle_timeout;

            // ⚠️ 逐帧读，**收到一块就发一块** —— 这是流式能成立的全部原因。
            //
            // 注意 4xx/5xx **也走这条路**：传输层不认识「业务失败」，
            // 那是调用方的判断（助手把非 2xx 的 body 当 error_body，
            // 调试器把 500 画成一条正常的结果 —— 两边要求不一样）。
            tokio::spawn(async move {
                use http_body_util::BodyExt;
                let mut body = response.into_body();
                loop {
                    // ⚠️ **空闲超时**。
                    //
                    // 没有它的话有这么一条路：对端连上了、响应头也回来了，
                    // 然后**再也不发数据、也不关连接**。这个循环会永远等下去，
                    // 而用户那边只有一个「正在跑」的界面 —— **一个字都不报**。
                    //
                    // 超时必须**报出来**，不能只是安静地退出循环：
                    // 安静退出在上层看来和「对端正常关了连接」一模一样，
                    // 而那条路会被当成**一轮完整的响应**（少了半截却当成成功）。
                    let frame = match tokio::time::timeout(idle_timeout, body.frame()).await {
                        Ok(Some(f)) => f,
                        Ok(None) => break, // 对端正常读完并关了连接
                        Err(_) => {
                            let _ = tx
                                .send(Err(HttpError::idle(format!(
                                    "连上了，但对端 {} 秒没再回数据（网络中间断了，或者这个网关不支持流式）",
                                    idle_timeout.as_secs()
                                ))))
                                .await;
                            break;
                        }
                    };
                    let frame = match frame {
                        Ok(f) => f,
                        Err(e) => {
                            // ⚠️ **读到一半断了要报出来**，不能安静 break。
                            //
                            // 安静 break 在上层看来和「对端正常读完并关了连接」
                            // 一模一样 —— 而那会被当成一轮**完整的**响应
                            // （少了半截却当成成功）。这条和上面那条空闲超时是
                            // 同一个道理，只是触发的方式不同（那个是「不说话」，
                            // 这个是「话说一半就走了」）。
                            //
                            // ⚠️ 消费者**可以**选择忽略它：SSE 那种场景里
                            // 「内容本身完整吗」是靠协议层判断的（很多网关关了
                            // socket 也不发 chunked 的终止符）。传输层只说
                            // 「字节流是怎么结束的」，那才是它该说的话。
                            let _ = tx
                                .send(Err(HttpError::body(format!("读响应体时断了：{e}"))))
                                .await;
                            break;
                        }
                    };
                    if let Some(data) = frame.data_ref() {
                        // 接收端没了（用户取消了）→ 别再读了。
                        if tx.send(Ok(data.to_vec())).await.is_err() {
                            break;
                        }
                    }
                }
            });

            return Ok(HttpResponse {
                status,
                reason,
                headers,
                final_url: request.url.clone(),
                redirects: Vec::new(), // 由调用方填（它才知道经过了几跳）
                http_version,
                ttfb,
                body: rx,
            });
        }};
    }

    match io {
        EitherIo::Tls(s) => send_over!(*s),
        EitherIo::Plain(s) => send_over!(s),
    }
}

/// 两条 IO 路（TLS / 明文）合成一个类型，好让上面的宏只写一遍。
enum EitherIo {
    Tls(Box<tokio_rustls::client::TlsStream<tokio::net::TcpStream>>),
    Plain(tokio::net::TcpStream),
}

/// 方法名规范化：大小写不敏感地转成大写，非法字符报错（**不猜**）。
///
/// ⚠️ **没有方法白名单** —— `PROPFIND` / `PURGE` / 各家自己造的扩展方法
/// 都是合法的 HTTP，真的有服务端在用。「认不出来就拒」在这里是错的：
/// 用户拿调试器打的就是那些平时用不到的方法。
///
/// 挡的是**不是 token** 的输入（带空格、中文、控制字符）——
/// 那些发出去只会得到一个看不懂的解析错，不如现在就说是哪儿不对。
fn normalize_method(raw: &str) -> Result<hyper::Method, HttpError> {
    let upper = raw.trim().to_ascii_uppercase();
    hyper::Method::from_bytes(upper.as_bytes()).map_err(|_| {
        HttpError::invalid(format!(
            "「{raw}」不是合法的 HTTP 方法名（不能有空格、中文这类字符）——\
             常见的有 GET / POST / PUT / PATCH / DELETE / HEAD / OPTIONS"
        ))
    })
}

/// 有 body 用 `Full`、没有用 `Empty`。
///
/// ⚠️ **别对空 body 无条件塞 `Full::new(Bytes::new())`** —— hyper 会因此发出
/// `content-length: 0`，有些网关会挑它（`GET` 带 `content-length: 0` 尤其怪）。
fn make_body(
    body: &[u8],
) -> http_body_util::combinators::BoxBody<bytes::Bytes, std::convert::Infallible> {
    use http_body_util::{BodyExt, Empty, Full};
    if body.is_empty() {
        Empty::<bytes::Bytes>::new().map_err(|e| match e {}).boxed()
    } else {
        Full::new(bytes::Bytes::copy_from_slice(body))
            .map_err(|e| match e {})
            .boxed()
    }
}

/// 保留头的处理。**收在一处**，两个消费者共用。
///
/// ⚠️ 两条规矩都是踩出来的：
///
/// * **用户显式给的 `host` 覆盖我们算的** —— 调试器就是要测虚拟主机，
///   把它丢掉等于那个功能不存在。这条的落地在 [`send_once`] 里
///   （「有没有用户那条」决定我们写不写），因为 `builder.header` 是**追加**
///   语义：这里放过去、那边也写，就是两条 `Host`。
/// * **`content-length` / `transfer-encoding` 一律丢掉** —— hyper 自己管这两个，
///   两边都设会得到一个**看不懂的 hyper 错误**（而且报的是「请求编不出来」，
///   和用户填了什么毫无关系）。
fn sanitize_headers(headers: &[(String, String)]) -> Vec<(&str, &str)> {
    headers
        .iter()
        .filter(|(k, _)| {
            let k = k.to_ascii_lowercase();
            k != "content-length" && k != "transfer-encoding"
        })
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect()
}

/// 把 `Location` 解析成绝对地址。
///
/// 三种形状（RFC 7231）：绝对地址、以 `/` 开头的根相对、其它相对（相对当前
/// 目录）。⚠️ **不引 `url` crate** —— 它会拉 `idna`/`icu_*`，
/// 而对 `-p devtoolkit-request` 单独构建那是实打实的新编译。
fn resolve_location(base: &str, location: &str) -> Result<String, HttpError> {
    let location = location.trim();
    if location.is_empty() {
        return Err(HttpError::redirect("跳转的 Location 是空的"));
    }
    if location.starts_with("http://") || location.starts_with("https://") {
        return Ok(location.to_string());
    }

    let base_endpoint =
        Endpoint::parse(base).map_err(|e| HttpError::redirect(format!("跳转的基准地址不对：{e}")))?;
    let scheme = if base_endpoint.tls { "https" } else { "http" };
    let authority = base_endpoint.authority();

    if location.starts_with('/') {
        return Ok(format!("{scheme}://{authority}{location}"));
    }

    // 相对当前路径的**目录**：`/a/b/c` + `d` → `/a/b/d`
    let dir = match base_endpoint.path.rfind('/') {
        Some(i) => &base_endpoint.path[..=i],
        None => "/",
    };
    Ok(format!("{scheme}://{authority}{dir}{location}"))
}

/// 地址里的主机部分（跨主机跳转要拿它比）。
fn host_of(url: &str) -> String {
    Endpoint::parse(url)
        .map(|e| e.host.to_ascii_lowercase())
        .unwrap_or_default()
}

/// 一个解析出来的地址。
///
/// 手写解析而**不引 `url` crate**：我们只接受 `http(s)://host[:port]/path`
/// 这一种形状，为它引一个通用 URL 解析器（连同它的依赖）不划算。
/// 但这个解析器**必须挑剔** —— 认不出来就报错，别猜。
#[derive(Debug, Clone, PartialEq, Eq)]
struct Endpoint {
    tls: bool,
    host: String,
    port: u16,
    /// 路径 + 查询串
    path: String,
}

impl Endpoint {
    fn parse(url: &str) -> Result<Self, HttpError> {
        let (tls, rest) = if let Some(r) = url.strip_prefix("https://") {
            (true, r)
        } else if let Some(r) = url.strip_prefix("http://") {
            // 明文 http：本地网关（vLLM / ollama 常常跑在 localhost 上）
            // 和我们的测试服务器用得到。
            (false, r)
        } else {
            return Err(HttpError::invalid(format!(
                "地址要以 http:// 或 https:// 开头，现在是「{url}」"
            )));
        };

        // 路径从第一个 `/` 开始；没有就是 `/`
        let (authority, path) = match rest.find('/') {
            Some(i) => (&rest[..i], &rest[i..]),
            None => (rest, "/"),
        };
        if authority.is_empty() {
            return Err(HttpError::invalid(format!("地址里没有主机名：「{url}」")));
        }

        // IPv6 字面量：`[::1]:8080`
        let (host, port) = if let Some(after) = authority.strip_prefix('[') {
            let Some(end) = after.find(']') else {
                return Err(HttpError::invalid(format!("IPv6 地址没闭合：「{url}」")));
            };
            let host = &after[..end];
            let tail = &after[end + 1..];
            (host.to_string(), parse_port(tail, tls, url)?)
        } else {
            match authority.rsplit_once(':') {
                Some((h, p)) => (h.to_string(), parse_port(&format!(":{p}"), tls, url)?),
                None => (authority.to_string(), default_port(tls)),
            }
        };

        if host.is_empty() {
            return Err(HttpError::invalid(format!("地址里没有主机名：「{url}」")));
        }

        Ok(Endpoint {
            tls,
            host,
            port,
            path: if path.is_empty() { "/".into() } else { path.into() },
        })
    }

    fn authority(&self) -> String {
        let default = default_port(self.tls);
        if self.port == default {
            self.host.clone()
        } else if self.host.contains(':') {
            format!("[{}]:{}", self.host, self.port)
        } else {
            format!("{}:{}", self.host, self.port)
        }
    }

    fn path_and_query(&self) -> String {
        self.path.clone()
    }

    /// HTTP/1.1 要求的 `Host` 头（`api.anthropic.com`，或者 `localhost:8443`）。
    ///
    /// ⚠️ **必须自己加 —— hyper 不会替你补。**
    ///
    /// hyper 1.x 的 http1 客户端只要求 URI 是 origin-form（就一个路径），
    /// 而路径里当然没有主机名，所以 Host 从别处来不了。对端拿不到它就回
    /// `400 Bad Request: missing required Host header` —— 用户在真机上撞到过，
    /// 而**我们的假服务器不检查 Host**（它只看路径），所以集成测试全绿。
    ///
    /// 这条缝的具体形状和 HANDOFF 里记的那条一模一样：**两边的测试结构性地
    /// 盖不到**。所以下面补了一条契约测试，让假服务器真的去要这个头。
    fn host_header(&self) -> String {
        // 默认端口不写出来：`example.com` 是惯例，`example.com:443` 虽然合法，
        // 但有的网关（和某些校验严格的 CDN）会挑这个。
        self.authority()
    }
}

fn default_port(tls: bool) -> u16 {
    if tls {
        443
    } else {
        80
    }
}

/// `":8080"` → 8080。空串取默认端口。
fn parse_port(tail: &str, tls: bool, url: &str) -> Result<u16, HttpError> {
    let digits = tail.strip_prefix(':').unwrap_or(tail);
    if digits.is_empty() {
        return Ok(default_port(tls));
    }
    digits.parse::<u16>().map_err(|_| {
        HttpError::invalid(format!("端口不对「{digits}」—— 要是 1–65535 之间的整数（地址：{url}）"))
    })
}
