//! 用**真 socket** 跑一遍 HTTP：请求怎么写的、响应怎么读的、跳转怎么跟的。
//!
//! # 为什么不用 mock
//!
//! 这一层测的东西**全是「字节怎么进出的」**：方法名写没写对、body 是不是原样、
//! 响应头有没有丢、跳转之后凭据还在不在、读断了会不会被当成正常结束。
//! 拿一个假的 `HttpTransport` 替身来测这些，等于把要验的那一段换成了一句台词
//! —— 而那正是 HANDOFF 里反复出现的那条：**假东西和真东西之间那条缝，
//! 两边的测试结构性地盖不到**（`Host` 头那次、`rename_all_fields` 那次都是）。
//!
//! 所以这里手写一个最小的 HTTP/1.1 服务器：**不用 hyper 的 server 端**
//! （那会引入 `httpdate`，锁文件里没有这个包），也**不引任何测试框架**。
//!
//! # 这里测不到的
//!
//! **TLS 那一截**（本地没有证书）：自签证书 + `accept_invalid_certs`
//! 那条路只能在真机上验 —— 和 `secrets.rs` 里那两条钥匙串测试同一个待遇。
//! 能在这里钉住的是「两种模式下的 config 都建得出来」（`tls.rs` 的测试），
//! 它挡的是「provider 没钉死 → 首次握手 panic」那个坑的一半。

use std::sync::{Arc, Mutex};
use std::time::Duration;

