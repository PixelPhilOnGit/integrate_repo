//! OpenAI 兼容的 Chat Completions（`POST /v1/chat/completions` + SSE）。
//!
//! 「兼容」这两个字要当回事：DeepSeek / Qwen / vLLM / ollama / 公司内网网关
//! 都往这个口子里接，而它们对 `tool_calls` 和 `stream_options` 的实现忠实度参差。
//! 所以这一层的原则是：**能认的认，认不出来的忽略，但绝不猜**。
//!
//! # 和 Anthropic 的三处硬差异（写错了不报错，只是行为错）
//!
//! 1. **工具结果的位置**：Anthropic 是一**条** user 消息里放多个 `tool_result` 块；
//!    OpenAI 是**每个调用一条 `tool` 角色的独立消息**。中立模型存的是前者，
//!    所以这里要**展开**成 N 条。
//! 2. **参数是字符串**：`function.arguments` 是逐片到达的 JSON **字符串**，
//!    拼完才解析（Anthropic 那边是对象片段）。拼和校验在 `turn.rs` 里统一做。
//! 3. **`prompt_tokens` 是总输入**（含缓存命中的那部分），而 Anthropic 的
//!    `input_tokens` **不含** —— 两边归一到同一个 `Usage` 时必须减一下，
//!    不然预算会算错。
//!
//! # 索引是保留的
//!
//! [`TurnAccum`] 按 `index` 分桶，而 OpenAI 的流里**没有内容块索引**这个概念
//! （`tool_calls[].index` 只是它在数组里的位置）。所以这里把索引**分段保留**：
//! 思考占 0、正文占 1、工具从 2 起。不同的东西落在同一个桶里会互相覆盖，
//! 而且不报错 —— 表现是「思考把正文吃掉了」这种莫名其妙的现象。

use serde::Deserialize;
use serde_json::{json, Value};

use crate::message::{Block, Message, Role, Usage};
use crate::provider::{clip, parse_data, run_stream};
use crate::session::{EventSink, Provider, ProviderError, ProviderRequest};
use crate::sse::Frame;
use crate::transport::{Transport, TransportRequest};
use crate::turn::{Delta, Turn};

/// 思考占这个桶。
const INDEX_THINKING: u32 = 0;
/// 正文占这个桶。
const INDEX_TEXT: u32 = 1;
/// 工具调用从这往后。
const INDEX_TOOL_BASE: u32 = 2;

/// 一次请求要什么。
#[derive(Debug, Clone)]
pub struct OpenAiConfig {
    /// 模型 id（`deepseek-chat` 之类）。
    pub model: String,
    /// 一轮的输出上限。
    pub max_tokens: u32,
}

impl Default for OpenAiConfig {
    fn default() -> Self {
        OpenAiConfig {
            model: "gpt-4o".into(),
            max_tokens: 16_000,
        }
    }
}

/// OpenAI 兼容的 provider。
pub struct OpenAiProvider<T: Transport> {
    transport: T,
    base_url: String,
    config: OpenAiConfig,
    api_key: String,
}

impl<T: Transport> OpenAiProvider<T> {
    /// 建一个。
    pub fn new(transport: T, base_url: String, config: OpenAiConfig, api_key: String) -> Self {
        OpenAiProvider {
            transport,
            base_url,
            config,
            api_key,
        }
    }

    /// 编请求。
    pub fn build_request(&self, request: &ProviderRequest) -> Result<TransportRequest, ProviderError> {
        let mut messages = Vec::new();
        // system 在 Anthropic 那边是独立字段，这边是 messages 的第一条。
        // 中立模型里它不在 messages 里，所以在这里补。
        if !request.system.trim().is_empty() {
            messages.push(json!({ "role": "system", "content": request.system }));
        }
        messages.extend(messages_to_json(&request.messages));

        let mut body = json!({
            "model": self.config.model,
            "max_tokens": self.config.max_tokens,
            "stream": true,
            "messages": Value::Array(messages),
            // ⚠️ 不显式要的话**流里根本没有用量** —— 记账、预算、缓存命中率
            // 全都会是空的，而且不报错。
            "stream_options": { "include_usage": true },
        });

        if !request.tools.is_empty() {
            body["tools"] = tools_to_json(&request.tools);
        }

        Ok(TransportRequest {
            url: join(&self.base_url, "/v1/chat/completions"),
            headers: vec![
                ("content-type".into(), "application/json".into()),
                ("authorization".into(), format!("Bearer {}", self.api_key)),
            ],
            body: serde_json::to_string(&body).map_err(|e| ProviderError {
                message: format!("请求编不出来：{e}"),
                retryable: false,
            })?,
        })
    }
}

