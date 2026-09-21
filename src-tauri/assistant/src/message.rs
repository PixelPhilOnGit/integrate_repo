//! provider 中立的对话模型。
//!
//! # 为什么要有一层中立的模型
//!
//! 两家的协议差别很大，但**循环只应该认识一套东西**：
//!
//! | 概念 | Anthropic | OpenAI 兼容 |
//! |---|---|---|
//! | 工具结果放哪 | 一条 **user** 消息里的多个 `tool_result` 块 | 每个调用一条 **`tool` 角色**的独立消息 |
//! | 工具参数 | `tool_use.input` 是个**对象** | `function.arguments` 是个 **JSON 字符串** |
//! | 结束判据 | `stop_reason == "tool_use"` | `finish_reason == "tool_calls"` |
//!
//! 归一之后，循环里就不该再出现任何 `if provider == ...`。
//!
//! # 两条必须守住的规矩
//!
//! 1. **认不出来的块要原样带回去**（[`Block::Unknown`]）。
//!    官方的要求是「把完整的 `response.content` 追加回历史」——
//!    只挑认识的块、丢掉其余的（thinking / compaction / server_tool_use …）
//!    **会静默改变行为**：没有报错，只是模型下一轮看到的上下文不完整了。
//!    所以这里用 [`RawValue`] 存原始字节，**解析再序列化是不行的**
//!    （键序、转义、浮点格式都可能变），那既可能丢信息、也会打乱 prompt 缓存。
//!
//! 2. **首条消息必须是 user**，且 `system` 不在 messages 里（见 [`crate::message::Role`]）。
//!    这是 Anthropic 的硬要求；OpenAI 兼容端把它翻译成一条 `system` 角色的消息。

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;

/// 消息的角色。
///
/// ⚠️ **中立模型里没有 `System`** —— system 提示是请求的一个**独立字段**
/// （Anthropic 就是这么设计的，OpenAI 那边由 provider 翻译成一条 `system` 消息）。
/// 混进 messages 里会踩两个坑：Anthropic 要求 messages 首条必须是 user；
/// 而且中途插 system 消息有位置约束（不能在 `messages[0]`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    /// 用户（也承载工具结果）。
    User,
    /// 模型。
    Assistant,
}

/// 一条消息。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    /// 谁说的。
    pub role: Role,
    /// 说了什么。**顺序有意义**，不要重排。
    pub content: Vec<Block>,
}

impl Message {
    /// 造一条纯文本的 user 消息。
    pub fn user_text(text: impl Into<String>) -> Self {
        Message {
            role: Role::User,
            content: vec![Block::Text { text: text.into() }],
        }
    }

    /// 这条消息里有没有工具调用。
    pub fn has_tool_use(&self) -> bool {
        self.content
            .iter()
            .any(|b| matches!(b, Block::ToolUse { .. }))
    }

    /// 逐个取出工具调用。
    pub fn tool_uses(&self) -> impl Iterator<Item = (&str, &str, &RawValue)> {
        self.content.iter().filter_map(|b| match b {
            Block::ToolUse { id, name, input } => Some((id.as_str(), name.as_str(), input.as_ref())),
            _ => None,
        })
    }

