//! HTTP 传输层：一个 POST，响应体**一块一块**地送回来。
//!
//! # 为什么单独一个文件
//!
//! 这是整个内核里唯一碰网络、唯一碰 TLS 的地方。仓库的惯例是
//! **把可能替换的第三方实现隔离在单文件里**（`portable-pty` 只出现在
//! `pty.rs` 就是为这个）—— 将来要换 HTTP 栈，改这一个文件。
//!
//! # 为什么是 trait
//!
//! 两个 provider 的**请求构造**和**事件翻译**是真正会出错的地方（字段名、
//! 终止条件、并行工具调用的分桶），而那些逻辑和"字节怎么来的"无关。
//! 抽出来之后，两个 provider 的测试用一个假 transport 喂**真实抓下来的
//! SSE 字节**就能跑完，不需要网络、不需要 key。
//!
//! 真实现走 `hyper` + `tokio-rustls`（**零新增包** —— 它们本来就是
//! `devtoolkit-sql` 的 mongodb 拉进来的，见 `Cargo.toml`）。

use tokio::sync::mpsc;

/// 一个要发的请求。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransportRequest {
    /// 完整地址，比如 `https://api.anthropic.com/v1/messages`。
    pub url: String,
    /// 请求头。**顺序原样发出去**（有的网关对顺序敏感，而且顺序变了
    /// prompt 缓存的前缀就变了 —— 虽然请求头不参与缓存，但确定性强一点没坏处）。
    pub headers: Vec<(String, String)>,
    /// JSON 请求体（已经序列化好的字符串 —— 我们不在这里解析它）。
    pub body: String,
}

/// 响应体的一块字节，或者一个传输错误。
pub type Chunk = Result<Vec<u8>, TransportError>;

/// 流式响应里，**两块数据之间**最多等多久。
///
/// ⚠️ 这是「多久算对端不说话了」的分界线，**不是**「一次请求总共能跑多久」——
/// 一次长回答流好几分钟是正常的，不正常的是一直**没有任何新数据**。
/// 拿总时长当上限会把慢模型误杀成网络问题。
///
/// 90 秒是刻意宽松的：有些 OpenAI 兼容网关不是真流式（攒完整个回答才吐），
/// 首字节之前沉默几十秒很正常。卡太紧的话，那种网关会被判成"断了"。
pub const IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(90);

/// 传输层出错。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransportError {
    /// 给用户看的一句话（中文）。
    pub message: String,
    /// 值不值得重发。
    ///
    /// 连接断、超时、5xx —— 值得；DNS 解析不了、证书不对 —— 不值得
    /// （重发一百次也一样，而且那种错误要说给用户听）。
    pub retryable: bool,
}

impl TransportError {
    /// 值得重发的（连接断了、对端 5xx）。
    pub fn retryable(message: impl Into<String>) -> Self {
        TransportError {
            message: message.into(),
            retryable: true,
        }
    }

    /// 不值得重发的（配置错、证书错、401）。
    pub fn permanent(message: impl Into<String>) -> Self {
        TransportError {
            message: message.into(),
            retryable: false,
        }
    }
}

/// 响应。
pub struct HttpResponse {
    /// HTTP 状态码。
    pub status: u16,
    /// 状态码**不是 2xx** 时的正文（错误信息在里面，要读出来给用户看）。
    pub error_body: Option<String>,
    /// 状态码是 2xx 时的流式正文。
    pub body: Option<mpsc::Receiver<Chunk>>,
}

impl HttpResponse {
    /// 成功（2xx）。
    pub fn ok(body: mpsc::Receiver<Chunk>) -> Self {
        HttpResponse {
            status: 200,
            error_body: None,
            body: Some(body),
        }
    }

    /// 失败。
    pub fn failed(status: u16, error_body: String) -> Self {
        HttpResponse {
            status,
            error_body: Some(error_body),
            body: None,
        }
    }