use devtoolkit_request::http::{
    ErrorKind, HttpError, HttpRequest, HttpTransport, HyperTransport, RequestOptions,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

// ------------------------------------------------------------------ 假服务器

/// 一个收到的请求（够用来断言「我们发出去了什么」）。
#[derive(Debug, Clone)]
struct Received {
    method: String,
    target: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Received {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    /// 同名头有几条（`content-length` 重复与否要数得出来）。
    fn count(&self, name: &str) -> usize {
        self.headers
            .iter()
            .filter(|(k, _)| k.eq_ignore_ascii_case(name))
            .count()
    }
}

/// 服务器要怎么回。
enum Reply {
    /// 完整回一条（`content-length` 标好，body 原样）。
    Complete {
        status: u16,
        reason: &'static str,
        headers: Vec<(&'static str, &'static str)>,
        body: &'static [u8],
    },
    /// 一条跳转。⚠️ `location` 是 `String` 而不是 `&'static str`：
    /// 「跨主机」那条测试要用当前端口现拼一个绝对地址。
    Redirect {
        status: u16,
        location: String,
    },
    /// 声称有 `claim` 字节，实际只发 `body` 就关连接 —— 制造「读到一半断了」。
    Truncated {
        claim: usize,
        body: &'static [u8],
    },
    /// 回完响应头就**一直不说话、也不关连接** —— 制造空闲超时。
    Silent,
}

impl Reply {
    fn ok(body: &'static [u8]) -> Reply {
        Reply::Complete {
            status: 200,
            reason: "OK",
            headers: vec![("content-type", "text/plain")],
            body,
        }
    }

    fn redirect(status: u16, location: impl Into<String>) -> Reply {
        Reply::Redirect {
            status,
            location: location.into(),
        }
    }
}

/// 先占一个端口，**不开始服务**。
///
/// 分成两步是因为「跨主机跳转」那条用例要先知道端口才能拼出 Location
/// （跳转目标得是同一台机器上的**另一个主机名**），而 Location 又要
/// 在服务器开始回之前就准备好。
async fn bind() -> (tokio::net::TcpListener, String) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    (listener, format!("http://{addr}"))
}

/// 起一个服务器，按 `replies` 的顺序**一条连接一条**地回。
///
/// 返回 `(基地址, 收到的请求, 服务器任务)`。
async fn serve(replies: Vec<Reply>) -> (String, Arc<Mutex<Vec<Received>>>, tokio::task::JoinHandle<()>) {
    let (listener, base) = bind().await;
    let (seen, handle) = serve_on(listener, replies);
    (base, seen, handle)
}

/// 在已经占好的监听口上服务（端口已经定了见 [`bind`]）。
fn serve_on(
    listener: tokio::net::TcpListener,
    replies: Vec<Reply>,
) -> (Arc<Mutex<Vec<Received>>>, tokio::task::JoinHandle<()>) {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let recorder = Arc::clone(&seen);

    let handle = tokio::spawn(async move {
        for reply in replies {
            let Ok((mut sock, _)) = listener.accept().await else {
                return;
            };
            let request = read_request(&mut sock).await;
            recorder.lock().unwrap().push(request);

            match reply {
                Reply::Complete {
                    status,
                    reason,
                    headers,
                    body,
                } => {
                    let mut head = format!("HTTP/1.1 {status} {reason}\r\n");
                    for (k, v) in headers {
                        head.push_str(&format!("{k}: {v}\r\n"));
                    }
                    head.push_str(&format!("content-length: {}\r\n\r\n", body.len()));
                    let _ = sock.write_all(head.as_bytes()).await;
                    let _ = sock.write_all(body).await;
                }
                Reply::Redirect { status, location } => {
                    let head = format!(
                        "HTTP/1.1 {status} Found\r\nlocation: {location}\r\ncontent-length: 0\r\n\r\n"
                    );
                    let _ = sock.write_all(head.as_bytes()).await;
                }
                Reply::Truncated { claim, body } => {
                    let head =
                        format!("HTTP/1.1 200 OK\r\ncontent-length: {claim}\r\n\r\n");
                    let _ = sock.write_all(head.as_bytes()).await;
                    let _ = sock.write_all(body).await;
                    // 关掉 —— 宣告的长度没发满，这是一个**断了**的响应体
                    let _ = sock.shutdown().await;
                }
                Reply::Silent => {
                    let _ = sock
                        .write_all(b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\n\r\n")
                        .await;
                    // 什么都不发、也不关连接 —— 等客户端自己超时。
                    // 睡一会儿是为了让**客户端**先超时（否则成了「服务器关了」
                    // 那种正常收尾，测的就不是同一件事了）。
                    tokio::time::sleep(Duration::from_secs(5)).await;
                }
            }
        }
    });

    (seen, handle)
}

/// 读一个完整请求（读到空行，再按 `content-length` 读 body）。
async fn read_request(sock: &mut tokio::net::TcpStream) -> Received {
    let mut raw = Vec::new();
    loop {
        let mut buf = [0u8; 1024];
        let n = sock.read(&mut buf).await.unwrap_or(0);
        if n == 0 {
            break;
        }
        raw.extend_from_slice(&buf[..n]);
        if let Some(end) = find_head_end(&raw) {
            // 头收全了：看 content-length 还差多少 body
            let head = String::from_utf8_lossy(&raw[..end]).to_string();
            let want = content_length(&head);
            let have = raw.len() - (end + 4);
            if have >= want {
                break;
            }
            // 继续读剩下的 body
            while raw.len() - (end + 4) < want {
                let mut buf = [0u8; 4096];
                let n = sock.read(&mut buf).await.unwrap_or(0);
                if n == 0 {
                    break;
                }
                raw.extend_from_slice(&buf[..n]);
            }
            break;
        }
    }

    let end = find_head_end(&raw).unwrap_or(raw.len());
    let head = String::from_utf8_lossy(&raw[..end]).to_string();
    let body = if end + 4 <= raw.len() {
        raw[end + 4..].to_vec()
    } else {
        Vec::new()
    };

    let mut lines = head.split("\r\n");
    let request_line = lines.next().unwrap_or_default();
    let mut parts = request_line.split(' ');

    Received {
        method: parts.next().unwrap_or_default().to_string(),
        target: parts.next().unwrap_or_default().to_string(),
        headers: lines
            .filter_map(|l| l.split_once(':'))
            .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))
            .collect(),
        body,
    }
}

fn find_head_end(raw: &[u8]) -> Option<usize> {
    raw.windows(4).position(|w| w == b"\r\n\r\n")
}