    /// 拼出这条消息里的纯文本（思考和工具调用都不算）。
    ///
    /// 用途是展示和落盘检索，**不是**回传给模型 —— 回传必须用完整的 `content`。
    pub fn text(&self) -> String {
        self.content
            .iter()
            .filter_map(|b| match b {
                Block::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("")
    }
}

/// 消息里的一个块。
///
/// 判别标签是 `type`（和两家的线格式一致），字段名按前端习惯用 camelCase。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum Block {
    /// 纯文本。
    Text {
        /// 内容。
        text: String,
    },

    /// 模型的思考。
    ///
    /// **落盘留着、组装时剥掉**（见 `context::sanitize`）。
    /// 原因是官方要求 thinking 块「原样回传 + 历史只追加」，
    /// 而我们的上下文策略恰恰在改写历史 —— 带着旧 thinking 块回传会**直接 400**，
    /// 且那个 400 看不出和上下文策略有关系。
    Thinking {
        /// 思考内容（`display: "summarized"` 时要显式要，否则是空串）。
        text: String,
        /// Anthropic 的签名。回传时必需，剥掉时自然一起没了。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        signature: Option<String>,
    },

    /// 模型请求调用一个工具。
    ToolUse {
        /// 配对的 id，`tool_result` 靠它对应上。
        id: String,
        /// 工具名。
        name: String,
        /// 参数。**已经是对象** —— 两家的差异在 provider 层就消化掉了
        /// （Anthropic 给对象，OpenAI 给 JSON 字符串，要拼接后严格解析）。
        input: Box<RawValue>,
    },

    /// 工具的执行结果。
    ToolResult {
        /// 对应哪个 `ToolUse`。
        tool_use_id: String,
        /// 给模型看的文本。
        content: String,
        /// 失败了就把这个置真 —— **失败的结果也要回传，不能丢**。
        is_error: bool,
    },

    /// 我们不认识的块，原样留着。
    ///
    /// 存在的唯一理由是**原样带回去**：thinking 的变体、compaction、
    /// server_tool_use、将来新增的类型……丢一个都是静默的行为改变。
    Unknown {
        /// 原始 JSON 字节。用 `RawValue` 而不是 `Value` 是为了**逐字节不变**。
        raw: Box<RawValue>,
    },
}

impl Block {
    /// 把一段原始 JSON 收成 `Unknown`。
    ///
    /// 解析失败时返回 `None` —— 调用方应当**跳过**这个块而不是报错：
    /// 它本来就是我们不认识的东西，为它中断整轮对话不值得。
    pub fn unknown_from_str(raw: &str) -> Option<Self> {
        RawValue::from_string(raw.to_owned())
            .ok()
            .map(|raw| Block::Unknown { raw })
    }
}

/// 手写的反序列化。
///
/// ⚠️ **不能用 `#[derive(Deserialize)]`。** 内部标签枚举（`tag = "type"`）会把整块内容
/// 缓冲成 serde 的 `Content` 中间表示再分派，而 `RawValue` **没法从 `Content` 里取出原始字节**
/// （会报 `invalid type: newtype struct`）。这两样东西我是都要的：
///
/// * 线格式得是 `{"type": "tool_use", ...}`（两家的线上都是这个形状）；
/// * 认不出来的块得**逐字节**留着（见 [`Block::Unknown`]）。
///
/// 所以走「先原样收下整块 → 只看一眼 `type` → 已知类型从**原始字节**重新解析」：
/// 未知类型的字节从头到尾没被解析过，保真；已知类型的字段错误也还是 serde 原生的报错。
impl<'de> Deserialize<'de> for Block {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        /// 只读 `type`，其余字段跳过（serde 跳过字段不分配）。
        #[derive(Deserialize)]
        struct TagOnly {
            #[serde(rename = "type")]
            tag: Option<String>,
        }

        /// 从原始字节反序列化一个已知变体的字段。
        ///
        /// 用 `DeserializeOwned` 是刻意的：变体里不能有借来的数据
        /// （借来的话它和 `raw` 的生命周期对不上）。
        fn take<T: serde::de::DeserializeOwned>(
            raw: &RawValue,
        ) -> Result<T, serde_json::Error> {
            serde_json::from_str(raw.get())
        }

        let raw = Box::<RawValue>::deserialize(deserializer)?;

        let tag = take::<TagOnly>(&raw)
            .map_err(serde::de::Error::custom)?
            .tag;

        // 没有 type 字段 —— 我们造的结构里不该出现，但也别炸，当未知收着。
        let Some(tag) = tag else {
            return Ok(Block::Unknown { raw });
        };

