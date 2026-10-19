//! 一轮的调度：选成员、拼提示词、起进程、把事件推给前端、落库、收尾。
//!
//! # 两种模式
//!
//! * **顺序接力（默认）**：按成员顺序逐个跑；第 N 个的提示词里带本轮前 N-1 个
//!   的最终回答 —— 这是「成员能看到彼此」最直接的实现。
//! * **并行**：同时跑，各自用同一份历史快照；本轮互相看不到（下一轮历史里能看到）。
//!
//! # 三条必须守住的规矩
//!
//! 1. **终态兜底**：不管从哪条路提前返回，`turnFinished` 都要发出去（Drop 守卫）。
//! 2. **杀树**：取消/超时要杀整棵树，而不是只杀直接子进程。杀进程的句柄放在
//!    [`TurnControl`] 里，`group_stop` 从命令线程直接调，不依赖这一轮还活着。
//! 3. **单个成员失败不终止整轮**：后面的成员继续，而且能在「前序回答」里
//!    看到失败说明（知道别重复它的路）。

use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use tokio::sync::watch;

use crate::adapter::{adapter_for, AdapterEvent, CliKind, MemberSpec, RunSpec, TurnMode};
use crate::error::GroupError;
use crate::event::{
    EventSink, GroupEventKind, MemberActivity, MemberStatus, ToolState, TurnStatus,
};
use crate::proc::{self, TreeKiller};
use crate::prompt::{self, ContextMessage, PriorAnswer, PromptInput, Speaker};
use crate::store::{GroupDetail, GroupMessage, GroupStore, MemberConfig, MemberOutcome, ToolTrace};

/// 单个成员正文的上限（超过就截断，防止一个坏掉的 CLI 把内存吃穿）。
const MAX_MEMBER_TEXT: usize = 256 * 1024;
/// stderr 只留末尾这么多字节（给失败原因用）。
const STDERR_TAIL: usize = 4096;
/// 子进程退出后等读任务收尾的上限（孙子进程可能继承着 stdout）。
const DRAIN_GRACE: Duration = Duration::from_secs(2);

/// 一轮的控制面：取消信号 + 所有还在跑的成员的杀树开关。
///
/// 克隆是廉价的（watch::Sender + Arc）。`group_stop` 拿到它就可以**同步**杀树。
#[derive(Clone)]
pub struct TurnControl {
    cancel: watch::Sender<bool>,
    killers: Arc<StdMutex<Vec<Arc<TreeKiller>>>>,
}

impl TurnControl {
    pub fn new() -> (Self, watch::Receiver<bool>) {
        let (cancel, rx) = watch::channel(false);
        (
            Self {
                cancel,
                killers: Arc::new(StdMutex::new(Vec::new())),
            },
            rx,
        )
    }

    /// 停止：置取消位 + **立刻**杀掉已经起来的进程树（不等运行中的任务）。
    pub fn stop(&self) {
        self.cancel.send_replace(true);
        self.kill_all();
    }

    /// 只杀当前登记在册的进程树（不置取消位）。
    fn kill_all(&self) {
        let killers: Vec<Arc<TreeKiller>> = {
            let guard = self.killers.lock().unwrap_or_else(|e| e.into_inner());
            guard.clone()
        };
        for killer in killers {
            killer.kill();
        }
    }

    fn register(&self, killer: Arc<TreeKiller>) {
        let mut guard = self.killers.lock().unwrap_or_else(|e| e.into_inner());
        guard.push(killer);
    }

    fn unregister(&self, killer: &Arc<TreeKiller>) {
        let mut guard = self.killers.lock().unwrap_or_else(|e| e.into_inner());
        guard.retain(|k| !Arc::ptr_eq(k, killer));
    }
}

/// 跑一轮需要的一切（命令层组装好传进来）。
pub struct TurnInput {
    pub group: GroupDetail,
    pub turn_id: String,
    pub user_text: String,
    pub mention_ids: Vec<String>,
    pub mode: TurnMode,
    /// 最近 N 轮**已完成**的消息（不含本轮）。
    pub history: Vec<ContextMessage>,
    pub store: Arc<GroupStore>,
    pub user_message_id: i64,
    pub started_at: i64,
    /// Windows 上 Git Bash 的路径（来自智能体会话模块的设置；csc 需要它）。
    pub git_bash: Option<String>,
}