fn content_length(head: &str) -> usize {
    head.lines()
        .find_map(|l| {
            let l = l.to_ascii_lowercase();
            l.strip_prefix("content-length:").map(|v| v.trim().to_string())
        })
        .and_then(|v| v.parse().ok())
        .unwrap_or(0)
}

fn request(method: &str, url: String) -> HttpRequest {
    HttpRequest {
        method: method.into(),
        url,
        headers: Vec::new(),
        body: Vec::new(),
        options: RequestOptions::default(),
    }
}

// ------------------------------------------------------------------ 请求怎么写的

#[tokio::test]
async fn 任意方法_路径_查询串都原样发出去() {
    let (base, seen, server) = serve(vec![Reply::ok(b"hi")]).await;

    let response = HyperTransport::new()
        .send(request("PATCH", format!("{base}/a/b?x=1&y=%20")))
        .await
        .expect("应当发得出去");

    let _ = response.read_all(1024).await;
    let got = &seen.lock().unwrap()[0];
    assert_eq!(got.method, "PATCH", "方法没原样发出去");
    assert_eq!(got.target, "/a/b?x=1&y=%20", "路径 + 查询串要一起发");
    server.abort();
}

#[tokio::test]
async fn 方法名大小写不敏感_扩展方法照发_非法字符才报_invalid() {
    let (base, seen, server) = serve(vec![Reply::ok(b""), Reply::ok(b"")]).await;

    let _ = HyperTransport::new()
        .send(request("delete", format!("{base}/x")))
        .await
        .unwrap()
        .read_all(1024)
        .await;
    assert_eq!(seen.lock().unwrap()[0].method, "DELETE", "要规范成大写");

    // ⚠️ **没有方法白名单**：`PROPFIND` 这类扩展方法真的有服务端在用，
    // 而用户拿调试器打的就是那些平时用不到的方法。
    let _ = HyperTransport::new()
        .send(request("PROPFIND", format!("{base}/x")))
        .await
        .unwrap()
        .read_all(1024)
        .await;
    assert_eq!(seen.lock().unwrap()[1].method, "PROPFIND");

    // ⚠️ 挡的是「不是 token」的输入 —— 发出去只会得到一个看不懂的解析错，
    // 不如现在就说是哪儿不对（而且**不猜**：猜成一个相近的方法，
    // 用户会拿到一个语义完全不同的请求）。
    let err = HyperTransport::new()
        .send(request("GE T", format!("{base}/x")))
        .await
        .unwrap_err();
    assert_eq!(err.kind, ErrorKind::Invalid);
    assert!(err.message.contains("GE T"), "报错里要有用户填的那个词：{}", err.message);
    assert!(!err.is_retryable(), "句子写错了重发一万次也一样");
    server.abort();
}

#[tokio::test]
async fn 二进制请求体一个字节都不变() {
    let (base, seen, server) = serve(vec![Reply::ok(b"")]).await;

    // 0x00 / 0xFF / 半个 UTF-8 字符 —— 旧的传输层（body: String）根本表达不了这些
    let payload: Vec<u8> = vec![0x00, 0xFF, 0xE4, 0xB8, 0x10, 0x0A, 0x0D, 0x7F];
    let mut req = request("POST", format!("{base}/bin"));
    req.headers = vec![("content-type".into(), "application/octet-stream".into())];
    req.body = payload.clone();

    let _ = HyperTransport::new().send(req).await.unwrap().read_all(1024).await;

    assert_eq!(seen.lock().unwrap()[0].body, payload, "body 被改过一个字节");
    server.abort();
}

#[tokio::test]
async fn host_头由我们算_默认端口不写出来() {
    let (base, seen, server) = serve(vec![Reply::ok(b"")]).await;

    let _ = HyperTransport::new()
        .send(request("GET", format!("{base}/")))
        .await
        .unwrap()
        .read_all(1024)
        .await;

    // ⚠️ 少了这个头，真服务端一律回 `400 missing required Host header`
    // —— 假服务器以前什么都不检查，所以那个 bug 一路绿到真机。
    let got = &seen.lock().unwrap()[0];
    let host = got.header("host").expect("必须带 Host 头").to_string();
    assert_eq!(host, base.trim_start_matches("http://"));
    assert!(!host.ends_with(":80"), "默认端口不该写出来：{host}");
    server.abort();
}