        #[derive(Deserialize)]
        struct TextFields {
            text: String,
        }
        #[derive(Deserialize)]
        struct ThinkingFields {
            text: String,
            #[serde(default)]
            signature: Option<String>,
        }
        #[derive(Deserialize)]
        struct ToolUseFields {
            id: String,
            name: String,
            input: Box<RawValue>,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct ToolResultFields {
            tool_use_id: String,
            content: String,
            #[serde(default)]
            is_error: bool,
        }

        let bad = |e: serde_json::Error| serde::de::Error::custom(e);

        Ok(match tag.as_str() {
            "text" => Block::Text {
                text: take::<TextFields>(&raw).map_err(bad)?.text,
            },
            "thinking" => {
                let f = take::<ThinkingFields>(&raw).map_err(bad)?;
                Block::Thinking {
                    text: f.text,
                    signature: f.signature,
                }
            }
            "tool_use" => {
                let f = take::<ToolUseFields>(&raw).map_err(bad)?;
                Block::ToolUse {
                    id: f.id,
                    name: f.name,
                    input: f.input,
                }
            }
            "tool_result" => {
                let f = take::<ToolResultFields>(&raw).map_err(bad)?;
                Block::ToolResult {
                    tool_use_id: f.tool_use_id,
                    content: f.content,
                    is_error: f.is_error,
                }
            }
            // 认不出来 —— 原样留着。**不报错**：本来就是别人新增的东西，
            // 为它中断整轮对话不值得。
            _ => Block::Unknown { raw },
        })
    }
}

/// 手写的相等判断（`RawValue` 没有实现 `PartialEq`，derive 不出来）。
///
/// ⚠️ **两个 `RawValue` 字段是按「原始文本」比的** —— 所以
/// `{"a":1,"b":2}` 和 `{"b":2,"a":1}` 会被判为**不等**，尽管它们是同一个 JSON。
///
/// 这是刻意的：这两个字段存在的意义就是「逐字节原样回传」，字节变了就是变了
/// （prompt 缓存也这么看）。需要**语义**比较的地方 —— 比如重复调用熔断要比
/// 「同一个工具 + 同一组参数」—— 得自己解析成 `Value` 再比，别用这个 `==`。
impl PartialEq for Block {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Block::Text { text: a }, Block::Text { text: b }) => a == b,
            (
                Block::Thinking {
                    text: a,
                    signature: sa,
                },
                Block::Thinking {
                    text: b,
                    signature: sb,
                },
            ) => a == b && sa == sb,
            (
                Block::ToolUse {
                    id: a,
                    name: na,
                    input: ia,
                },
                Block::ToolUse {
                    id: b,
                    name: nb,
                    input: ib,
                },
            ) => a == b && na == nb && ia.get() == ib.get(),
            (
                Block::ToolResult {
                    tool_use_id: a,
                    content: ca,
                    is_error: ea,
                },
                Block::ToolResult {
                    tool_use_id: b,
                    content: cb,
                    is_error: eb,
                },
            ) => a == b && ca == cb && ea == eb,
            (Block::Unknown { raw: a }, Block::Unknown { raw: b }) => a.get() == b.get(),
            _ => false,
        }
    }
}

/// 一轮请求的用量。
///
/// ⚠️ **这里的字段名是刻意和 Anthropic 的线格式不同的。**
///
/// 线格式里 `input_tokens` 只是**未缓存的那一部分**，总输入是
/// `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`。
/// 把它直接叫 `input_tokens` 的话，一定会有人拿它当"输入大小"去做 token 预算 ——
/// 那样在缓存生效时会**低估 5~10 倍**，预算永远不触发，账单照涨。
/// 所以这里改叫 [`Usage::uncached_input`]，并且只通过 [`Usage::total_input`] 求和。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    /// 输入里**没走缓存**的那部分（Anthropic 的 `input_tokens`）。
    pub uncached_input: u64,
    /// 从缓存读到的输入 token。价钱约是全价的 0.1×。
    pub cache_read: u64,
    /// 写进缓存的 token，**5 分钟 TTL** 那档。价钱是全价的 1.25×。
    pub cache_creation_5m: u64,
    /// 写进缓存的 token，**1 小时 TTL** 那档。价钱是全价的 2×。
    ///
    /// 和 5m 分开存是必要的：只留一个总数就**算不出准确成本**。
    pub cache_creation_1h: u64,
    /// 输出的 token。
    pub output: u64,
}

