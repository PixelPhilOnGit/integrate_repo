//! 上下文组装：从历史里挑出这一轮要发给模型的消息。
//!
//! 这是「用户可选策略」那个功能的实现层。策略决定**挑哪些**，
//! 而挑完之后还必须过一道 [`sanitize`]，两道加起来才是能发的消息。
//!
//! # 为什么「挑」的最小单位是原子块，不是消息
//!
//! 一次工具调用在协议上是**两条消息**：assistant 里的 `tool_use`，
//! 和紧接着 user 里的 `tool_result`。它们是一对，**中间切开就是 400**。
//!
//! 所以窗口不能按消息条数切 —— 表现形式是「偶发 400，重试一下又好了」
//! （重试时上下文变了一点，恰好没切在那儿），最难查的一类。
//! 这里把它变成结构性的：先切成 [`Atom`]，窗口只能落在原子之间。
//!
//! # 净化那一步在做什么
//!
//! [`sanitize`] 干两件事，都是「不改写就没法发」的：
//!
//! 1. **剥掉 thinking 块。** 官方的要求是「thinking 块原样回传、且历史应当是
//!    **只追加**的」，而我们的策略**恰恰在改写历史**（滚动要丢、摘要要压）。
//!    改写过之后旧的 thinking 块会被判为无效 —— 新账号 / 新模型上直接 400，
//!    而那个 400 看不出和上下文策略有任何关系。
//!    ⚠️ 这是**只有我们这种自己管上下文的客户端**才会踩的坑。
//! 2. **丢掉配不上对的 `tool_use` / `tool_result`。** 历史理论上不该有孤儿
//!    （循环那边保证不追加半截），但这里是最后一道防线：错的配对发出去就是 400，
//!    而 400 的文案不会告诉你是哪一条消息的问题。

use crate::message::{Block, Message, Role};

/// 挑窗口的策略。用户在界面上选的就是这个。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContextStrategy {
    /// 全量：一条不丢。
    ///
    /// 对 prompt 缓存最友好的一种（历史只追加，前缀从不变），
    /// 短会话就该用它。
    Full,
    /// 滚动：只留最近 N 个原子块。
    ///
    /// ⚠️ 代价要说清楚：**每轮都会打断 messages 那一段的缓存**
    /// （砍掉开头 = 前缀变了 = 从改动点往后全失效）。
    /// tools + system 那一段（前缀最前面）还能保住，而 messages 通常是 token 大头。
    /// 界面上要能看出这个差别，别让用户以为"换了策略只是省 token"。
    Rolling {
        /// 留最近几个**原子块**（不是几条消息 —— 见模块文档）。
        keep_last_atoms: usize,
    },
    /// 滑动：老的压成摘要（**二期，未实现**）。
    Summarize {
        /// 最近多少个原子块原样保留。
        keep_recent: usize,
    },
    /// 检索：从落盘的历史里召回相关的（**三期，未实现**）。
    Retrieve {
        /// 召回几条。
        top_k: usize,
    },
}

impl ContextStrategy {
    /// 存进记录 / 传给前端用的短名。
    ///
    /// ⚠️ **改了会让老数据对不上** —— 会话记录里存的就是这个字符串
    /// （见 `transcript.rs`），而那份数据要跨版本比对「哪个策略划算」。
    /// 要加新策略就加新名字，别动旧名字的拼法。
    pub fn as_str(self) -> String {
        match self {
            ContextStrategy::Full => "full".to_string(),
            ContextStrategy::Rolling { keep_last_atoms } => format!("rolling:{keep_last_atoms}"),
            ContextStrategy::Summarize { keep_recent } => format!("summarize:{keep_recent}"),
            ContextStrategy::Retrieve { top_k } => format!("retrieve:{top_k}"),
        }
    }

