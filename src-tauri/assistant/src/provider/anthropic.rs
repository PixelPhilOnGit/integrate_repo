//! Anthropic 的 Messages API（`POST /v1/messages` + SSE）。
//!
//! # 这个文件只做两件事
//!
//! 1. 把中立模型的请求**编成** Anthropic 的线格式；
//! 2. 把 Sse 帧**翻译成** [`Delta`]。
//!
//! 别的都不做。**尤其不做判断** —— 「截断了要不要执行工具」那类决定全在
//! `loop_runner` 里，翻译层多一个判断就多一个测试盖不到的分支。
//!
//! # 几个必须记住的线格式事实
//!
//! * `stop_reason` 在 **`message_delta`** 里，不在 `message_stop` 里 ——
//!   从后者读永远读到空值。
//! * `input_tokens` 只是**未缓存的那部分**，总输入还要加 cache_read 和
//!   cache_creation（两个 TTL 档分开给）。
//! * 工具参数是 `input_json_delta` 的**片段**，要按 `index` 拼，拼完才解析。
//! * `thinking` 块的内容字段叫 `thinking` 不叫 `text`；签名单独一个
//!   `signature_delta` 到达。

use serde::Deserialize;
use serde_json::{json, Value};

use crate::message::{Block, Message, Role, Usage};
use crate::provider::{clip, parse_data, run_stream};
use crate::session::{EventSink, Provider, ProviderError, ProviderRequest};
use crate::sse::Frame;
use crate::transport::{HttpRequest, HttpTransport};
use crate::turn::{Delta, Turn};

/// Anthropic 的接口版本。**写死不要动** —— 它管的是线格式的兼容性。
const API_VERSION: &str = "2023-06-01";

/// 一次 Anthropic 请求要什么。
#[derive(Debug, Clone)]
pub struct AnthropicConfig {
    /// 模型 id（`claude-opus-5` 之类）。
    pub model: String,
    /// 一轮的输出上限。
    pub max_tokens: u32,
    /// 思考深度。
    ///
    /// ⚠️ 一期**不暴露给用户**：改它会打断 messages 那一段的 prompt 缓存。
    /// 固定住是缓存友好的一部分。
    pub effort: String,
}

impl Default for AnthropicConfig {
    fn default() -> Self {
        AnthropicConfig {
            model: "claude-opus-5".into(),
            max_tokens: 16_000,
            effort: "high".into(),
        }
    }
}

/// Anthropic 的 provider。
///
/// 泛型而不是 `dyn HttpTransport`：那两个 trait 的方法都用了 RPITIT，
/// 不是对象安全的。泛型在这里没有代价（调用点只实例化一次）。
pub struct AnthropicProvider<T: HttpTransport> {
    transport: T,
    base_url: String,
    config: AnthropicConfig,
    api_key: String,
}

impl<T: HttpTransport> AnthropicProvider<T> {
    /// 建一个。
    pub fn new(transport: T, base_url: String, config: AnthropicConfig, api_key: String) -> Self {
        AnthropicProvider {
            transport,
            base_url,
            config,
            api_key,
        }
    }

    /// 编请求。
    pub fn build_request(&self, request: &ProviderRequest) -> Result<HttpRequest, ProviderError> {
        let body = json!({
            "model": self.config.model,
            "max_tokens": self.config.max_tokens,
            // 流式：长回合不流式会撞 HTTP 超时，而且界面上是空白一片等半天。
            "stream": true,
            // system 是**独立字段**，不在 messages 里（见 `message::Role` 的文档）。
            "system": request.system,
            "messages": messages_to_json(&request.messages),
            "tools": tools_to_json(&request.tools),
            // ⚠️ 必须显式写。默认是 omitted，那样界面上会是一段莫名其妙的长空白 ——
            // 用户看不出"它在想"还是"它卡住了"。
            "thinking": { "type": "adaptive", "display": "summarized" },
            "output_config": { "effort": self.config.effort },
        });

        let body = serde_json::to_string(&body).map_err(|e| ProviderError {
            message: format!("请求编不出来：{e}"),
            retryable: false,
        })?;

        // `HttpRequest::post` 就是助手要的那条捷径：POST + 一段 UTF-8 文本。
        // 泛化之后请求**不再只能是** POST 了（接口调试要任意方法），
        // 但这个构造器把「助手这边永远是这样」写在一处，见它的文档。
        Ok(HttpRequest::post(
            join(&self.base_url, "/v1/messages"),
            vec![
                ("content-type".into(), "application/json".into()),
                ("x-api-key".into(), self.api_key.clone()),
                ("anthropic-version".into(), API_VERSION.into()),
            ],
            body,
        ))
    }
}