/// 选出这一轮要发言的成员（按配置顺序）。
///
/// `@` 语义：空 = 全员；非空 = 只跑被点名者。**未知 / 停用的 id 直接报错**，
/// 不静默退化成全员（那会让用户以为只是「没点名」）。
pub fn select_members(
    group: &GroupDetail,
    mention_ids: &[String],
) -> Result<Vec<MemberConfig>, GroupError> {
    let enabled: Vec<MemberConfig> = group
        .members
        .iter()
        .filter(|m| m.enabled)
        .cloned()
        .collect();

    if mention_ids.is_empty() {
        if enabled.is_empty() {
            return Err(GroupError::bad_input(
                "这个群还没有可用的成员 —— 先去右侧检查器加一个",
            ));
        }
        return Ok(enabled);
    }

    let mut selected: Vec<MemberConfig> = Vec::new();
    for id in mention_ids {
        let member = enabled
            .iter()
            .find(|m| &m.id == id)
            .ok_or_else(|| GroupError::bad_input(format!("@ 了一个不存在或已停用的成员（{id}）")))?;
        if !selected.iter().any(|m| &m.id == id) {
            selected.push(member.clone());
        }
    }
    // 保持配置顺序（@ 的先后不该改变发言顺序）
    selected.sort_by_key(|m| m.position);
    Ok(selected)
}

/// 跑一轮。**最外层只负责选成员、发 turnStarted、聚合终态**；单个成员的
/// 细节在 [`run_member`]。
pub async fn run_turn(input: TurnInput, sink: EventSink, control: TurnControl, mut cancel: watch::Receiver<bool>) {
    let started = Instant::now();
    let members = match select_members(&input.group, &input.mention_ids) {
        Ok(m) => m,
        Err(e) => {
            // 命令层已经校验过一遍；这里是防御性兜底（事件必须收尾）。
            sink.send(GroupEventKind::TurnFinished {
                turn_id: input.turn_id.clone(),
                status: TurnStatus::Failed,
                error: Some(e.to_string()),
                elapsed_ms: started.elapsed().as_millis() as u64,
            });
            let _ = input.store.finish_turn(&input.turn_id, "failed", Some(&e.to_string()));
            return;
        }
    };

    let mentioned_names: Vec<String> = if input.mention_ids.is_empty() {
        Vec::new()
    } else {
        members.iter().map(|m| m.name.clone()).collect()
    };

    sink.send(GroupEventKind::TurnStarted {
        turn_id: input.turn_id.clone(),
        group_id: input.group.id.clone(),
        user_message_id: input.user_message_id,
        user_text: input.user_text.clone(),
        member_ids: members.iter().map(|m| m.id.clone()).collect(),
        mode: input.mode,
        started_at: input.started_at,
    });
    for (index, member) in members.iter().enumerate() {
        sink.send(GroupEventKind::MemberQueued {
            member_id: member.id.clone(),
            position: index,
        });
    }

    let mut guard = FinishGuard {
        sink: sink.clone(),
        turn_id: input.turn_id.clone(),
        started,
        done: false,
    };

    // 如果命令还没跑就已经被停止（用户手快），直接收尾。
    if *cancel.borrow() {
        finish_cancelled(&mut guard, &input.store).await;
        return;
    }

    let mut any_done = false;
    let mut last_error: Option<String> = None;

    match input.mode {
        TurnMode::Sequential => {
            let mut prior: Vec<PriorAnswer> = Vec::new();
            for (index, member) in members.iter().enumerate() {
                if *cancel.borrow() {
                    break;
                }
                let outcome = run_member(
                    &input,
                    member,
                    index as i64,
                    &prior,
                    &mentioned_names,
                    &sink,
                    &control,
                    &mut cancel,
                )
                .await;
                match &outcome {
                    MemberRunOutcome::Done { text } => {
                        any_done = true;
                        prior.push(PriorAnswer {
                            name: member.name.clone(),
                            text: text.clone(),
                            failed: false,
                            error: None,
                        });
                    }
                    MemberRunOutcome::Failed { text, error } => {
                        last_error = Some(error.clone());
                        prior.push(PriorAnswer {
                            name: member.name.clone(),
                            text: text.clone(),
                            failed: true,
                            error: Some(error.clone()),
                        });
                    }
                    MemberRunOutcome::Cancelled => break,
                }
            }
        }
        TurnMode::Parallel => {
            let mut set = tokio::task::JoinSet::new();
            for (index, member) in members.iter().enumerate() {
                let member = member.clone();
                let history = input.history.clone();
                // 并行：所有成员共享「本轮开始前」的同一份视角，互相看不到。
                let prior: Vec<PriorAnswer> = Vec::new();
                let mentioned = mentioned_names.clone();
                let group = input.group.clone();
                let turn_id = input.turn_id.clone();
                let user_text = input.user_text.clone();
                let store = Arc::clone(&input.store);
                let sink2 = sink.clone();
                let control2 = control.clone();
                let cancel2 = cancel.clone();
                let git_bash = input.git_bash.clone();
                set.spawn(async move {
                    let local_input = TurnInput {
                        group,
                        turn_id,
                        user_text,
                        mention_ids: Vec::new(),
                        mode: TurnMode::Parallel,
                        history,
                        store,
                        user_message_id: 0,
                        started_at: 0,
                        git_bash,
                    };
                    let mut cancel2 = cancel2;
                    run_member(
                        &local_input,
                        &member,
                        index as i64,
                        &prior,
                        &mentioned,
                        &sink2,
                        &control2,
                        &mut cancel2,
                    )
                    .await
                });
            }
            while let Some(joined) = set.join_next().await {
                match joined {
                    Ok(MemberRunOutcome::Done { .. }) => any_done = true,
                    Ok(MemberRunOutcome::Failed { error, .. }) => last_error = Some(error),
                    Ok(MemberRunOutcome::Cancelled) => {}
                    Err(e) => last_error = Some(format!("成员任务异常：{e}")),
                }
            }
        }
    }

    let status = if *cancel.borrow() {
        TurnStatus::Cancelled
    } else if any_done {
        TurnStatus::Done
    } else {
        TurnStatus::Failed
    };
    let error = if status == TurnStatus::Failed {
        Some(last_error.unwrap_or_else(|| "所有成员都失败了".to_string()))
    } else {
        None
    };

    let db_status = status_str(status);
    let _ = input
        .store
        .finish_turn(&input.turn_id, db_status, error.as_deref());
    guard.finish(status, error);
}