    /// [`ContextStrategy::as_str`] 的逆运算（命令层从 IPC 收字符串）。
    ///
    /// ⚠️ **认不出来就报错，绝不退到某个默认值。** 用户以为自己选了滚动、
    /// 实际在用全量的话，账单会替他发现问题 —— 而那时已经烧掉了。
    pub fn parse(s: &str) -> Result<Self, String> {
        let (head, tail) = match s.split_once(':') {
            Some((h, t)) => (h, Some(t)),
            None => (s, None),
        };
        let count = |name: &str| -> Result<usize, String> {
            tail.ok_or_else(|| format!("「{name}」后面要跟一个数字，比如 {name}:20"))?
                .trim()
                .parse::<usize>()
                .map_err(|_| format!("「{name}」后面的数字看不懂：{}", tail.unwrap_or("")))
        };
        match head {
            "full" => Ok(ContextStrategy::Full),
            "rolling" => Ok(ContextStrategy::Rolling {
                keep_last_atoms: count("rolling")?,
            }),
            "summarize" => Ok(ContextStrategy::Summarize {
                keep_recent: count("summarize")?,
            }),
            "retrieve" => Ok(ContextStrategy::Retrieve {
                top_k: count("retrieve")?,
            }),
            other => Err(format!("认不出的上下文策略「{other}」")),
        }
    }
}

/// 组装失败。
///
/// ⚠️ **策略没实现时是「报错」，不是「悄悄退回全量」。**
/// 静默退回的话，用户以为自己在用检索、实际在把整段历史全塞进去 ——
/// 账单上看不出来，行为上也看不出来（直到上下文爆掉）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ContextError {
    /// 这个策略还没实现（哪一期做，见 [`ContextStrategy`] 的文档）。
    NotImplemented {
        /// 策略名，给用户看的。
        strategy: &'static str,
        /// 哪一期做。
        planned: &'static str,
    },
}

impl std::fmt::Display for ContextError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ContextError::NotImplemented { strategy, planned } => {
                write!(f, "「{strategy}」这条上下文策略还没做（计划在{planned}）")
            }
        }
    }
}

/// 一个原子块：**不可再分**的一段历史。
///
/// 要么是一条独立的 user / assistant 消息，要么是「assistant 的 `tool_use`
/// 加上紧接着那条回答它的 user 消息」这一对。
#[derive(Debug, Clone, PartialEq)]
pub struct Atom {
    /// 这个原子块里的消息，顺序原样。
    pub messages: Vec<Message>,
}

/// 把历史切成原子块。
///
/// 规则只有一条：**assistant 消息里的 `tool_use`，和紧接着那条 user 消息里
/// 回答它们的 `tool_result`，属于同一个原子块。**
pub fn atoms(history: &[Message]) -> Vec<Atom> {
    let mut out: Vec<Atom> = Vec::new();

    for msg in history {
        // 这条消息是不是「在回答上一条 assistant 的工具调用」？
        let answers_previous = msg.role == Role::User
            && !msg.content.is_empty()
            && msg.content.iter().all(|b| matches!(b, Block::ToolResult { .. }));

        match out.last_mut() {
            Some(last)
                if answers_previous
                    && last
                        .messages
                        .last()
                        .is_some_and(|m| m.role == Role::Assistant && m.has_tool_use()) =>
            {
                // 并进上一个原子块 —— 这一对从此同生同死。
                last.messages.push(msg.clone());
            }
            _ => out.push(Atom {
                messages: vec![msg.clone()],
            }),
        }
    }

    out
}

/// 按策略挑出要发的消息。
///
/// ⚠️ 返回值**还没净化**。调用方必须再过一道 [`sanitize`]。
/// （不在这里顺手做掉，是因为「挑」和「净化」是两件事，
/// 分开之后各自能单独测，出错时也知道是哪一步。）
pub fn assemble(
    strategy: ContextStrategy,
    history: &[Message],
) -> Result<Vec<Message>, ContextError> {
    let all = atoms(history);

    let selected: Vec<Atom> = match strategy {
        ContextStrategy::Full => all,

        ContextStrategy::Rolling { keep_last_atoms } => {
            let keep = keep_last_atoms.max(1);
            let start = all.len().saturating_sub(keep);

            // ⚠️ **滚动的语义是「任务原文 + 最近 N 轮」，不是「最近 N 轮」。**
            //
            // 两个理由，任何一个单独都够：
            //
            // 1. **第一块往往是 assistant 起头的**（那个原子块是「调用 + 结果」这种
            //    成对的东西）。只留尾部的话，拼出来的历史第一条就是 assistant，
            //    而 Anthropic 硬性要求 messages 必须以 user 开头 —— 直接发不出去。
            // 2. 一个 agent 循环从头到尾**只有一条用户消息**（就是任务原文），
            //    后面全是「调用→结果→调用→结果」。真按"最近 N 轮"砍下去，
            //    等于把任务本身砍掉，模型就不知道自己为什么要做这些事了。
            //
            // 所以把「第一个以 user 起头的原子块」钉在最前面，再从窗口位置接下去。
            let head = all
                .iter()
                .position(|a| a.messages.first().is_some_and(|m| m.role == Role::User));

            let mut picked: Vec<Atom> = Vec::new();
            if let Some(h) = head {
                if h < start {
                    picked.push(all[h].clone());
                }
            }
            picked.extend(all[start..].iter().cloned());
            picked
        }

        ContextStrategy::Summarize { .. } => {
            return Err(ContextError::NotImplemented {
                strategy: "滑动（摘要）",
                planned: "二期",
            })
        }

        ContextStrategy::Retrieve { .. } => {
            return Err(ContextError::NotImplemented {
                strategy: "检索（向量召回）",
                planned: "三期",
            })
        }
    };

    Ok(flatten(ensure_starts_with_user(selected)))
}

