//! 把流式事件**聚合成一轮**。
//!
//! provider 层负责把线格式解析成 [`Delta`]（两家的形状差很多），
//! 这个文件负责把这些增量攒成一轮完整的结果 —— 所以它是**两家共用的**，
//! 里面不该出现任何 `if provider == ...`。
//!
//! # 三个必须写对的地方
//!
//! 1. **工具输入要按 `index` 分桶。** 一轮里模型可以并行请求多个工具，
//!    它们的参数片段会交错着流过来。少一个桶、或者用一个"当前工具"的变量，
//!    多个调用就会互相覆盖 —— 而且**不报错**，表现是「模型偶尔调错工具、
//!    参数是另一个工具的」。
//!
//! 2. **`stop_reason` 和 `usage` 都在 `message_delta` 里，不在 `message_stop` 里。**
//!    从 `message_stop` 读的话永远读到空值，于是 `while` 循环的终止条件失效 ——
//!    表现是**无限循环烧钱**。
//!
//! 3. **参数拼不出合法 JSON 时，这一轮既不能执行、也不能追加**（见 [`ArgsState`]）。
//!    追加一个畸形 `tool_use` 进去，下一轮请求直接被服务端拒掉。

use std::collections::BTreeMap;

use serde_json::value::RawValue;

use crate::message::{Block, StopReason, Usage};

/// 流里的一个增量。各家 provider 把线格式翻译成这个。
#[derive(Debug, Clone, PartialEq)]
pub enum Delta {
    /// 正文的一小片。
    Text {
        /// 内容块下标（Anthropic 给；OpenAI 的正文恒为 0）。
        index: u32,
        /// 这一片文本。
        text: String,
    },
    /// 思考的一小片。
    Thinking {
        /// 内容块下标。
        index: u32,
        /// 这一片文本。
        text: String,
    },
    /// 思考块的签名（Anthropic 在块收尾时给）。回传时必需。
    ThinkingSignature {
        /// 内容块下标。
        index: u32,
        /// 签名原文。
        signature: String,
    },
    /// 一个工具调用开始了。
    ToolUseStart {
        /// 内容块下标。
        index: u32,
        /// 调用 id。
        id: String,
        /// 工具名。
        name: String,
    },
    /// 工具参数的一小片（**要按 index 拼**）。
    ToolUseArgs {
        /// 内容块下标。
        index: u32,
        /// 这一片（不保证是完整 JSON）。
        fragment: String,
    },
    /// 某个内容块结束了。
    ///
    /// 早点收到它就能早点把工具参数定稿 —— 错误定位在"哪一块坏了"上，
    /// 而不是等到整轮结束才发现。
    BlockStop {
        /// 内容块下标。
        index: u32,
    },
    /// 一个我们认不出来的块。**原样留着带回去。**
    UnknownBlock {
        /// 内容块下标。
        index: u32,
        /// 这个块开头的原始 JSON。
        raw: String,
    },
    /// 这一轮结束了，以及为什么。
    Stop(StopReason),
    /// 输入侧的用量（Anthropic 在 `message_start` 里给）。
    ///
    /// ⚠️ 和 [`Delta::OutputUsage`] 分开是刻意的：它们在两个不同的地方到达，
    /// 合成一个「加一加」的接口迟早会把同一个数加两遍。
    InputUsage(Usage),
    /// 输出侧的 token 数（Anthropic 在 `message_delta` 里给）。
    OutputUsage(u64),
}

/// 工具参数拼出来的结果。
///
/// ⚠️ **两种失败要分开处理，区别是「能不能把这一轮追加回历史」**：
///
/// * [`ArgsState::Unparseable`] —— 拼出来的字节**根本不是合法 JSON**
///   （被 `max_tokens` 截断了，或者模型自己吐坏了）。
///   这种情况下**整个 `tool_use` 块都没法表示**（我们的块用 `RawValue` 存参数，
///   而它要求合法 JSON），所以追加回历史会把下一轮请求搞成 400。
///   → 按「流中断」处理：**丢掉这一轮的半截、重发请求**。
/// * 拼出来是合法 JSON 但**不符合工具的 schema** —— 那是另一回事，
///   由 `tool::validate_input` 管：块照常追加，回一条 `is_error: true` 的
///   `tool_result` 让模型自己改。
#[derive(Debug, Clone)]
pub enum ArgsState {
    /// 拼出了合法 JSON。
    Ok(Box<RawValue>),
    /// 拼不出来。里面存着原始文本，好让报错能说清收到了什么。
    Unparseable(String),
}