/// 提前取消：落库 + 发终态。
async fn finish_cancelled(guard: &mut FinishGuard, store: &Arc<GroupStore>) {
    let _ = store.finish_turn(&guard.turn_id, "cancelled", None);
    guard.finish(TurnStatus::Cancelled, None);
}

/// 一个成员的结局（内部用；事件在 `run_member` 里已经发过了）。
enum MemberRunOutcome {
    Done { text: String },
    Failed { text: String, error: String },
    Cancelled,
}

/// 跑一个成员：拼提示词 → 起进程 → 读流 → 落库 → 发终态事件。
#[allow(clippy::too_many_arguments)]
async fn run_member(
    input: &TurnInput,
    member: &MemberConfig,
    position: i64,
    prior: &[PriorAnswer],
    mentioned_names: &[String],
    sink: &EventSink,
    control: &TurnControl,
    cancel: &mut watch::Receiver<bool>,
) -> MemberRunOutcome {
    let started = Instant::now();
    let spec = MemberSpec {
        id: member.id.clone(),
        name: member.name.clone(),
        kind: member.kind,
        command: member.command.clone(),
        model: member.model.clone(),
        role_prompt: member.role_prompt.clone(),
        permission: member.permission,
        extra_args: member.extra_args.clone(),
    };

    sink.send(GroupEventKind::MemberStarted {
        member_id: member.id.clone(),
        started_at: now_ms(),
    });
    sink.send(GroupEventKind::MemberActivity {
        member_id: member.id.clone(),
        activity: MemberActivity::Thinking,
    });

    let prompt = prompt::build(&PromptInput {
        group_name: &input.group.name,
        member: &spec,
        workspace: std::path::Path::new(&input.group.workspace),
        history: &input.history,
        prior,
        user_text: &input.user_text,
        mentioned_names,
        mode: input.mode,
        context_chars: input.group.context_chars.max(1000) as usize,
    });

    // Windows 上 csc 要 Git Bash：优先用**用户已经给智能体会话配好的路径**
    // （命令层从 KV 读来的），没有就自动探测。claude 也顺手设一份 ——
    // 老版 claude 在 Windows 上同样认 `CLAUDE_CODE_GIT_BASH_PATH`。
    let git_bash = input
        .git_bash
        .clone()
        .or_else(|| proc::detect_git_bash().map(|p| p.display().to_string()));
    let mut env: Vec<(String, String)> = Vec::new();
    if let Some(bash) = git_bash {
        if matches!(spec.kind, CliKind::Claude | CliKind::Csc) {
            env.push(("CLAUDE_CODE_GIT_BASH_PATH".to_string(), bash.clone()));
        }
        if spec.kind == CliKind::Csc {
            env.push(("COSTRICT_GIT_BASH_PATH".to_string(), bash));
        }
    }

    let run_spec = RunSpec {
        member: spec.clone(),
        workspace: std::path::PathBuf::from(&input.group.workspace),
        prompt,
        // 配置层限制 10..=3600；这里只做下限兜底（测试会用 1 秒）。
        timeout: Duration::from_secs(input.group.timeout_secs.clamp(1, 3600) as u64),
        turn_id: input.turn_id.clone(),
        program_override: None,
        env,
    };

    let plan = match adapter_for(spec.kind).plan(&run_spec) {
        Ok(p) => p,
        Err(e) => {
            return finish_member(
                input,
                member,
                position,
                Extract::default(),
                MemberStatus::Failed,
                Some(e.to_string()),
                started,
                sink,
            )
            .await;
        }
    };

    let mut spawned = match proc::spawn(&plan).await {
        Ok(s) => s,
        Err(e) => {
            return finish_member(
                input,
                member,
                position,
                Extract::default(),
                MemberStatus::Failed,
                Some(e.to_string()),
                started,
                sink,
            )
            .await;
        }
    };
    control.register(Arc::clone(&spawned.killer));

    let (mut out_rx, mut err_rx) = proc::collect_streams(&mut spawned.child);
    let mut extract = Extract::default();
    let mut stderr_tail = String::new();
    let mut timed_out = false;
    let mut cancelled = false;

    let deadline = tokio::time::Instant::now() + run_spec.timeout;
    let mut exit_status: Option<std::process::ExitStatus> = None;

    loop {
        tokio::select! {
            line = out_rx.recv() => {
                match line {
                    Some(line) => {
                        for event in adapter_for(spec.kind).parse_line(&line) {
                            handle_adapter_event(event, member, &mut extract, sink);
                        }
                    }
                    None => {}
                }
            }
            line = err_rx.recv() => {
                if let Some(line) = line {
                    stderr_tail.push_str(&line);
                    stderr_tail.push('\n');
                    if stderr_tail.len() > STDERR_TAIL {
                        let cut = stderr_tail.len() - STDERR_TAIL;
                        // 按字符边界切（中文 stderr 按字节切会出替换字符）
                        let cut = floor_char_boundary(&stderr_tail, cut);
                        stderr_tail = stderr_tail[cut..].to_string();
                    }
                }
            }
            status = spawned.child.wait() => {
                exit_status = status.ok();
                break;
            }
            _ = cancel.changed() => {
                if *cancel.borrow() {
                    cancelled = true;
                    break;
                }
            }
            _ = tokio::time::sleep_until(deadline) => {
                timed_out = true;
                break;
            }
        }
    }

    // 取消/超时：先杀整棵树，再等直接子进程收尸。
    // （不放在 select 的分支体里：那会和 `child.wait()` 的借用打架。）
    if cancelled || timed_out {
        spawned.killer.kill();
        let _ = spawned.child.wait().await;
    }

    // 子进程退出后把剩余输出读完（最多 DRAIN_GRACE）：否则最后几段正文会丢。
    drain_streams(
        &mut out_rx,
        &mut err_rx,
        &spec,
        member,
        &mut extract,
        &mut stderr_tail,
        sink,
    )
    .await;

    spawned.killer.mark_reaped();
    control.unregister(&spawned.killer);

    let (status, error) = if cancelled {
        (MemberStatus::Cancelled, None)
    } else if timed_out {
        (
            MemberStatus::Failed,
            Some(format!(
                "超过 {} 秒没有完成，已停止",
                run_spec.timeout.as_secs()
            )),
        )
    } else {
        match exit_status {
            Some(s) if s.success() => (MemberStatus::Done, None),
            Some(s) => {
                let reason = if stderr_tail.trim().is_empty() {
                    format!("进程退出码 {}", s.code().unwrap_or(-1))
                } else {
                    format!("进程退出码 {}：{}", s.code().unwrap_or(-1), stderr_tail.trim())
                };
                (MemberStatus::Failed, Some(reason))
            }
            None => (
                MemberStatus::Failed,
                Some(if stderr_tail.trim().is_empty() {
                    "进程没有正常结束".to_string()
                } else {
                    stderr_tail.trim().to_string()
                }),
            ),
        }
    };

    finish_member(input, member, position, extract, status, error, started, sink).await
}