/// 把原子块摊平成消息。
fn flatten(atoms: Vec<Atom>) -> Vec<Message> {
    atoms.into_iter().flat_map(|a| a.messages).collect()
}

/// 丢掉开头那些**不以 user 消息起头**的原子块。
///
/// ⚠️ 这一步必须在**原子块层面**做，不能摊平之后按消息丢。
/// 按消息丢的话，会丢掉 `assistant(tool_use)` 却留下它的 `tool_result` ——
/// 正好造出这个文件全文在防的那种孤儿对（而且它还会被 `sanitize` 悄悄清掉，
/// 用户看到的是「工具结果莫名消失了」）。
///
/// 整块丢掉是安全的：每个原子块自成一体（内部那对调用/结果配好了对），
/// 拿走一整块不会让剩下的任何一条失配。
fn ensure_starts_with_user(atoms: Vec<Atom>) -> Vec<Atom> {
    atoms
        .into_iter()
        .skip_while(|a| a.messages.first().is_some_and(|m| m.role != Role::User))
        .collect()
}

/// 净化：把不能这么发出去的东西处理掉。见模块文档。
pub fn sanitize(messages: Vec<Message>) -> Vec<Message> {
    let mut out: Vec<Message> = Vec::with_capacity(messages.len());

    for msg in messages {
        let content: Vec<Block> = msg
            .content
            .into_iter()
            // 剥掉思考块（理由见模块文档第 1 条）。
            .filter(|b| !matches!(b, Block::Thinking { .. }))
            .collect();

        if content.is_empty() {
            // 整条都是思考块 —— 这条消息净化完就空了。
            // 空 content 的消息发出去是 400，所以整条丢掉。
            continue;
        }

        out.push(Message {
            role: msg.role,
            content,
        });
    }

    drop_unpaired_tools(&mut out);
    out
}