/// 手写的相等判断（`RawValue` 没有实现 `PartialEq`）。
///
/// 和 `message::Block` 那边同一条规矩：**两个 `Ok` 按原始文本比** ——
/// 键序不同的等价 JSON 会被判为不等。这是刻意的（这两个字段的意义就是逐字节保真）。
impl PartialEq for ArgsState {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (ArgsState::Ok(a), ArgsState::Ok(b)) => a.get() == b.get(),
            (ArgsState::Unparseable(a), ArgsState::Unparseable(b)) => a == b,
            _ => false,
        }
    }
}

/// 一个工具调用。
#[derive(Debug, Clone, PartialEq)]
pub struct ToolCall {
    /// 调用 id（`tool_result` 靠它配对）。
    pub id: String,
    /// 工具名。
    pub name: String,
    /// 参数。
    pub args: ArgsState,
}

impl ToolCall {
    /// 参数的**原始 JSON 文本**。
    ///
    /// 拼不出来的那种也拿得到 —— 报错和日志要用它说清「到底收到了什么」。
    pub fn args_text(&self) -> &str {
        match &self.args {
            ArgsState::Ok(raw) => raw.get(),
            ArgsState::Unparseable(raw) => raw,
        }
    }
}

/// 一个内容块的累积状态。
#[derive(Debug, Clone)]
enum Slot {
    Text(String),
    Thinking {
        text: String,
        signature: Option<String>,
    },
    ToolUse {
        id: String,
        name: String,
        /// 参数片段的拼接结果（**拼完才解析**）。
        json: String,
        /// 已经定稿了（收到过 `BlockStop`），别再改。
        sealed: bool,
    },
    Unknown(String),
}

/// 攒一轮。
#[derive(Debug, Default)]
pub struct TurnAccum {
    /// ⚠️ **按内容块下标分桶**，理由见文件头第 1 条。
    ///
    /// 用 `BTreeMap` 而不是 `HashMap`：输出的时候要按 index 排序才是**模型说的那个顺序**
    /// （正文和工具调用的先后会影响模型下一轮的理解），而哈希表的迭代顺序是不确定的。
    slots: BTreeMap<u32, Slot>,
    stop_reason: Option<StopReason>,
    usage: Usage,
    /// 收到过 `Stop` 没有。
    stopped: bool,
}

impl TurnAccum {
    /// 新建。
    pub fn new() -> Self {
        Self::default()
    }

    /// 吃一个增量。
    pub fn apply(&mut self, delta: Delta) {
        match delta {
            Delta::Text { index, text } => {
                let slot = self
                    .slots
                    .entry(index)
                    .or_insert_with(|| Slot::Text(String::new()));
                // 同一个 index 先当工具、后来又是文本 —— 线上不该出现。
                // **不覆盖**：宁可留着一半，也不要悄悄把已经收到的东西抹掉。
                if let Slot::Text(buf) = slot {
                    buf.push_str(&text);
                }
            }

            Delta::Thinking { index, text } => {
                let slot = self.slots.entry(index).or_insert_with(|| Slot::Thinking {
                    text: String::new(),
                    signature: None,
                });
                if let Slot::Thinking { text: buf, .. } = slot {
                    buf.push_str(&text);
                }
            }

            Delta::ThinkingSignature { index, signature } => {
                if let Some(Slot::Thinking { signature: s, .. }) = self.slots.get_mut(&index) {
                    *s = Some(signature);
                }
            }

            Delta::ToolUseStart { index, id, name } => {
                self.slots.insert(
                    index,
                    Slot::ToolUse {
                        id,
                        name,
                        json: String::new(),
                        sealed: false,
                    },
                );
            }

            Delta::ToolUseArgs { index, fragment } => {
                if let Some(Slot::ToolUse { json, sealed, .. }) = self.slots.get_mut(&index) {
                    if !*sealed {
                        json.push_str(&fragment);
                    }
                }
            }

            Delta::BlockStop { index } => {
                if let Some(Slot::ToolUse { sealed, .. }) = self.slots.get_mut(&index) {
                    // 定稿。之后再来的参数片段会被忽略（正常流里不会有）。
                    *sealed = true;
                }
            }

            Delta::UnknownBlock { index, raw } => {
                self.slots.insert(index, Slot::Unknown(raw));
            }

            Delta::Stop(reason) => {
                self.stop_reason = Some(reason);
                self.stopped = true;
            }

            Delta::InputUsage(u) => {
                // 输入侧是**整体给一次**的，所以覆盖而不是累加。
                self.usage.uncached_input = u.uncached_input;
                self.usage.cache_read = u.cache_read;
                self.usage.cache_creation_5m = u.cache_creation_5m;
                self.usage.cache_creation_1h = u.cache_creation_1h;
            }

            Delta::OutputUsage(n) => {
                self.usage.output = n;
            }
        }
    }