/// 解析出来的正文/工具/用量（流式事件已经发过，这里是为了落库和终态）。
#[derive(Default)]
struct Extract {
    text: String,
    tools: Vec<ToolTrace>,
    usage: Option<String>,
    truncated: bool,
    notices: Vec<String>,
}

fn handle_adapter_event(
    event: AdapterEvent,
    member: &MemberConfig,
    extract: &mut Extract,
    sink: &EventSink,
) {
    match event {
        AdapterEvent::TextDelta(delta) => {
            if extract.text.len() >= MAX_MEMBER_TEXT {
                if !extract.truncated {
                    extract.truncated = true;
                    extract.text.push_str("\n…（输出太长，已截断）");
                }
                return;
            }
            extract.text.push_str(&delta);
            sink.send(GroupEventKind::MemberText {
                member_id: member.id.clone(),
                text: delta,
            });
            sink.send(GroupEventKind::MemberActivity {
                member_id: member.id.clone(),
                activity: MemberActivity::Thinking,
            });
        }
        AdapterEvent::FinalText(full) => {
            // 权威终稿：覆盖累积文本（前端在 memberFinished 里拿这个值）。
            extract.text = full;
        }
        AdapterEvent::SessionId(id) => {
            // v1 不 resume；只记着（健康日志需要时再看）。
            let _ = id;
        }
        AdapterEvent::ToolStarted {
            tool_id,
            name,
            display,
        } => {
            extract.tools.push(ToolTrace {
                tool_id: tool_id.clone(),
                name: name.clone(),
                display: display.clone(),
                is_error: None,
            });
            sink.send(GroupEventKind::MemberTool {
                member_id: member.id.clone(),
                tool_id,
                name,
                display,
                state: ToolState::Started,
            });
            sink.send(GroupEventKind::MemberActivity {
                member_id: member.id.clone(),
                activity: MemberActivity::Tool,
            });
        }
        AdapterEvent::ToolFinished {
            tool_id,
            name,
            is_error,
            display,
        } => {
            // 按 tool_id 找行；没有 id（或对不上）就找第一条还没结果的。
            let index = tool_id
                .as_ref()
                .and_then(|id| {
                    extract
                        .tools
                        .iter()
                        .position(|t| t.tool_id.as_ref() == Some(id) && t.is_error.is_none())
                })
                .or_else(|| extract.tools.iter().position(|t| t.is_error.is_none()));
            if let Some(index) = index {
                extract.tools[index].is_error = Some(is_error);
                if extract.tools[index].display.is_empty() && !display.is_empty() {
                    extract.tools[index].display = display.clone();
                }
                sink.send(GroupEventKind::MemberTool {
                    member_id: member.id.clone(),
                    tool_id: tool_id.or_else(|| extract.tools[index].tool_id.clone()),
                    name: if name.is_empty() {
                        extract.tools[index].name.clone()
                    } else {
                        name
                    },
                    display: if display.is_empty() {
                        extract.tools[index].display.clone()
                    } else {
                        display
                    },
                    state: if is_error {
                        ToolState::Failed
                    } else {
                        ToolState::Finished
                    },
                });
            }
        }
        AdapterEvent::Usage(usage) => {
            extract.usage = Some(usage);
        }
        AdapterEvent::Notice(text) => {
            extract.notices.push(text);
        }
    }
}