/// 丢掉配不上对的 `tool_use` / `tool_result`。
///
/// 判据就是 id 集合：每个 `tool_use.id` 要有且只有一个对应的 `tool_result.tool_use_id`
/// —— **两个方向都要查**：孤儿 `tool_result`（没有对应的调用）和孤儿 `tool_use`
/// （调用没被回答）都会让请求 400。
///
/// 丢掉一个 `tool_use` 会让它所在的 assistant 消息少一个块（消息本身通常还有正文，
/// 保留）；如果那条消息净化完空了，上面那一步已经把它整条丢了。
fn drop_unpaired_tools(messages: &mut [Message]) {
    use std::collections::HashSet;

    let called: HashSet<String> = messages
        .iter()
        .flat_map(|m| m.content.iter())
        .filter_map(|b| match b {
            Block::ToolUse { id, .. } => Some(id.clone()),
            _ => None,
        })
        .collect();

    let answered: HashSet<String> = messages
        .iter()
        .flat_map(|m| m.content.iter())
        .filter_map(|b| match b {
            Block::ToolResult { tool_use_id, .. } => Some(tool_use_id.clone()),
            _ => None,
        })
        .collect();

    for msg in messages.iter_mut() {
        msg.content.retain(|b| match b {
            Block::ToolUse { id, .. } => answered.contains(id),
            Block::ToolResult { tool_use_id, .. } => called.contains(tool_use_id),
            _ => true,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user(text: &str) -> Message {
        Message::user_text(text)
    }

    fn assistant(text: &str) -> Message {
        Message {
            role: Role::Assistant,
            content: vec![Block::Text { text: text.into() }],
        }
    }

    fn assistant_calls(id: &str, name: &str) -> Message {
        Message {
            role: Role::Assistant,
            content: vec![Block::ToolUse {
                id: id.into(),
                name: name.into(),
                input: serde_json::value::RawValue::from_string("{}".into()).unwrap(),
            }],
        }
    }

    fn tool_result(id: &str) -> Message {
        Message {
            role: Role::User,
            content: vec![Block::ToolResult {
                tool_use_id: id.into(),
                content: "ok".into(),
                is_error: false,
            }],
        }
    }

    fn thinking(text: &str) -> Message {
        Message {
            role: Role::Assistant,
            content: vec![Block::Thinking {
                text: text.into(),
                signature: Some("sig".into()),
            }],
        }
    }

    /// 一段典型历史：用户提问 → 调工具 → 拿结果 → 回答。
    fn realistic_history() -> Vec<Message> {
        vec![
            user("帮我看看 a.txt"),
            assistant_calls("t1", "read_file"),
            tool_result("t1"),
            assistant("a.txt 里写的是 hello"),
        ]
    }

    #[test]
    fn a_tool_use_and_its_result_are_one_atom() {
        let a = atoms(&realistic_history());
        assert_eq!(a.len(), 3, "四条消息应当是三个原子块");
        assert_eq!(a[1].messages.len(), 2, "调用和它的结果要在一个块里");
    }

    #[test]
    fn a_window_can_never_land_between_a_call_and_its_result() {
        // ⚠️ **这是这个文件存在的原因。**
        //
        // 历史有 3 个原子块。不管留几个，切完的那个历史都必须是自洽的 ——
        // 具体说：**不能出现没有配对的 tool_use 或 tool_result**。
        // 如果窗口按「消息条数」切，留 3 条就会正好切在调用和结果之间 → 请求 400。
        let history = realistic_history();

        for keep in 1..=5 {
            let picked = assemble(ContextStrategy::Rolling { keep_last_atoms: keep }, &history)
                .expect("滚动是实现了的");
            let cleaned = sanitize(picked);

            let called: Vec<&str> = cleaned
                .iter()
                .flat_map(|m| m.content.iter())
                .filter_map(|b| match b {
                    Block::ToolUse { id, .. } => Some(id.as_str()),
                    _ => None,
                })
                .collect();
            let answered: Vec<&str> = cleaned
                .iter()
                .flat_map(|m| m.content.iter())
                .filter_map(|b| match b {
                    Block::ToolResult { tool_use_id, .. } => Some(tool_use_id.as_str()),
                    _ => None,
                })
                .collect();

            assert_eq!(
                called, answered,
                "留 {keep} 个原子块时出现了配不上对的一对：调用 {called:?}、结果 {answered:?}"
            );
            if let Some(first) = cleaned.first() {
                assert_eq!(first.role, Role::User, "留 {keep} 个原子块时首条不是 user");
            }
        }
    }

    #[test]
    fn rolling_keeps_the_task_plus_the_tail() {
        // 历史：[用户提问] [调用+结果] [回答]，留最近 2 个原子块。
        //
        // 结果是 **4 条**而不是 3 条 —— 因为「任务原文」那个原子块被钉在最前面了
        // （它本来在窗口之外）。这正是滚动的语义：**任务 + 最近 N 轮**。
        let picked = assemble(
            ContextStrategy::Rolling {
                keep_last_atoms: 2,
            },
            &realistic_history(),
        )
        .unwrap();

        assert_eq!(picked.len(), 4);
        assert_eq!(picked[0].role, Role::User);
        assert_eq!(picked[0].text(), "帮我看看 a.txt", "任务原文必须留着");
        assert!(picked[1].has_tool_use(), "窗口从第二个原子块接上");
    }

    #[test]
    fn an_agent_loop_never_loses_its_task_statement() {
        // ⚠️ 一个 agent 循环从头到尾**只有一条用户消息**（任务原文），
        // 后面全是「调用→结果」重复很多轮。真按"最近 N 轮"砍，等于把任务砍掉 ——
        // 模型就不知道自己为什么要做这些事了。
        let mut history = vec![user("把 src 下所有 TODO 找出来")];
        for i in 0..12 {
            history.push(assistant_calls(&format!("t{i}"), "search"));
            history.push(tool_result(&format!("t{i}")));
        }

        let picked = assemble(
            ContextStrategy::Rolling {
                keep_last_atoms: 4,
            },
            &history,
        )
        .unwrap();

        assert_eq!(picked[0].role, Role::User);
        assert_eq!(picked[0].text(), "把 src 下所有 TODO 找出来");
        assert!(
            picked.len() < history.len(),
            "该砍的还是要砍（窗口确实起了作用）"
        );
    }

    #[test]
    fn rolling_never_returns_an_empty_window() {
        // 留 0 条在界面上是说得通的（"别带历史"），但一个消息都不发也是 400。
        // 所以下限是 1 个原子块。
        let picked = assemble(
            ContextStrategy::Rolling {
                keep_last_atoms: 0,
            },
            &realistic_history(),
        )
        .unwrap();
        assert!(!picked.is_empty());
    }

    #[test]
    fn full_keeps_everything() {
        let picked = assemble(ContextStrategy::Full, &realistic_history()).unwrap();
        assert_eq!(picked.len(), 4);
    }

    #[test]
    fn unimplemented_strategies_say_so_instead_of_falling_back() {
        // ⚠️ 静默退回全量 = 用户以为在用检索、实际在烧全量，两边都看不出来。
        for s in [
            ContextStrategy::Summarize { keep_recent: 3 },
            ContextStrategy::Retrieve { top_k: 5 },
        ] {
            let err = assemble(s, &realistic_history()).unwrap_err();
            let text = err.to_string();
            assert!(text.contains("还没做"), "错误要说人话：{text}");
        }
    }

    #[test]
    fn a_history_starting_with_assistant_gets_trimmed_to_user() {
        let history = vec![assistant("我先说一句"), user("然后你说"), assistant("好")];
        let picked = assemble(ContextStrategy::Full, &history).unwrap();
        assert_eq!(picked.first().unwrap().role, Role::User);
        assert_eq!(picked.len(), 2);
    }

    #[test]
    fn thinking_is_stripped_but_text_survives() {
        // 改写过历史之后旧 thinking 块会 400 —— 所以组装时一律剥掉。
        let history = vec![
            user("你好"),
            Message {
                role: Role::Assistant,
                content: vec![
                    Block::Thinking {
                        text: "内心戏".into(),
                        signature: Some("s".into()),
                    },
                    Block::Text { text: "你好呀".into() },
                ],
            },
        ];
        let cleaned = sanitize(assemble(ContextStrategy::Full, &history).unwrap());
        assert_eq!(cleaned.len(), 2);
        assert_eq!(cleaned[1].content.len(), 1);
        assert!(matches!(cleaned[1].content[0], Block::Text { .. }));
    }

    #[test]
    fn a_message_that_was_only_thinking_disappears_entirely() {
        // 净化完 content 是空的消息发出去也是 400 —— 整条丢掉。
        let history = vec![user("你好"), thinking("只想不说")];
        let cleaned = sanitize(assemble(ContextStrategy::Full, &history).unwrap());
        assert_eq!(cleaned.len(), 1, "空 content 的消息必须整条消失");
    }

    #[test]
    fn orphan_tool_results_are_dropped_in_both_directions() {
        // 孤儿 tool_result（没有调用）和孤儿 tool_use（没人回答）都会 400。
        let history = vec![
            user("开始"),
            tool_result("never-called"), // 孤儿结果
            assistant_calls("t9", "read_file"), // 孤儿调用
        ];
        let cleaned = sanitize(assemble(ContextStrategy::Full, &history).unwrap());
        let blocks: Vec<&Block> = cleaned.iter().flat_map(|m| m.content.iter()).collect();
        assert!(
            blocks.iter().all(|b| matches!(b, Block::Text { .. })),
            "两个方向的孤儿都该被丢掉，剩下：{blocks:?}"
        );
    }

    #[test]
    fn a_user_prompt_that_follows_a_reply_is_its_own_atom() {
        // 「user 消息」有两种：真人打的字，和工具结果。
        // 后者并进上一个原子块，前者必须自成一块 —— 别混。
        let history = vec![assistant("答"), user("再问一个")];
        let a = atoms(&history);
        assert_eq!(a.len(), 2);
    }
}