    /// 能不能收尾了（收到过 `Stop`）。
    pub fn is_stopped(&self) -> bool {
        self.stopped
    }

    /// 收尾，产出一轮。
    pub fn finish(self) -> Turn {
        let mut blocks = Vec::new();
        let mut tool_calls = Vec::new();

        // 按 index 顺序 —— 那才是模型说的顺序。
        for (_, slot) in self.slots {
            match slot {
                Slot::Text(text) => blocks.push(Block::Text { text }),
                Slot::Thinking { text, signature } => {
                    blocks.push(Block::Thinking { text, signature })
                }
                Slot::ToolUse { id, name, json, .. } => {
                    let args = match RawValue::from_string(json.clone()) {
                        Ok(raw) => ArgsState::Ok(raw),
                        Err(_) => ArgsState::Unparseable(json),
                    };
                    // 参数拼得出来才建块；拼不出来时**不建块**（理由见 ArgsState 的文档）。
                    if let ArgsState::Ok(raw) = &args {
                        blocks.push(Block::ToolUse {
                            id: id.clone(),
                            name: name.clone(),
                            input: raw.clone(),
                        });
                    }
                    tool_calls.push(ToolCall { id, name, args });
                }
                Slot::Unknown(raw) => {
                    if let Some(b) = Block::unknown_from_str(&raw) {
                        blocks.push(b);
                    }
                }
            }
        }

        Turn {
            blocks,
            tool_calls,
            stop_reason: self.stop_reason.unwrap_or(StopReason::Unknown("missing".into())),
            usage: self.usage,
        }
    }
}

/// 聚合出来的一轮。
#[derive(Debug, Clone, PartialEq)]
pub struct Turn {
    /// 这一轮的内容块，**顺序就是模型给的顺序**。
    /// 要原样追加回历史（`Unknown` 也在里面）。
    pub blocks: Vec<Block>,
    /// 这一轮请求的工具调用。
    pub tool_calls: Vec<ToolCall>,
    /// 为什么停的。
    pub stop_reason: StopReason,
    /// 用量。
    pub usage: Usage,
}

impl Turn {
    /// 要造一条 assistant 消息追加回历史吗？
    ///
    /// 两个条件，缺一不可：
    ///
    /// 1. **每个调用的参数都拼得出合法 JSON** —— 拼不出的那种连块都建不出来
    ///    （理由见 [`ArgsState`]），这一轮的半截不能追加。
    /// 2. **每个调用都有对应的 `tool_use` 块。** 少一个的话，我们把结果追加回去
    ///    就成了**孤儿 `tool_result`** —— 下一轮请求直接 400，而且报错不会指认
    ///    是哪一条消息的问题。
    ///
    /// 第 2 条在正常流里是恒真的（块和调用在 [`TurnAccum`] 里同源），
    /// 留着是因为它把「追加的这一轮一定是自洽的」这件事变成了**可以断言的东西** ——
    /// 而不是靠"反正上游不会那样"。
    pub fn is_appendable(&self) -> bool {
        self.tool_calls
            .iter()
            .all(|c| matches!(c.args, ArgsState::Ok(_)))
            && self.tool_calls.iter().all(|c| {
                self.blocks
                    .iter()
                    .any(|b| matches!(b, Block::ToolUse { id, .. } if id == &c.id))
            })
    }