impl<T: Transport> Provider for OpenAiProvider<T> {
    async fn stream(
        &self,
        request: ProviderRequest,
        events: EventSink,
    ) -> Result<Turn, ProviderError> {
        let transport_request = self.build_request(&request)?;
        run_stream(&self.transport, transport_request, &events, translate).await
    }
}

fn join(base: &str, path: &str) -> String {
    format!(
        "{}/{}",
        base.trim_end_matches('/'),
        path.trim_start_matches('/')
    )
}

/// 中立消息 → OpenAI 的 `messages`。
///
/// ⚠️ **一条中立消息可能变成多条**：中立模型把一轮的工具结果都放在一条 user
/// 消息里（那是 Anthropic 的形状），而这里每个结果要一条独立的 `tool` 消息。
fn messages_to_json(messages: &[Message]) -> Vec<Value> {
    let mut out = Vec::new();

    for m in messages {
        match m.role {
            Role::User => {
                // 这条 user 消息是"工具结果"还是"用户说的话"？看块。
                let results: Vec<&Block> = m
                    .content
                    .iter()
                    .filter(|b| matches!(b, Block::ToolResult { .. }))
                    .collect();

                if !results.is_empty() {
                    // 每个结果**一条独立消息**（这是 OpenAI 的形状）。
                    for b in results {
                        if let Block::ToolResult {
                            tool_use_id,
                            content,
                            is_error,
                        } = b
                        {
                            out.push(json!({
                                "role": "tool",
                                "tool_call_id": tool_use_id,
                                // ⚠️ OpenAI 没有 `is_error` 这个字段。失败必须**写在正文里**，
                                // 否则模型以为工具成功了，会基于假结果继续推理。
                                "content": if *is_error { format!("[工具执行失败] {content}") } else { content.clone() },
                            }));
                        }
                    }
                    // 同一条中立消息里如果还夹着正文，单独发一条 user 补上。
                    let extra = text_of(&m.content);
                    if !extra.is_empty() {
                        out.push(json!({ "role": "user", "content": extra }));
                    }
                    continue;
                }

                out.push(json!({ "role": "user", "content": text_of(&m.content) }));
            }

            Role::Assistant => {
                let calls: Vec<Value> = m
                    .content
                    .iter()
                    .filter_map(|b| match b {
                        Block::ToolUse { id, name, input } => {
                            serde_json::from_str::<Value>(input.get()).ok().map(|args| {
                                json!({
                                    "id": id,
                                    "type": "function",
                                    "function": {
                                        "name": name,
                                        // ⚠️ 这里必须是**字符串**，不是对象 ——
                                        // 发成对象的话对端会拒掉（或者更糟：静默当成没有工具调用）。
                                        "arguments": serde_json::to_string(&args).unwrap_or_else(|_| "{}".into()),
                                    }
                                })
                            })
                        }
                        _ => None,
                    })
                    .collect();

                let text = text_of(&m.content);
                if calls.is_empty() {
                    out.push(json!({ "role": "assistant", "content": text }));
                } else {
                    // 有工具调用时 content 可以是 null（只调工具不说话）。
                    out.push(json!({
                        "role": "assistant",
                        "content": if text.is_empty() { Value::Null } else { Value::String(text) },
                        "tool_calls": calls,
                    }));
                }
            }
        }
    }

    out
}

