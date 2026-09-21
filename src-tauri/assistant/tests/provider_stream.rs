//! 用**真 socket** 跑一遍完整链路：请求写出去、SSE 一块块读回来、翻成一轮。
//!
//! # 为什么不用 mock
//!
//! 单元测试喂的是"已经切好的帧"，那证明不了：
//! HTTP 请求写对没有、chunked 编码认不认、`Transfer-Encoding` 底下
//! 一块块到达的字节会不会被攒成一坨（攒了就没有流式了）、连接提前断掉会怎样。
//!
//! 这些只有真 socket 抓得出来。所以这里手写一个最小的 HTTP/1.1 服务器 ——
//! **不用 hyper 的 server 端**（那会引入 `httpdate`，锁文件里没有这个包）。
//!
//! ⚠️ 这一组跑不到 TLS（本地没有证书）。TLS 那一截的验证在真机上做，
//! 见计划里的「e2e 覆盖不到的那一截」。

use std::time::Duration;

use devtoolkit_assistant::provider::anthropic::{AnthropicConfig, AnthropicProvider};
use devtoolkit_assistant::provider::openai::{OpenAiConfig, OpenAiProvider};
use devtoolkit_assistant::session::{EventSink, Provider, ProviderRequest, RunEvent};
use devtoolkit_assistant::transport::HyperTransport;
use devtoolkit_assistant::message::{Message, StopReason};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// 起一个假服务器，把 `pieces` 按 chunked 一块块吐给**第一个**连上来的人。
///
/// 返回 `(地址, 收到请求的原文)`。
async fn fake_server(pieces: Vec<&'static str>) -> (String, tokio::task::JoinHandle<String>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    let handle = tokio::spawn(async move {
        let (mut sock, _) = listener.accept().await.unwrap();

        // 读请求头（读到空行为止）
        let mut raw = Vec::new();
        loop {
            let mut buf = [0u8; 1024];
            let n = sock.read(&mut buf).await.unwrap();
            if n == 0 {
                break;
            }
            raw.extend_from_slice(&buf[..n]);
            if raw.windows(4).any(|w| w == b"\r\n\r\n") {
                break;
            }
        }

        sock.write_all(
            b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n",
        )
        .await
        .unwrap();

        for piece in pieces {
            // 每块之间停一下 —— 这样才能证明**流式**是真的（攒成一坨就看不见了）
            tokio::time::sleep(Duration::from_millis(5)).await;
            sock.write_all(format!("{:x}\r\n", piece.len()).as_bytes())
                .await
                .unwrap();
            sock.write_all(piece.as_bytes()).await.unwrap();
            sock.write_all(b"\r\n").await.unwrap();
            sock.flush().await.unwrap();
        }

        sock.write_all(b"0\r\n\r\n").await.unwrap();
        let _ = sock.shutdown().await;

        String::from_utf8_lossy(&raw).into_owned()
    });

    (format!("http://{addr}"), handle)
}

fn request() -> ProviderRequest {
    ProviderRequest {
        system: "你是助手".into(),
        messages: vec![Message::user_text("看看 a.txt")],
        tools: vec![],
        max_tokens: 4096,
    }
}

const ANTHROPIC_SSE: &[&str] = &[
    "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":10,\"cache_read_input_tokens\":900}}}\n\n",
    "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
    "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"读到了\"}}\n\n",
    "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"，写的是 hello\"}}\n\n",
    "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
    "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"tool_use\",\"id\":\"t1\",\"name\":\"read_file\",\"input\":{}}}\n\n",
    // ⚠️ 参数是**片段**，而且故意切在 JSON 中间 —— 真链路上就是这样
    "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"path\\\":\"}}\n\n",
    "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"\\\"a.txt\\\"}\"}}\n\n",
    "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":1}\n\n",
    "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"},\"usage\":{\"output_tokens\":42}}\n\n",
    "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
];

