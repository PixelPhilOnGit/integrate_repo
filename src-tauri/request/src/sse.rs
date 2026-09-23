//! Server-Sent Events 的帧解析。
//!
//! 两家的流式接口都是 SSE（Anthropic 和 OpenAI 兼容端一样），形状也基本一致：
//! 若干 `字段: 值` 行，一个**空行**表示这一帧结束。
//!
//! # 为什么是一个「喂字节」的状态机
//!
//! 网络上来的东西**切在哪里完全随机** —— 一块字节可能停在半行中间、
//! 停在 `\r\n` 的中间、甚至停在**一个多字节 UTF-8 字符的中间**。
//! 所以这个类型只有一件事要做对：**把字节攒够、在正确的位置切帧**。
//!
//! ⚠️ **缓冲区必须存字节（`Vec<u8>`），不能存字符串。**
//! 如果每来一块就 `from_utf8_lossy` 一下，被切断的多字节字符会变成 U+FFFD ——
//! 而且是**静默**的：模型的名字、路径、中文内容里会冒出几个问号，
//! 谁也不会想到那是 TCP 分包干的。仓库在终端字节上踩过同一个坑
//! （见 `agents/Cargo.toml` 里 base64 那条注释）。
//!
//! 存字节之后，切帧只发生在换行符处（ASCII），所以「一行的字节一定是完整
//! 的一段 UTF-8」这件事自然成立 —— 半截字符会一直留在缓冲区里等到下一块。

/// 一帧。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    /// `event:` 字段。没有就是 `None`（OpenAI 兼容端不发这个字段）。
    pub event: Option<String>,
    /// `data:` 字段。多行会按规范用 `\n` 连起来。
    pub data: String,
}

/// 增量解析器。
///
/// 用法：每次从网络拿到一块字节就 [`push`](SseBuffer::push) 一次，
/// 拿回这次能凑出来的所有完整帧（可能是 0 个、也可能一次好几个）。
#[derive(Debug, Default)]
pub struct SseBuffer {
    /// 还没凑成完整帧的字节。
    ///
    /// 用 `Vec<u8>` 而不是 `String`，理由见文件头 —— 那是这个类型存在的全部意义。
    buf: Vec<u8>,

    /// 正在累积的那一帧的 `event` 字段。
    ///
    /// ⚠️ **这些累积器必须是结构体的字段，不能是 `push` 里的局部变量。**
    /// 一帧的字段行和它结尾的那个空行**完全可能落在不同的块里** ——
    /// 局部变量会在两次 `push` 之间悄悄丢掉，表现是「某些分包下整帧凭空消失」，
    /// 而且只在特定的包边界出现（真机上是「偶发丢字的流」那种抓不住的毛病）。
    event: Option<String>,

    /// 正在累积的那一帧的所有 `data` 行。
    data: Vec<String>,
}

impl SseBuffer {
    /// 新建一个空的解析器。
    pub fn new() -> Self {
        Self::default()
    }

    /// 喂一块字节，拿回所有**已经完整**的帧。
    pub fn push(&mut self, chunk: &[u8]) -> Vec<Frame> {
        self.buf.extend_from_slice(chunk);
        let mut frames = Vec::new();
        let mut cursor = 0usize;

        while let Some((line_end, next)) = find_line_end(&self.buf, cursor) {
            let line_bytes = &self.buf[cursor..line_end];
            cursor = next;

            // 到这一步，这一行的字节一定是一段完整的 UTF-8（切点只可能在
            // 换行符处，而换行符是 ASCII）——所以这里的 lossy 实际上永远不会
            // 真的替换掉什么，留着只是为了**远端发来非法字节时不要 panic**。
            let line = String::from_utf8_lossy(line_bytes);

            if line.is_empty() {
                // 空行 = 这一帧结束。
                //
                // ⚠️ 规范里「data 为空就不分发」——别在这里无条件 push 一个空帧，
                // 否则流的开头（或心跳）会多出几个空事件，上层得处处防空洞。
                if !self.data.is_empty() {
                    frames.push(Frame {
                        event: self.event.take(),
                        data: std::mem::take(&mut self.data).join("\n"),
                    });
                }
                // 无论分不分发，字段都要清干净：空行是**帧边界**，不是分隔符。
                self.event = None;
                self.data.clear();
                continue;
            }

            // `:` 开头是注释（有的服务端用它做心跳保活）。按规范忽略。
            if line.starts_with(':') {
                continue;
            }

            let (field, value) = match line.find(':') {
                Some(i) => (&line[..i], &line[i + 1..]),
                // 没有冒号的行：字段名是整行，值是空串。
                None => (line.as_ref(), ""),
            };

            // ⚠️ 规范是「去掉**一个**前导空格」，不是 `trim_start()`。
            // 用 trim_start 会把内容里本来就有的空格也吃掉 ——
            // 而增量文本里「下一个词以空格开头」是很常见的事。
            let value = value.strip_prefix(' ').unwrap_or(value);

            match field {
                "event" => self.event = Some(value.to_owned()),
                "data" => self.data.push(value.to_owned()),
                // `id` / `retry` 用不上；认不出来的字段按规范**忽略**，不报错。
                _ => {}
            }
        }

        // 把已经消化掉的字节丢掉，剩下的（半行）留着等下一块。
        self.buf.drain(..cursor);
        frames
    }