impl<T: HttpTransport> Provider for AnthropicProvider<T> {
    async fn stream(
        &self,
        request: ProviderRequest,
        events: EventSink,
    ) -> Result<Turn, ProviderError> {
        let transport_request = self.build_request(&request)?;
        run_stream(&self.transport, transport_request, &events, translate).await
    }
}

/// 地址拼路径（去重斜杠）。
fn join(base: &str, path: &str) -> String {
    format!(
        "{}/{}",
        base.trim_end_matches('/'),
        path.trim_start_matches('/')
    )
}

/// 中立消息 → Anthropic 的 `messages`。
fn messages_to_json(messages: &[Message]) -> Value {
    Value::Array(
        messages
            .iter()
            .map(|m| {
                json!({
                    "role": match m.role { Role::User => "user", Role::Assistant => "assistant" },
                    "content": blocks_to_json(&m.content),
                })
            })
            .collect(),
    )
}

/// 一轮的内容块 → JSON 数组。
fn blocks_to_json(blocks: &[Block]) -> Value {
    Value::Array(blocks.iter().filter_map(block_to_json).collect())
}

fn block_to_json(block: &Block) -> Option<Value> {
    match block {
        Block::Text { text } => Some(json!({ "type": "text", "text": text })),

        // `sanitize` 已经剥过 thinking 了。这里再兜一次底：漏出去的 thinking
        // 块会在改写过历史时被服务端判为无效（400），而且那个 400
        // 看不出和上下文策略有关系。
        Block::Thinking { .. } => None,

        Block::ToolUse { id, name, input } => Some(json!({
            "type": "tool_use",
            "id": id,
            "name": name,
            // ⚠️ 解析成 `Value` 再塞进去**不会打乱键序** —— 我们给 serde_json
            // 开了 `preserve_order`（见 Cargo.toml）。没有它的话每次回传都会
            // 按字母重排，prompt 缓存的前缀就全变了。
            "input": serde_json::from_str::<Value>(input.get()).ok()?,
        })),

        Block::ToolResult {
            tool_use_id,
            content,
            is_error,
        } => Some(json!({
            "type": "tool_result",
            "tool_use_id": tool_use_id,
            "content": content,
            "is_error": is_error,
        })),

        // 认不出来的块**原样发回去**。丢一个都是静默的行为改变
        // （官方要求把完整的 content 带回去）。
        Block::Unknown { raw } => serde_json::from_str::<Value>(raw.get()).ok(),
    }
}

/// 工具定义 → Anthropic 的 `tools`。
fn tools_to_json(tools: &[crate::tool::ToolSpec]) -> Value {
    Value::Array(
        tools
            .iter()
            .map(|t| {
                json!({
                    "name": t.name,
                    "description": t.description,
                    "input_schema": t.schema,
                    // ⚠️ 开了它，服务端就**不再校验、也不再纠正**参数 ——
                    // 片段直接流过来。所以工具层必须自己按 schema 验一遍
                    // （`tool::validate_input` 就是干这个的）。
                    //
                    // 为什么还要开：不开的话，一个会写整份文件的工具，
                    // 参数会在服务端攒完才一起吐过来 —— 那是**好几分钟的静默**。
                    "eager_input_streaming": true,
                })
            })
            .collect(),
    )
}

// ------------------------------------------------------------------ 事件翻译

/// `message_start` 里的用量。
#[derive(Debug, Deserialize)]
struct MessageStart {
    message: StartMessage,
}

#[derive(Debug, Deserialize)]
struct StartMessage {
    #[serde(default)]
    usage: StartUsage,
}

#[derive(Debug, Default, Deserialize)]
struct StartUsage {
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    cache_read_input_tokens: u64,
    /// ⚠️ 两档 TTL 分开给。只留一个总数的话**算不出准确成本** ——
    /// 5 分钟档写入价是 1.25×，1 小时档是 2×。
    #[serde(default)]
    cache_creation: CacheCreation,
}

#[derive(Debug, Default, Deserialize)]
struct CacheCreation {
    #[serde(default)]
    ephemeral_5m_input_tokens: u64,
    #[serde(default)]
    ephemeral_1h_input_tokens: u64,
}

#[derive(Debug, Deserialize)]
struct BlockStart {
    index: u32,
    content_block: Value,
}

#[derive(Debug, Deserialize)]
struct BlockDelta {
    index: u32,
    delta: DeltaPayload,
}