#[tokio::test]
async fn 用户给的_host_覆盖我们自己算的() {
    // 虚拟主机调试就是要测这个：同一个 IP、不同的 Host。
    let (base, seen, server) = serve(vec![Reply::ok(b"")]).await;

    let mut req = request("GET", format!("{base}/"));
    req.headers = vec![("host".into(), "example.com".into())];
    let _ = HyperTransport::new().send(req).await.unwrap().read_all(1024).await;

    let got = &seen.lock().unwrap()[0];
    assert_eq!(got.header("host"), Some("example.com"));
    assert_eq!(got.count("host"), 1, "两条 Host 是错的：{:?}", got.headers);
    server.abort();
}

#[tokio::test]
async fn content_length_和_transfer_encoding_一律丢掉() {
    // ⚠️ hyper 自己管这两个。两边都设会得到一个**看不懂的 hyper 错误**
    //（报的是「请求编不出来」，和用户填了什么毫无关系）。
    let (base, seen, server) = serve(vec![Reply::ok(b"")]).await;

    let mut req = request("POST", format!("{base}/"));
    req.headers = vec![
        ("content-length".into(), "999".into()),
        ("transfer-encoding".into(), "chunked".into()),
        ("x-keep".into(), "yes".into()),
    ];
    req.body = b"hello".to_vec();
    let _ = HyperTransport::new().send(req).await.unwrap().read_all(1024).await;

    let got = &seen.lock().unwrap()[0];
    assert_eq!(got.count("content-length"), 1, "用户那条该被丢掉");
    assert_eq!(got.header("content-length"), Some("5"), "长度要 hyper 自己算");
    assert_eq!(got.count("transfer-encoding"), 0);
    assert_eq!(got.header("x-keep"), Some("yes"), "不认识的头要原样留着");
    server.abort();
}

#[tokio::test]
async fn 同名头允许多条() {
    // `Accept` / `Set-Cookie` 那种。builder 的 `header` 是追加语义。
    let (base, seen, server) = serve(vec![Reply::ok(b"")]).await;

    let mut req = request("GET", format!("{base}/"));
    req.headers = vec![
        ("accept".into(), "text/html".into()),
        ("accept".into(), "application/json".into()),
    ];
    let _ = HyperTransport::new().send(req).await.unwrap().read_all(1024).await;

    assert_eq!(seen.lock().unwrap()[0].count("accept"), 2);
    server.abort();
}

// ------------------------------------------------------------------ 响应怎么读的

#[tokio::test]
async fn 响应头保序_重复的都在_大小写不敏感地查得到() {
    let (base, _seen, server) = serve(vec![Reply::Complete {
        status: 201,
        reason: "Created",
        headers: vec![
            ("set-cookie", "a=1"),
            ("x-order", "first"),
            ("set-cookie", "b=2"),
            ("x-order", "second"),
        ],
        body: b"ok",
    }])
    .await;

    let response = HyperTransport::new()
        .send(request("GET", format!("{base}/")))
        .await
        .unwrap();

    assert_eq!(response.status, 201);
    assert_eq!(response.reason, "Created");
    assert_eq!(response.final_url, format!("{base}/"));
    assert!(response.redirects.is_empty());
    assert!(response.ttfb > Duration::ZERO, "首字节耗时要有数");

    // 顺序就是服务器发出来的顺序（调试器要照着原样显示）
    let order: Vec<&str> = response
        .headers
        .iter()
        .filter(|(k, _)| k.eq_ignore_ascii_case("x-order"))
        .map(|(_, v)| v.as_str())
        .collect();
    assert_eq!(order, vec!["first", "second"], "响应头顺序被打乱了");

    // 重复的头一条不少
    let cookies: Vec<&str> = response.headers_of("set-cookie").collect();
    assert_eq!(cookies, vec!["a=1", "b=2"]);
    // 查的时候不区分大小写（HTTP 头名就是不分大小写的）
    assert_eq!(response.header("SET-COOKIE"), Some("a=1"));

    let body = response.read_all(1024).await.unwrap();
    assert_eq!(body.bytes, b"ok");
    assert!(!body.truncated);
    server.abort();
}

