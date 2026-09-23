//! 「跳过证书校验」那个开关**到底放行了什么** —— 真证书、真握手、真断言。
//!
//! # 为什么非要有这一组
//!
//! 那个开关是整个应用里**最危险的一个复选框**，而它的语义我们一度写错在注释和
//! 界面上：写的是「只跳过证书链，不跳过签名验证 —— 拿别人的证书冒充仍然挡得住」。
//!
//! 读过 rustls 的源码之后发现后半句是**错的**：我们换掉的是
//! `verify_server_cert` **一个**回调，而 rustls 在它里面同时做两件事 ——
//! 链验证**和主机名校验**。两件都在那个函数里，一开就两件都不查了；
//! 签名验证转发给内层的那部分只证明「对端手里有这张证书的私钥」，**不是身份**。
//!
//! 所以这个文件里最要紧的一条是 [`开关打开时_主机名对不上的自签证书也会被接受`]：
//! 证书是给 `self-signed.local` 签的，而客户端连的是 `127.0.0.1` ——
//! **名字对不上**，开关一开照样通。那就是「中间人自己签一张就能冒充任何域名」
//! 的机器可验证版本，钉在这儿，别只写在注释里（注释正是错过的东西）。
//!
//! # 证书是**测试时现生的**
//!
//! 用 `openssl` 命令行现生成一对自签证书（临时目录，跑完删掉），而不是把一张
//! 证书和私钥提交进仓库：
//!
//! * 仓库里躺着一个 `.key` 文件是给代码扫描器和后来的人添堵（「这是不是谁的真
//!   钥匙？」）；
//! * 现生成也就几十毫秒，而且能顺手把「主机名不匹配」这件事写进参数里。
//!
//! ⚠️ **没装 openssl 就明确说一声再跳过**（`secrets.rs` 那两条钥匙串测试是同一个
//! 待遇）—— 静默跳过会让人以为「验过了」，而这一组恰恰是安全属性的第一条防线。
//! CI 的 ubuntu runner 上 openssl 是预装的，所以那边跑得到。

use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

use devtoolkit_request::http::{ErrorKind, HttpRequest, HyperTransport, HttpTransport as _, RequestOptions};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// 证书**签给**哪个名字。
///
/// ⚠️ 客户端连的是 `127.0.0.1` —— 这两个**故意不一样**，见文件头部那段。
const CERT_NAME: &str = "self-signed.local";

/// 临时目录，**Drop 时删掉**（HANDOFF 里记过：`core/tests/export.rs` 漏了清理，
/// 每跑一次就往 /tmp 漏一批目录，攒到 32 个才发现）。
struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!(
            "devtoolkit-tls-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).expect("建不出临时目录");
        TempDir(dir)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// 现生成一对自签证书，返回 `(证书 DER, 私钥 DER)`。没装 openssl 返回 `None`。
fn make_cert(dir: &TempDir) -> Option<(Vec<u8>, Vec<u8>)> {
    let cert_pem = dir.0.join("cert.pem");
    let key_pem = dir.0.join("key.pem");
    let cert_der = dir.0.join("cert.der");
    let key_der = dir.0.join("key.der");

    let gen = Command::new("openssl")
        .args([
            "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "36500", "-subj",
            &format!("/CN={CERT_NAME}"),
        ])
        .arg("-keyout")
        .arg(&key_pem)
        .arg("-out")
        .arg(&cert_pem)
        .output();

    let ok = matches!(gen, Ok(out) if out.status.success());
    if !ok {
        return None;
    }

    // DER 而不是 PEM：读 PEM 要 `rustls-pemfile`，而它不在锁文件里 ——
    // 为两条测试拉一个新包不划算（openssl 本来就能直接吐 DER）
    let cert = Command::new("openssl")
        .args(["x509", "-in"])
        .arg(&cert_pem)
        .args(["-outform", "DER", "-out"])
        .arg(&cert_der)
        .output()
        .ok()?;
    if !cert.status.success() {
        return None;
    }

    // ⚠️ 私钥必须**显式转成 PKCS#8**（`pkcs8 -topk8 -nocrypt`）：openssl 3.0 的
    // `pkey -outform DER` 吐的是 **PKCS#1**（实测过：开头是 `30 82 .. 02 01 00 02 82`，
    // 即 RSAPrivateKey 的老结构），而 rustls 那边按 PKCS#8 收，报的是
    // 「failed to parse private key as RSA, ECDSA, or EdDSA」—— 一句看不出
    // 是「格式不对」的话。
    let key = Command::new("openssl")
        .args(["pkcs8", "-topk8", "-nocrypt", "-in"])
        .arg(&key_pem)
        .args(["-outform", "DER", "-out"])
        .arg(&key_der)
        .output()
        .ok()?;
    if !key.status.success() {
        return None;
    }

    Some((std::fs::read(cert_der).ok()?, std::fs::read(key_der).ok()?))
}

/// 起一个 TLS 假服务器：握手、读掉请求头、回一条带正文的 200。
///
/// 返回它监听在哪个端口。
async fn serve_tls(cert: Vec<u8>, key: Vec<u8>) -> u16 {
    let config = rustls::ServerConfig::builder_with_provider(std::sync::Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .expect("协议版本")
    .with_no_client_auth()
    .with_single_cert(
        vec![CertificateDer::from(cert)],
        PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key)),
    )
    .expect("服务端证书装不进去");

    let acceptor = tokio_rustls::TlsAcceptor::from(std::sync::Arc::new(config));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();

    tokio::spawn(async move {
        if let Ok((sock, _)) = listener.accept().await {
            let Ok(mut tls) = acceptor.accept(sock).await else {
                // 客户端在握手阶段就拒了（严格模式那条正是如此）——
                // 这一条连接到此为止，测试那边会拿到一个 TLS 错
                return;
            };
            let mut buf = Vec::new();
            let mut chunk = [0u8; 512];
            // 读到请求头结束就够（我们只回一条固定响应）
            while let Ok(n) = tls.read(&mut chunk).await {
                if n == 0 {
                    break;
                }
                buf.extend_from_slice(&chunk[..n]);
                if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
            }
            let _ = tls
                .write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok")
                .await;
            let _ = tls.flush().await;
            let _ = tls.shutdown().await;
        }
    });

    port
}