impl Usage {
    /// 这一轮真正的输入规模。**预算检查只能用它。**
    pub fn total_input(&self) -> u64 {
        self.uncached_input + self.cache_read + self.cache_creation_5m + self.cache_creation_1h
    }

    /// 写进缓存的 token 合计（两档 TTL）。
    pub fn cache_creation(&self) -> u64 {
        self.cache_creation_5m + self.cache_creation_1h
    }

    /// 累加（一次 run 里统计用）。
    pub fn add(&mut self, other: &Usage) {
        self.uncached_input += other.uncached_input;
        self.cache_read += other.cache_read;
        self.cache_creation_5m += other.cache_creation_5m;
        self.cache_creation_1h += other.cache_creation_1h;
        self.output += other.output;
    }

    /// 缓存命中率：读到的 / （读到的 + 写的 + 没缓存的）。
    ///
    /// 返回 `None` 表示这一轮压根没有输入（没东西可算），
    /// **不是** 0% —— UI 要能区分这两者。
    pub fn cache_hit_rate(&self) -> Option<f64> {
        let total = self.total_input();
        if total == 0 {
            return None;
        }
        Some(self.cache_read as f64 / total as f64)
    }
}

/// 这一轮为什么停了（两家归一之后）。
///
/// 归一是必需的：少映射一个，`while` 循环就会在某个 provider 上多转一轮
/// 或者该继续时停下 —— 都不报错。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StopReason {
    /// 正常说完。
    EndTurn,
    /// 要调工具，**继续循环**。
    ToolUse,
    /// 撞到输出上限被截断。
    ///
    /// ⚠️ 此时如果带着 `tool_use`，**那个工具不能执行** ——
    /// 参数很可能被截断了，而截断后的 JSON 常常仍能解析成一个"看着合法"的部分对象。
    MaxTokens,
    /// 安全分类器拒绝了。
    ///
    /// ⚠️ 这一轮的工具**一个都不能执行**：拒绝可能把 `tool_use` 切一半。
    Refusal,
    /// 撞到自定义停止序列。
    StopSequence,
    /// 服务端把这一轮暂停了（服务端工具跑满了一轮的上限）。
    ///
    /// 正确动作是「把响应原样追加、重新请求」，不是当 `end_turn` 结束、
    /// 也不是当未知状态报错。
    PauseTurn,
    /// 认不出来的值。**留着原文**，好让报错能说清是谁。
    Unknown(String),
}

impl StopReason {
    /// 从 Anthropic 的 `stop_reason` 归一。
    pub fn from_anthropic(s: &str) -> Self {
        match s {
            "end_turn" => Self::EndTurn,
            "tool_use" => Self::ToolUse,
            "max_tokens" => Self::MaxTokens,
            "refusal" => Self::Refusal,
            "stop_sequence" => Self::StopSequence,
            "pause_turn" => Self::PauseTurn,
            other => Self::Unknown(other.to_owned()),
        }
    }

