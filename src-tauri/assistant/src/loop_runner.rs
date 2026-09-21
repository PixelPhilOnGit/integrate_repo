//! ReAct 循环：`for`（任务）× `while`（迭代）。
//!
//! # 这个文件只做决定，不做 IO
//!
//! 「拿到一轮结果之后该干什么」全部在这里，而且是**纯函数**。
//! 网络、磁盘、工具执行、等用户点确认 —— 全在驱动层（`session.rs`）。
//!
//! 这么切是因为这个仓库里最容易写错的东西，恰好都长在"决定"这一侧：
//! 「`max_tokens` 截断了还敢不敢执行那个工具」「拒绝了怎么办」「第 40 轮还在
//! 请求同一个工具要不要拦」。这些都是**输入→输出**，可以在毫秒级的测试里穷举。
//!
//! # 那些"写错了不报错"的规矩，在这里落实
//!
//! | 规矩 | 落在哪 |
//! |---|---|
//! | 撞上 `max_tokens` 时**不能执行**那一轮的工具（参数可能是截断的） | [`Action::Tools`] 的 [`ToolMode`] |
//! | `refusal` 时那一轮工具**一个都不能执行** | [`AbortReason::Refused`] |
//! | `pause_turn` 要「原样追加、重新请求」，不是结束也不是报错 | [`Action::Continue`] |
//! | 参数拼不出合法 JSON → **丢弃整轮、重发** | [`Action::Retry`] |
//! | 同一个工具同一组参数反复调用要熔断 | [`check_limits`] |

use crate::message::{StopReason, Usage};
use crate::turn::{ArgsState, ToolCall, Turn};

/// 一次 run 的硬上限。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Limits {
    /// 单个任务最多迭代几轮（`while` 的上限）。
    pub max_iterations: usize,
    /// 单个任务累计能用多少 token（**总输入 + 输出**，见 `Usage::total_input` 的文档）。
    pub token_budget: u64,
    /// 同一个 `(工具, 参数)` 出现几次就**警告**模型。
    pub warn_repeat_calls: usize,
    /// 出现几次就**中止**这个任务。
    pub max_repeat_calls: usize,
    /// 一轮流断了之后，最多重发几次。
    pub max_retries: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            max_iterations: 40,
            token_budget: 2_000_000,
            warn_repeat_calls: 3,
            max_repeat_calls: 5,
            max_retries: 2,
        }
    }
}

/// 循环跑到哪儿了。
#[derive(Debug, Clone, Default)]
pub struct LoopState {
    /// 已经迭代了几轮。
    pub iteration: usize,
    /// 这个任务累计的用量。
    pub usage: Usage,
    /// 历史上每个工具调用的**签名**（见 [`signature_of`]）。
    ///
    /// 长的不是参数本身，是签名 —— 只为了数"同一个调用重复了几次"。
    pub call_signatures: Vec<String>,
    /// 这个任务已经重发过几次（流断了）。
    pub retries: usize,
}

/// 把 JSON 归一成**键序无关**的规范形式（递归地按键名排序）。
///
/// ⚠️ **不能只靠「解析成 `Value` 再序列化」** —— 我们给 `serde_json` 开了
/// `preserve_order`（那是为了别把 provider 带回来的原始字节弄乱，见 `Cargo.toml`），
/// 于是 `Value` 里的对象**保留插入顺序**：`{"a":1,"b":2}` 解析再序列化**还是**
/// `{"a":1,"b":2}`，归一化等于没做。这个坑很阴 —— 代码看起来完全正确，
/// 只是熔断永远不触发。
fn canonical(v: serde_json::Value) -> serde_json::Value {
    match v {
        serde_json::Value::Object(map) => {
            let mut entries: Vec<(String, serde_json::Value)> = map
                .into_iter()
                .map(|(k, val)| (k, canonical(val)))
                .collect();
            entries.sort_by(|a, b| a.0.cmp(&b.0));
            serde_json::Value::Object(entries.into_iter().collect())
        }
        serde_json::Value::Array(items) => {
            serde_json::Value::Array(items.into_iter().map(canonical).collect())
        }
        other => other,
    }
}

