//! 「接口调试」的命令层。
//!
//! 真正的活儿全在 `devtoolkit-request` 里（那个 crate 不依赖 tauri，所以能脱离
//! WebKit 跑真 socket 的测试）。这里只做两件事：**把前端那份 spec 翻译成
//! `HttpRequest`**，以及**把响应体的字节流接上 `Channel`**。
//!
//! # ⚠️ 三条踩过的坑，都在这儿
//!
//! 1. **Channel 必须活到事件发完**（`Channel` 一被丢掉，Rust 侧就往 JS 发一条
//!    `{end: true}`，JS 收到就**注销回调** —— 之后的消息石沉大海，而且不报错）。
//!    所以这个命令**一直 await 到整个请求结束**，通道就攥在函数体里：
//!    和 `assistant_commands.rs` 那个 spawn 出去的转发任务相比，这里不需要
//!    spawn —— 命令本身活到最后，通道自然活到最后。
//! 2. **无论从哪条路退出都要发一条终态事件**（`Finished` 或 `Failed`）。
//!    漏了的话前端那个「正在跑」永远停不下来 —— 而它既不报错、也不超时，
//!    用户只能看着一个转圈的界面。下面每一条 return 前面都有一句。
//! 3. **转发有 2 MiB 上限**（[`MAX_FORWARD_BYTES`]）。调接口调试的时候一个
//!    几百 MB 的下载是家常便饭，全塞进 webview 就是一次内存事故。
//!
//! # 所有结局都走通道，不走返回值
//!
//! `Result<(), String>` 的 `Err` 只留给**命令根本没跑起来**那一种
//!（最典型的是前端少发了一个字段 —— serde 反序列化失败，见 HANDOFF 里
//! `rename_all_fields` 那一节）。请求本身的失败（连不上、超时、404 之后读断了）
//! 全是**数据**，走 `Failed` 事件 —— 和 SSH 那边「主机密钥的两种拒绝走 `Ok`」
//! 是同一条分工：`Err` 只说明「这次往返没做完」，不代表别的。
//!
//! # 这一版**没有**「停止」
//!
//! Postman 有一个 Cancel 按钮，这里没有。理由和代价都记下来，别当成漏了：
//! 停止要在读循环里插一个可等待的取消信号，而那个循环在 `devtoolkit-request`
//! 里 —— 也就是说得把「取消」这个概念引进传输层（`RequestOptions` 或
//! 一个新参数），而传输层现在是干净的：它只知道「发出去、把字节读回来」。
//! 不做的代价是**一条永远不结束的响应只能等空闲超时**（默认 90 秒）；
//! 流式响应有 2 MiB 上限兜着，所以真正会卡住的只有「连上了但一直不吐数据」
//! 那一种，而那正好就是空闲超时管的事。真要做，正确的形状是在读循环里
//! `select!` 一个取消信号（而不是在前端假装停了、后面还在读）。

use std::time::{Duration, Instant};

use base64::Engine as _;
use devtoolkit_request::http::{ErrorKind, HttpRequest, HttpTransport as _, HyperTransport, RequestOptions};
use tauri::ipc::Channel;

/// 最多往 webview 里搬多少响应体。
///
/// ⚠️ 2 MiB 是**转发**上限，不是读取上限：超了就停转发、把接收端丢掉
///（`rx` 一没，Rust 侧那个读循环 `send` 会失败，于是它真的把连接收掉 ——
/// 不是继续在后台读一个几百 MB 的文件）。
///
/// 这个数针对的是「调接口时看一眼响应」：几兆的 JSON 已经很罕见了，
/// 而真要下载文件，用户会用专门的工具，不会用调试器。
const MAX_FORWARD_BYTES: usize = 2 * 1024 * 1024;

/// 前端那份请求。字段名是 camelCase（和 `services/types.ts` 一一对应）。
///
/// ⚠️ **`rename_all` 不往下传**：`options` 是另一层结构，它得自己写一遍
/// （`rename_all_fields` 只在**枚举的变体内部**传播，也不管这种嵌套结构体）。
/// 下面那条契约测试就是拿**手写的前端 JSON** 去反序列化它 —— 照着 Rust 结构体
/// 拼的话，两边一起错还是绿的。
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestSpec {
    /// `"GET"` / `"post"` / 自定义方法（`PROPFIND` 那种）都行 —— 传输层不设白名单。
    pub method: String,
    /// 完整地址。**前端不做任何补全**（不加 `http://`，理由见前端 `core/draft.ts`）。
    pub url: String,
    /// 已经过筛选的请求头（没启用的那些前端就不发过来）。同名头允许多条。
    pub headers: Vec<(String, String)>,
    /// 请求体。⚠️ 空 = **不带 body**（不是「带一个长度为 0 的 body」——
    /// 后者会让 hyper 发出 `content-length: 0`，有些网关会挑它）。
    ///
    /// ⚠️ 一期只有文本：传输层支持任意字节（那是抽 crate 的理由之一），
    /// 但界面上还没有「选一个文件当 body」的入口。
    pub body: String,
    /// 可调项。
    pub options: OptionsSpec,
}