/// 把一轮里的正文块拼起来（思考、工具调用都不算）。
fn text_of(blocks: &[Block]) -> String {
    blocks
        .iter()
        .filter_map(|b| match b {
            Block::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("")
}

/// 工具定义 → OpenAI 的 `tools`。
fn tools_to_json(tools: &[crate::tool::ToolSpec]) -> Value {
    Value::Array(
        tools
            .iter()
            .map(|t| {
                json!({
                    "type": "function",
                    "function": {
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.schema,
                    }
                })
            })
            .collect(),
    )
}

// ------------------------------------------------------------------ 事件翻译

#[derive(Debug, Deserialize)]
struct Chunk {
    #[serde(default)]
    choices: Vec<Choice>,
    #[serde(default)]
    usage: Option<ChunkUsage>,
}

#[derive(Debug, Deserialize)]
struct Choice {
    #[serde(default)]
    delta: ChunkDelta,
    #[serde(default)]
    finish_reason: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct ChunkDelta {
    #[serde(default)]
    content: Option<String>,
    /// 有的兼容端（DeepSeek 系）把思考放这儿。
    #[serde(default)]
    reasoning_content: Option<String>,
    /// 另一些（vLLM 等）放这儿。
    #[serde(default)]
    reasoning: Option<String>,
    #[serde(default)]
    tool_calls: Vec<ToolCallDelta>,
}

#[derive(Debug, Deserialize)]
struct ToolCallDelta {
    /// 它在 `tool_calls` 数组里的位置 —— **不是**内容块索引。
    #[serde(default)]
    index: u32,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    function: Option<FunctionDelta>,
}

#[derive(Debug, Deserialize)]
struct FunctionDelta {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    arguments: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ChunkUsage {
    #[serde(default)]
    prompt_tokens: u64,
    #[serde(default)]
    completion_tokens: u64,
    #[serde(default)]
    prompt_tokens_details: Option<PromptDetails>,
}

#[derive(Debug, Deserialize)]
struct PromptDetails {
    #[serde(default)]
    cached_tokens: u64,
}

/// 一个 Sse 帧 → 零个或多个增量。
pub fn translate(frame: &Frame) -> Result<Vec<Delta>, ProviderError> {
    // OpenAI 的流用一个哨兵收尾：`data: [DONE]`。它不是 JSON，别去解析它。
    if frame.data.trim() == "[DONE]" {
        return Ok(Vec::new());
    }

    let chunk: Chunk = parse_data(frame)?;
    let mut out = Vec::new();

    for choice in &chunk.choices {
        if let Some(t) = choice
            .delta
            .reasoning_content
            .as_deref()
            .or(choice.delta.reasoning.as_deref())
        {
            if !t.is_empty() {
                out.push(Delta::Thinking {
                    index: INDEX_THINKING,
                    text: t.to_string(),
                });
            }
        }

        if let Some(t) = &choice.delta.content {
            if !t.is_empty() {
                out.push(Delta::Text {
                    index: INDEX_TEXT,
                    text: t.clone(),
                });
            }
        }

        for tc in &choice.delta.tool_calls {
            let index = INDEX_TOOL_BASE + tc.index;
            // ⚠️ id 和函数名**只在第一片里有**，后面只有参数片段。
            // 靠 `index` 把它们归到同一个桶（`TurnAccum` 负责）。
            if let (Some(id), Some(f)) = (&tc.id, &tc.function) {
                if let Some(name) = &f.name {
                    out.push(Delta::ToolUseStart {
                        index,
                        id: id.clone(),
                        name: name.clone(),
                    });
                }
            }
            if let Some(args) = tc.function.as_ref().and_then(|f| f.arguments.as_ref()) {
                if !args.is_empty() {
                    out.push(Delta::ToolUseArgs {
                        index,
                        fragment: args.clone(),
                    });
                }
            }
        }

        if let Some(reason) = &choice.finish_reason {
            out.push(Delta::Stop(crate::message::StopReason::from_openai(reason)));
        }
    }

    if let Some(u) = &chunk.usage {
        // ⚠️ OpenAI 的 `prompt_tokens` 是**总输入**（含缓存），而 Anthropic 的
        // `input_tokens` 不含 —— 归一到同一个 `Usage` 时要减掉，不然
        // 「总输入」这件事两边算出来不一样，预算和缓存命中率都会歪。
        let cached = u
            .prompt_tokens_details
            .as_ref()
            .map(|d| d.cached_tokens)
            .unwrap_or(0);
        out.push(Delta::InputUsage(Usage {
            uncached_input: u.prompt_tokens.saturating_sub(cached),
            cache_read: cached,
            // OpenAI 是自动前缀缓存，**没有"写入"这个概念**，也没有费用。
            cache_creation_5m: 0,
            cache_creation_1h: 0,
            output: 0,
        }));
        out.push(Delta::OutputUsage(u.completion_tokens));
    }

    Ok(out)
}

/// 从错误正文里取出给用户看的话（OpenAI 的形状是 `{"error":{"message":...}}`）。
pub fn error_from_body(body: &str) -> String {
    #[derive(Deserialize)]
    struct Payload {
        error: Detail,
    }
    #[derive(Deserialize)]
    struct Detail {
        #[serde(default)]
        message: String,
    }
    match serde_json::from_str::<Payload>(body) {
        Ok(p) if !p.error.message.is_empty() => clip(&p.error.message),
        // 认不出来就原样给它 —— 有的网关回的是纯文本。
        _ => clip(body.trim()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct NoTransport;
    impl Transport for NoTransport {
        async fn post(
            &self,
            _r: TransportRequest,
        ) -> Result<crate::transport::HttpResponse, crate::transport::TransportError> {
            unreachable!("测试只编请求，不发")
        }
    }

    fn provider() -> OpenAiProvider<NoTransport> {
        OpenAiProvider::new(
            NoTransport,
            "https://api.deepseek.com".into(),
            OpenAiConfig {
                model: "deepseek-chat".into(),
                max_tokens: 4096,
            },
            "sk-test".into(),
        )
    }

    fn req(messages: Vec<Message>) -> ProviderRequest {
        ProviderRequest {
            system: "你是助手".into(),
            messages,
            tools: vec![],
            max_tokens: 4096,
        }
    }

    fn body_of(r: &ProviderRequest) -> Value {
        serde_json::from_str(&provider().build_request(r).unwrap().body).unwrap()
    }

    fn frame(data: &str) -> Frame {
        Frame {
            event: None,
            data: data.into(),
        }
    }

    fn tool_use(id: &str, name: &str, args: &str) -> Block {
        Block::ToolUse {
            id: id.into(),
            name: name.into(),
            input: serde_json::value::RawValue::from_string(args.to_owned()).unwrap(),
        }
    }

    #[test]
    fn system_becomes_the_first_message() {
        // Anthropic 那边 system 是独立字段；这边是 messages 的第一条。
        let b = body_of(&req(vec![Message::user_text("hi")]));
        assert_eq!(b["messages"][0]["role"], "system");
        assert_eq!(b["messages"][1]["role"], "user");
    }

    #[test]
    fn usage_is_requested_explicitly() {
        // ⚠️ 不显式要的话流里根本没有用量 —— 记账和预算全空，而且不报错。
        assert_eq!(body_of(&req(vec![Message::user_text("hi")]))["stream_options"]["include_usage"], true);
    }

    #[test]
    fn one_neutral_message_with_two_results_becomes_two_tool_messages() {
        // ⚠️ 这是两家最硬的差异：Anthropic 一条消息装全部结果，
        // OpenAI 每个结果一条独立消息。不展开的话第二个结果的
        // `tool_call_id` 对不上 → 对端拒掉，或者更糟：静默丢掉。
        let r = req(vec![
            Message {
                role: Role::Assistant,
                content: vec![tool_use("t1", "read_file", "{}"), tool_use("t2", "read_file", "{}")],
            },
            Message {
                role: Role::User,
                content: vec![
                    Block::ToolResult {
                        tool_use_id: "t1".into(),
                        content: "a".into(),
                        is_error: false,
                    },
                    Block::ToolResult {
                        tool_use_id: "t2".into(),
                        content: "b".into(),
                        is_error: false,
                    },
                ],
            },
        ]);
        let b = body_of(&r);
        let msgs = b["messages"].as_array().unwrap();
        // system + assistant + tool + tool
        assert_eq!(msgs.len(), 4);
        assert_eq!(msgs[2]["role"], "tool");
        assert_eq!(msgs[3]["role"], "tool");
        assert_eq!(msgs[2]["tool_call_id"], "t1");
        assert_eq!(msgs[3]["tool_call_id"], "t2");
    }

    #[test]
    fn tool_arguments_are_sent_as_a_string_not_an_object() {
        // ⚠️ 发成对象的话对端会拒掉，或者更糟：静默当成没有工具调用。
        let r = req(vec![Message {
            role: Role::Assistant,
            content: vec![tool_use("t1", "read_file", r#"{"path":"a.txt"}"#)],
        }]);
        let b = body_of(&r);
        let args = &b["messages"][1]["tool_calls"][0]["function"]["arguments"];
        assert!(args.is_string(), "arguments 必须是字符串：{args}");
        assert_eq!(args.as_str().unwrap(), r#"{"path":"a.txt"}"#);
    }

    #[test]
    fn an_assistant_message_with_only_tool_calls_has_null_content() {
        let r = req(vec![Message {
            role: Role::Assistant,
            content: vec![tool_use("t1", "read_file", "{}")],
        }]);
        let b = body_of(&r);
        assert!(b["messages"][1]["content"].is_null());
    }

    #[test]
    fn a_failed_tool_result_says_so_in_the_text() {
        // ⚠️ OpenAI 没有 is_error 字段。不写进正文的话，模型以为工具成功了，
        // 会基于假结果继续推理。
        let r = req(vec![Message {
            role: Role::User,
            content: vec![Block::ToolResult {
                tool_use_id: "t1".into(),
                content: "文件不存在".into(),
                is_error: true,
            }],
        }]);
        let b = body_of(&r);
        let content = b["messages"][1]["content"].as_str().unwrap();
        assert!(content.contains("失败"), "{content}");
        assert!(content.contains("文件不存在"));
    }

    #[test]
    fn a_bearer_token_header_is_used() {
        let tr = provider().build_request(&req(vec![Message::user_text("hi")])).unwrap();
        assert_eq!(tr.headers[1].0, "authorization");
        assert_eq!(tr.headers[1].1, "Bearer sk-test");
        assert!(tr.url.ends_with("/v1/chat/completions"));
    }

    #[test]
    fn text_and_reasoning_land_in_different_buckets() {
        // ⚠️ 放同一个桶里会互相覆盖 —— 症状是「思考把正文吃掉了」，不报错。
        let think = translate(&frame(
            r#"{"choices":[{"delta":{"reasoning_content":"我在想"}}]}"#,
        ))
        .unwrap();
        let text = translate(&frame(r#"{"choices":[{"delta":{"content":"你好"}}]}"#)).unwrap();

        let ti = match &think[0] {
            Delta::Thinking { index, .. } => *index,
            other => panic!("{other:?}"),
        };
        let xi = match &text[0] {
            Delta::Text { index, .. } => *index,
            other => panic!("{other:?}"),
        };
        assert_ne!(ti, xi, "思考和正文必须落在不同的桶里");
    }

    #[test]
    fn tool_call_fragments_accumulate_by_index() {
        // 第一片带 id 和名字，后面只有参数片段。
        let first = translate(&frame(
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":""}}]}}]}"#,
        ))
        .unwrap();
        assert_eq!(
            first[0],
            Delta::ToolUseStart {
                index: INDEX_TOOL_BASE,
                id: "call_1".into(),
                name: "read_file".into()
            }
        );

        let later = translate(&frame(
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"pa"}}]}}]}"#,
        ))
        .unwrap();
        assert_eq!(
            later[0],
            Delta::ToolUseArgs {
                index: INDEX_TOOL_BASE,
                fragment: "{\"pa".into()
            }
        );
    }

    #[test]
    fn finish_reason_becomes_our_stop_reason() {
        for (wire, want) in [
            ("tool_calls", crate::message::StopReason::ToolUse),
            ("stop", crate::message::StopReason::EndTurn),
            ("length", crate::message::StopReason::MaxTokens),
            ("content_filter", crate::message::StopReason::Refusal),
        ] {
            let out = translate(&frame(&format!(
                r#"{{"choices":[{{"delta":{{}},"finish_reason":"{wire}"}}]}}"#
            )))
            .unwrap();
            assert!(out.contains(&Delta::Stop(want)), "{wire} 没映射对：{out:?}");
        }
    }

    #[test]
    fn prompt_tokens_are_normalized_against_the_cached_part() {
        // ⚠️ OpenAI 的 prompt_tokens **含**缓存命中；Anthropic 的 input_tokens
        // **不含**。不减这一下，"总输入"两边算出来差一大截。
        let out = translate(&frame(
            r#"{"choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":7,
                "prompt_tokens_details":{"cached_tokens":900}}}"#,
        ))
        .unwrap();
        let usage = out
            .iter()
            .find_map(|d| match d {
                Delta::InputUsage(u) => Some(*u),
                _ => None,
            })
            .unwrap();
        assert_eq!(usage.cache_read, 900);
        assert_eq!(usage.uncached_input, 100);
        assert_eq!(usage.total_input(), 1000, "总数应当还是 prompt_tokens");
        // 没有"写入缓存"这个概念
        assert_eq!(usage.cache_creation(), 0);
    }

    #[test]
    fn the_done_sentinel_is_not_parsed_as_json() {
        let out = translate(&frame("[DONE]")).unwrap();
        assert!(out.is_empty());
    }

    #[test]
    fn a_chunk_without_usage_does_not_produce_a_usage_delta() {
        let out = translate(&frame(r#"{"choices":[{"delta":{"content":"x"}}]}"#)).unwrap();
        assert!(out.iter().all(|d| !matches!(d, Delta::InputUsage(_))));
    }
}
