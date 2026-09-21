//! 驱动层：把前面那些纯逻辑接到 IO 上，跑完一个任务。
//!
//! 这个文件里**没有分支判断** —— 「拿到一轮结果该干什么」全在
//! [`crate::loop_runner::next_action`] 里。这里只负责按那个决定去调
//! 网络 / 工具 / 审批，然后**把结果按协议拼回去**。
//!
//! # 为什么这么切
//!
//! 循环里最容易写错的东西（截断的工具不能执行、拒绝的那轮一个都不能跑、
//! 参数拼不出来要整轮丢掉）全是"决定"，那些在纯函数里可以穷举测试。
//! 留在这一层的是"搬运"，搬运错了基本上是编译不过或者一眼能看出来的那种。
//!
//! # 三个 IO 口子都是 trait
//!
//! * [`Provider`] —— 模型
//! * [`ToolRunner`] —— 工具（准备 + 执行）
//! * [`ApproveGate`] —— 审批
//!
//! 三个都抽出来是为了**这一个文件能用假实现跑完整条链路**：
//! 不需要网络、不需要 API key、不需要 Tauri。里程碑就是它。

use std::time::Duration;

use tokio::sync::mpsc;

use crate::approval::{ApprovalRequest, Cancel, Decision};
use crate::context::{ContextStrategy, assemble, sanitize};
use crate::loop_runner::{AbortReason, Action, Limits, LoopState, ToolMode, check_limits, next_action, signature_of};
use crate::message::{Block, Message, Role, StopReason, Usage};
use crate::tool::{InvalidInput, PreparedCall, ToolSpec};
use crate::turn::{ToolCall, Turn};

/// 给模型的一次请求。
#[derive(Debug, Clone, PartialEq)]
pub struct ProviderRequest {
    /// system 提示（**不在 messages 里**，见 `message::Role` 的文档）。
    pub system: String,
    /// 这一轮的历史。
    pub messages: Vec<Message>,
    /// 可用的工具。
    pub tools: Vec<ToolSpec>,
    /// 输出上限。
    pub max_tokens: u32,
}

/// 模型侧出错。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderError {
    /// 给用户看的一句话（中文）。
    pub message: String,
    /// 值不值得重发。
    ///
    /// 限流、超时、连接断 —— 值得；401 / 400 —— 不值得（重发一百次也一样）。
    pub retryable: bool,
}

/// 模型。
pub trait Provider: Send + Sync {
    /// 跑一轮。流式的增量通过 [`RunSpec::events`] 边收边报。
    fn stream(
        &self,
        request: ProviderRequest,
        events: EventSink,
    ) -> impl std::future::Future<Output = Result<Turn, ProviderError>> + Send;
}

/// 一次工具执行的结果（给模型看的那部分）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolOutcome {
    /// 给模型看的文本。
    pub content: String,
    /// 失败了就置真 —— **失败的结果也要回传，不能丢**。
    pub is_error: bool,
}

/// 工具。
pub trait ToolRunner: Send + Sync {
    /// 把模型给的调用变成一个**准备好执行**的调用。
    ///
    /// 这里做三件事：按 schema 校验参数、经 `Workspace` 解析路径（唯一的安全闸门）、
    /// 算出给人看的文案。失败就是 [`InvalidInput`]，会被包成一条 `is_error` 回给模型。
    fn prepare(&self, call: &ToolCall) -> Result<PreparedCall, InvalidInput>;

    /// 真的执行。参数是**上面准备好的那个** —— 不许执行时再解析一遍
    /// （那等于给「用户批准的」和「实际执行的」不是一个东西留门）。
    fn execute(
        &self,
        call: &PreparedCall,
    ) -> impl std::future::Future<Output = ToolOutcome> + Send;
}

/// 审批的结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalOutcome {
    /// 不用问（只读，或者本会话已经批准过这一类）。
    NotNeeded,
    /// 用户允许了。
    Allowed,
    /// 用户拒绝了 —— 回一条 `is_error`，循环**继续**。
    Denied,
    /// 被取消了 —— **整个 run 结束**（不是当拒绝）。
    Cancelled,
}

