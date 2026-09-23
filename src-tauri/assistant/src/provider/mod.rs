//! 两个 provider：Anthropic 和 OpenAI 兼容。
//!
//! 两家只有两件事不一样：**请求体长什么样**、**Sse 帧怎么翻译成 [`Delta`]**。
//! 别的（发请求、读流、攒轮次、报错）完全一样，所以放在这里共用。
//!
//! # 一条规矩
//!
//! 这两个文件**只做翻译**，不做判断 —— 「截断了要不要执行工具」「拒绝了怎么办」
//! 全在 [`crate::loop_runner`] 里。翻译层多一个判断，就等于多一个测试盖不到的
//! 行为分支。
//!
//! [`Delta`]: crate::turn::Delta

pub mod anthropic;
pub mod openai;

use crate::session::{EventSink, ProviderError, RunEvent};
use crate::sse::Frame;
use crate::transport::{ErrorKind, HttpRequest, HttpTransport};
use crate::turn::{Delta, Turn, TurnAccum};

/// 非 2xx 时，最多从响应体里读多少字节当错误说明。
///
/// ⚠️ 必须有上限：错误正文是**对端说了算**的长度，放一个 1 GB 的进来
/// 就是一次内存事故。64 KiB 足够装下任何一家的错误 JSON（它们的原话都很短）。
const MAX_ERROR_BODY: usize = 64 * 1024;

/// 请求体、地址、请求头都准备好了，跑一次流式请求。
///
/// `translate` 由各 provider 提供：把一个 Sse 帧翻成零个或多个 [`Delta`]。
pub(crate) async fn run_stream<T>(
    transport: &T,
    request: HttpRequest,
    events: &EventSink,
    mut translate: impl FnMut(&Frame) -> Result<Vec<Delta>, ProviderError>,
) -> Result<Turn, ProviderError>
where
    T: HttpTransport,
{
    let response = transport.send(request).await.map_err(to_provider_error)?;

    if !response.is_ok() {
        // ⚠️ 错误正文**要读出来**：两家都是把「key 不对」「模型名写错了」
        // 这类信息放在响应体里的，只报一个状态码等于让用户去猜。
        //
        // ⚠️ 传输层**不再替我们读**它了（泛化之后 4xx/5xx 的 body 也是一条
        // 流，见 `HttpResponse::body` 的文档）—— 所以「读多少」这件事
        // 从传输层搬到了这里，上限见 [`MAX_ERROR_BODY`]。
        // 读不出来（连接断了）不算错：那就只剩状态码可报，和以前一样。
        let status = response.status;
        let detail = response
            .read_all(MAX_ERROR_BODY)
            .await
            .map(|body| String::from_utf8_lossy(&body.bytes).into_owned())
            .unwrap_or_default();
        return Err(ProviderError {
            message: describe_status(status, &detail),
            retryable: crate::transport::status_is_retryable(status),
        });
    }

    // ⚠️ 泛化之后 body **永远是一条流**（不再是 `Option`）：
    // 「4xx 有正文、2xx 有流」那个二选一是旧形状，见 `HttpResponse` 的文档。
    let mut body = response.body;

    let mut sse = crate::sse::SseBuffer::new();
    let mut accum = TurnAccum::new();

    while let Some(chunk) = body.recv().await {
        let bytes = match chunk {
            Ok(b) => b,
            // ⚠️ **读断了（`ErrorKind::Body`）在这里不当失败** —— 这是刻意的。
            //
            // 很多网关（CLI 代理、自己写的转发）把 SSE 的事件吐完就直接关
            // socket，**不发 chunked 的终止符**。传输层如实报了「字节流是被截断
            // 结束的」（那是对的说法），但对这一层来说：一轮是不是完整，
            // 判据在**内容**上 —— `message_stop` / `[DONE]` 到了没有、
            // 有没有半截帧。那两个判断就在下面几行。
            //
            // 拿传输层的收尾方式当判据的话，那种网关上的每一次对话都会变成
            // 「连接在响应中途断了」，而模型的原话明明已经收全了。
            Err(e) if e.kind == ErrorKind::Body => break,
            Err(e) => return Err(to_provider_error(e)),
        };
        for frame in sse.push(&bytes) {
            for delta in translate(&frame)? {
                // 边收边报 —— 界面要的是"正在打字"的效果，不是等整轮结束。
                match &delta {
                    Delta::Text { text, .. } => {
                        events.send(RunEvent::TextDelta { text: text.clone() });
                    }
                    Delta::Thinking { text, .. } => {
                        events.send(RunEvent::ThinkingDelta { text: text.clone() });
                    }
                    _ => {}
                }
                accum.apply(delta);
            }
        }
    }

    // 收尾：把最后那点字节处理掉（末尾孤立的 `\r` 是天生有歧义的，
    // 只有调用方知道"不会再有字节了"）。
    for frame in sse.finish() {
        for delta in translate(&frame)? {
            accum.apply(delta);
        }
    }

    // ⚠️ **断在半截上要当失败**，不能当成一轮完整的响应。
    // 当成功的话，这一轮的 assistant 消息会被追加进历史 ——
    // 而它可能是个没有配对 `tool_result` 的 `tool_use`，下一轮直接 400。
    if sse.has_partial() {
        return Err(ProviderError {
            message: "连接在响应中途断了".to_string(),
            retryable: true,
        });
    }

    if !accum.is_stopped() {
        return Err(ProviderError {
            message: "响应结束了但没收到结束标记".to_string(),
            retryable: true,
        });
    }

    Ok(accum.finish())
}