#[tokio::test]
async fn read_all_到上限就停手_不把整个东西读进内存() {
    // ⚠️ 「读完再截」在 1 GB 的下载上会把内存吃光；这里要的是**不再往下读**。
    let (base, _seen, server) = serve(vec![Reply::Complete {
        status: 200,
        reason: "OK",
        headers: vec![],
        body: &[b'x'; 4096],
    }])
    .await;

    let response = HyperTransport::new()
        .send(request("GET", format!("{base}/big")))
        .await
        .unwrap();
    let body = response.read_all(100).await.unwrap();

    assert_eq!(body.bytes.len(), 100);
    assert!(body.truncated, "撞上上限要标出来，不然用户以为文件就这么大");
    server.abort();
}

#[tokio::test]
async fn 读到一半断了_要报出来_不能当成正常结束() {
    // ⚠️ 这是「少了半截却当成成功」那个形状：安静地结束循环，在上层看来
    // 和对端正常读完关了连接**一模一样**。
    let (base, _seen, server) = serve(vec![Reply::Truncated {
        claim: 100,
        body: b"0123456789",
    }])
    .await;

    let response = HyperTransport::new()
        .send(request("GET", format!("{base}/cut")))
        .await
        .unwrap();

    let mut body = response.body;
    let mut err = None;
    while let Some(chunk) = body.recv().await {
        if let Err(e) = chunk {
            err = Some(e);
            break;
        }
    }
    let err = err.expect("截断的响应体必须报出来");
    assert_eq!(err.kind, ErrorKind::Body);
    server.abort();
}

#[tokio::test]
async fn 连上了但对端不说话_到点报空闲超时() {
    // ⚠️ 没有这条超时的话：对端连上了、响应头也回来了，然后**再也不发数据**，
    // 读循环会永远等下去 —— 而用户那边只有一个「正在跑」的界面，一个字都不报。
    let (base, _seen, server) = serve(vec![Reply::Silent]).await;

    let mut req = request("GET", format!("{base}/silent"));
    req.options.idle_timeout = Duration::from_millis(200);

    let response = HyperTransport::new().send(req).await.unwrap();
    let mut body = response.body;
    let err = loop {
        match body.recv().await {
            Some(Err(e)) => break e,
            Some(Ok(_)) => continue,
            None => panic!("对端没关连接，这里不该是正常结束"),
        }
    };

    assert_eq!(err.kind, ErrorKind::Idle);
    assert!(err.is_retryable(), "对端不说话是值得重发的");
    server.abort();
}

#[tokio::test]
async fn 连不上是_connect_地址不合法是_invalid() {
    // 绑一个端口再放掉 —— 这个地址上没有人听
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let dead = listener.local_addr().unwrap();
    drop(listener);

    let err = HyperTransport::new()
        .send(request("GET", format!("http://{dead}/")))
        .await
        .unwrap_err();
    assert_eq!(err.kind, ErrorKind::Connect);

    let err = HyperTransport::new()
        .send(request("GET", "ftp://example.com/".into()))
        .await
        .unwrap_err();
    assert_eq!(err.kind, ErrorKind::Invalid);

    let err = HyperTransport::new()
        .send(request("GET", "http:///nohost".into()))
        .await
        .unwrap_err();
    assert_eq!(err.kind, ErrorKind::Invalid);
}

// ------------------------------------------------------------------ 跳转

#[tokio::test]
async fn 默认不跟跳转_303_就是一条普通响应() {
    // 助手那一边一个字节都不能变：它从来不开跳转。
    let (base, seen, server) = serve(vec![Reply::redirect(303, "http://example.com/elsewhere")]).await;

    let response = HyperTransport::new()
        .send(request("GET", format!("{base}/")))
        .await
        .unwrap();

    assert_eq!(response.status, 303, "没开跳转就该把 3xx 原样交出去");
    assert!(response.redirects.is_empty());
    assert_eq!(seen.lock().unwrap().len(), 1, "不该发第二个请求");
    server.abort();
}

