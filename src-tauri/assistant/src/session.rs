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

use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tokio::sync::mpsc;

use crate::approval::{ApprovalRequest, Cancel, Decision};
use crate::context::{ContextStrategy, assemble, sanitize};
use crate::journal::Journal;
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
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
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
    ///
    /// ⚠️ **`ApprovalNeeded` 这条事件由实现来发，而且必须发在「登记之后」。**
    /// 调用方（`run_tools`）刻意不发它 —— 那个位置在登记**之前**，
    /// 前端有可能抢在登记完成前就回答，那条回答会石沉大海，
    /// 表现是「弹层消失了，但什么也没发生」（见 `approval.rs` 的不变量 1）。
    ///
    /// 真实现把它挂在 `Gate::request` 的 `emit` 回调上，那个回调就是
    /// 为「登记完成之后、不持锁」这件事设计的。
    fn approve(
        &self,
        request: ApprovalRequest,
        cancel: &Cancel,
        events: &EventSink,
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
///
/// ⚠️ `rename_all` 只管**变体名**，变体内部的字段名要 `rename_all_fields` 才管 ——
/// 少写了就是 `invalid args` 那类「两边测试都盖不到」的错（见 HANDOFF 里那条）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
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
        /// 要不要给「本次会话记住」这个选项。
        ///
        /// ⚠️ **前端必须按它决定按钮显不显示。** 给一个点了没用（下次照样问）
        /// 的按钮比不给更糟 —— 用户会以为已经批准过了。
        /// 什么情况下是 `false`，见 [`crate::tool::PreparedCall::needs_approval`]。
        can_remember: bool,
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
    /// 这次 run 结束了。**一定是最后一条事件。**
    ///
    /// ⚠️ 前端靠它收尾：关掉还挂着的审批弹层、把输入框解禁、把「正在跑」
    /// 的指示停掉。少了它，界面只能靠「不再来消息了」去猜 ——
    /// 而「跑完了」和「连接断了」在界面上长得一模一样。
    Finished {
        /// 结局。
        status: RunStatus,
        /// 累计用量。
        usage: Usage,
        /// 一共跑了几轮。
        iterations: usize,
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
    /// 这次 run 之前的历史（**不含** `prompt`）。
    ///
    /// ⚠️ 空 = 一次全新的对话。要做多轮的话，**调用方自己**把上一轮的
    /// `RunOutcome::history` 存起来、下一轮从这里传回来 —— 循环这边不替谁保管它。
    ///
    /// 那是刻意的：历史放在哪儿（内存？落盘？按会话分几份？）是调用方的事，
    /// 而这个 crate 的定位是「给定历史，跑一轮」。它要是自己藏一份，
    /// 就会和 `transcript.rs` 那份落盘的、以及上下文策略要改写的**变成三份**。
    pub history: Vec<Message>,
    /// 上下文策略。
    pub strategy: ContextStrategy,
    /// 可用的工具。
    pub tools: Vec<ToolSpec>,
    /// 硬上限。
    pub limits: Limits,
    /// 每轮输出上限。
    pub max_tokens: u32,
    /// 记账口子（`None` = 这次不记）。
    ///
    /// ⚠️ 放在 `RunSpec` 里而不是给 `run()` 再加一个参数：`run()` 已经有六个了，
    /// 而「记不记、记到哪儿」本来就是**这一次 run 要什么**的一部分 ——
    /// 和 [`RunSpec::run_id`] 是一类东西。
    pub journal: Option<Arc<dyn Journal>>,
}

/// 一次 run 的结局。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
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
    // ⚠️ 历史从 `spec.history` 接上，而不是每次从零开始 —— 不然「对话」
    // 就退化成「每次问一个独立的问题」，模型看不到上一句
    // （症状是「它怎么不记得我刚才说的」）。
    let mut history: Vec<Message> = spec.history.clone();
    history.push(Message::user_text(&spec.prompt));
    let mut state = LoopState::default();

    // 记账。**在发第一个请求之前**就开一条记录：连第一轮都没发出去的那些 run
    // （key 不对、模型名拼错、地址填错）恰恰是最需要留下痕迹的。
    let handle = spec.journal.as_ref().map(|j| j.start(&spec));

    // ⚠️ 收尾包成闭包，而不是在每一处 `return` 前面写一遍：`run()` 有九条出口
    // （完成 / 预算超了 / 迭代超了 / 卡住 / 拒绝 / 取消 / 不可重试的错……），
    // 漏掉一条的后果是那条记录**永远停在「没有结束时间」上** ——
    // 按它算时长要么是无穷大、要么被静默跳过，而且不会有任何报错。
    let finish = |status: RunStatus, history: Vec<Message>, state: LoopState| {
        if let (Some(j), Some(h)) = (spec.journal.as_ref(), handle.as_ref()) {
            j.finish(h, &status);
        }
        // 「跑完了」这条一定要发出去，它是前端的收尾信号。它和别的 `try_send`
        // 不一样的地方在于：**它后面就没有别的消息了**，所以就算这次 `try_send`
        // 撞上队列满，前端也永远等不到收尾 —— 界面会一直停在「正在跑」。
        // 队列打满需要前端在几毫秒里一条都不消费，实践中到不了；真到了，
        // 用 `EventSink` 的容量去兜（命令层给的是 256）。
        events.send(RunEvent::Finished {
            status: status.clone(),
            usage: state.usage,
            iterations: state.iteration,
        });
        RunOutcome {
            status,
            history,
            usage: state.usage,
            iterations: state.iteration,
        }
    };

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

        // 记这一轮。⚠️ **就地写，不攒到收尾**：`[profile.release]` 里是
        // `panic = "abort"`，进程一炸攒着的一个字都留不下（见 `transcript.rs`）。
        // 上面那个 `events.send` 靠不住 —— 它是 `try_send`、满了就丢，
        // 而用量是不能丢的那种数据。
        if let (Some(j), Some(h)) = (spec.journal.as_ref(), handle.as_ref()) {
            j.turn(h, state.iteration, &turn.usage, &turn.stop_reason);
        }

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

/// 带**总超时**地跑一轮（`run()` 之外的入口）。
///
/// ⚠️ 平时**不要**用它。`run()` 里的每一轮都不该有总时长上限 ——
/// 长回答可以流好几分钟，那是正常的；真正该拦的是「一直没有任何新数据」，
/// 那件事由 [`crate::transport::DEFAULT_IDLE_TIMEOUT`] 管（**空闲**超时）。
/// 拿总时长当上限会把慢模型误杀成网络问题。
///
/// 它存在的理由是「测试连接」那类场景：用户点一下按钮，是为了
/// **立刻知道通不通**，等两分钟才给答案就失去意义了。
pub async fn stream_once<P: Provider>(
    provider: &P,
    request: ProviderRequest,
    events: EventSink,
    timeout: Duration,
) -> Result<Turn, ProviderError> {
    match tokio::time::timeout(timeout, provider.stream(request, events)).await {
        Ok(result) => result,
        // ⚠️ 超时的文案在这里拼，不在调用方 —— 调用方拼的话，同一个意思
        // 会在每个用到它的地方各写一遍，然后慢慢走偏。
        Err(_) => Err(ProviderError {
            message: format!(
                "等了 {} 秒还没有响应头。可能是网络慢/被挡了，也可能这个网关就是很慢 —— \
                 直接发一句对话看看。",
                timeout.as_secs()
            ),
            // 不值得自动重发：用户就在屏幕前面等着，再等一轮只是更慢地告诉他同一件事。
            retryable: false,
        }),
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
                // ⚠️ **原样带上去，不要在这里补一个兜底的 key。**
                // `None` 是「这次不给记住选项」（见 `PreparedCall::needs_approval`），
                // 补个假 key 就把它变成「可以记住」了 —— 而那正是
                // `run_command` 跑 shell 解释器时最不该发生的事。
                grant: prepared.grant.clone(),
            };
            // ⚠️ **这里不发 `ApprovalNeeded`**（以前发过，那是个结构性的错）：
            // 这个位置在闸门**登记之前**，前端可能抢在前面回答，而那条回答
            // 落在还没登记的闸门上 —— 石沉大海。发事件是 approver 的事，
            // 它会在登记完成之后发（见 `ApproveGate::approve` 的文档）。
            //
            // 顺带还有一层：`EventSink::send` 是 `try_send`（满了就丢），
            // 审批事件一旦丢掉，`gate.request` 会挂到天荒地老 ——
            // 界面上看到的就是「它卡住了」。
            let outcome = approver.approve(req.clone(), cancel, events).await;
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
    ///
    /// 顺带**把它收到的请求记下来** —— 「模型到底看到了什么」这件事只能从这里
    /// 验：`RunOutcome::history` 只能证明循环手里有什么，证明不了它发了什么。
    struct ScriptedProvider {
        queued: StdMutex<Vec<Result<Turn, ProviderError>>>,
        seen: StdMutex<Vec<ProviderRequest>>,
    }

    impl ScriptedProvider {
        fn new(turns: Vec<Turn>) -> Self {
            ScriptedProvider {
                queued: StdMutex::new(turns.into_iter().map(Ok).collect()),
                seen: StdMutex::new(Vec::new()),
            }
        }
        fn with_errors(items: Vec<Result<Turn, ProviderError>>) -> Self {
            ScriptedProvider {
                queued: StdMutex::new(items),
                seen: StdMutex::new(Vec::new()),
            }
        }
        /// 第 `n` 次请求里模型看到的 messages。
        fn sent_messages(&self, n: usize) -> Vec<Message> {
            self.seen.lock().unwrap()[n].messages.clone()
        }
    }

    impl Provider for ScriptedProvider {
        async fn stream(
            &self,
            request: ProviderRequest,
            _events: EventSink,
        ) -> Result<Turn, ProviderError> {
            self.seen.lock().unwrap().push(request);
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
            _events: &EventSink,
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
            history: vec![],
            strategy: ContextStrategy::Full,
            tools: vec![],
            limits: Limits::default(),
            max_tokens: 4096,
            journal: None,
        }
    }

    /// 记账的假实现：把调用顺序记下来。
    #[derive(Debug, Default)]
    struct FakeJournal {
        log: StdMutex<Vec<String>>,
    }

    impl FakeJournal {
        fn taken(&self) -> Vec<String> {
            self.log.lock().unwrap().clone()
        }
    }

    impl Journal for FakeJournal {
        fn start(&self, _spec: &RunSpec) -> crate::journal::RunHandle {
            self.log.lock().unwrap().push("start".into());
            crate::journal::RunHandle(1)
        }
        fn turn(
            &self,
            _handle: &crate::journal::RunHandle,
            n: usize,
            _usage: &Usage,
            _stop: &StopReason,
        ) {
            self.log.lock().unwrap().push(format!("turn:{n}"));
        }
        fn finish(&self, _handle: &crate::journal::RunHandle, status: &RunStatus) {
            let what = match status {
                RunStatus::Completed { .. } => "completed",
                RunStatus::Aborted { .. } => "aborted",
                RunStatus::Cancelled => "cancelled",
                RunStatus::Failed { .. } => "failed",
            };
            self.log.lock().unwrap().push(format!("finish:{what}"));
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

    #[tokio::test]
    async fn a_stream_that_never_starts_gives_up_with_a_readable_message() {
        // ⚠️ `stream_once` 是给「测试连接」用的：用户点一下按钮是为了**立刻**
        // 知道通不通，不该等两分钟。而且超时**不能**自动重发 —— 用户就在
        // 屏幕前面等着，再等一轮只是更慢地告诉他同一件事。
        struct NeverAnswers;

        impl Provider for NeverAnswers {
            async fn stream(
                &self,
                _request: ProviderRequest,
                _events: EventSink,
            ) -> Result<Turn, ProviderError> {
                // 永远不会就绪 —— 模拟「连上了但对端一个字都不回」。
                std::future::pending::<()>().await;
                unreachable!()
            }
        }

        let (sink, _rx) = EventSink::new(1);
        let request = ProviderRequest {
            system: String::new(),
            messages: vec![Message::user_text("ping")],
            tools: vec![],
            max_tokens: 16,
        };

        let started = std::time::Instant::now();
        let err = stream_once(
            &NeverAnswers,
            request,
            sink,
            Duration::from_millis(50),
        )
        .await
        .expect_err("超时了就该报错，不是一直等");

        assert!(!err.retryable, "超时不该自动重发");
        assert!(err.message.contains("秒"), "文案要说清等了多久：{}", err.message);
        assert!(started.elapsed() < Duration::from_secs(5), "没有真的超时");
    }

    #[tokio::test]
    async fn a_follow_up_actually_sees_what_came_before() {
        // ⚠️ 这条钉的是**「对话」这件事本身**。`run()` 一开始是拿
        // `vec![user_text(prompt)]` 硬起头的 —— 那样每一句都是独立的问题，
        // 模型看不到上一句，症状是「它怎么不记得我刚才说的」。
        //
        // 注意断言的是**模型收到了什么**（`sent_messages`），不只是循环手里
        // 有什么 —— 后者证明不了它发出去了。
        let provider = ScriptedProvider::new(vec![text_turn("接着说", StopReason::EndTurn)]);
        let tools = FakeTools::default();
        let approver = ScriptedApprover::new(vec![]);
        let (_sw, cancel) = crate::approval::cancel_pair();
        let (sink, _rx) = EventSink::new(64);

        let mut s = spec();
        s.prompt = "接着聊".into();
        s.history = vec![
            Message::user_text("第一句"),
            Message {
                role: Role::Assistant,
                content: vec![Block::Text {
                    text: "第一句的回答".into(),
                }],
            },
        ];

        let out = run(&provider, &tools, &approver, &cancel, s, sink).await;
        assert!(matches!(out.status, RunStatus::Completed { .. }));

        let sent = provider.sent_messages(0);
        assert_eq!(sent.len(), 3, "模型该看到：前两句 + 这一句");
        match &sent[0].content[0] {
            Block::Text { text } => assert_eq!(text, "第一句"),
            other => panic!("历史没接上：{other:?}"),
        }
        // 结果里带回的也是完整历史（调用方要靠它接下一轮）
        assert_eq!(out.history.len(), 4);
    }

    #[tokio::test]
    async fn a_first_turn_starts_from_nothing() {
        // 空历史是**默认**的样子：不传就是一次全新的对话，不该凭空多出东西。
        let provider = ScriptedProvider::new(vec![text_turn("好", StopReason::EndTurn)]);
        let tools = FakeTools::default();
        let approver = ScriptedApprover::new(vec![]);
        let (_sw, cancel) = crate::approval::cancel_pair();
        let (sink, _rx) = EventSink::new(64);

        let out = run(&provider, &tools, &approver, &cancel, spec(), sink).await;
        assert_eq!(out.history.len(), 2);
        assert_eq!(provider.sent_messages(0).len(), 1);
    }

    #[tokio::test]
    async fn a_normal_run_is_journalled_from_start_to_finish() {
        let provider = ScriptedProvider::new(vec![
            tool_turn("t1", "read_file", "{}"),
            text_turn("看完了", StopReason::EndTurn),
        ]);
        let tools = FakeTools::default();
        let approver = ScriptedApprover::new(vec![]);
        let (_sw, cancel) = crate::approval::cancel_pair();
        let (sink, _rx) = EventSink::new(64);

        let fake = Arc::new(FakeJournal::default());
        let mut s = spec();
        s.journal = Some(fake.clone() as Arc<dyn Journal>);

        let out = run(&provider, &tools, &approver, &cancel, s, sink).await;
        assert!(matches!(out.status, RunStatus::Completed { .. }));

        assert_eq!(
            fake.taken(),
            ["start", "turn:1", "turn:2", "finish:completed"],
            "每一轮都要记一笔，而且要能看出是哪一轮"
        );
    }

    #[tokio::test]
    async fn a_run_that_never_gets_a_turn_still_gets_its_end_marker() {
        // ⚠️ 这条盯的是「每一处 `return` 都要记一笔」里最容易漏的那种：
        // 一轮都没跑就返回了（开跑前就取消、或者第一轮就是不可重试的错）。
        // 漏了的话那条记录会**永远停在「没有结束时间」上** —— 不报错，
        // 只是很久以后有人问「为什么这些 run 的时长是空的」。
        let provider = ScriptedProvider::new(vec![]);
        let tools = FakeTools::default();
        let approver = ScriptedApprover::new(vec![]);
        let (sw, cancel) = crate::approval::cancel_pair();
        sw.cancel();
        let (sink, _rx) = EventSink::new(64);

        let fake = Arc::new(FakeJournal::default());
        let mut s = spec();
        s.journal = Some(fake.clone() as Arc<dyn Journal>);

        let out = run(&provider, &tools, &approver, &cancel, s, sink).await;
        assert_eq!(out.status, RunStatus::Cancelled);

        assert_eq!(
            fake.taken(),
            ["start", "finish:cancelled"],
            "一次都没跑也要收尾"
        );
    }

    fn mk_call(id: &str, name: &str, args: &str) -> ToolCall {
        ToolCall {
            id: id.into(),
            name: name.into(),
            args: crate::turn::ArgsState::Ok(RawValue::from_string(args.to_owned()).unwrap()),
        }
    }

    // ------------------------------------------------------------ IPC 契约
    //
    // ⚠️ 这一组盯的是**前端和 Rust 之间那条缝**。两端各自的测试都盖不到它：
    // 前端跑的是假实现（不过 serde）、Rust 测试直接构造 Rust 值（不过序列化）。
    // 而这条缝真的出过事 —— `#[serde(rename_all)]` 加在枚举上**只改变体名、
    // 不改变体内部的字段名**，症状是 `invalid args ... missing field`，
    // 两边的测试全绿（见 HANDOFF 里那一整节）。
    //
    // 所以这里**手写前端会读到的字段名**，不要照着结构体拼 ——
    // 照着拼只是把 Rust 的定义抄了一遍，改错了照样绿。

    #[test]
    fn contract_approval_needed_uses_the_names_the_frontend_reads() {
        let e = RunEvent::ApprovalNeeded {
            key: crate::approval::ApprovalKey {
                run: 7,
                call: "toolu_1".into(),
            },
            tool: "write_file".into(),
            display: "写入 src/a.txt".into(),
            can_remember: true,
        };
        let json = serde_json::to_value(&e).unwrap();

        assert_eq!(json["kind"], "approvalNeeded");
        assert_eq!(json["key"]["run"], 7);
        assert_eq!(json["key"]["call"], "toolu_1");
        assert_eq!(json["tool"], "write_file");
        assert_eq!(json["display"], "写入 src/a.txt");
        // ⚠️ 少了 `rename_all_fields` 的话这里就是 `can_remember`，
        // 而前端读的是 `canRemember` —— 那个「记住」按钮会永远不显示。
        assert_eq!(
            json["canRemember"], true,
            "字段名没转成 camelCase：{json}"
        );
    }

    #[test]
    fn contract_finished_nests_the_status_the_way_the_frontend_switches_on() {
        let e = RunEvent::Finished {
            status: RunStatus::Aborted {
                reason: AbortReason::BudgetExhausted {
                    used: 120,
                    budget: 100,
                },
            },
            usage: Usage::default(),
            iterations: 3,
        };
        let json = serde_json::to_value(&e).unwrap();

        assert_eq!(json["kind"], "finished");
        assert_eq!(json["iterations"], 3);
        assert_eq!(json["status"]["kind"], "aborted");
        assert_eq!(json["status"]["reason"]["kind"], "budgetExhausted");
        assert_eq!(json["status"]["reason"]["used"], 120);
        assert_eq!(json["status"]["reason"]["budget"], 100);
    }

    #[test]
    fn contract_text_keeps_chinese_readable_over_the_wire() {
        // 转义成 `中` 也不算错，但前端调试时会看不清 —— 这条只是钉住
        // 「我们没开那个会转义的配置」。
        let e = RunEvent::ToolFinished {
            name: "read_file".into(),
            is_error: false,
            content: "读到了".into(),
        };
        let json = serde_json::to_string(&e).unwrap();
        assert!(json.contains("读到了"), "中文被转义了：{json}");
        assert!(json.contains(r#""isError":false"#), "{json}");
        assert!(json.contains(r#""kind":"toolFinished""#), "{json}");
    }
}