/// 可调项。**默认值 = 传输层的默认值**（前端那边也照抄一份，见 `core/draft.ts`）。
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OptionsSpec {
    /// 建连 + TLS 握手 + 等响应头的上限（秒）。
    pub timeout_secs: u64,
    /// 响应体两块数据之间的上限（秒）—— 「对端多久不说话了」。
    pub idle_timeout_secs: u64,
    /// 跟不跟 3xx。
    pub follow_redirects: bool,
    /// 最多跟几跳。⚠️ 收 `u32` 而在下面夹到传输层的 `u8`：
    /// 让**越界变成一个确定的、有文档的行为**，而不是一句 serde 的
    /// `invalid value: integer 300`（那句话对用户毫无意义）。
    pub max_redirects: u32,
    /// ⚠️ **跳过证书链校验**（只跳链，不跳签名）。界面上有红字提示，默认关。
    pub accept_invalid_certs: bool,
}

/// 往前端推的事件。
///
/// ⚠️ 形状必须和 `modules/request/services/types.ts` 里的 `RequestEvent`
/// **一字不差**。这条缝两端的测试结构性地盖不到（假实现对不上真 serde，
/// 内核测试又不过序列化）—— 所以下面有一组契约测试，拿**手写的 JSON**
/// 逐个变体钉住字段名。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum RequestEvent {
    /// 响应头到了。**正文之前先报它** —— 用户这时候就该看见状态码，
    /// 而不是一个字节都不显示地干等（大响应的首字节可能要好几秒）。
    Started {
        /// 状态码。
        status: u16,
        /// 原因短语（`"OK"`）。
        reason: String,
        /// 响应头。**保序、重复的都在**（`set-cookie` 那几条要原样列出来）。
        headers: Vec<(String, String)>,
        /// 跟完跳转之后的最终地址。
        final_url: String,
        /// 经过的每一跳。
        redirects: Vec<RedirectInfo>,
        /// `"HTTP/1.1"`。
        http_version: String,
        /// **从这个命令开始到响应头到手**（含建连和 TLS 握手）。
        /// ⚠️ 它和传输层自己那个 `ttfb` 不是一回事：那个不含建连。
        /// 界面上显示的是这个（用户的心理模型是「我点了发送之后等了多久」）。
        elapsed_millis: u64,
    },
    /// 响应体的一块。**base64** —— 和 SSH 那个方向对称。
    ///
    /// 不用 `Vec<u8>`：serde 会把它编成数字数组（每个字节三四个字符）。
    /// 也**不在 Rust 侧把它解成文本**：SSH 那轮记过，块边界会切断多字节
    /// UTF-8（中文变 U+FFFD）；前端用 `TextDecoder` 的流式模式解，
    /// 那条路子认得半个字符。
    Chunk {
        /// 这一块的字节。
        base64: String,
    },
    /// 读完了（或者撞上转发上限了）。**一定是最后一条。**
    Finished {
        /// 实际交到前端手上的字节数（撞上限时就是上限）。
        bytes: u64,
        /// 是不是撞上了 [`MAX_FORWARD_BYTES`]。
        truncated: bool,
        /// 从点发送到读完的总耗时。
        total_millis: u64,
    },
    /// 出错了。**一定是最后一条。**
    ///
    /// ⚠️ 正文读到一半才出错（空闲超时、连接被掐）时也会走这里 ——
    /// 所以带上 `bytes`，界面才能说清「收到 8 KiB 之后断了」，
    /// 而不是把已经收到的内容一起丢掉。
    Failed {
        /// 出错的大类（`invalid` / `connect` / `tls` / `timeout` / `idle` /
        /// `redirect` / `protocol` / `body`）。界面按它决定怎么措辞。
        error_kind: String,
        /// 给用户看的一句话（中文，可直接显示）。
        message: String,
        /// 出错之前已经收到的字节数。
        bytes: u64,
    },
}

/// 一次跳转（界面把它画成一条链）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedirectInfo {
    /// 那一跳的状态码。
    pub status: u16,
    /// 从哪儿。
    pub from: String,
    /// 到哪儿。
    pub to: String,
}