/// 审批口子（第三个 trait）。
///
/// 真实现包装 [`crate::approval::Gate`]；测试里塞一个按剧本回答的假实现。
pub trait ApproveGate: Send + Sync {
    /// 问一次。
    fn approve(
        &self,
        request: ApprovalRequest,
        cancel: &Cancel,
    ) -> impl std::future::Future<Output = ApprovalOutcome> + Send;
}

/// 往前端发事件的出口（有界通道，照仓库一贯的做法）。
#[derive(Debug, Clone)]
pub struct EventSink {
    tx: mpsc::Sender<RunEvent>,
}

impl EventSink {
    /// 新建（返回出口，接收端留给命令层转成 `Channel`）。
    pub fn new(capacity: usize) -> (EventSink, mpsc::Receiver<RunEvent>) {
        let (tx, rx) = mpsc::channel(capacity);
        (EventSink { tx }, rx)
    }

    /// 发一条。**发不出去就丢掉**（前端没了 / 卡住了），绝不在这里阻塞 ——
    /// 事件是"告知"，不该让循环为了它停下来。
    pub fn send(&self, event: RunEvent) {
        let _ = self.tx.try_send(event);
    }
}

/// 循环往上报的事件。
#[derive(Debug, Clone, PartialEq)]
pub enum RunEvent {
    /// 第几圈开始了。
    Iteration {
        /// 从 1 开始。
        n: usize,
    },
    /// 模型吐了一小段正文。
    TextDelta {
        /// 这一片。
        text: String,
    },
    /// 模型吐了一小段思考。
    ThinkingDelta {
        /// 这一片。
        text: String,
    },
    /// 模型请求了一个工具。
    ToolRequested {
        /// 工具名。
        name: String,
        /// 给人看的那一行。
        display: String,
    },
    /// **在等你确认。**
    ///
    /// ⚠️ 这个事件是前端角标亮起来的依据（`Module.badge` 的注释原话就是
    /// 「用户在别的模块里，而 agent 在等他」）。默认**不超时**，所以这条必须
    /// 一直留在界面上，直到用户回答或取消。
    ApprovalNeeded {
        /// 键（回答的时候要带回来）。
        key: crate::approval::ApprovalKey,
        /// 工具名。
        tool: String,
        /// 给人看的那一行。
        display: String,
    },
    /// 审批有结果了。
    ApprovalDecided {
        /// 键。
        key: crate::approval::ApprovalKey,
        /// 结果。
        decision: ApprovalOutcome,
    },
    /// 一个工具跑完了。
    ToolFinished {
        /// 工具名。
        name: String,
        /// 成没成。
        is_error: bool,
        /// 结果（可能被截断，见工具层）。
        content: String,
    },
    /// 这一轮结束了。
    TurnFinished {
        /// 为什么停的。
        stop_reason: StopReason,
        /// 这一轮的用量。
        usage: Usage,
    },
    /// 流断了，正在重发。
    Retrying {
        /// 第几次。
        attempt: usize,
        /// 为什么。
        reason: String,
    },
}

/// 一次 run 要什么。
#[derive(Debug, Clone)]
pub struct RunSpec {
    /// 这一次 run 的编号（审批键里要带，防串台）。
    pub run_id: u64,
    /// system 提示。
    pub system: String,
    /// 用户的输入（对 `for` 循环来说，就是这一个任务）。
    pub prompt: String,
    /// 上下文策略。
    pub strategy: ContextStrategy,
    /// 可用的工具。
    pub tools: Vec<ToolSpec>,
    /// 硬上限。
    pub limits: Limits,
    /// 每轮输出上限。
    pub max_tokens: u32,
    /// 审批等多久算拒绝。
    ///
    /// ⚠️ **默认是 `None`（永远等下去）**，这是刻意的产品决定：
    /// 这个应用已有的设计就是「agent 可以一直等你」（agents 那边有专门的
    /// 「需要你」状态 + 角标）。十步任务里弹十次、次次自动拒，比等着更烦人。
    /// 挂起状态在界面上必须显眼，并且随时可取消 —— 那就够了。
    pub approval_timeout: Option<Duration>,
}