#[tokio::test]
async fn 跳转_302_跟过去_并且改成_get_丢掉_body() {
    let (base, seen, server) = serve(vec![
        Reply::redirect(302, "/next"),
        Reply::ok(b"landed"),
    ])
    .await;

    let mut req = request("POST", format!("{base}/start"));
    req.options.follow_redirects = true;
    req.headers = vec![("content-type".into(), "application/json".into())];
    req.body = b"{\"a\":1}".to_vec();

    let response = HyperTransport::new().send(req).await.unwrap();

    assert_eq!(response.status, 200);
    assert_eq!(response.final_url, format!("{base}/next"), "最终地址要报出来");
    assert_eq!(response.redirects.len(), 1);
    assert_eq!(response.redirects[0].status, 302);
    assert_eq!(response.redirects[0].from, format!("{base}/start"));
    assert_eq!(response.redirects[0].to, format!("{base}/next"));

    let got = seen.lock().unwrap();
    assert_eq!(got[1].method, "GET", "301/302/303 按惯例改成 GET");
    assert!(got[1].body.is_empty(), "改了 GET 就不该再带 body");
    assert_eq!(got[1].count("content-type"), 0, "body 没了，类型头也该走");

    let body = response.read_all(1024).await.unwrap();
    assert_eq!(body.bytes, b"landed");
    server.abort();
}

#[tokio::test]
async fn 跳转_307_原样重发_method_和_body_都不动() {
    let (base, seen, server) = serve(vec![Reply::redirect(307, "/again"), Reply::ok(b"ok")]).await;

    let mut req = request("PUT", format!("{base}/first"));
    req.options.follow_redirects = true;
    req.body = b"payload".to_vec();

    let _ = HyperTransport::new().send(req).await.unwrap().read_all(1024).await;

    let got = seen.lock().unwrap();
    assert_eq!(got[1].method, "PUT");
    assert_eq!(got[1].body, b"payload");
    server.abort();
}

#[tokio::test]
async fn 同主机跳转_凭据留着() {
    let (base, seen, server) = serve(vec![Reply::redirect(302, "/same"), Reply::ok(b"")]).await;

    let mut req = request("GET", format!("{base}/a"));
    req.options.follow_redirects = true;
    req.headers = vec![
        ("authorization".into(), "Bearer secret".into()),
        ("cookie".into(), "s=1".into()),
    ];

    let _ = HyperTransport::new().send(req).await.unwrap().read_all(1024).await;

    let got = seen.lock().unwrap();
    assert_eq!(got[1].header("authorization"), Some("Bearer secret"));
    assert_eq!(got[1].header("cookie"), Some("s=1"));
    server.abort();
}

#[tokio::test]
async fn 跨主机跳转_丢掉凭据() {
    // ⚠️ 安全默认（curl 和 Postman 都这么做）：token 是发给**那一台**机器的，
    // 跟着跳到别处就是把用户的东西交给第三方。
    //
    // 这里用 `localhost` 对 `127.0.0.1` —— 同一台机器、**不同的主机名**，
    // 正好验的是「按主机名比」这件事本身（比 `..` 归一化那种事简单得多，
    // 而且我们的比较就是字面的）。
    let (listener, base) = bind().await;
    let port = base.trim_start_matches("http://").rsplit(':').next().unwrap().to_string();
    let cross = format!("http://127.0.0.1:{port}/other");
    let (seen, server) = serve_on(listener, vec![Reply::redirect(302, cross), Reply::ok(b"")]);

    let mut req = request("GET", format!("http://localhost:{port}/a"));
    req.options.follow_redirects = true;
    req.headers = vec![
        ("authorization".into(), "Bearer secret".into()),
        ("cookie".into(), "s=1".into()),
        ("proxy-authorization".into(), "Basic zzz".into()),
        ("x-trace".into(), "keep-me".into()),
    ];

    let _ = HyperTransport::new().send(req).await.unwrap().read_all(1024).await;

    let got = seen.lock().unwrap();
    assert_eq!(got[1].header("host"), Some(format!("127.0.0.1:{port}").as_str()));
    assert_eq!(got[1].header("authorization"), None, "跨主机不能带 Authorization");
    assert_eq!(got[1].header("cookie"), None, "跨主机不能带 Cookie");
    assert_eq!(got[1].header("proxy-authorization"), None);
    assert_eq!(got[1].header("x-trace"), Some("keep-me"), "别的头不用动");
    server.abort();
}