/// 发一个请求，响应走通道回来。
///
/// 一直 await 到读完为止（理由见模块头部第 1 条）。
#[tauri::command]
pub async fn request_send(
    spec: RequestSpec,
    channel: Channel<RequestEvent>,
) -> Result<(), String> {
    let options = RequestOptions {
        // ⚠️ 下限 1 秒：0 会变成「立刻超时」，而用户填 0 的意思多半是
        // 「我不想等」，不是「让这个请求必然失败」。
        timeout: Duration::from_secs(spec.options.timeout_secs.max(1)),
        idle_timeout: Duration::from_secs(spec.options.idle_timeout_secs.max(1)),
        follow_redirects: spec.options.follow_redirects,
        max_redirects: spec.options.max_redirects.min(20) as u8,
        accept_invalid_certs: spec.options.accept_invalid_certs,
    };

    let request = HttpRequest {
        method: spec.method,
        url: spec.url,
        headers: spec.headers,
        body: spec.body.into_bytes(),
        options,
    };

    let started = Instant::now();

    // ① 发出去。这一步的失败（地址不合法 / 连不上 / 证书不对 / 超时）
    //    也走通道 —— 它在界面上和「读到一半断了」是同一种东西：一条红字。
    let response = match HyperTransport::new().send(request).await {
        Ok(response) => response,
        Err(e) => {
            let _ = channel.send(RequestEvent::Failed {
                error_kind: kind_name(e.kind).to_string(),
                message: e.message,
                bytes: 0,
            });
            return Ok(());
        }
    };

    let _ = channel.send(RequestEvent::Started {
        status: response.status,
        reason: response.reason.clone(),
        headers: response.headers.clone(),
        final_url: response.final_url.clone(),
        redirects: response.redirects.iter().map(RedirectInfo::from).collect(),
        http_version: response.http_version.clone(),
        elapsed_millis: started.elapsed().as_millis() as u64,
    });

    // ② 搬正文。
    let mut body = response.body;
    let mut bytes: u64 = 0;
    let mut truncated = false;

    while let Some(chunk) = body.recv().await {
        match chunk {
            Ok(data) => {
                if bytes + data.len() as u64 > MAX_FORWARD_BYTES as u64 {
                    // ⚠️ **超了就停手**，不是「读完再截」——后者会一边读一个
                    // 几百 MB 的文件一边把内存吃光。break 之后 `body` 被丢掉，
                    // 传输层那边 `send` 失败就真的把连接收掉了。
                    truncated = true;
                    break;
                }
                bytes += data.len() as u64;
                let _ = channel.send(RequestEvent::Chunk {
                    base64: base64::engine::general_purpose::STANDARD.encode(&data),
                });
            }
            Err(e) => {
                // ⚠️ 正文读了一半断掉也走终态事件，并且**带上已经收到的字节数**
                // —— 界面要能说「收到 8 KiB 之后断了」，而不是把收到的
                // 一起丢掉（调 SSE 的时候那半截往往正是你要看的东西）。
                let _ = channel.send(RequestEvent::Failed {
                    error_kind: kind_name(e.kind).to_string(),
                    message: e.message,
                    bytes,
                });
                return Ok(());
            }
        }
    }

    let _ = channel.send(RequestEvent::Finished {
        bytes,
        truncated,
        total_millis: started.elapsed().as_millis() as u64,
    });
    Ok(())
}

/// 错误大类 → 前端认得的短名（`ErrorKind` 的 serde 形态）。
///
/// 手写映射而不用 `serde` 派生：`ErrorKind` 在传输层是**给 Rust 调用方**
/// 用的枚举，它的序列化形态在这里才第一次有意义 —— 让传输层为了 IPC 去
/// 派生 Serialize，等于把「前端认什么名字」这件事塞进传输层。
fn kind_name(kind: ErrorKind) -> &'static str {
    match kind {
        ErrorKind::Invalid => "invalid",
        ErrorKind::Connect => "connect",
        ErrorKind::Tls => "tls",
        ErrorKind::Timeout => "timeout",
        ErrorKind::Idle => "idle",
        ErrorKind::Redirect => "redirect",
        ErrorKind::Protocol => "protocol",
        ErrorKind::Body => "body",
    }
}

impl From<&devtoolkit_request::http::Redirect> for RedirectInfo {
    fn from(r: &devtoolkit_request::http::Redirect) -> Self {
        RedirectInfo {
            status: r.status,
            from: r.from.clone(),
            to: r.to.clone(),
        }
    }
}

// ------------------------------------------------------------------ 契约测试