/// 一次 run 的结局。
#[derive(Debug, Clone, PartialEq)]
pub enum RunStatus {
    /// 正常结束。
    Completed {
        /// 为什么停的。
        reason: StopReason,
    },
    /// 被中止（预算 / 迭代 / 卡住 / 拒绝）。
    Aborted {
        /// 原因。
        reason: AbortReason,
    },
    /// 用户取消。
    Cancelled,
    /// 出错了（不可重试的那种）。
    Failed {
        /// 给用户看的一句话。
        message: String,
    },
}

/// 一次 run 的结果。
#[derive(Debug, Clone)]
pub struct RunOutcome {
    /// 结局。
    pub status: RunStatus,
    /// 跑完之后的完整历史（会被落盘）。
    pub history: Vec<Message>,
    /// 累计用量。
    pub usage: Usage,
    /// 迭代了几圈。
    pub iterations: usize,
}

/// 跑一个任务。**这是整个内核的入口。**
pub async fn run<P, T, A>(
    provider: &P,
    tools: &T,
    approver: &A,
    cancel: &Cancel,
    spec: RunSpec,
    events: EventSink,
) -> RunOutcome
where
    P: Provider,
    T: ToolRunner,
    A: ApproveGate,
{
    let mut history: Vec<Message> = vec![Message::user_text(&spec.prompt)];
    let mut state = LoopState::default();

    loop {
        // 取消和上限**先于**任何 IO 检查：预算超了就不要再发请求了。
        if cancel.is_cancelled() {
            return finish(RunStatus::Cancelled, history, state);
        }
        if let Some(reason) = check_limits(&state, &spec.limits) {
            return finish(RunStatus::Aborted { reason }, history, state);
        }

        let messages = match assemble(spec.strategy, &history) {
            Ok(m) => sanitize(m),
            Err(e) => {
                return finish(
                    RunStatus::Failed {
                        message: e.to_string(),
                    },
                    history,
                    state,
                );
            }
        };

        events.send(RunEvent::Iteration {
            n: state.iteration + 1,
        });

        let request = ProviderRequest {
            system: spec.system.clone(),
            messages,
            tools: spec.tools.clone(),
            max_tokens: spec.max_tokens,
        };

        let turn = match provider.stream(request, events.clone()).await {
            Ok(t) => {
                state.retries = 0;
                t
            }
            Err(e) => {
                // ⚠️ **流断了的这一轮，半截绝不能追加进历史** ——
                // 那会造出没有配对 `tool_result` 的 `tool_use`，下一轮请求直接 400。
                // 这里什么都没 push，正是那个保证。
                if e.retryable {
                    if state.retries < spec.limits.max_retries {
                        state.retries += 1;
                        events.send(RunEvent::Retrying {
                            attempt: state.retries,
                            reason: e.message.clone(),
                        });
                        continue;
                    }
                    // 重发次数用完了 —— 这是**一个 run 级的结局**，不是一条 API 错误。
                    // 文案要说的是「流一直没接上」，而不是最后那次的原始报错
                    // （用户看第 3 遍同一个网络错误没有意义）。
                    return finish(
                        RunStatus::Aborted {
                            reason: AbortReason::RetriesExhausted {
                                limit: spec.limits.max_retries,
                            },
                        },
                        history,
                        state,
                    );
                }
                // 不可重试（401 / 400 之类）：把原始报错给用户 —— 那个是有用的信息。
                return finish(RunStatus::Failed { message: e.message }, history, state);
            }
        };

        state.iteration += 1;
        state.usage.add(&turn.usage);
        events.send(RunEvent::TurnFinished {
            stop_reason: turn.stop_reason.clone(),
            usage: turn.usage,
        });

        let action = next_action(&turn);

        // ⚠️ **只有会被追加的分支才追加。** `Action::Retry`（参数拼不出合法 JSON、
        // 认不出的停止原因、说调工具却没给调用）走的是「丢掉这一轮重发」，
        // 追加进去就是把一个畸形的 assistant 消息塞进历史。
        if matches!(action, Action::Retry { .. }) {
            if let Action::Retry { reason } = action {
                if state.retries >= spec.limits.max_retries {
                    return finish(
                        RunStatus::Aborted {
                            reason: AbortReason::RetriesExhausted {
                                limit: spec.limits.max_retries,
                            },
                        },
                        history,
                        state,
                    );
                }
                state.retries += 1;
                events.send(RunEvent::Retrying {
                    attempt: state.retries,
                    reason,
                });
                continue;
            }
        }

        // 追加这一轮（完整的 content，含未知块）。
        if !turn.blocks.is_empty() {
            history.push(Message {
                role: Role::Assistant,
                content: turn.blocks.clone(),
            });
        }

        match action {
            Action::Continue => continue,

            Action::Finish { reason } => {
                return finish(RunStatus::Completed { reason }, history, state);
            }

            Action::Abort(reason) => {
                return finish(RunStatus::Aborted { reason }, history, state);
            }

            Action::Retry { .. } => unreachable!("上面已经处理掉了"),

            Action::Tools { calls, mode } => {
                let results = run_tools(tools, approver, cancel, &spec, &events, &calls, &mode)
                    .await;

                // 取消是在工具执行到一半时发生的 —— 按取消处理，
                // **不追加**那半批结果（它们对应的调用还没全跑完）。
                if results.is_cancelled {
                    return finish(RunStatus::Cancelled, history, state);
                }

                // 记签名（卡住检测用）。
                for c in &calls {
                    state.call_signatures.push(signature_of(c));
                }

                // ⚠️ **一轮的全部结果放在同一条 user 消息里。**
                // 拆成多条会静默地训练模型不再并行调用工具 —— 不报错，只是慢慢退化。
                history.push(Message {
                    role: Role::User,
                    content: results.blocks,
                });
            }
        }
    }
}