/// 子进程退出后把管道里剩下的读掉。
async fn drain_streams(
    out_rx: &mut tokio::sync::mpsc::UnboundedReceiver<String>,
    err_rx: &mut tokio::sync::mpsc::UnboundedReceiver<String>,
    spec: &MemberSpec,
    member: &MemberConfig,
    extract: &mut Extract,
    stderr_tail: &mut String,
    sink: &EventSink,
) {
    let deadline = tokio::time::Instant::now() + DRAIN_GRACE;
    loop {
        tokio::select! {
            line = out_rx.recv() => {
                match line {
                    Some(line) => {
                        for event in adapter_for(spec.kind).parse_line(&line) {
                            handle_adapter_event(event, member, extract, sink);
                        }
                    }
                    None => break,
                }
            }
            line = err_rx.recv() => {
                if let Some(line) = line {
                    stderr_tail.push_str(&line);
                    stderr_tail.push('\n');
                }
            }
            _ = tokio::time::sleep_until(deadline) => break,
        }
    }
}

/// 落库 + 发 `memberFinished`。
#[allow(clippy::too_many_arguments)]
async fn finish_member(
    input: &TurnInput,
    member: &MemberConfig,
    position: i64,
    extract: Extract,
    status: MemberStatus,
    error: Option<String>,
    started: Instant,
    sink: &EventSink,
) -> MemberRunOutcome {
    let error_text = match (&error, extract.notices.is_empty()) {
        (Some(e), true) => e.clone(),
        (Some(e), false) => format!("{e}（{}）", extract.notices.join("；")),
        (None, true) => String::new(),
        (None, false) => extract.notices.join("；"),
    };
    let status_text = match status {
        MemberStatus::Done => "done",
        MemberStatus::Failed => "failed",
        MemberStatus::Cancelled => "cancelled",
    };

    let store = Arc::clone(&input.store);
    let group_id = input.group.id.clone();
    let turn_id = input.turn_id.clone();
    let member_id = member.id.clone();
    let name = member.name.clone();
    let text = extract.text.clone();
    let tools = extract.tools.clone();
    let usage = extract.usage.clone();
    let error_for_db = error_text.clone();
    let status_for_db = status_text.to_string();

    let message_id = tokio::task::spawn_blocking(move || {
        store.record_member_message(&MemberOutcome {
            group_id: &group_id,
            turn_id: &turn_id,
            member_id: &member_id,
            speaker_name: &name,
            member_position: position,
            text: &text,
            tools: &tools,
            status: &status_for_db,
            error: &error_for_db,
            usage: usage.as_deref(),
        })
    })
    .await
    .ok()
    .and_then(|r| r.ok());

    sink.send(GroupEventKind::MemberFinished {
        member_id: member.id.clone(),
        message_id,
        status,
        text: extract.text.clone(),
        error: if error_text.is_empty() {
            None
        } else {
            Some(error_text.clone())
        },
        usage: extract.usage.clone(),
        elapsed_ms: started.elapsed().as_millis() as u64,
    });

    match status {
        MemberStatus::Done => MemberRunOutcome::Done {
            text: extract.text,
        },
        MemberStatus::Failed => MemberRunOutcome::Failed {
            text: extract.text,
            error: error_text,
        },
        MemberStatus::Cancelled => MemberRunOutcome::Cancelled,
    }
}