    /// 流结束了，把最后一点字节收尾。
    ///
    /// ⚠️ **为什么 `push` 一个人做不到这件事**：缓冲区末尾那个孤立的 `\r`
    /// 是**天生有歧义**的 —— 它可能是这一行的结尾，也可能是下一块字节要补上来的
    /// `\n` 的前一半。`push` 只能等着；只有调用方知道「不会再有字节了」。
    ///
    /// 收尾的办法是补一个 `\n`：于是那个 `\r` 走的是 `\r\n` 这条正常路径，
    /// 不需要在解析器里再写一套"到此为止"的终止逻辑（那种第二套逻辑
    /// 一定会和正常路径慢慢长歪）。
    ///
    /// 返回值是这次收尾新凑出来的帧（通常是 0 个，除非流正好以孤单的 `\r` 结束）。
    /// **收尾之后还要看 [`has_partial`](SseBuffer::has_partial)** ——
    /// 它为真说明这一轮是**断在半截上的**，该重试而不是当成完整响应。
    pub fn finish(&mut self) -> Vec<Frame> {
        if self.buf.last() == Some(&b'\r') {
            self.buf.push(b'\n');
        }
        self.push(&[])
    }

    /// 是不是停在一帧的中间（还有没消化完的东西）。
    ///
    /// 流正常结束时它应当是假的；为真说明**最后一帧是残缺的**——
    /// 调用方拿这个判断「连接是在一帧中间断的」，从而走「丢弃半截、重试」那条路，
    /// 而不是把半个响应当成完整的一轮（那会造出没有配对 `tool_result` 的
    /// `tool_use`，下一轮请求直接 400）。
    ///
    /// ⚠️ 三个条件缺一不可：**光看 `buf` 是不够的** ——
    /// 字段行已经收齐、只差结尾那个空行的情况，缓冲区里一个字节都不剩。
    pub fn has_partial(&self) -> bool {
        !self.buf.is_empty() || !self.data.is_empty() || self.event.is_some()
    }
}