/// 从 Sse 帧里把 `data:` 解析成某个类型。
///
/// ⚠️ 两家的负载都是 JSON，**必须用真解析器** —— 拿字符串找子串的话，
/// 内容里带引号、转义、或者嵌套字段同名都会误判。
pub(crate) fn parse_data<T: serde::de::DeserializeOwned>(frame: &Frame) -> Result<T, ProviderError> {
    serde_json::from_str(&frame.data).map_err(|e| ProviderError {
        // 解析失败的**原文要带出来**：这种错多半是"对端不是我们以为的那一家"
        // （比如把 OpenAI 兼容的地址填进了 Anthropic 那一栏），
        // 不带原文的话用户完全无从查起。
        message: format!("响应格式看不懂（{}）：{}", e, clip(&frame.data)),
        retryable: false,
    })
}

/// 把一长串截短，用于报错文案。
pub(crate) fn clip(s: &str) -> String {
    const MAX: usize = 200;
    if s.chars().count() <= MAX {
        return s.to_string();
    }
    let head: String = s.chars().take(MAX).collect();
    format!("{head}…")
}

/// 传输层的错 → provider 的错。
///
/// ⚠️ 「值不值得重发」现在**由错误种类推出来**（[`HttpError::is_retryable`]），
/// 不再是构造这个错误的人当场填的一个布尔 —— 以前那个形状的问题是：
/// 每加一个出错的地方，都要由写那行代码的人自己判断填 true 还是 false，
/// 而「填错」在行为上只表现为「重试了/没重试」，看不出来。
fn to_provider_error(e: crate::transport::HttpError) -> ProviderError {
    // 先把种类问出来再搬 `message`（它是 `String`，move 之后 `e` 就没了）。
    let retryable = e.is_retryable();
    ProviderError {
        message: e.message,
        retryable,
    }
}

/// 状态码 + 响应正文 → 给用户看的一句话。
///
/// 两家的错误正文结构不一样，这里**不解析它** —— 只把原文附上。
/// 解析的话，对端换一版字段就变成"看不出来哪里错了"。
fn describe_status(status: u16, detail: &str) -> String {
    let head = match status {
        401 | 403 => "API key 不对或者没权限",
        404 => "接口地址或模型名不对",
        413 => "请求太大了",
        429 => "被限流了",
        s if (500..600).contains(&s) => "对端出错了",
        _ => "请求被拒绝了",
    };
    if detail.trim().is_empty() {
        format!("{head}（HTTP {status}）")
    } else {
        format!("{head}（HTTP {status}）：{}", clip(detail.trim()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_status_with_a_body_keeps_the_body() {
        // ⚠️ 两家的错误正文里才有「模型名写错了」这种可行动的信息，
        // 只报一个状态码等于让用户去猜。
        let msg = describe_status(404, r#"{"error":{"message":"model not found"}}"#);
        assert!(msg.contains("model not found"), "{msg}");
        assert!(msg.contains("404"));
    }

    #[test]
    fn an_empty_body_still_says_something_useful() {
        let msg = describe_status(500, "   ");
        assert!(msg.contains("对端出错了"));
        assert!(!msg.contains("："), "没有正文就不该拖一个冒号：{msg}");
    }

    #[test]
    fn a_long_body_is_clipped() {
        let long = "x".repeat(5000);
        let msg = describe_status(400, &long);
        assert!(msg.chars().count() < 400, "报错文案不该拖一屏");
        assert!(msg.ends_with('…'));
    }

    #[test]
    fn a_wrong_provider_produces_a_message_that_shows_what_came_back() {
        // 把 OpenAI 兼容的地址填进 Anthropic 那一栏，是这个错误的典型来源。
        let frame = Frame {
            event: Some("content_block_delta".into()),
            data: "not json at all".into(),
        };
        let err = parse_data::<serde_json::Value>(&frame).unwrap_err();
        assert!(err.message.contains("not json at all"), "{}", err.message);
        assert!(!err.retryable, "格式看不懂重发一万次也一样");
    }
}