    /// 成功了吗。
    pub fn is_ok(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

/// 谁能发一个流式的 POST。
pub trait Transport: Send + Sync {
    /// 发出去。**返回后响应体还在流**，调用方要自己把 `body` 读干。
    fn post(
        &self,
        request: TransportRequest,
    ) -> impl std::future::Future<Output = Result<HttpResponse, TransportError>> + Send;
}

/// 这一家的状态码值不值得重发。
///
/// ⚠️ 这条判断**两边都可能搞反**，所以写在一处、测在一处：
/// * `429` 值得（等一会儿再来）；
/// * `5xx` 值得（对端的锅）；
/// * `4xx`（除了 429）**不值得** —— 400 是请求有问题、401 是 key 不对，
///   重发一百次结果一样，而且用户需要看到那句话。
pub fn status_is_retryable(status: u16) -> bool {
    status == 429 || (500..600).contains(&status)
}

// ------------------------------------------------------------------ 真实现

/// 真的走网络的传输层（`hyper` + `tokio-rustls`）。
///
/// **整个 crate 里只有这一处碰 socket**，别的都不知道网络是怎么连的。
#[derive(Debug, Clone)]
pub struct HyperTransport {
    /// 建连 + 握手 + 等响应头的上限。
    ///
    /// **不设响应体的超时**：模型一个长回合能跑好几分钟，那是正常的。
    /// 卡住的话由用户点停止，或者对端自己断。
    pub timeout: std::time::Duration,
}

impl Default for HyperTransport {
    fn default() -> Self {
        HyperTransport {
            timeout: std::time::Duration::from_secs(30),
        }
    }
}

impl HyperTransport {
    /// 建一个。
    pub fn new() -> Self {
        Self::default()
    }
}

impl Transport for HyperTransport {
    async fn post(&self, request: TransportRequest) -> Result<HttpResponse, TransportError> {
        let target = Endpoint::parse(&request.url)?;

        // ① 建连（带超时 —— 没有它的话，打到一个不通的地址会一直挂着）
        let stream = tokio::time::timeout(
            self.timeout,
            tokio::net::TcpStream::connect((target.host.as_str(), target.port)),
        )
        .await
        .map_err(|_| TransportError::retryable("连接超时"))?
        .map_err(|e| TransportError::retryable(format!("连不上 {}：{e}", target.host)))?;

        // 关掉 Nagle：请求体一般一次写完，等它攒包只会让首字节更慢。
        let _ = stream.set_nodelay(true);

        // ② 需要的话套一层 TLS
        let body = request.body;
        let headers = request.headers;
        let uri_path = target.path_and_query();

        // 分两条路写：TLS 那条的泛型是另一套类型，但**下面发请求的代码完全一样**。
        // 用宏而不是复制一遍 —— 复制的话两边的超时/错误文案迟早会走偏。
        macro_rules! send_over {
            ($io:expr) => {{
                let io = hyper_util::rt::TokioIo::new($io);
                let (mut sender, conn) = hyper::client::conn::http1::handshake(io)
                    .await
                    .map_err(|e| TransportError::retryable(format!("握手失败：{e}")))?;

                // 连接必须有人驱动，否则请求发不出去。它随着 sender 一起结束。
                tokio::spawn(async move {
                    let _ = conn.await;
                });

                let mut builder = hyper::Request::builder()
                    .method(hyper::Method::POST)
                    .uri(&uri_path)
                    // ⚠️ **Host 得自己加**（hyper 不会补，它只看 URI 里的路径）。
                    // 少了这一条，真的服务端一律回
                    // `400 Bad Request: missing required Host header`。
                    .header(hyper::header::HOST, target.host_header());
                for (k, v) in &headers {
                    builder = builder.header(k.as_str(), v.as_str());
                }
                let req = builder.body(http_body_util::Full::new(bytes::Bytes::from(body)))
                    .map_err(|e| TransportError::permanent(format!("请求编不出来：{e}")))?;

                let response = tokio::time::timeout(self.timeout, sender.send_request(req))
                    .await
                    .map_err(|_| TransportError::retryable("等响应头超时"))?
                    .map_err(|e| TransportError::retryable(format!("请求失败：{e}")))?;
                let status = response.status().as_u16();
                let (tx, rx) = tokio::sync::mpsc::channel::<Chunk>(64);

                if !(200..300).contains(&status) {
                    // 错误正文**要读出来** —— 「key 不对」「模型名写错了」
                    // 这类话只在这里面。
                    let bytes = http_body_util::BodyExt::collect(response.into_body())
                        .await
                        .map(|b| b.to_bytes())
                        .unwrap_or_default();
                    return Ok(HttpResponse::failed(
                        status,
                        String::from_utf8_lossy(&bytes).into_owned(),
                    ));
                }

                // 逐帧读，**收到一块就发一块** —— 这是流式能成立的全部原因。
                tokio::spawn(async move {
                    use http_body_util::BodyExt;
                    let mut body = response.into_body();
                    loop {
                        // ⚠️ **空闲超时**。
                        //
                        // 没有它的话有这么一条路：对端连上了、响应头也回来了，
                        // 然后**再也不发数据、也不关连接**。这个循环会永远等下去，
                        // 而用户那边只有一个「正在跑」的界面 —— **一个字都不报**，
                        // 重试也不会发生，日志里什么都没有。那种失败完全无从下手。
                        //
                        // 超时必须**报出来**，不能只是安静地退出循环：
                        // 安静退出在上层看来和「对端正常关了连接」一模一样，
                        // 而那条路会被当成**一轮完整的响应**（少了半截内容却当成成功）。
                        let frame = match tokio::time::timeout(IDLE_TIMEOUT, body.frame()).await {
                            Ok(Some(f)) => f,
                            Ok(None) => break, // 对端正常读完并关了连接
                            Err(_) => {
                                let _ = tx
                                    .send(Err(TransportError::retryable(format!(
                                        "连上了，但对端 {} 秒没再回数据（网络中间断了，或者这个网关不支持流式）",
                                        IDLE_TIMEOUT.as_secs()
                                    ))))
                                    .await;
                                break;
                            }
                        };
                        let Ok(frame) = frame else { break };
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
                    error_body: None,
                    body: Some(rx),
                });
            }};
        }

        if target.tls {
            let connector = tls_connector()?;
            let server_name = rustls::pki_types::ServerName::try_from(target.host.clone())
                .map_err(|_| TransportError::permanent(format!("主机名不对：{}", target.host)))?;
            let tls = tokio::time::timeout(self.timeout, connector.connect(server_name, stream))
                .await
                .map_err(|_| TransportError::retryable("TLS 握手超时"))?
                .map_err(|e| TransportError::permanent(format!("TLS 握手失败：{e}")))?;
            send_over!(tls)
        } else {
            send_over!(stream)
        }
    }
}

/// 建 TLS 连接器。
///
/// ⚠️ **显式指定 `ring` 作为加密后端**，不用「按 crate feature 自动挑」：
/// 如果依赖树里同时开着 `ring` 和 `aws-lc-rs`，自动挑那一步会返回 `None`，
/// 然后在**第一次真正发 HTTPS 请求时 panic** —— 编译期完全看不出来。
fn tls_connector() -> Result<tokio_rustls::TlsConnector, TransportError> {
    let provider = std::sync::Arc::new(rustls::crypto::ring::default_provider());
    let config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| TransportError::permanent(format!("TLS 配置不对：{e}")))?
        .with_root_certificates(root_store())
        .with_no_client_auth();
    Ok(tokio_rustls::TlsConnector::from(std::sync::Arc::new(config)))
}

/// 根证书：用**打包进来的那一份**（`webpki-roots`）。
///
/// 不读系统证书库是刻意的：读的话行为会跟着用户机器变（公司 MITM 代理、
/// 自己塞的自签证书），而那种失败的样子是「我这儿好好的，他那儿连不上」。
/// 代价是走代理抓包的环境连不上 —— 那种环境本来也该用 `http://` 的本地网关。
fn root_store() -> rustls::RootCertStore {
    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    roots
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
    fn parse(url: &str) -> Result<Self, TransportError> {
        let (tls, rest) = if let Some(r) = url.strip_prefix("https://") {
            (true, r)
        } else if let Some(r) = url.strip_prefix("http://") {
            // 明文 http：本地网关（vLLM / ollama 常常跑在 localhost 上）
            // 和我们的测试服务器用得到。
            (false, r)
        } else {
            return Err(TransportError::permanent(format!(
                "地址要以 http:// 或 https:// 开头，现在是「{url}」"
            )));
        };

        let (authority, path) = match rest.find('/') {
            Some(i) => (&rest[..i], &rest[i..]),
            None => (rest, "/"),
        };
        if authority.is_empty() {
            return Err(TransportError::permanent("地址里没有主机名".to_string()));
        }

        let (host, port) = match authority.rsplit_once(':') {
            // `[::1]:8080` 这种 IPv6 字面量的处理：方括号里的是主机
            Some((h, p)) if !h.ends_with(']') || h.starts_with('[') => {
                let port: u16 = p
                    .parse()
                    .map_err(|_| TransportError::permanent(format!("端口不对：{p}")))?;
                (h.to_string(), port)
            }
            _ => (
                authority.to_string(),
                if tls { 443 } else { 80 },
            ),
        };
        if host.is_empty() {
            return Err(TransportError::permanent("地址里没有主机名".to_string()));
        }

        Ok(Endpoint {
            tls,
            host,
            port,
            path: path.to_string(),
        })
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
        let default_port = if self.tls { 443 } else { 80 };
        if self.port == default_port {
            self.host.clone()
        } else {
            format!("{}:{}", self.host, self.port)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(url: &str) -> Endpoint {
        Endpoint::parse(url).unwrap()
    }

    #[test]
    fn the_host_header_omits_the_default_port() {
        // ⚠️ `example.com:443` 是合法的，但惯例是不写出来，而且有的网关
        // （和校验严格的 CDN）会挑它。
        assert_eq!(parse("https://api.anthropic.com/v1/messages").host_header(), "api.anthropic.com");
        assert_eq!(parse("http://localhost/v1/messages").host_header(), "localhost");

        // 非默认端口**必须**写出来 —— 不写的话请求会打到 80/443 上，
        // 而那个错看起来像"网关挂了"。
        assert_eq!(parse("http://localhost:8080/v1").host_header(), "localhost:8080");
        // ⚠️ 这条最容易写错：**TLS + 非 443** 也是非默认端口（内网网关常见）。
        assert_eq!(
            parse("https://gw.example.com:8443/v1").host_header(),
            "gw.example.com:8443"
        );
    }

    #[test]
    fn https_defaults_to_443_and_http_to_80() {
        assert_eq!(parse("https://api.anthropic.com/v1/messages").port, 443);
        assert_eq!(parse("http://localhost:8080/v1/x").port, 8080);
        assert_eq!(parse("http://localhost/x").port, 80);
    }

    #[test]
    fn the_path_is_kept_whole() {
        let e = parse("https://a.com:8443/v1/messages?beta=1");
        assert_eq!(e.host, "a.com");
        assert_eq!(e.port, 8443);
        assert_eq!(e.path_and_query(), "/v1/messages?beta=1");
    }

    #[test]
    fn a_url_without_a_path_gets_a_slash() {
        assert_eq!(parse("https://a.com").path_and_query(), "/");
        assert_eq!(parse("https://a.com:9000").path_and_query(), "/");
    }

    #[test]
    fn a_missing_scheme_is_rejected_with_a_readable_message() {
        // 少了 scheme 时**不能猜**：猜成 https 的话，用户在一个明文网关上
        // 会收到一个看不懂的 TLS 错误。
        let err = Endpoint::parse("api.deepseek.com/v1").unwrap_err();
        assert!(err.message.contains("http"), "{}", err.message);
        assert!(!err.retryable);
    }

    #[test]
    fn a_bad_port_is_rejected() {
        assert!(Endpoint::parse("https://a.com:notaport/v1").is_err());
        assert!(Endpoint::parse("https://a.com:99999/v1").is_err());
    }

    #[test]
    fn an_empty_host_is_rejected() {
        assert!(Endpoint::parse("https:///v1/messages").is_err());
    }

    #[test]
    fn plain_http_is_allowed_because_local_gateways_use_it() {
        // vLLM / ollama 常常跑在 http://localhost 上，这条不是只为测试开的。
        assert!(!parse("http://127.0.0.1:11434/v1/chat/completions").tls);
        assert!(parse("https://api.anthropic.com/v1/messages").tls);
    }

    #[test]
    fn retryable_statuses_are_narrow_on_purpose() {
        assert!(status_is_retryable(429));
        assert!(status_is_retryable(500));
        assert!(status_is_retryable(503));

        // ⚠️ 这几个**不能**当可重发：重发改变不了任何事，
        // 而且用户需要看到那句话（key 不对 / 请求有问题）。
        assert!(!status_is_retryable(400));
        assert!(!status_is_retryable(401));
        assert!(!status_is_retryable(403));
        assert!(!status_is_retryable(404));
        assert!(!status_is_retryable(422));
    }
}