fn finish(status: RunStatus, history: Vec<Message>, state: LoopState) -> RunOutcome {
    RunOutcome {
        status,
        history,
        usage: state.usage,
        iterations: state.iteration,
    }
}

struct ToolRunResult {
    blocks: Vec<Block>,
    is_cancelled: bool,
}

/// 跑一轮工具调用。
async fn run_tools<T, A>(
    tools: &T,
    approver: &A,
    cancel: &Cancel,
    spec: &RunSpec,
    events: &EventSink,
    calls: &[ToolCall],
    mode: &ToolMode,
) -> ToolRunResult
where
    T: ToolRunner,
    A: ApproveGate,
{
    let mut blocks = Vec::new();

    for call in calls {
        // 截断的那一轮：**一个都不执行**，每个都回一条错误。
        if let ToolMode::RefuseWithError { message } = mode {
            blocks.push(Block::ToolResult {
                tool_use_id: call.id.clone(),
                content: message.clone(),
                is_error: true,
            });
            continue;
        }

        // ① 准备：校验参数 + 解析路径（唯一的安全闸门）+ 算展示文案。
        let prepared = match tools.prepare(call) {
            Ok(p) => p,
            Err(InvalidInput { reason }) => {
                // 参数不合法 → 回一条错误让模型自己改（**不是**执行失败）。
                // 这一轮还是照常追加进历史了，所以它配得上对。
                blocks.push(Block::ToolResult {
                    tool_use_id: call.id.clone(),
                    content: reason,
                    is_error: true,
                });
                continue;
            }
        };

        events.send(RunEvent::ToolRequested {
            name: prepared.name.clone(),
            display: prepared.display.clone(),
        });

        // ② 审批（只对写 / 执行类）。
        let decision = if prepared.side_effect.needs_approval() {
            let req = ApprovalRequest {
                key: crate::approval::ApprovalKey {
                    run: spec.run_id,
                    call: call.id.clone(),
                },
                tool: prepared.name.clone(),
                display: prepared.display.clone(),
                grant: prepared.grant.clone().unwrap_or_else(|| crate::tool::GrantKey {
                    tool: prepared.name.clone(),
                    target: prepared.display.clone(),
                }),
            };
            events.send(RunEvent::ApprovalNeeded {
                key: req.key.clone(),
                tool: req.tool.clone(),
                display: req.display.clone(),
            });
            let outcome = approver.approve(req.clone(), cancel).await;
            events.send(RunEvent::ApprovalDecided {
                key: req.key,
                decision: outcome,
            });
            outcome
        } else {
            ApprovalOutcome::NotNeeded
        };

        match decision {
            ApprovalOutcome::Cancelled => {
                return ToolRunResult {
                    blocks,
                    is_cancelled: true,
                };
            }
            ApprovalOutcome::Denied => {
                blocks.push(Block::ToolResult {
                    tool_use_id: call.id.clone(),
                    content: "用户拒绝了这次操作。可以换个做法，或者先问问他想要什么。"
                        .to_string(),
                    is_error: true,
                });
                continue;
            }
            ApprovalOutcome::NotNeeded | ApprovalOutcome::Allowed => {}
        }

        // ③ 执行。注意传的是**准备好的那个**，不是模型的原始参数。
        let outcome = tools.execute(&prepared).await;
        events.send(RunEvent::ToolFinished {
            name: prepared.name.clone(),
            is_error: outcome.is_error,
            content: outcome.content.clone(),
        });
        blocks.push(Block::ToolResult {
            tool_use_id: call.id.clone(),
            content: outcome.content,
            is_error: outcome.is_error,
        });
    }

    ToolRunResult {
        blocks,
        is_cancelled: false,
    }
}