    /// 从 OpenAI 兼容端的 `finish_reason` 归一。
    pub fn from_openai(s: &str) -> Self {
        match s {
            "stop" => Self::EndTurn,
            "tool_calls" | "function_call" => Self::ToolUse,
            "length" => Self::MaxTokens,
            "content_filter" => Self::Refusal,
            other => Self::Unknown(other.to_owned()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usage_total_covers_every_input_bucket() {
        let u = Usage {
            uncached_input: 100,
            cache_read: 1000,
            cache_creation_5m: 200,
            cache_creation_1h: 50,
            output: 7,
        };
        // 这条断言就是那个「低估 5~10 倍」的 bug 的防线：
        // 总输入必须把三个桶都算上，不能只看 uncached_input。
        assert_eq!(u.total_input(), 1350);
        assert_eq!(u.cache_creation(), 250);
    }

    #[test]
    fn cache_hit_rate_distinguishes_empty_from_zero() {
        assert_eq!(Usage::default().cache_hit_rate(), None);
        let u = Usage {
            uncached_input: 10,
            ..Default::default()
        };
        assert_eq!(u.cache_hit_rate(), Some(0.0));
    }

    #[test]
    fn unknown_block_survives_round_trip_byte_for_byte() {
        // 这条是「把完整的 response.content 追加回去」的保证。
        // 如果哪天有人把 RawValue 换成 Value，键序会被重排，这条测试会红。
        let raw = r#"{"type":"compaction","weird_key":1,"z_comes_first":true,"nested":{"b":1,"a":2}}"#;
        let block = Block::unknown_from_str(raw).expect("应当能收下");
        let out = serde_json::to_string(&block).unwrap();
        assert!(
            out.contains(raw),
            "原始字节必须原样保留，实际是：{out}"
        );
    }

    #[test]
    fn tool_use_input_stays_an_object() {
        // provider 层已经消化了「OpenAI 给的是 JSON 字符串」这件事，
        // 到这里必须是对象（好让工具直接按 schema 校验）。
        let json = r#"{"type":"tool_use","id":"toolu_1","name":"read_file","input":{"path":"a.txt"}}"#;
        let block: Block = serde_json::from_str(json).unwrap();
        match block {
            Block::ToolUse { id, name, input } => {
                assert_eq!(id, "toolu_1");
                assert_eq!(name, "read_file");
                assert_eq!(input.get(), r#"{"path":"a.txt"}"#);
            }
            other => panic!("解析成了 {other:?}"),
        }
    }

    #[test]
    fn block_field_names_are_camel_case() {
        // ⚠️ 枚举上的 `rename_all` 不改变体内部字段名 —— 要 `rename_all_fields`。
        // 这个仓库在 agents 那一轮被这条坑过（HANDOFF 519 行）。
        let b = Block::ToolResult {
            tool_use_id: "t1".into(),
            content: "ok".into(),
            is_error: false,
        };
        let s = serde_json::to_string(&b).unwrap();
        assert!(s.contains(r#""toolUseId""#), "字段名没转成 camelCase：{s}");
        assert!(!s.contains("tool_use_id"), "字段名漏了转换：{s}");
    }

    #[test]
    fn tool_results_are_pairable() {
        let m = Message {
            role: Role::User,
            content: vec![
                Block::ToolResult {
                    tool_use_id: "a".into(),
                    content: "1".into(),
                    is_error: false,
                },
                Block::ToolResult {
                    tool_use_id: "b".into(),
                    content: "boom".into(),
                    is_error: true,
                },
            ],
        };
        // 失败的结果也在里面 —— 「工具失败也要回 is_error，不能丢」。
        assert_eq!(m.content.len(), 2);
        assert!(!m.has_tool_use());
    }

    #[test]
    fn stop_reason_normalizes_both_providers() {
        assert_eq!(StopReason::from_anthropic("end_turn"), StopReason::EndTurn);
        assert_eq!(StopReason::from_openai("stop"), StopReason::EndTurn);
        assert_eq!(StopReason::from_anthropic("tool_use"), StopReason::ToolUse);
        assert_eq!(StopReason::from_openai("tool_calls"), StopReason::ToolUse);
        assert_eq!(StopReason::from_openai("length"), StopReason::MaxTokens);
        assert_eq!(
            StopReason::from_openai("content_filter"),
            StopReason::Refusal
        );
        // 认不出来时留着原文，别静默当成 EndTurn。
        assert_eq!(
            StopReason::from_anthropic("something_new"),
            StopReason::Unknown("something_new".into())
        );
    }
}