/// 从 `from` 开始找下一行，返回 `(行内容的结束下标, 下一行的开始下标)`。
///
/// ⚠️ **缓冲区末尾那个孤零零的 `\r` 不能当场认成行尾** ——
/// 它可能是下一块字节要补上来的 `\n` 的前一半。认早了会让一整帧的数据
/// 多切一刀（表现是 JSON 解析偶发失败，而且只在某些分包下出现）。
fn find_line_end(buf: &[u8], from: usize) -> Option<(usize, usize)> {
    let mut i = from;
    while i < buf.len() {
        match buf[i] {
            b'\n' => return Some((i, i + 1)),
            b'\r' => {
                if i + 1 == buf.len() {
                    // 还差一个字节才能判断。等下一块。
                    return None;
                }
                return Some((i, if buf[i + 1] == b'\n' { i + 2 } else { i + 1 }));
            }
            _ => i += 1,
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frames(buf: &mut SseBuffer, s: &str) -> Vec<Frame> {
        buf.push(s.as_bytes())
    }

    #[test]
    fn parses_a_simple_frame() {
        let mut b = SseBuffer::new();
        let out = frames(&mut b, "event: message_start\ndata: {\"a\":1}\n\n");
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].event.as_deref(), Some("message_start"));
        assert_eq!(out[0].data, "{\"a\":1}");
        assert!(!b.has_partial());
    }

    #[test]
    fn parses_openai_style_frames_without_event_field() {
        let mut b = SseBuffer::new();
        let out = frames(&mut b, "data: {\"choices\":[]}\n\ndata: [DONE]\n\n");
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].event, None);
        assert_eq!(out[1].data, "[DONE]");
    }

    #[test]
    fn reassembles_across_arbitrary_splits() {
        // 这是这个类型的核心契约：**怎么切都得解析出同一批帧**。
        let wire = "event: content_block_delta\ndata: {\"text\":\"你好\"}\n\n\
                    event: message_delta\ndata: {\"stop_reason\":\"end_turn\"}\n\n";
        let bytes = wire.as_bytes();
        for split in 0..bytes.len() {
            let mut b = SseBuffer::new();
            let mut got = b.push(&bytes[..split]);
            got.extend(b.push(&bytes[split..]));
            assert_eq!(got.len(), 2, "在第 {split} 字节切开时帧数不对");
            assert_eq!(got[0].data, "{\"text\":\"你好\"}");
            assert_eq!(got[1].data, "{\"stop_reason\":\"end_turn\"}");
        }
    }

    #[test]
    fn survives_a_multibyte_char_split_across_chunks() {
        // 「你」是 3 字节。把 UTF-8 拆开是**最会静默出错**的一种切法：
        // 如果缓冲区存的是字符串，这里会变成 U+FFFD，而且不报错。
        let wire = "data: 你好\n\n".as_bytes();
        let mut b = SseBuffer::new();
        let mut got = Vec::new();
        for byte in wire {
            got.extend(b.push(&[*byte]));
        }
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].data, "你好");
        assert!(!got[0].data.contains('\u{FFFD}'), "多字节字符被切坏了");
    }

    #[test]
    fn crlf_split_across_chunks_is_not_a_premature_terminator() {
        // `\r` 落在块尾、`\n` 在下一块 —— 认早了会多切出一行。
        let mut b = SseBuffer::new();
        let first = b.push(b"data: hello\r");
        assert!(first.is_empty(), "还不该出帧");
        assert!(b.has_partial());
        let rest = b.push(b"\n\r\n");
        assert_eq!(rest.len(), 1);
        assert_eq!(rest[0].data, "hello");
    }

    #[test]
    fn lone_cr_is_a_valid_terminator() {
        // SSE 规范里单独的 `\r` 也是行尾。
        //
        // 但末尾那个 `\r` 是**有歧义**的（可能是 `\r\n` 的前一半），
        // `push` 只能等 —— 是 `finish` 告诉它「不会再有字节了」。
        let mut b = SseBuffer::new();
        assert!(b.push(b"data: x\r\r").is_empty(), "歧义未决时不该出帧");
        let out = b.finish();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].data, "x");
        assert!(!b.has_partial(), "收尾之后应当是干净的");
    }

    #[test]
    fn finish_reports_a_stream_that_died_mid_frame() {
        // 这是调用方真正要用的一条：连接在一帧中间断了。
        let mut b = SseBuffer::new();
        let _ = b.push(b"event: content_block_delta\ndata: {\"partial\":");
        assert!(b.finish().is_empty());
        assert!(
            b.has_partial(),
            "断在半截上必须能看出来 —— 否则会被当成完整的一轮，\
             下一轮请求因为孤儿 tool_use 直接 400"
        );
    }

    #[test]
    fn finish_on_a_clean_stream_is_a_noop() {
        let mut b = SseBuffer::new();
        let _ = b.push(b"data: x\n\n");
        assert!(b.finish().is_empty());
        assert!(!b.has_partial());
    }

    #[test]
    fn joins_multiline_data_with_newline() {
        let mut b = SseBuffer::new();
        let out = b.push(b"data: line1\ndata: line2\n\n");
        assert_eq!(out[0].data, "line1\nline2");
    }

    #[test]
    fn ignores_comments_and_unknown_fields() {
        let mut b = SseBuffer::new();
        let out = b.push(b": keep-alive\nid: 42\nretry: 100\ndata: x\n\n");
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].data, "x");
    }

    #[test]
    fn a_blank_line_with_no_data_does_not_dispatch() {
        // 心跳、流的开头都可能是空行 —— 不该冒出空帧让上层处处防空洞。
        let mut b = SseBuffer::new();
        assert!(b.push(b"\n\n\n").is_empty());
    }

    #[test]
    fn strips_exactly_one_leading_space() {
        // ⚠️ 不是 trim_start：内容里本来就有的空格不能被吃掉。
        let mut b = SseBuffer::new();
        let out = b.push(b"data:  two spaces\n\n");
        assert_eq!(out[0].data, " two spaces");
    }

    #[test]
    fn data_without_a_space_after_the_colon_works() {
        let mut b = SseBuffer::new();
        let out = b.push(b"data:{\"a\":1}\n\n");
        assert_eq!(out[0].data, "{\"a\":1}");
    }

    #[test]
    fn a_truncated_tail_is_reported_as_partial() {
        // 连接在一帧中间断了 —— 上层必须能看出来，好走「丢弃半截、重试」，
        // 而不是把半个响应当成完整的一轮（那会造出没有配对 tool_result 的
        // tool_use，下一轮请求直接 400）。
        let mut b = SseBuffer::new();
        let out = b.push(b"event: message_start\ndata: {\"a\":");
        assert!(out.is_empty());
        assert!(b.has_partial());
    }

    #[test]
    fn handles_a_full_realistic_anthropic_stream() {
        let wire = concat!(
            "event: message_start\n",
            "data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"usage\":{\"input_tokens\":9}}}\n\n",
            "event: content_block_start\n",
            "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
            "event: content_block_delta\n",
            "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hello\"}}\n\n",
            "event: content_block_stop\n",
            "data: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
            // ⚠️ stop_reason 在 message_delta 里，不在 message_stop 里 ——
            // 从 message_stop 读的话永远读到 None，while 循环的终止条件就失效了。
            "event: message_delta\n",
            "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":12}}\n\n",
            "event: message_stop\n",
            "data: {\"type\":\"message_stop\"}\n\n",
        );
        let mut b = SseBuffer::new();
        let out = b.push(wire.as_bytes());
        assert_eq!(out.len(), 6);
        assert_eq!(out[0].event.as_deref(), Some("message_start"));
        assert_eq!(out[4].event.as_deref(), Some("message_delta"));
        assert!(out[4].data.contains("end_turn"));
        assert_eq!(out[5].event.as_deref(), Some("message_stop"));
        assert!(!b.has_partial());
    }
}