/// 终态兜底：不管从哪条路返回，`turnFinished` 都至少发一次。
struct FinishGuard {
    sink: EventSink,
    turn_id: String,
    started: Instant,
    done: bool,
}

impl FinishGuard {
    fn finish(&mut self, status: TurnStatus, error: Option<String>) {
        if self.done {
            return;
        }
        self.done = true;
        self.sink.send(GroupEventKind::TurnFinished {
            turn_id: self.turn_id.clone(),
            status,
            error,
            elapsed_ms: self.started.elapsed().as_millis() as u64,
        });
    }
}

impl Drop for FinishGuard {
    fn drop(&mut self) {
        if !self.done {
            self.sink.send(GroupEventKind::TurnFinished {
                turn_id: self.turn_id.clone(),
                status: TurnStatus::Failed,
                error: Some("内部错误：这一轮没有正常收尾".to_string()),
                elapsed_ms: self.started.elapsed().as_millis() as u64,
            });
        }
    }
}

fn status_str(status: TurnStatus) -> &'static str {
    match status {
        TurnStatus::Done => "done",
        TurnStatus::Failed => "failed",
        TurnStatus::Cancelled => "cancelled",
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 从 `cut` 往前找最近的字符边界（中文按字节切会产生 U+FFFD）。
fn floor_char_boundary(s: &str, cut: usize) -> usize {
    if cut >= s.len() {
        return s.len();
    }
    let mut i = cut;
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

/// 把库里的消息转成提示词用的上下文。
pub fn context_from_history(history: &[GroupMessage]) -> Vec<ContextMessage> {
    history
        .iter()
        .map(|m| ContextMessage {
            speaker: if m.speaker_kind == "user" {
                Speaker::User
            } else {
                Speaker::Member
            },
            name: m.speaker_name.clone(),
            text: m.text.clone(),
            failed: m.status == "failed" || m.status == "cancelled",
            error: if m.error.is_empty() {
                None
            } else {
                Some(m.error.clone())
            },
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapter::{CliKind, Permission};
    use crate::store::MemberConfig;

    fn member(id: &str, name: &str, position: i64, enabled: bool) -> MemberConfig {
        MemberConfig {
            id: id.into(),
            name: name.into(),
            kind: CliKind::Claude,
            command: String::new(),
            model: String::new(),
            role_prompt: String::new(),
            permission: Permission::WorkspaceWrite,
            extra_args: vec![],
            position,
            enabled,
        }
    }

    fn detail(members: Vec<MemberConfig>) -> GroupDetail {
        GroupDetail {
            id: "g1".into(),
            name: "群".into(),
            workspace: "/tmp".into(),
            mode: TurnMode::Sequential,
            context_turns: 6,
            context_chars: 24000,
            timeout_secs: 600,
            members,
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn 没点名时选全部启用成员() {
        let g = detail(vec![
            member("m1", "甲", 0, true),
            member("m2", "乙", 1, false),
            member("m3", "丙", 2, true),
        ]);
        let selected = select_members(&g, &[]).unwrap();
        assert_eq!(selected.len(), 2);
        assert_eq!(selected[0].id, "m1");
        assert_eq!(selected[1].id, "m3");
    }

    #[test]
    fn 点名只选被点名的_而且保持配置顺序() {
        let g = detail(vec![
            member("m1", "甲", 0, true),
            member("m2", "乙", 1, true),
            member("m3", "丙", 2, true),
        ]);
        let selected = select_members(&g, &["m3".into(), "m1".into()]).unwrap();
        assert_eq!(
            selected.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            vec!["m1", "m3"],
            "@ 的先后不该改变发言顺序"
        );
    }

    #[test]
    fn 点名未知或停用的成员直接报错_不退化成全员() {
        let g = detail(vec![member("m1", "甲", 0, true), member("m2", "乙", 1, false)]);
        assert!(select_members(&g, &["nope".into()]).is_err());
        assert!(select_members(&g, &["m2".into()]).is_err(), "停用的成员不能 @");
    }

    #[test]
    fn 一个可用成员都没有时给可执行的提示() {
        let g = detail(vec![member("m1", "甲", 0, false)]);
        let err = select_members(&g, &[]).expect_err("该报错");
        assert!(err.to_string().contains("检查器"));
    }

    #[test]
    fn 历史消息转上下文_失败状态带上错误() {
        let history = vec![GroupMessage {
            id: 1,
            turn_id: "t1".into(),
            speaker_kind: "member".into(),
            member_id: Some("m1".into()),
            speaker_name: "甲".into(),
            member_position: 0,
            text: String::new(),
            tools: vec![],
            status: "failed".into(),
            error: "超时".into(),
            usage: None,
            created_at: 0,
        }];
        let ctx = context_from_history(&history);
        assert!(ctx[0].failed);
        assert_eq!(ctx[0].error.as_deref(), Some("超时"));
    }

    #[test]
    fn 中文截断边界_不会切在字节中间() {
        let s = "中文";
        for cut in 0..=s.len() {
            let i = floor_char_boundary(s, cut);
            assert!(s.is_char_boundary(i));
        }
    }
}