/// 发一个 GET，`accept_invalid_certs` 由调用方定。
async fn get(port: u16, accept_invalid_certs: bool) -> Result<u16, ErrorKind> {
    let mut request = HttpRequest {
        method: "GET".into(),
        url: format!("https://127.0.0.1:{port}/"),
        headers: Vec::new(),
        body: Vec::new(),
        options: RequestOptions {
            accept_invalid_certs,
            ..RequestOptions::default()
        },
    };
    request.options.timeout = Duration::from_secs(10);

    match HyperTransport::new().send(request).await {
        Ok(response) => {
            let _ = response.read_all(1024).await;
            Ok(200)
        }
        Err(e) => Err(e.kind),
    }
}

#[tokio::test]
async fn 默认校验_自签证书连不上() {
    let dir = TempDir::new();
    let Some((cert, key)) = make_cert(&dir) else {
        println!(
            "⚠️ 没装 openssl，跳过 {CERT_NAME} 那两条 TLS 测试（apt-get install openssl）——\
             这一组是「跳过证书校验」那个开关的安全属性，别当成验过了"
        );
        return;
    };

    let port = serve_tls(cert.clone(), key.clone()).await;

    // 这一条同时说明了默认值是**安全的那一头**：一张自签证书过不去
    let kind = get(port, false).await.expect_err("自签证书默认必须连不上");
    assert_eq!(kind, ErrorKind::Tls, "应当是证书那类错，而不是连不上");
}

#[tokio::test]
async fn 开关打开时_主机名对不上的自签证书也会被接受() {
    let dir = TempDir::new();
    let Some((cert, key)) = make_cert(&dir) else {
        println!(
            "⚠️ 没装 openssl，跳过 {CERT_NAME} 那两条 TLS 测试（apt-get install openssl）——\
             这一组是「跳过证书校验」那个开关的安全属性，别当成验过了"
        );
        return;
    };

    let port = serve_tls(cert, key).await;

    // ⚠️ 证书签给的是 `self-signed.local`，这里连的是 `127.0.0.1` —— **名字对不上**。
    // 开关一开**照样通**：这就是 rustls 那个回调里「链」和「名」两件事一起被跳过
    // 的机器可验证版本。要是哪天有人把校验器改成「只跳链、保留名字检查」，
    // 这条会红 —— 那时候请连着改 `tls.rs` 的模块文档和界面上那句红字。
    let status = tokio::time::timeout(Duration::from_secs(10), get(port, true))
        .await
        .expect("等超时了 —— 服务端没接上")
        .expect("开关开了还连不上：说明我们把名字校验也留着了（那就该改注释，不是改测试）");
    assert_eq!(status, 200);
}