/// 一次工具调用的签名。**用来数重复**（卡住检测）。
///
/// ⚠️ 参数要**归一化之后再比**：模型的 JSON 里键序、空白都可能变，
/// 直接拿原始字符串比会漏掉「其实是同一个调用」—— 熔断就永远不触发，
/// 而它不触发的表现是**安静地一直烧钱**。
pub fn signature_of(call: &ToolCall) -> String {
    let args = match &call.args {
        ArgsState::Ok(raw) => serde_json::from_str::<serde_json::Value>(raw.get())
            .ok()
            .map(canonical)
            .and_then(|v| serde_json::to_string(&v).ok())
            .unwrap_or_else(|| raw.get().to_owned()),
        // 拼不出来的参数：原样拿去比。它们本来就会被判为「要重发」，
        // 签名只是顺便有个值。
        ArgsState::Unparseable(raw) => raw.clone(),
    };
    format!("{}\u{0}{}", call.name, args)
}

/// 循环下一步该干什么。
#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    /// 把这一轮追加进历史，然后**再请求一次**（`pause_turn` 走这条）。
    Continue,
    /// 执行这些工具。
    Tools {
        /// 要执行的调用。
        calls: Vec<ToolCall>,
        /// 怎么处理它们。
        mode: ToolMode,
    },
    /// 这一轮的半截不能用（比如参数被截断了），**丢掉它、重发请求**。
    Retry {
        /// 给用户看的原因。
        reason: String,
    },
    /// 这个任务干完了。
    Finish {
        /// 为什么停的。
        reason: StopReason,
    },
    /// 中止这个任务（安全 / 预算 / 模型卡住了）。
    Abort(AbortReason),
}

/// 执行工具的方式。
#[derive(Debug, Clone, PartialEq)]
pub enum ToolMode {
    /// 正常执行。
    Execute,
    /// **一个都不执行**，全部回一条 `is_error` 的错误结果。
    ///
    /// 用在撞上 `max_tokens` 的时候：模型要调工具、但输出被截断了，
    /// 参数很可能是不完整的。而且**截断后的 JSON 常常仍然能解析成一个
    /// "看着合法"的部分对象** —— 所以「能解析」在这里不是放行理由。
    /// 回一条错误让模型重来，比拿着半截参数去写文件强。
    RefuseWithError {
        /// 给模型看的说明（它会据此重试）。
        message: String,
    },
}

/// 为什么中止。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AbortReason {
    /// 迭代次数到顶了。
    IterationsExhausted {
        /// 上限。
        limit: usize,
    },
    /// token 预算用完了。
    BudgetExhausted {
        /// 已经用掉多少。
        used: u64,
        /// 预算。
        budget: u64,
    },
    /// 模型卡住了：同一个调用反复请求。
    StuckOnRepeatedCall {
        /// 那个调用的签名。
        signature: String,
        /// 重复了几次。
        times: usize,
    },
    /// 模型拒绝了。
    Refused,
    /// 重发次数用完了（流一直断）。
    RetriesExhausted {
        /// 重试上限。
        limit: usize,
    },
}

impl AbortReason {
    /// 给用户看的一句话。
    pub fn message(&self) -> String {
        match self {
            AbortReason::IterationsExhausted { limit } => {
                format!("转了 {limit} 轮还没结束，先停下（可以接着聊，或把任务拆小一点）")
            }
            AbortReason::BudgetExhausted { used, budget } => {
                format!("这个任务的 token 用超了（{used} / {budget}），先停下")
            }
            AbortReason::StuckOnRepeatedCall { signature, times } => {
                format!("模型卡在同一个调用上了（{signature} 请求了 {times} 次），先停下")
            }
            AbortReason::Refused => "模型拒绝了这一轮请求".to_string(),
            AbortReason::RetriesExhausted { limit } => {
                format!("流连续断了 {limit} 次都没接上，先停下")
            }
        }
    }
}