    /// 有没有工具要执行。
    pub fn has_tool_calls(&self) -> bool {
        !self.tool_calls.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::message::Usage;

    fn text(index: u32, t: &str) -> Delta {
        Delta::Text {
            index,
            text: t.to_owned(),
        }
    }

    fn tool_start(index: u32, id: &str, name: &str) -> Delta {
        Delta::ToolUseStart {
            index,
            id: id.to_owned(),
            name: name.to_owned(),
        }
    }

    fn args(index: u32, f: &str) -> Delta {
        Delta::ToolUseArgs {
            index,
            fragment: f.to_owned(),
        }
    }

    #[test]
    fn text_fragments_accumulate_in_order() {
        let mut a = TurnAccum::new();
        for piece in ["Hel", "lo, ", "world"] {
            a.apply(text(0, piece));
        }
        a.apply(Delta::Stop(StopReason::EndTurn));
        let turn = a.finish();
        assert_eq!(turn.blocks, vec![Block::Text { text: "Hello, world".into() }]);
        assert_eq!(turn.stop_reason, StopReason::EndTurn);
    }

    #[test]
    fn parallel_tool_calls_do_not_overwrite_each_other() {
        // ⚠️ 这是这个文件最要紧的一条。真实流里两个调用的片段是**交错**过来的：
        //   start(1) → start(2) → args(1) → args(2) → args(1) → args(2) → stop
        // 用一个"当前工具"的变量来攒参数，这里就必然串台 —— 而且不报错。
        let mut a = TurnAccum::new();
        a.apply(tool_start(1, "t1", "read_file"));
        a.apply(tool_start(2, "t2", "write_file"));
        a.apply(args(1, r#"{"pa"#));
        a.apply(args(2, r#"{"path":"b"#));
        a.apply(args(1, r#"th":"a.txt"}"#));
        a.apply(args(2, r#".txt","contents":"x"}"#));
        a.apply(Delta::BlockStop { index: 1 });
        a.apply(Delta::BlockStop { index: 2 });
        a.apply(Delta::Stop(StopReason::ToolUse));

        let turn = a.finish();
        assert_eq!(turn.tool_calls.len(), 2);
        match &turn.tool_calls[0].args {
            ArgsState::Ok(raw) => assert_eq!(raw.get(), r#"{"path":"a.txt"}"#),
            other => panic!("第一个调用的参数坏了：{other:?}"),
        }
        match &turn.tool_calls[1].args {
            ArgsState::Ok(raw) => assert_eq!(raw.get(), r#"{"path":"b.txt","contents":"x"}"#),
            other => panic!("第二个调用的参数坏了：{other:?}"),
        }
    }

    #[test]
    fn blocks_come_out_in_model_order_not_hash_order() {
        // 正文在前、工具调用在后 —— 顺序是模型说的，不能被容器重排。
        let mut a = TurnAccum::new();
        a.apply(tool_start(1, "t1", "read_file"));
        a.apply(text(0, "先看看这个文件"));
        a.apply(args(1, "{}"));
        a.apply(Delta::Stop(StopReason::ToolUse));

        let turn = a.finish();
        assert!(matches!(turn.blocks[0], Block::Text { .. }), "正文应当排在前面");
        assert!(matches!(turn.blocks[1], Block::ToolUse { .. }));
    }

    #[test]
    fn a_truncated_tool_input_is_not_appendable() {
        // 撞上 max_tokens 时参数会被切断。追加进历史 = 下一轮请求 400，
        // 所以这一轮必须整体丢掉重发。
        let mut a = TurnAccum::new();
        a.apply(tool_start(1, "t1", "write_file"));
        a.apply(args(1, r#"{"path":"a.txt","cont"#));
        a.apply(Delta::Stop(StopReason::MaxTokens));

        let turn = a.finish();
        match &turn.tool_calls[0].args {
            ArgsState::Unparseable(raw) => assert!(raw.contains("cont")),
            other => panic!("应当判为拼不出来：{other:?}"),
        }
        assert!(!turn.is_appendable());
        // 拼不出来的块也不该出现在 blocks 里
        assert!(turn.blocks.iter().all(|b| !matches!(b, Block::ToolUse { .. })));
    }

    #[test]
    fn a_schema_invalid_but_parseable_input_is_still_appendable() {
        // 合法 JSON 但不符合工具 schema —— 那是工具层的活儿：
        // 块照常追加，回一条 is_error 让模型自己改。
        let mut a = TurnAccum::new();
        a.apply(tool_start(1, "t1", "write_file"));
        a.apply(args(1, r#"{"oops":true}"#));
        a.apply(Delta::Stop(StopReason::ToolUse));

        let turn = a.finish();
        assert!(turn.is_appendable());
        assert!(matches!(turn.tool_calls[0].args, ArgsState::Ok(_)));
    }

    #[test]
    fn usage_arrives_in_two_pieces() {
        // 输入侧在 message_start、输出侧在 message_delta。合成一个"加一加"的接口
        // 迟早会把同一个数加两遍 —— 所以是两个独立的 delta。
        let mut a = TurnAccum::new();
        a.apply(Delta::InputUsage(Usage {
            uncached_input: 10,
            cache_read: 900,
            cache_creation_5m: 90,
            ..Default::default()
        }));
        a.apply(Delta::OutputUsage(42));
        a.apply(Delta::Stop(StopReason::EndTurn));

        let turn = a.finish();
        assert_eq!(turn.usage.total_input(), 1000);
        assert_eq!(turn.usage.output, 42);
    }

    #[test]
    fn input_usage_arriving_twice_does_not_double_count() {
        let mut a = TurnAccum::new();
        a.apply(Delta::InputUsage(Usage {
            uncached_input: 10,
            ..Default::default()
        }));
        a.apply(Delta::InputUsage(Usage {
            uncached_input: 10,
            ..Default::default()
        }));
        assert_eq!(a.finish().usage.total_input(), 10);
    }

    #[test]
    fn unknown_blocks_are_kept_verbatim() {
        let raw = r#"{"type":"compaction","summary":"...","z":1,"a":2}"#;
        let mut a = TurnAccum::new();
        a.apply(Delta::UnknownBlock {
            index: 0,
            raw: raw.to_owned(),
        });
        a.apply(Delta::Stop(StopReason::EndTurn));

        let turn = a.finish();
        assert_eq!(turn.blocks.len(), 1);
        match &turn.blocks[0] {
            Block::Unknown { raw: kept } => assert_eq!(kept.get(), raw),
            other => panic!("未知块被弄丢了：{other:?}"),
        }
    }

    #[test]
    fn thinking_keeps_its_signature() {
        let mut a = TurnAccum::new();
        a.apply(Delta::Thinking {
            index: 0,
            text: "想想".into(),
        });
        a.apply(Delta::ThinkingSignature {
            index: 0,
            signature: "sig-abc".into(),
        });
        a.apply(Delta::Stop(StopReason::EndTurn));

        match &a.finish().blocks[0] {
            Block::Thinking { text, signature } => {
                assert_eq!(text, "想想");
                assert_eq!(signature.as_deref(), Some("sig-abc"));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_call_without_its_block_is_not_appendable() {
        // ⚠️ 有调用却少了 `tool_use` 块 → 追加回去就是**孤儿 tool_result**，
        // 下一轮请求直接 400。
        let mut a = TurnAccum::new();
        a.apply(tool_start(1, "t1", "read_file"));
        a.apply(args(1, "{}"));
        a.apply(Delta::Stop(StopReason::ToolUse));
        let good = a.finish();
        assert!(good.is_appendable());

        let mut broken = good.clone();
        broken.blocks.clear();
        assert!(
            !broken.is_appendable(),
            "没有配对的块就不能追加 —— 否则是孤儿 tool_result"
        );
    }

    #[test]
    fn a_missing_stop_reason_is_not_silently_end_turn() {
        // 没有 Stop 就收尾（流断了）时，**不能**默认成 EndTurn ——
        // 那会让 while 循环以为"说完了"，安静地少跑一轮。
        let turn = TurnAccum::new().finish();
        assert_eq!(turn.stop_reason, StopReason::Unknown("missing".into()));
        assert!(!turn.has_tool_calls());
    }
}