/// 让 `Decision` 直接当 [`ApprovalOutcome`] 用（真实现的便利）。
impl From<Decision> for ApprovalOutcome {
    fn from(d: Decision) -> Self {
        match d {
            Decision::Allow | Decision::AllowSession => ApprovalOutcome::Allowed,
            Decision::Deny => ApprovalOutcome::Denied,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tool::{GrantKey, SideEffect};
    use serde_json::value::RawValue;
    use std::sync::Mutex as StdMutex;

    // ---------------------------------------------------------------- 假实现

    /// 按剧本回答的模型：每次 `stream` 弹一个 `Turn`。
    struct ScriptedProvider {
        queued: StdMutex<Vec<Result<Turn, ProviderError>>>,
    }

    impl ScriptedProvider {
        fn new(turns: Vec<Turn>) -> Self {
            ScriptedProvider {
                queued: StdMutex::new(turns.into_iter().map(Ok).collect()),
            }
        }
        fn with_errors(items: Vec<Result<Turn, ProviderError>>) -> Self {
            ScriptedProvider {
                queued: StdMutex::new(items),
            }
        }
    }

    impl Provider for ScriptedProvider {
        async fn stream(
            &self,
            _request: ProviderRequest,
            _events: EventSink,
        ) -> Result<Turn, ProviderError> {
            let mut q = self.queued.lock().unwrap();
            if q.is_empty() {
                return Err(ProviderError {
                    message: "剧本用完了".into(),
                    retryable: false,
                });
            }
            q.remove(0)
        }
    }

    /// 记下收到的工具调用，按预设回答。
    #[derive(Default)]
    struct FakeTools {
        seen: StdMutex<Vec<String>>,
        answer: StdMutex<String>,
    }

    impl ToolRunner for FakeTools {
        fn prepare(&self, call: &ToolCall) -> Result<PreparedCall, InvalidInput> {
            self.seen.lock().unwrap().push(call.name.clone());
            Ok(PreparedCall {
                name: call.name.clone(),
                args: serde_json::from_str(call.args_text()).unwrap_or_default(),
                side_effect: if call.name.starts_with("write") || call.name.starts_with("run") {
                    SideEffect::Write
                } else {
                    SideEffect::Read
                },
                display: format!("{} {}", call.name, call.args_text()),
                grant: Some(GrantKey {
                    tool: call.name.clone(),
                    target: "t".into(),
                }),
            })
        }

        async fn execute(&self, _call: &PreparedCall) -> ToolOutcome {
            ToolOutcome {
                content: self.answer.lock().unwrap().clone(),
                is_error: false,
            }
        }
    }

    /// 按剧本回答的审批。
    struct ScriptedApprover {
        answers: StdMutex<Vec<ApprovalOutcome>>,
    }

    impl ScriptedApprover {
        fn new(answers: Vec<ApprovalOutcome>) -> Self {
            ScriptedApprover {
                answers: StdMutex::new(answers),
            }
        }
    }

    impl ApproveGate for ScriptedApprover {
        async fn approve(
            &self,
            _request: ApprovalRequest,
            _cancel: &Cancel,
        ) -> ApprovalOutcome {
            let mut a = self.answers.lock().unwrap();
            if a.is_empty() {
                ApprovalOutcome::NotNeeded
            } else {
                a.remove(0)
            }
        }
    }

    // ---------------------------------------------------------------- 剧本素材

    fn text_turn(t: &str, stop: StopReason) -> Turn {
        Turn {
            blocks: vec![Block::Text { text: t.into() }],
            tool_calls: vec![],
            stop_reason: stop,
            usage: Usage {
                uncached_input: 100,
                output: 20,
                ..Default::default()
            },
        }
    }

    fn tool_turn(id: &str, name: &str, args: &str) -> Turn {
        let raw = RawValue::from_string(args.to_owned()).unwrap();
        Turn {
            blocks: vec![Block::ToolUse {
                id: id.into(),
                name: name.into(),
                input: raw.clone(),
            }],
            tool_calls: vec![ToolCall {
                id: id.into(),
                name: name.into(),
                args: crate::turn::ArgsState::Ok(raw),
            }],
            stop_reason: StopReason::ToolUse,
            usage: Usage {
                uncached_input: 100,
                output: 20,
                ..Default::default()
            },
        }
    }

    fn spec() -> RunSpec {
        RunSpec {
            run_id: 1,
            system: "你是助手".into(),
            prompt: "看看 a.txt".into(),
            strategy: ContextStrategy::Full,
            tools: vec![],
            limits: Limits::default(),
            max_tokens: 4096,
            approval_timeout: None,
        }
    }

    // ---------------------------------------------------------------- 测试

    #[tokio::test]
    async fn a_plain_conversation_finishes() {
        let provider = ScriptedProvider::new(vec![text_turn("说完了", StopReason::EndTurn)]);
        let tools = FakeTools::default();
        let approver = ScriptedApprover::new(vec![]);
        let (_sw, cancel) = crate::approval::cancel_pair();
        let (sink, _rx) = EventSink::new(64);

        let out = run(&provider, &tools, &approver, &cancel, spec(), sink).await;

        assert_eq!(
            out.status,
            RunStatus::Completed {
                reason: StopReason::EndTurn
            }
        );
        assert_eq!(out.iterations, 1);
        // 历史：用户那句 + 模型那句
        assert_eq!(out.history.len(), 2);
    }

    #[tokio::test]
    async fn a_tool_round_trip_puts_every_result_in_one_message() {
        // ⚠️ 一轮里的全部结果必须在**同一条 user 消息**里。拆开的话不报错，
        // 只是模型会慢慢不再并行调用工具。
        let provider = ScriptedProvider::new(vec![
            Turn {
                // 块的顺序就是模型给的顺序，两个调用各一块。
                blocks: vec![
                    Block::ToolUse {
                        id: "t1".into(),
                        name: "read_file".into(),
                        input: RawValue::from_string("{}".into()).unwrap(),
                    },
                    Block::ToolUse {
                        id: "t2".into(),
                        name: "read_file".into(),
                        input: RawValue::from_string("{}".into()).unwrap(),
                    },
                ],
                tool_calls: vec![
                    mk_call("t1", "read_file", "{}"),
                    mk_call("t2", "read_file", "{}"),
                ],
                stop_reason: StopReason::ToolUse,
                usage: Usage::default(),
            },
            text_turn("看完了", StopReason::EndTurn),
        ]);
        let tools = FakeTools::default();
        *tools.answer.lock().unwrap() = "内容".into();
        let approver = ScriptedApprover::new(vec![]);
        let (_sw, cancel) = crate::approval::cancel_pair();
        let (sink, _rx) = EventSink::new(64);

        let out = run(&provider, &tools, &approver, &cancel, spec(), sink).await;

        assert!(matches!(out.status, RunStatus::Completed { .. }));
        // 历史：user / assistant(2 个调用) / user(2 个结果) / assistant
        assert_eq!(out.history.len(), 4);
        let results = &out.history[2];
        assert_eq!(results.role, Role::User);
        assert_eq!(results.content.len(), 2, "两个结果必须在同一条消息里");
        assert!(results.content.iter().all(|b| matches!(b, Block::ToolResult { .. })));
    }

    #[tokio::test]
    async fn a_denied_tool_becomes_an_error_result_and_the_loop_continues() {
        // 拒绝 ≠ 停止：循环继续，模型会换个做法。
        let provider = ScriptedProvider::new(vec![
            tool_turn("t1", "write_file", r#"{"path":"a"}"#),
            text_turn("那我就不写了", StopReason::EndTurn),
        ]);
        let tools = FakeTools::default();
        let approver = ScriptedApprover::new(vec![ApprovalOutcome::Denied]);
        let (_sw, cancel) = crate::approval::cancel_pair();
        let (sink, _rx) = EventSink::new(64);

        let out = run(&provider, &tools, &approver, &cancel, spec(), sink).await;

        assert!(matches!(out.status, RunStatus::Completed { .. }));
        match &out.history[2].content[0] {
            Block::ToolResult {
                content, is_error, ..
            } => {
                assert!(is_error, "拒绝要以 is_error 回给模型");
                assert!(content.contains("拒绝"));
            }
            other => panic!("{other:?}"),
        }
        // 而且**没有真的执行**（执行过的话 seen 里会有 write_file 之外的记录 ——
        // 这里 prepare 被调过，但 execute 不该被调）
        assert_eq!(tools.seen.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_cancelled_approval_ends_the_whole_run() {
        // ⚠️ 取消是**整个 run 结束**，不是「拒绝这一次然后继续」。
        // 混起来的话，用户点了停止、模型换个法子继续烧钱。
        let provider = ScriptedProvider::new(vec![tool_turn("t1", "write_file", "{}")]);
        let tools = FakeTools::default();
        let approver = ScriptedApprover::new(vec![ApprovalOutcome::Cancelled]);
        let (_sw, cancel) = crate::approval::cancel_pair();
        let (sink, _rx) = EventSink::new(64);

        let out = run(&provider, &tools, &approver, &cancel, spec(), sink).await;
        assert_eq!(out.status, RunStatus::Cancelled);
    }

    #[tokio::test]
    async fn a_truncated_tool_call_is_never_executed() {
        // 截断的那一轮：一个都不执行，每个都回一条错误。
        let mut t = tool_turn("t1", "write_file", r#"{"path":"a.txt"}"#);
        t.stop_reason = StopReason::MaxTokens;
        let provider = ScriptedProvider::new(vec![t, text_turn("重来", StopReason::EndTurn)]);
        let tools = FakeTools::default();
        let approver = ScriptedApprover::new(vec![ApprovalOutcome::Allowed]);
        let (_sw, cancel) = crate::approval::cancel_pair();
        let (sink, _rx) = EventSink::new(64);

        let out = run(&provider, &tools, &approver, &cancel, spec(), sink).await;

        assert!(matches!(out.status, RunStatus::Completed { .. }));
        match &out.history[2].content[0] {
            Block::ToolResult { is_error, content, .. } => {
                assert!(is_error);
                assert!(content.contains("截断"));
            }
            other => panic!("{other:?}"),
        }
        // 关键：**根本没走审批，也没执行**
        assert_eq!(tools.seen.lock().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn a_broken_stream_is_retried_without_appending_anything() {
        // ⚠️ 半截的那一轮不能进历史 —— 否则造出孤儿 tool_use，下一轮 400。
        let provider = ScriptedProvider::with_errors(vec![
            Err(ProviderError {
                message: "连接断了".into(),
                retryable: true,
            }),
            Ok(text_turn("接上了", StopReason::EndTurn)),
        ]);
        let tools = FakeTools::default();
        let approver = ScriptedApprover::new(vec![]);
        let (_sw, cancel) = crate::approval::cancel_pair();
        let (sink, _rx) = EventSink::new(64);

        let out = run(&provider, &tools, &approver, &cancel, spec(), sink).await;

        assert!(matches!(out.status, RunStatus::Completed { .. }));
        // 只有「用户那句 + 模型那句」，断掉那轮**一个字都没留下**
        assert_eq!(out.history.len(), 2);
        assert!(matches!(out.history[1].content[0], Block::Text { .. }));
    }

    #[tokio::test]
    async fn a_non_retryable_error_gives_up_immediately() {
        let provider = ScriptedProvider::with_errors(vec![Err(ProviderError {
            message: "API key 不对".into(),
            retryable: false,
        })]);
        let tools = FakeTools::default();
        let approver = ScriptedApprover::new(vec![]);
        let (_sw, cancel) = crate::approval::cancel_pair();
        let (sink, _rx) = EventSink::new(64);

        let out = run(&provider, &tools, &approver, &cancel, spec(), sink).await;
        assert!(matches!(out.status, RunStatus::Failed { .. }));
        assert_eq!(out.iterations, 0);
    }

    #[tokio::test]
    async fn too_many_retries_aborts() {
        let errs: Vec<Result<Turn, ProviderError>> = (0..5)
            .map(|_| {
                Err(ProviderError {
                    message: "又断了".into(),
                    retryable: true,
                })
            })
            .collect();
        let provider = ScriptedProvider::with_errors(errs);
        let tools = FakeTools::default();
        let approver = ScriptedApprover::new(vec![]);
        let (_sw, cancel) = crate::approval::cancel_pair();
        let (sink, _rx) = EventSink::new(64);

        let out = run(&provider, &tools, &approver, &cancel, spec(), sink).await;
        assert!(matches!(
            out.status,
            RunStatus::Aborted {
                reason: AbortReason::RetriesExhausted { .. }
            }
        ));
    }

    #[tokio::test]
    async fn cancelling_before_the_first_request_does_nothing_at_all() {
        let provider = ScriptedProvider::new(vec![text_turn("不该被叫到", StopReason::EndTurn)]);
        let tools = FakeTools::default();
        let approver = ScriptedApprover::new(vec![]);
        let (sw, cancel) = crate::approval::cancel_pair();
        sw.cancel();
        let (sink, _rx) = EventSink::new(64);

        let out = run(&provider, &tools, &approver, &cancel, spec(), sink).await;
        assert_eq!(out.status, RunStatus::Cancelled);
        assert_eq!(out.iterations, 0);
        assert_eq!(out.history.len(), 1, "只有用户那句");
    }

    #[tokio::test]
    async fn the_token_budget_stops_a_runaway_loop() {
        let mut s = spec();
        s.limits.token_budget = 150; // 一轮就用掉 120
        let provider = ScriptedProvider::new(vec![
            tool_turn("t1", "read_file", "{}"),
            tool_turn("t2", "read_file", "{}"),
            tool_turn("t3", "read_file", "{}"),
        ]);
        let tools = FakeTools::default();
        let approver = ScriptedApprover::new(vec![]);
        let (_sw, cancel) = crate::approval::cancel_pair();
        let (sink, _rx) = EventSink::new(64);

        let out = run(&provider, &tools, &approver, &cancel, s, sink).await;
        assert!(matches!(
            out.status,
            RunStatus::Aborted {
                reason: AbortReason::BudgetExhausted { .. }
            }
        ));
    }

    #[tokio::test]
    async fn an_unimplemented_context_strategy_fails_loudly() {
        // 静默退回全量 = 用户以为在用检索、实际在烧全量。所以要**报错**。
        let mut s = spec();
        s.strategy = ContextStrategy::Retrieve { top_k: 5 };
        let provider = ScriptedProvider::new(vec![]);
        let tools = FakeTools::default();
        let approver = ScriptedApprover::new(vec![]);
        let (_sw, cancel) = crate::approval::cancel_pair();
        let (sink, _rx) = EventSink::new(64);

        let out = run(&provider, &tools, &approver, &cancel, s, sink).await;
        match out.status {
            RunStatus::Failed { message } => assert!(message.contains("还没做")),
            other => panic!("应当明确报错：{other:?}"),
        }
    }

    fn mk_call(id: &str, name: &str, args: &str) -> ToolCall {
        ToolCall {
            id: id.into(),
            name: name.into(),
            args: crate::turn::ArgsState::Ok(RawValue::from_string(args.to_owned()).unwrap()),
        }
    }
}