/// 检查硬上限。**先于** [`next_action`] 调用：预算是安全闸门，优先级最高。
///
/// 返回 `None` 表示还能继续。
pub fn check_limits(state: &LoopState, limits: &Limits) -> Option<AbortReason> {
    if state.iteration >= limits.max_iterations {
        return Some(AbortReason::IterationsExhausted {
            limit: limits.max_iterations,
        });
    }

    // ⚠️ 用 `total_input()`（= 未缓存 + 缓存读 + 缓存写）**加** 输出。
    // 只算 `uncached_input` 的话，缓存生效时会低估 5~10 倍 ——
    // 预算永远不触发，账单照涨，而且什么都没报。
    let used = state.usage.total_input() + state.usage.output;
    if used >= limits.token_budget {
        return Some(AbortReason::BudgetExhausted {
            used,
            budget: limits.token_budget,
        });
    }

    // 卡住检测：看最后这几次调用里，有没有同一个签名反复出现。
    //
    // 只数**末尾连续**的若干次，而不是整段历史 —— 因为"同一个工具调用出现多次"
    // 本身可能是正常的（比如对十来个文件各跑一次同一个命令，参数不同就是不同签名；
    // 但同一个文件读两次也说得通）。真正要拦的是**卡住**：它连着一遍遍重复。
    let recent = &state.call_signatures;
    if let Some(last) = recent.last() {
        let times = recent.iter().rev().take_while(|s| *s == last).count();
        if times >= limits.max_repeat_calls {
            return Some(AbortReason::StuckOnRepeatedCall {
                signature: last.clone(),
                times,
            });
        }
    }

    None
}

/// 这一轮的调用是不是已经重复到该警告的程度了。
pub fn should_warn_about_repeat(state: &LoopState, limits: &Limits) -> bool {
    let Some(last) = state.call_signatures.last() else {
        return false;
    };
    let times = state
        .call_signatures
        .iter()
        .rev()
        .take_while(|s| *s == last)
        .count();
    times >= limits.warn_repeat_calls
}