/// ⚠️ 这一组测的是**前端和 Rust 之间那条缝**，而两边的测试都盖不到它：
/// 浏览器版 e2e 走的是 `services/web.ts` 的假实现（根本不过 serde），
/// 内核那些测试又在 Rust 里直接构造结构体（不过反序列化）。
///
/// 规矩（HANDOFF 里 `rename_all_fields` 那一节定的）：**手写前端会发出来的
/// JSON 字面量**，不要照着 Rust 结构体拼 —— 拼的话两边一起错还是绿的。
#[cfg(test)]
mod contract {
    use super::*;
    use serde_json::json;

    /// 前端 `services/types.ts` 里那份 `RequestSpec` 对应的请求。
    const FRONTEND_SPEC: &str = r#"{
        "method": "POST",
        "url": "https://httpbin.org/post",
        "headers": [["content-type", "application/json"]],
        "body": "{\"a\":1}",
        "options": {
            "timeoutSecs": 30,
            "idleTimeoutSecs": 90,
            "followRedirects": true,
            "maxRedirects": 5,
            "acceptInvalidCerts": false
        }
    }"#;

    #[test]
    fn 前端发过来的那份_spec_能反序列化() {
        let spec: RequestSpec = serde_json::from_str(FRONTEND_SPEC).expect(
            "前端那份 JSON 反序列化不了 —— 多半是某个字段名没跟上 camelCase\
             （嵌套结构体要自己写一遍 rename_all）",
        );
        assert_eq!(spec.method, "POST");
        assert_eq!(spec.headers.len(), 1);
        assert_eq!(spec.body, r#"{"a":1}"#);
        assert_eq!(spec.options.timeout_secs, 30);
        // ⚠️ 这两个是**嵌套结构体里的** camelCase 字段，最容易漏
        assert!(spec.options.follow_redirects);
        assert_eq!(spec.options.max_redirects, 5);
        assert!(!spec.options.accept_invalid_certs);
    }

    #[test]
    fn 事件形状和前端那份类型对得上() {
        // ⚠️ 每个变体都要有：漏一个的话，前端拿到它会**静默对不上**
        //（TS 那边收窄不了，运行时是一个 undefined 字段）。
        let started = RequestEvent::Started {
            status: 200,
            reason: "OK".into(),
            headers: vec![("set-cookie".into(), "a=1".into())],
            final_url: "https://x/y".into(),
            redirects: vec![RedirectInfo {
                status: 302,
                from: "https://x/a".into(),
                to: "https://x/y".into(),
            }],
            http_version: "HTTP/1.1".into(),
            elapsed_millis: 42,
        };
        assert_eq!(
            serde_json::to_value(started).unwrap(),
            json!({
                "kind": "started",
                "status": 200,
                "reason": "OK",
                "headers": [["set-cookie", "a=1"]],
                "finalUrl": "https://x/y",
                "redirects": [{ "status": 302, "from": "https://x/a", "to": "https://x/y" }],
                "httpVersion": "HTTP/1.1",
                "elapsedMillis": 42
            })
        );

        assert_eq!(
            serde_json::to_value(RequestEvent::Chunk {
                base64: "aGk=".into()
            })
            .unwrap(),
            json!({ "kind": "chunk", "base64": "aGk=" })
        );

        assert_eq!(
            serde_json::to_value(RequestEvent::Finished {
                bytes: 1234,
                truncated: true,
                total_millis: 99
            })
            .unwrap(),
            json!({ "kind": "finished", "bytes": 1234, "truncated": true, "totalMillis": 99 })
        );

        assert_eq!(
            serde_json::to_value(RequestEvent::Failed {
                error_kind: "idle".into(),
                message: "连上了，但对端 90 秒没再回数据".into(),
                bytes: 8192
            })
            .unwrap(),
            json!({
                "kind": "failed",
                "errorKind": "idle",
                "message": "连上了，但对端 90 秒没再回数据",
                "bytes": 8192
            })
        );
    }

    #[test]
    fn 八种错误都有短名() {
        // ⚠️ 界面按这个短名决定措辞（「证书不对」和「连不上」要说不同的话），
        // 少一个的话前端会拿到 undefined 而只能显示一句兜底文案。
        let all = [
            ErrorKind::Invalid,
            ErrorKind::Connect,
            ErrorKind::Tls,
            ErrorKind::Timeout,
            ErrorKind::Idle,
            ErrorKind::Redirect,
            ErrorKind::Protocol,
            ErrorKind::Body,
        ];
        for kind in all {
            let name = kind_name(kind);
            assert!(!name.is_empty());
            assert!(
                name.chars().all(|c| c.is_ascii_lowercase()),
                "短名要是小写的 ASCII：{name}"
            );
        }
    }
}
