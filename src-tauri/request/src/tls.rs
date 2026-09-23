//! ⚠️ **全仓库唯一建 rustls 配置的地方。**
//!
//! # 为什么必须只有一份
//!
//! 树里 `ring` 和 `aws-lc-rs` **两个加密后端都在**（tauri / mongodb 拉的），
//! 而 rustls 的「自动挑后端」在**两个都在**的时候返回 `None` ——
//! 于是**第一次真正发 HTTPS 请求时 panic**，编译期完全看不出来。
//! 更阴的是这个 feature 在「单独构建这个 crate」和「整个工作区构建」时还不一样。
//!
//! 所以这里 `builder_with_provider(ring)` **显式钉死**，不信自动挑。
//!
//! # 为什么连「忽略证书错误」也在这一份里
//!
//! ⚠️ **任何一个自己建 `ClientConfig` 的地方，都是同一个坑的新入口。**
//! 已经有两个了：
//!
//! 1. 这份（HTTP）；
//! 2. 马上要加的 WebSocket —— `tokio-tungstenite` 有个 `Connector::Rustls` 变体，
//!    它**接受别人给的 config**。传我们这份进去，别让它自己建。
//!
//! 把两者收在同一个函数里，「第三个入口」就不可能出现 —— 这正是这个文件存在的理由。
//!
//! # 「忽略证书错误」是给谁用的
//!
//! 内网自签证书的服务、本地开发服务器 —— 调接口时天天遇到。界面上的开关
//! **带红字提示**，而且默认关着。
//!
//! ## ⚠️⚠️ 它到底跳过了什么（这一段改过一次，之前写少了一半）
//!
//! 我们换掉的是 [`ServerCertVerifier::verify_server_cert`] 这**一个**回调，
//! 而 rustls 在那个函数里做**两件事**（读过 `webpki/server_verifier.rs`）：
//!
//! 1. `verify_server_cert_signed_by_trust_anchor_impl` —— 链：这张证书是不是
//!    可信 CA 签的；
//! 2. `verify_server_name` —— 名：这张证书是不是**发给这个主机的**。
//!
//! 两件都在它里面，所以开关一开**两件都不查了**。原来这里的注释只写了第 1 条，
//! 还顺手得出「拿别人的证书来冒充仍然会被挡下」—— **那是错的**：
//! 名字不查之后，中间人**自己生成一张自签证书**就能冒充任何一个域名。
//!
//! 签名验证（[`ServerCertVerifier::verify_tls13_signature`]）确实还转发给内层，
//! 但它证的是「对端手里有**这张证书**对应的私钥」，**不是身份** ——
//! 它挡的只是「照抄一张证书、拿不到私钥」这一种。
//!
//! 一句话：**开着它等于接受任何人的证书**。所以界面上那句红字写的是
//! 「中间人能看到和改掉全部内容」，不是「只影响自签证书」。
//! （这条有测试钉着：`tests/tls_self_signed.rs` —— 一张**主机名对不上**的
//! 自签证书，开关打开时必须**通过**。那是这个开关的真实代价。）

use std::sync::Arc;

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::client::WebPkiServerVerifier;
use rustls::crypto::ring;
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};

/// 建一份客户端 TLS 配置。**HTTP 和 WS 都走它。**
///
/// `accept_invalid_certs` 见模块文档 —— ⚠️ 它跳过的是**链和主机名两样**，
/// 不是「只跳链」。
///
/// 返回 `Err(String)` 而不是 crate 的错误类型：这个文件不该认识 `HttpError`
/// （WS 那边也有自己的错误类型），调用方自己包一层。
pub fn client_config(accept_invalid_certs: bool) -> Result<Arc<rustls::ClientConfig>, String> {
    let provider = Arc::new(ring::default_provider());

    let builder = rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .map_err(|e| format!("TLS 配置不对：{e}"))?;

    let config = if accept_invalid_certs {
        // ⚠️ 内层 verifier **也要显式给 provider** —— `WebPkiServerVerifier::builder()`
        // 那条路走的是进程默认 provider，也就是「自动挑」的第三个入口。
        let inner = WebPkiServerVerifier::builder_with_provider(
            Arc::new(root_store()),
            provider,
        )
        .build()
        .map_err(|e| format!("TLS 校验器建不起来：{e}"))?;

        builder
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(TrustAnyCert(inner)))
            .with_no_client_auth()
    } else {
        builder.with_root_certificates(root_store()).with_no_client_auth()
    };

    Ok(Arc::new(config))
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

/// 「谁的证书都收」的包装器。
///
/// ⚠️ 名字从前叫 `SkipChainVerification`，**改掉是因为那个名字说的是假的**：
/// 它把 `verify_server_cert` 换成了恒真，而 rustls 在那个回调里同时做
/// **链验证**和**主机名校验** —— 见模块文档那段（名字少说了一半，害得注释
/// 也跟着错了一半：冒充是挡不住的）。
///
/// 签名验证**转发给内层**：它证的是「对端手里有这张证书对应的私钥」，
/// 挡住的是「照抄一张证书」那一种，**不是身份**。
#[derive(Debug)]
struct TrustAnyCert(Arc<WebPkiServerVerifier>);

impl ServerCertVerifier for TrustAnyCert {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        // 唯一的让步：**链和主机名都不查了**（自签证书卡在前者，
        // 内网 IP 上的证书卡在后者）。签名那两条在上面转发给内层。
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.0.verify_tls12_signature(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.0.verify_tls13_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.supported_verify_schemes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 两种模式都建得出来，而且**拿得到握手里要用的那几样东西**。
    ///
    /// ⚠️ 这条测的不是「能不能连上」（那在 `tests/tls_self_signed.rs` 里，
    /// 用真证书真握手），它挡的是另一半：**加密后端没钉死时，
    /// `builder_with_provider` 之外的那条路会在第一次握手时 panic** ——
    /// 编译期看不出来，而这里至少能在毫秒级单测里证明
    /// 「配置建得出来、verifier 在里面」。
    ///
    /// 用 `Debug` 形态断言是刻意的：`ClientConfig` 内部结构不对外，
    /// 而我们要的正是「里面塞的是我们那个包装器」这件事。
    #[test]
    fn 两种模式都建得出配置() {
        let strict = client_config(false).expect("严格校验那份建不出来");
        assert!(!format!("{strict:?}").contains("TrustAnyCert"));

        let lax = client_config(true).expect("跳过链校验那份建不出来");
        assert!(
            format!("{lax:?}").contains("TrustAnyCert"),
            "开了开关却没换上我们的校验器"
        );
    }

    #[test]
    fn 根证书是打包进来的那一份() {
        // ⚠️ 空的话所有 HTTPS 请求都会以「证书链不对」告终，而且看起来
        // 像是用户的网络问题。webpki-roots 的那份是几百张，不是 0 张。
        assert!(root_store().len() > 100, "根证书库看着是空的");
    }
}