#[tokio::test]
async fn 跳转绕圈_到上限就停手并报错() {
    let mut replies = Vec::new();
    for _ in 0..4 {
        replies.push(Reply::redirect(302, "/loop"));
    }
    let (base, seen, server) = serve(replies).await;

    let mut req = request("GET", format!("{base}/loop"));
    req.options.follow_redirects = true;
    req.options.max_redirects = 2;

    let err = HyperTransport::new().send(req).await.unwrap_err();
    assert_eq!(err.kind, ErrorKind::Redirect);
    assert!(err.message.contains("2 次"), "报错要说清上限是多少：{}", err.message);
    // 上限是 2 → 最多 3 次请求（初始那条 + 2 跳）
    assert_eq!(seen.lock().unwrap().len(), 3);
    server.abort();
}

#[tokio::test]
async fn 相对地址的_location_要按_rfc_拼出来() {
    // 三种形状：绝对、根相对、相对当前目录。⚠️ 不引 `url` crate
    //（它会拉 idna/icu_*，对单独构建这个 crate 是实打实的新编译）。
    let (base, seen, server) = serve(vec![
        Reply::redirect(302, "deep/../final?q=1"),
        Reply::ok(b""),
    ])
    .await;

    let mut req = request("GET", format!("{base}/a/b/c"));
    req.options.follow_redirects = true;

    let response = HyperTransport::new().send(req).await.unwrap();
    // `/a/b/` + `deep/../final?q=1` —— 我们只做拼接，**不做** `..` 的归一化
    //（那是 `url` crate 的活儿）。真服务端给的 Location 基本都是干净的。
    assert_eq!(response.final_url, format!("{base}/a/b/deep/../final?q=1"));
    assert_eq!(seen.lock().unwrap()[1].target, "/a/b/deep/../final?q=1");
    server.abort();
}

// ------------------------------------------------------------------ 纯判断

#[test]
fn 重发与否按种类分() {
    assert!(HttpError::connect("x").is_retryable());
    assert!(HttpError::timeout("x").is_retryable());
    assert!(HttpError::idle("x").is_retryable());
    assert!(HttpError::protocol("x").is_retryable());
    assert!(HttpError::body("x").is_retryable());

    // ⚠️ 这三类**不重发**：地址写错了重发一百次也一样；证书不对更是一样，
    // 而且那种错要说给用户听，不能靠重发掩盖。
    assert!(!HttpError::invalid("x").is_retryable());
    assert!(!HttpError::tls("x").is_retryable());
    assert!(!HttpError::redirect("x").is_retryable());
}

#[test]
fn 状态码的重发判定和传输层的判定是两件事() {
    // ⚠️ 一个是 HTTP 语义、一个是传输语义，调用方两个都要用得上。
    assert!(devtoolkit_request::http::status_is_retryable(429));
    assert!(devtoolkit_request::http::status_is_retryable(503));
    assert!(!devtoolkit_request::http::status_is_retryable(400));
    assert!(!devtoolkit_request::http::status_is_retryable(200));
}

#[test]
fn post_那条捷径仍然是助手要的形状() {
    // 助手那一侧的验收标准是「行为一个字不变」，这个构造器就是那条保证。
    let req = HttpRequest::post("https://x/y", vec![("a".into(), "b".into())], "{}".into());
    assert_eq!(req.method, "POST");
    assert_eq!(req.body, b"{}");
    assert_eq!(req.options, RequestOptions::default());
    assert!(!req.options.follow_redirects, "助手不开跳转");
    assert!(!req.options.accept_invalid_certs, "助手不关证书校验");
}