#[derive(Debug, Deserialize)]
struct DeltaPayload {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    text: String,
    /// 思考块的正文 —— 字段名叫 `thinking` 不叫 `text`。
    #[serde(default)]
    thinking: String,
    #[serde(default)]
    signature: String,
    #[serde(default)]
    partial_json: String,
}

#[derive(Debug, Deserialize)]
struct MessageDelta {
    #[serde(default)]
    delta: StopPayload,
    #[serde(default)]
    usage: OutputUsage,
}

#[derive(Debug, Default, Deserialize)]
struct StopPayload {
    #[serde(default)]
    stop_reason: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct OutputUsage {
    #[serde(default)]
    output_tokens: u64,
}

/// 一个 Sse 帧 → 零个或多个增量。
///
/// ⚠️ **认不出来的事件要忽略，不能报错**：服务端加新事件类型是常态
/// （`ping`、`message_stop`、将来的新东西），为它们中断整轮对话不值得。
pub fn translate(frame: &Frame) -> Result<Vec<Delta>, ProviderError> {
    let Some(event) = frame.event.as_deref() else {
        // 没有 event 字段的帧：只有 data 的话按负载里的 `type` 走。
        let Ok(v) = serde_json::from_str::<Value>(&frame.data) else {
            return Ok(Vec::new());
        };
        let kind = v.get("type").and_then(Value::as_str).unwrap_or_default();
        return translate_named(kind, frame);
    };
    translate_named(event, frame)
}

fn translate_named(event: &str, frame: &Frame) -> Result<Vec<Delta>, ProviderError> {
    match event {
        "message_start" => {
            let start: MessageStart = parse_data(frame)?;
            Ok(vec![Delta::InputUsage(Usage {
                uncached_input: start.message.usage.input_tokens,
                cache_read: start.message.usage.cache_read_input_tokens,
                cache_creation_5m: start.message.usage.cache_creation.ephemeral_5m_input_tokens,
                cache_creation_1h: start.message.usage.cache_creation.ephemeral_1h_input_tokens,
                output: 0,
            })])
        }

        "content_block_start" => {
            let start: BlockStart = parse_data(frame)?;
            let kind = start
                .content_block
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default();
            match kind {
                "tool_use" => {
                    let id = start
                        .content_block
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    let name = start
                        .content_block
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    Ok(vec![Delta::ToolUseStart {
                        index: start.index,
                        id,
                        name,
                    }])
                }
                // 正文和思考的内容都是从 delta 来的，这里不用管。
                "text" | "thinking" | "redacted_thinking" => Ok(Vec::new()),
                // 认不出来的块**原样留着带回去**（草稿块、服务端工具的结果……）。
                _ => Ok(vec![Delta::UnknownBlock {
                    index: start.index,
                    raw: start.content_block.to_string(),
                }]),
            }
        }

        "content_block_delta" => {
            let d: BlockDelta = parse_data(frame)?;
            let delta = match d.delta.kind.as_str() {
                "text_delta" => Delta::Text {
                    index: d.index,
                    text: d.delta.text,
                },
                "thinking_delta" => Delta::Thinking {
                    index: d.index,
                    text: d.delta.thinking,
                },
                "signature_delta" => Delta::ThinkingSignature {
                    index: d.index,
                    signature: d.delta.signature,
                },
                "input_json_delta" => Delta::ToolUseArgs {
                    index: d.index,
                    fragment: d.delta.partial_json,
                },
                // 认不出来的增量类型：忽略（服务端加新的是常态）。
                _ => return Ok(Vec::new()),
            };
            Ok(vec![delta])
        }

        "content_block_stop" => {
            #[derive(Deserialize)]
            struct Stop {
                index: u32,
            }
            let s: Stop = parse_data(frame)?;
            Ok(vec![Delta::BlockStop { index: s.index }])
        }

        // ⚠️ **`stop_reason` 在这里**，不在 `message_stop` 里。
        // 输出侧的 token 数也在这里。
        "message_delta" => {
            let d: MessageDelta = parse_data(frame)?;
            let mut out = Vec::new();
            if let Some(reason) = d.delta.stop_reason {
                out.push(Delta::Stop(crate::message::StopReason::from_anthropic(&reason)));
            }
            out.push(Delta::OutputUsage(d.usage.output_tokens));
            Ok(out)
        }

        // 流中途的错误：得当成失败，不能静默忽略（忽略的话这一轮会被当成
        // "说完了"，历史里留下半截内容）。
        "error" => Err(error_from_frame(frame).unwrap_or(ProviderError {
            message: "模型返回了一个看不懂的错误".to_string(),
            retryable: true,
        })),

        // `message_stop` / `ping`：什么都不用做。
        _ => Ok(Vec::new()),
    }
}

/// 从 `error` 事件里取出给用户看的话。
pub fn error_from_frame(frame: &Frame) -> Option<ProviderError> {
    #[derive(Deserialize)]
    struct ErrPayload {
        error: ErrDetail,
    }
    #[derive(Deserialize)]
    struct ErrDetail {
        #[serde(rename = "type", default)]
        kind: String,
        #[serde(default)]
        message: String,
    }
    let parsed: ErrPayload = serde_json::from_str(&frame.data).ok()?;
    Some(ProviderError {
        message: format!("模型返回了错误：{}", clip(&parsed.error.message)),
        // 流中途的错误：重发一次常常能过（对端抖了一下）。
        retryable: parsed.error.kind != "invalid_request_error",
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> AnthropicConfig {
        AnthropicConfig::default()
    }

    fn req(messages: Vec<Message>) -> ProviderRequest {
        ProviderRequest {
            system: "你是助手".into(),
            messages,
            tools: vec![],
            max_tokens: 4096,
        }
    }

    fn frame(event: &str, data: &str) -> Frame {
        Frame {
            event: Some(event.into()),
            data: data.into(),
        }
    }

    struct NoTransport;
    impl HttpTransport for NoTransport {
        async fn send(
            &self,
            _r: HttpRequest,
        ) -> Result<crate::transport::HttpResponse, crate::transport::HttpError> {
            unreachable!("测试只编请求，不发")
        }
    }

    fn provider() -> AnthropicProvider<NoTransport> {
        AnthropicProvider::new(NoTransport, "https://api.anthropic.com".into(), cfg(), "sk-test".into())
    }

    #[test]
    fn the_request_puts_system_outside_messages() {
        // Anthropic 要求 messages 首条是 user，system 是独立字段。
        let body: Value =
            serde_json::from_slice(&provider().build_request(&req(vec![Message::user_text("hi")])).unwrap().body)
                .unwrap();
        assert_eq!(body["system"], "你是助手");
        assert_eq!(body["messages"][0]["role"], "user");
        assert_eq!(body["messages"][0]["content"][0]["text"], "hi");
    }

    #[test]
    fn the_request_asks_for_summarized_thinking() {
        // ⚠️ 不显式要的话默认是 omitted —— 界面上会是一段莫名其妙的长空白。
        let body: Value =
            serde_json::from_slice(&provider().build_request(&req(vec![Message::user_text("hi")])).unwrap().body)
                .unwrap();
        assert_eq!(body["thinking"]["display"], "summarized");
    }

    #[test]
    fn tools_are_sent_with_eager_input_streaming() {
        let mut r = req(vec![Message::user_text("hi")]);
        r.tools = vec![crate::tool::ToolSpec {
            name: "read_file".into(),
            description: "读文件".into(),
            schema: json!({"type": "object", "properties": {}}),
            side_effect: crate::tool::SideEffect::Read,
        }];
        let body: Value =
            serde_json::from_slice(&provider().build_request(&r).unwrap().body).unwrap();
        // 开了它服务端才不缓冲大参数；代价是校验归我们自己做。
        assert_eq!(body["tools"][0]["eager_input_streaming"], true);
        assert_eq!(body["tools"][0]["name"], "read_file");
    }

    #[test]
    fn tool_use_input_keeps_its_key_order() {
        // 键序变了 = prompt 缓存前缀变了。这条盯着 `preserve_order` 别被谁关掉。
        let block = Block::ToolUse {
            id: "t1".into(),
            name: "x".into(),
            input: serde_json::value::RawValue::from_string(
                r#"{"z":1,"a":2,"m":3}"#.to_owned(),
            )
            .unwrap(),
        };
        let out = block_to_json(&block).unwrap();
        assert_eq!(out["input"].to_string(), r#"{"z":1,"a":2,"m":3}"#);
    }

    #[test]
    fn unknown_blocks_are_sent_back() {
        // 官方要求把完整的 content 带回去 —— 丢一个都是静默的行为改变。
        let block = Block::unknown_from_str(r#"{"type":"compaction","summary":"x"}"#).unwrap();
        let out = block_to_json(&block).unwrap();
        assert_eq!(out["type"], "compaction");
        assert_eq!(out["summary"], "x");
    }

    #[test]
    fn thinking_blocks_are_never_sent_back() {
        // 兜底：`sanitize` 已经剥过，但漏出去就会在改写过历史时 400。
        let block = Block::Thinking {
            text: "内心戏".into(),
            signature: Some("s".into()),
        };
        assert!(block_to_json(&block).is_none());
    }

    #[test]
    fn block_start_of_a_new_kind_is_kept_verbatim() {
        let out = translate(&frame(
            "content_block_start",
            r#"{"index":2,"content_block":{"type":"server_tool_use","id":"s1","whatever":1}}"#,
        ))
        .unwrap();
        match &out[0] {
            Delta::UnknownBlock { index, raw } => {
                assert_eq!(*index, 2);
                assert!(raw.contains("server_tool_use"));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn tool_use_start_carries_id_and_name() {
        let out = translate(&frame(
            "content_block_start",
            r#"{"index":1,"content_block":{"type":"tool_use","id":"t1","name":"read_file","input":{}}}"#,
        ))
        .unwrap();
        assert_eq!(
            out[0],
            Delta::ToolUseStart {
                index: 1,
                id: "t1".into(),
                name: "read_file".into()
            }
        );
    }

    #[test]
    fn the_thinking_delta_reads_the_thinking_field_not_text() {
        // 思考块的字段叫 `thinking`。读成 `text` 的话思考会**静默变成空串**。
        let out = translate(&frame(
            "content_block_delta",
            r#"{"index":0,"delta":{"type":"thinking_delta","thinking":"我在想"}}"#,
        ))
        .unwrap();
        assert_eq!(
            out[0],
            Delta::Thinking {
                index: 0,
                text: "我在想".into()
            }
        );
    }

    #[test]
    fn input_json_delta_comes_through_as_a_fragment() {
        let out = translate(&frame(
            "content_block_delta",
            r#"{"index":1,"delta":{"type":"input_json_delta","partial_json":"{\"pa"}}"#,
        ))
        .unwrap();
        assert_eq!(
            out[0],
            Delta::ToolUseArgs {
                index: 1,
                fragment: "{\"pa".into()
            }
        );
    }

    #[test]
    fn stop_reason_is_read_from_message_delta() {
        // ⚠️ 从 `message_stop` 读的话永远读到空值 → while 循环的终止条件失效
        // → 无限循环烧钱。这条盯着它。
        let out = translate(&frame(
            "message_delta",
            r#"{"delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":42}}"#,
        ))
        .unwrap();
        assert!(out.contains(&Delta::Stop(crate::message::StopReason::ToolUse)));
        assert!(out.contains(&Delta::OutputUsage(42)));
    }

    #[test]
    fn usage_splits_the_two_cache_ttls() {
        let out = translate(&frame(
            "message_start",
            r#"{"message":{"usage":{"input_tokens":10,"cache_read_input_tokens":900,
                "cache_creation":{"ephemeral_5m_input_tokens":100,"ephemeral_1h_input_tokens":7}}}}"#,
        ))
        .unwrap();
        match &out[0] {
            Delta::InputUsage(u) => {
                assert_eq!(u.uncached_input, 10);
                assert_eq!(u.cache_read, 900);
                // 两档分开：只留总数就算不出准确成本（1.25× vs 2×）
                assert_eq!(u.cache_creation_5m, 100);
                assert_eq!(u.cache_creation_1h, 7);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn unknown_events_are_ignored_not_fatal() {
        // 服务端加新事件类型是常态。为它们中断整轮对话不值得。
        for e in ["ping", "message_stop", "future_thing"] {
            assert!(translate(&frame(e, "{}")).unwrap().is_empty());
        }
        // 认不出来的 delta 类型也一样
        assert!(translate(&frame(
            "content_block_delta",
            r#"{"index":0,"delta":{"type":"brand_new_delta","stuff":1}}"#
        ))
        .unwrap()
        .is_empty());
    }

    #[test]
    fn an_error_frame_becomes_a_message_with_the_original_text() {
        let err = error_from_frame(&frame(
            "error",
            r#"{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#,
        ))
        .unwrap();
        assert!(err.message.contains("Overloaded"));
        assert!(err.retryable, "过载值得重发");
    }

    #[test]
    fn a_wrong_provider_message_tells_you_what_came_back() {
        // 把 OpenAI 兼容的地址填进 Anthropic 那一栏时就是这个样子。
        let err = translate(&frame("message_start", "definitely not json")).unwrap_err();
        assert!(!err.retryable);
    }
}