#[tokio::test]
async fn anthropic_over_a_real_socket() {
    let (base, server) = fake_server(ANTHROPIC_SSE.to_vec()).await;

    let provider = AnthropicProvider::new(
        HyperTransport::new(),
        base,
        AnthropicConfig::default(),
        "sk-test".into(),
    );
    let (sink, mut events) = EventSink::new(64);

    let turn = provider.stream(request(), sink).await.expect("这一轮应当成功");

    // 正文拼起来了
    assert_eq!(turn.blocks[0], devtoolkit_assistant::message::Block::Text { text: "读到了，写的是 hello".into() });
    // 工具参数**跨片段拼起来了**，而且是个能解析的对象
    assert_eq!(turn.tool_calls.len(), 1);
    assert_eq!(turn.tool_calls[0].name, "read_file");
    assert_eq!(turn.tool_calls[0].args_text(), r#"{"path":"a.txt"}"#);
    // 停止原因是从 message_delta 里读出来的
    assert_eq!(turn.stop_reason, StopReason::ToolUse);
    // 用量：两处合并（输入在 message_start、输出在 message_delta）
    assert_eq!(turn.usage.total_input(), 910);
    assert_eq!(turn.usage.output, 42);

    // 边收边报：正文是**分片**到达界面的（合并成一坨就说明没有流式）
    let mut text_deltas = Vec::new();
    while let Ok(e) = events.try_recv() {
        if let RunEvent::TextDelta { text } = e {
            text_deltas.push(text);
        }
    }
    assert_eq!(text_deltas.len(), 2, "两片正文应当分别上报：{text_deltas:?}");

    // 请求本身也要对
    let raw = server.await.unwrap();
    assert!(raw.starts_with("POST /v1/messages "), "{raw}");
    assert!(raw.to_lowercase().contains("x-api-key: sk-test"));
    assert!(raw.contains("anthropic-version"));
    assert!(raw.contains("\"stream\":true"));
    assert!(raw.contains("你是助手"));
}

const OPENAI_SSE: &[&str] = &[
    "data: {\"choices\":[{\"delta\":{\"content\":\"好\"}}]}\n\n",
    "data: {\"choices\":[{\"delta\":{\"content\":\"的\"}}]}\n\n",
    "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"c1\",\"function\":{\"name\":\"read_file\",\"arguments\":\"\"}}]}}]}\n\n",
    "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{\\\"path\\\"\"}}]}}]}\n\n",
    "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\":\\\"a.txt\\\"}\"}}]}}]}\n\n",
    "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n",
    "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":1000,\"completion_tokens\":7,\"prompt_tokens_details\":{\"cached_tokens\":900}}}\n\n",
    "data: [DONE]\n\n",
];

#[tokio::test]
async fn openai_compatible_over_a_real_socket() {
    let (base, server) = fake_server(OPENAI_SSE.to_vec()).await;

    let provider = OpenAiProvider::new(
        HyperTransport::new(),
        base,
        OpenAiConfig {
            model: "deepseek-chat".into(),
            max_tokens: 4096,
        },
        "sk-test".into(),
    );
    let (sink, _events) = EventSink::new(64);

    let turn = provider.stream(request(), sink).await.expect("这一轮应当成功");

    assert_eq!(
        turn.tool_calls[0].args_text(),
        r#"{"path":"a.txt"}"#,
        "参数是逐片到达的字符串，必须拼完整"
    );
    assert_eq!(turn.stop_reason, StopReason::ToolUse);

    // ⚠️ prompt_tokens 含缓存命中，而 Anthropic 的 input_tokens 不含 ——
    // 归一之后"总输入"两边应当是同一个口径。
    assert_eq!(turn.usage.total_input(), 1000);
    assert_eq!(turn.usage.uncached_input, 100);
    assert_eq!(turn.usage.cache_read, 900);

    let raw = server.await.unwrap();
    assert!(raw.starts_with("POST /v1/chat/completions "), "{raw}");
    assert!(raw.to_lowercase().contains("authorization: bearer sk-test"));
    assert!(raw.contains("include_usage"), "不显式要的话流里根本没有用量");
}

#[tokio::test]
async fn a_stream_that_dies_midway_is_an_error_not_a_turn() {
    // ⚠️ 半截的响应**不能**当成一轮 —— 那会把一个没有配对 `tool_result` 的
    // `tool_use` 追加进历史，下一轮请求直接 400。
    let pieces = vec![
        "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{}}}\n\n",
        "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"t1\",\"name\":\"read_file\",\"input\":{}}}\n\n",
        // 说到一半就没了：没有 message_delta，也没有 message_stop
        "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"pa\"}}\n\n",
    ];
    let (base, _server) = fake_server(pieces).await;

    let provider = AnthropicProvider::new(
        HyperTransport::new(),
        base,
        AnthropicConfig::default(),
        "sk-test".into(),
    );
    let (sink, _events) = EventSink::new(64);

    let err = provider
        .stream(request(), sink)
        .await
        .expect_err("半截的流必须报错");
    assert!(err.retryable, "断在半截上值得重发：{}", err.message);
}

#[tokio::test]
async fn an_http_error_carries_the_body_text() {
    // 「key 不对」「模型名写错了」这些话**只在响应体里**。只报状态码
    // 等于让用户去猜。
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let (mut sock, _) = listener.accept().await.unwrap();
        let mut buf = [0u8; 4096];
        let _ = sock.read(&mut buf).await;
        let body = r#"{"error":{"type":"authentication_error","message":"invalid x-api-key"}}"#;
        let head = format!(
            "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
            body.len()
        );
        sock.write_all(head.as_bytes()).await.unwrap();
        sock.write_all(body.as_bytes()).await.unwrap();
        let _ = sock.shutdown().await;
    });

    let provider = AnthropicProvider::new(
        HyperTransport::new(),
        format!("http://{addr}"),
        AnthropicConfig::default(),
        "wrong-key".into(),
    );
    let (sink, _events) = EventSink::new(64);

    let err = provider.stream(request(), sink).await.unwrap_err();
    assert!(err.message.contains("invalid x-api-key"), "{}", err.message);
    assert!(!err.retryable, "401 重发一百次也一样");
}