/// **这一轮结果到手之后，下一步干什么。**
///
/// 只按协议规则判断；上限和卡住检测在 [`check_limits`] 里。
pub fn next_action(turn: &Turn) -> Action {
    // 参数拼不出合法 JSON：这一轮的 assistant 消息**根本没法表示**
    // （我们的块用 `RawValue` 存参数，它要求合法 JSON），追加进去下一轮直接 400。
    // 所以整轮丢掉重发 —— 顺序上这必须排在所有其他判断之前。
    if !turn.is_appendable() {
        return Action::Retry {
            reason: "这一轮的工具参数不是合法 JSON（多半是被输出上限截断了）".to_string(),
        };
    }

    match &turn.stop_reason {
        // 要调工具，正常执行。
        StopReason::ToolUse if turn.has_tool_calls() => Action::Tools {
            calls: turn.tool_calls.clone(),
            mode: ToolMode::Execute,
        },

        // ⚠️ 上一行没匹配上就落到这里：说 `tool_use` 却一个调用都没有。
        // 这种自相矛盾的状态**不能当结束**（那会安静地少跑一轮），
        // 也不能当没看见 —— 重发一次。
        StopReason::ToolUse => Action::Retry {
            reason: "模型说要调工具，但一个调用都没给".to_string(),
        },

        // ⚠️ 撞上输出上限、而它正在调工具：**一个都不执行**。
        // 截断后的 JSON 常常仍能解析成"看着合法"的部分对象 ——
        // 「能解析」在这里不是放行理由（拿半截参数去写文件的后果不可逆）。
        StopReason::MaxTokens if turn.has_tool_calls() => Action::Tools {
            calls: turn.tool_calls.clone(),
            mode: ToolMode::RefuseWithError {
                message: "上一轮输出被长度上限截断了，工具参数可能不完整，没有执行。请重新给出完整的调用。"
                    .to_string(),
            },
        },

        // 服务端把这一轮暂停了：把响应原样追加、**重新请求**。
        // 不是结束（会丢掉后半段），也不是报错（这是正常流程）。
        StopReason::PauseTurn => Action::Continue,

        // 正常说完 / 撞长度上限但没在调工具 / 撞停止序列 —— 都算这一轮结束。
        StopReason::EndTurn | StopReason::MaxTokens | StopReason::StopSequence => Action::Finish {
            reason: turn.stop_reason.clone(),
        },

        // 拒绝：这一轮的工具一个都不能执行（拒绝可能把 tool_use 切一半）。
        StopReason::Refusal => Action::Abort(AbortReason::Refused),

        // 认不出来的停止原因（服务端加了新值）：**不能猜**。
        // 当成结束可能少跑一轮，当成继续可能无限循环 —— 两边都比报错糟。
        StopReason::Unknown(raw) => Action::Retry {
            reason: format!("认不出来的停止原因 `{raw}`"),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::message::{Block, Usage};
    use crate::turn::ArgsState;
    use serde_json::value::RawValue;

    fn call(id: &str, name: &str, args: &str) -> ToolCall {
        ToolCall {
            id: id.into(),
            name: name.into(),
            args: ArgsState::Ok(RawValue::from_string(args.to_owned()).unwrap()),
        }
    }

    /// 造一轮。
    ///
    /// ⚠️ **块和调用一起造**：真实的 `Turn` 里两者同源（`TurnAccum` 一起产出），
    /// 少了块的那一轮是"不能追加"的（`is_appendable` 会拦）——
    /// helper 要是偷懒不给块，测试就在测一个线上不存在的形状。
    fn turn(stop: StopReason, calls: Vec<ToolCall>) -> Turn {
        let blocks = calls
            .iter()
            .filter_map(|c| match &c.args {
                ArgsState::Ok(raw) => Some(Block::ToolUse {
                    id: c.id.clone(),
                    name: c.name.clone(),
                    input: raw.clone(),
                }),
                ArgsState::Unparseable(_) => None,
            })
            .collect();
        Turn {
            blocks,
            tool_calls: calls,
            stop_reason: stop,
            usage: Usage::default(),
        }
    }

    #[test]
    fn a_normal_tool_call_runs() {
        let t = turn(StopReason::ToolUse, vec![call("t1", "read_file", "{}")]);
        assert!(matches!(
            next_action(&t),
            Action::Tools {
                mode: ToolMode::Execute,
                ..
            }
        ));
    }

    #[test]
    fn max_tokens_with_a_tool_call_refuses_to_run_it() {
        // ⚠️ 这条是「拿半截参数去写文件」的防线。截断后的 JSON 常常**仍然能解析**，
        // 所以不能靠"解析成功"放行 —— 要看 stop_reason。
        let t = turn(
            StopReason::MaxTokens,
            vec![call("t1", "write_file", r#"{"path":"a.txt"}"#)],
        );
        match next_action(&t) {
            Action::Tools {
                mode: ToolMode::RefuseWithError { message },
                ..
            } => assert!(message.contains("截断")),
            other => panic!("应当拒绝执行：{other:?}"),
        }
    }

    #[test]
    fn max_tokens_without_tools_is_a_normal_finish() {
        let t = turn(StopReason::MaxTokens, vec![]);
        assert!(matches!(next_action(&t), Action::Finish { .. }));
    }

    #[test]
    fn refusal_runs_nothing() {
        // 拒绝可能把 tool_use 切一半，所以那一轮的工具一个都不能碰。
        let t = turn(StopReason::Refusal, vec![call("t1", "run_command", "{}")]);
        assert_eq!(next_action(&t), Action::Abort(AbortReason::Refused));
    }

    #[test]
    fn pause_turn_continues_instead_of_finishing() {
        // 当结束会丢掉后半段；当报错会把正常流程变成红色错误条。
        let t = turn(StopReason::PauseTurn, vec![]);
        assert_eq!(next_action(&t), Action::Continue);
    }

    #[test]
    fn unparseable_args_discard_the_turn() {
        // 块的参数用 RawValue 存，非法 JSON 根本表示不了 —— 追加进去下一轮 400。
        let t = Turn {
            blocks: vec![],
            tool_calls: vec![ToolCall {
                id: "t1".into(),
                name: "write_file".into(),
                args: ArgsState::Unparseable(r#"{"path":"a"#.into()),
            }],
            stop_reason: StopReason::ToolUse,
            usage: Usage::default(),
        };
        assert!(matches!(next_action(&t), Action::Retry { .. }));
    }

    #[test]
    fn tool_use_without_any_call_is_not_treated_as_done() {
        // 自相矛盾的状态：说调工具却没有调用。当成结束 = 安静地少跑一轮。
        let t = turn(StopReason::ToolUse, vec![]);
        assert!(matches!(next_action(&t), Action::Retry { .. }));
    }

    #[test]
    fn an_unknown_stop_reason_is_never_guessed() {
        // 服务端加了新值：当结束可能少跑，当继续可能死循环 —— 都不如报错。
        let t = turn(StopReason::Unknown("brand_new".into()), vec![]);
        match next_action(&t) {
            Action::Retry { reason } => assert!(reason.contains("brand_new")),
            other => panic!("不该猜：{other:?}"),
        }
    }

    #[test]
    fn budget_counts_cached_tokens_too() {
        // ⚠️ 这个测试盯着那个「低估 5~10 倍」的 bug：
        // 缓存命中的输入也是输入，不算进去的话预算永远不触发。
        let mut state = LoopState::default();
        state.usage = Usage {
            uncached_input: 1_000,
            cache_read: 900_000,
            output: 50_000,
            ..Default::default()
        };
        let limits = Limits {
            token_budget: 500_000,
            ..Default::default()
        };
        assert!(matches!(
            check_limits(&state, &limits),
            Some(AbortReason::BudgetExhausted { .. })
        ));
    }

    #[test]
    fn iterations_are_capped() {
        let state = LoopState {
            iteration: 40,
            ..Default::default()
        };
        assert!(matches!(
            check_limits(&state, &Limits::default()),
            Some(AbortReason::IterationsExhausted { .. })
        ));
    }

    #[test]
    fn being_stuck_on_one_call_aborts() {
        let sig = signature_of(&call("t1", "read_file", r#"{"path":"a.txt"}"#));
        let state = LoopState {
            call_signatures: vec![sig.clone(); 5],
            ..Default::default()
        };
        match check_limits(&state, &Limits::default()) {
            Some(AbortReason::StuckOnRepeatedCall { times, .. }) => assert_eq!(times, 5),
            other => panic!("应当判为卡住：{other:?}"),
        }
    }

    #[test]
    fn a_repeated_signature_that_is_not_consecutive_does_not_abort() {
        // 「同一个工具出现多次」本身可能是正常的（对十来个文件各跑一次）。
        // 要拦的是**卡住** —— 连着重复。
        let a = signature_of(&call("t1", "read_file", r#"{"path":"a.txt"}"#));
        let b = signature_of(&call("t2", "read_file", r#"{"path":"b.txt"}"#));
        let mut sigs = vec![a.clone(); 4];
        sigs.push(b);
        sigs.push(a);
        let state = LoopState {
            call_signatures: sigs,
            ..Default::default()
        };
        assert_eq!(check_limits(&state, &Limits::default()), None);
    }

    #[test]
    fn warning_threshold_comes_before_the_abort_threshold() {
        let sig = signature_of(&call("t1", "read_file", "{}"));
        let limits = Limits::default();
        let three = LoopState {
            call_signatures: vec![sig.clone(); 3],
            ..Default::default()
        };
        assert!(should_warn_about_repeat(&three, &limits));
        assert_eq!(check_limits(&three, &limits), None, "3 次只警告，不该中止");
    }

    #[test]
    fn signature_ignores_key_order() {
        // ⚠️ 键序不同的等价 JSON 必须是同一个签名，否则熔断永远不触发。
        let a = signature_of(&call("t1", "read_file", r#"{"path":"a.txt","n":1}"#));
        let b = signature_of(&call("t2", "read_file", r#"{"n":1,"path":"a.txt"}"#));
        assert_eq!(a, b);
    }

    #[test]
    fn the_same_call_to_different_targets_has_different_signatures() {
        let a = signature_of(&call("t1", "read_file", r#"{"path":"a.txt"}"#));
        let b = signature_of(&call("t2", "read_file", r#"{"path":"b.txt"}"#));
        assert_ne!(a, b);
    }

    #[test]
    fn a_finished_turn_keeps_its_blocks_for_replay() {
        // 循环追加历史时用的是 complete blocks（含未知块）——
        // 这个测试只是想说明 `Action::Finish` 不代表"丢掉这一轮"。
        let t = Turn {
            blocks: vec![Block::Text { text: "行".into() }],
            tool_calls: vec![],
            stop_reason: StopReason::EndTurn,
            usage: Usage::default(),
        };
        assert!(!t.blocks.is_empty());
        assert!(matches!(next_action(&t), Action::Finish { .. }));
    }
}
