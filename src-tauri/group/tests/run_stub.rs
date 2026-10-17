//! 一轮的真实执行：起桩进程、读流、取消/超时、杀整棵树。
//!
//! 这一组和内核单测的分工：单测验「拼什么参数、怎么解析一行」，这里验
//! **进程真的起来了、顺序/并行真的按语义跑、停止真的把树收掉了**。
//! 桩程序是临时 `.sh` / `.cmd`，跨平台各写一遍（照 agents 的约定）。

mod common;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use devtoolkit_group::adapter::{CliKind, Permission, TurnMode};
use devtoolkit_group::event::{EventSink, GroupEvent, GroupEventKind, MemberStatus, TurnStatus};
use devtoolkit_group::store::{GroupDetail, GroupStore, MemberInput};
use devtoolkit_group::turn::{run_turn, TurnControl, TurnInput};

struct Harness {
    /// 只为 Drop（临时目录活到测试结束）。
    _dir: tempfile::TempDir,
    store: Arc<GroupStore>,
    group: GroupDetail,
}

/// 建群 + 成员（成员的命令就是桩脚本路径）。
fn setup(members: Vec<(&str, PathBuf)>, kind: CliKind) -> Harness {
    let dir = tempfile::tempdir().expect("临时目录");
    let store = Arc::new(GroupStore::open_in_memory().expect("内存库"));
    let group = store.create_group("测试群").expect("建群");

    let inputs: Vec<MemberInput> = members
        .iter()
        .enumerate()
        .map(|(index, (name, command))| MemberInput {
            id: String::new(),
            name: (*name).to_string(),
            kind,
            command: command.display().to_string(),
            model: String::new(),
            role_prompt: String::new(),
            permission: Permission::WorkspaceWrite,
            extra_args: vec![],
            position: index as i64,
            enabled: true,
        })
        .collect();

    let saved = store
        .save_group(&devtoolkit_group::store::GroupConfigInput {
            id: group.id.clone(),
            name: group.name.clone(),
            workspace: dir.path().display().to_string(),
            mode: TurnMode::Sequential,
            context_turns: 6,
            context_chars: 24000,
            timeout_secs: 600,
            members: inputs,
        })
        .expect("保存成员");
    Harness { _dir: dir, store, group: saved }
}

fn input(h: &Harness, turn_id: &str, text: &str, mentions: Vec<String>, mode: TurnMode) -> TurnInput {
    let started = h
        .store
        .begin_turn(turn_id, &h.group.id, text, &mentions, mode)
        .expect("开一轮");
    TurnInput {
        group: h.group.clone(),
        turn_id: turn_id.to_string(),
        user_text: text.to_string(),
        mention_ids: mentions,
        mode,
        history: vec![],
        store: Arc::clone(&h.store),
        user_message_id: started.user_message_id,
        started_at: started.started_at,
    }
}

fn find_turn_status(events: &[GroupEvent]) -> Option<TurnStatus> {
    events.iter().find_map(|e| match &e.kind {
        GroupEventKind::TurnFinished { status, .. } => Some(*status),
        _ => None,
    })
}

fn member_status(events: &[GroupEvent], member_id: &str) -> Option<MemberStatus> {
    events.iter().find_map(|e| match &e.kind {
        GroupEventKind::MemberFinished { member_id: id, status, .. }
            if id.as_str() == member_id =>
        {
            Some(*status)
        }
        _ => None,
    })
}

fn turn_finished_is_last(events: &[GroupEvent]) {
    let last = events.last().expect("至少有终态事件");
    assert!(
        matches!(last.kind, GroupEventKind::TurnFinished { .. }),
        "turnFinished 必须是最后一条，实际是 {:?}",
        last.kind
    );
}

fn read(path: &std::path::Path) -> String {
    std::fs::read_to_string(path).unwrap_or_default()
}

// ---------------------------------------------------------------- 顺序 / 并行

#[test]
fn 顺序接力_后发言的成员能在提示词里看到前一位的回答() {
    let dir = tempfile::tempdir().unwrap();
    let a_in = dir.path().join("a_in.txt");
    let b_in = dir.path().join("b_in.txt");
    let a_out = dir.path().join("a_out.txt");
    let b_out = dir.path().join("b_out.txt");
    std::fs::write(&a_out, "A_ANSWER").unwrap();
    std::fs::write(&b_out, "B_ANSWER").unwrap();
    let a = common::echo_stub(dir.path(), "a", &a_in, &a_out);
    let b = common::echo_stub(dir.path(), "b", &b_in, &b_out);

    let h = setup(vec![("甲", a), ("乙", b)], CliKind::Custom);
    let (sink, mut rx) = EventSink::new();
    let (control, cancel) = TurnControl::new();
    let turn = input(&h, "t1", "介绍一下这个项目", vec![], TurnMode::Sequential);
    let member_ids: Vec<String> = h.group.members.iter().map(|m| m.id.clone()).collect();

    tokio::runtime::Runtime::new()
        .unwrap()
        .block_on(run_turn(turn, sink, control, cancel));

    let events: Vec<GroupEvent> = std::iter::from_fn(|| rx.try_recv().ok()).collect();
    assert_eq!(find_turn_status(&events), Some(TurnStatus::Done));
    turn_finished_is_last(&events);
    assert_eq!(member_status(&events, &member_ids[0]), Some(MemberStatus::Done));
    assert_eq!(member_status(&events, &member_ids[1]), Some(MemberStatus::Done));

    let b_prompt = read(&b_in);
    assert!(
        b_prompt.contains("A_ANSWER"),
        "顺序模式下乙的提示词里该有甲的回答：\n{b_prompt}"
    );
    assert!(b_prompt.contains("本轮其他成员已经完成的回答"));
}

#[test]
fn 并行_成员互相看不到本轮的答案_但都能回答() {
    let dir = tempfile::tempdir().unwrap();
    let a_in = dir.path().join("a_in.txt");
    let b_in = dir.path().join("b_in.txt");
    let a_out = dir.path().join("a_out.txt");
    let b_out = dir.path().join("b_out.txt");
    std::fs::write(&a_out, "A_ANSWER").unwrap();
    std::fs::write(&b_out, "B_ANSWER").unwrap();
    let a = common::echo_stub(dir.path(), "a", &a_in, &a_out);
    let b = common::echo_stub(dir.path(), "b", &b_in, &b_out);

    let h = setup(vec![("甲", a), ("乙", b)], CliKind::Custom);
    let (sink, mut rx) = EventSink::new();
    let (control, cancel) = TurnControl::new();
    let turn = input(&h, "t1", "各自说说", vec![], TurnMode::Parallel);

    tokio::runtime::Runtime::new()
        .unwrap()
        .block_on(run_turn(turn, sink, control, cancel));

    let events: Vec<GroupEvent> = std::iter::from_fn(|| rx.try_recv().ok()).collect();
    assert_eq!(find_turn_status(&events), Some(TurnStatus::Done));
    let b_prompt = read(&b_in);
    assert!(
        !b_prompt.contains("A_ANSWER"),
        "并行模式下不该看到本轮的答案：\n{b_prompt}"
    );
    assert!(b_prompt.contains("本轮没有点名"));
}

// ---------------------------------------------------------------- @ 选择

#[test]
fn 点名_只启动被点名的成员() {
    let dir = tempfile::tempdir().unwrap();
    let a_in = dir.path().join("a_in.txt");
    let b_in = dir.path().join("b_in.txt");
    let a_out = dir.path().join("a_out.txt");
    let b_out = dir.path().join("b_out.txt");
    std::fs::write(&a_out, "A").unwrap();
    std::fs::write(&b_out, "B").unwrap();
    let a = common::echo_stub(dir.path(), "a", &a_in, &a_out);
    let b = common::echo_stub(dir.path(), "b", &b_in, &b_out);

    let h = setup(vec![("甲", a), ("乙", b)], CliKind::Custom);
    let b_id = h.group.members[1].id.clone();
    let (sink, mut rx) = EventSink::new();
    let (control, cancel) = TurnControl::new();
    let turn = input(&h, "t1", "只问乙", vec![b_id.clone()], TurnMode::Sequential);

    tokio::runtime::Runtime::new()
        .unwrap()
        .block_on(run_turn(turn, sink, control, cancel));

    let events: Vec<GroupEvent> = std::iter::from_fn(|| rx.try_recv().ok()).collect();
    assert_eq!(find_turn_status(&events), Some(TurnStatus::Done));
    assert!(!a_in.exists(), "没被点名的人不该被启动");
    assert!(b_in.exists(), "被点名的人必须跑");
    assert!(read(&b_in).contains("本轮点名了"));
}

// ---------------------------------------------------------------- 取消 / 超时

#[cfg(unix)]
#[test]
fn 取消_整棵进程树都要收掉() {
    let dir = tempfile::tempdir().unwrap();
    let stdin_path = dir.path().join("stdin.txt");
    let pid_path = dir.path().join("grandchild.pid");
    let stub = common::slow_stub(dir.path(), "slow", &stdin_path, &pid_path, true);

    let h = setup(vec![("甲", stub)], CliKind::Custom);
    let (sink, mut rx) = EventSink::new();
    let (control, cancel) = TurnControl::new();
    let turn = input(&h, "t1", "跑个长任务", vec![], TurnMode::Sequential);

    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(async {
        let handle = tokio::spawn(run_turn(turn, sink, control.clone(), cancel));

        assert!(
            common::wait_for_file(&pid_path, Duration::from_secs(5)).await,
            "桩程序没起来（孙进程 pid 文件没出现）"
        );
        let grandchild: i32 = read(&pid_path).trim().parse().expect("孙进程 pid");

        let stop_at = Instant::now();
        control.stop();
        tokio::time::timeout(Duration::from_secs(10), handle)
            .await
            .expect("停止之后一轮该在 10 秒内结束")
            .expect("run_turn 不该 panic");
        assert!(stop_at.elapsed() < Duration::from_secs(10));

        // 孙进程必须也没了（kill(pid,0) 返回 -1 且 errno = ESRCH）。
        let mut gone = false;
        for _ in 0..100 {
            let alive = unsafe { libc::kill(grandchild, 0) == 0 };
            if !alive {
                gone = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
        assert!(gone, "孙进程 {grandchild} 还活着 —— 进程树没杀干净");
    });

    let events: Vec<GroupEvent> = std::iter::from_fn(|| rx.try_recv().ok()).collect();
    assert_eq!(find_turn_status(&events), Some(TurnStatus::Cancelled));
    turn_finished_is_last(&events);
}

#[test]
fn 超时_杀掉进程并如实报错() {
    let dir = tempfile::tempdir().unwrap();
    let stdin_path = dir.path().join("stdin.txt");
    let pid_path = dir.path().join("pid.txt");
    let stub = common::slow_stub(dir.path(), "slow", &stdin_path, &pid_path, false);

    let mut h = setup(vec![("甲", stub)], CliKind::Custom);
    // 配置层限制 >=10 秒；这里直接改 GroupDetail 缩短，测的是内核行为。
    h.group.timeout_secs = 1;

    let (sink, mut rx) = EventSink::new();
    let (control, cancel) = TurnControl::new();
    let turn = input(&h, "t1", "跑吧", vec![], TurnMode::Sequential);

    let started = Instant::now();
    tokio::runtime::Runtime::new()
        .unwrap()
        .block_on(run_turn(turn, sink, control, cancel));
    assert!(started.elapsed() < Duration::from_secs(8), "超时没有及时生效");

    let events: Vec<GroupEvent> = std::iter::from_fn(|| rx.try_recv().ok()).collect();
    assert_eq!(find_turn_status(&events), Some(TurnStatus::Failed));
    let member_id = h.group.members[0].id.clone();
    assert_eq!(member_status(&events, &member_id), Some(MemberStatus::Failed));
    let error = events.iter().find_map(|e| match &e.kind {
        GroupEventKind::MemberFinished { member_id: id, error, .. }
            if id.as_str() == member_id.as_str() =>
        {
            error.clone()
        }
        _ => None,
    });
    assert!(
        error.unwrap_or_default().contains("超过"),
        "失败原因该说清是超时"
    );
}

// ---------------------------------------------------------------- 起不来 / 继续

#[test]
fn 一个成员起不来_后面的成员照常跑() {
    let dir = tempfile::tempdir().unwrap();
    let b_in = dir.path().join("b_in.txt");
    let b_out = dir.path().join("b_out.txt");
    std::fs::write(&b_out, "B_ANSWER").unwrap();
    let b = common::echo_stub(dir.path(), "b", &b_in, &b_out);

    let missing = if cfg!(windows) {
        PathBuf::from("C:\\definitely-not-here\\nope.exe")
    } else {
        PathBuf::from("/definitely-not-here/nope")
    };
    let h = setup(vec![("坏的", missing), ("乙", b)], CliKind::Custom);
    let (sink, mut rx) = EventSink::new();
    let (control, cancel) = TurnControl::new();
    let turn = input(&h, "t1", "试试", vec![], TurnMode::Sequential);

    tokio::runtime::Runtime::new()
        .unwrap()
        .block_on(run_turn(turn, sink, control, cancel));

    let events: Vec<GroupEvent> = std::iter::from_fn(|| rx.try_recv().ok()).collect();
    let ids: Vec<String> = h.group.members.iter().map(|m| m.id.clone()).collect();
    assert_eq!(member_status(&events, &ids[0]), Some(MemberStatus::Failed));
    assert_eq!(member_status(&events, &ids[1]), Some(MemberStatus::Done));
    // 至少有一个成功 → 整轮算完成（个别失败在成员状态里）
    assert_eq!(find_turn_status(&events), Some(TurnStatus::Done));
    assert!(read(&b_in).contains("这一轮失败了"), "后来的成员该知道前一位失败了");
}

// ---------------------------------------------------------------- JSONL 端到端

#[test]
fn claude_适配器端到端_增量显示_终稿不重复() {
    let dir = tempfile::tempdir().unwrap();
    let stdin_path = dir.path().join("stdin.txt");
    let jsonl = dir.path().join("out.jsonl");
    std::fs::write(
        &jsonl,
        concat!(
            r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"先"}}}"#,
            "\n",
            r#"{"type":"result","subtype":"success","result":"终稿"}"#,
            "\n"
        ),
    )
    .unwrap();
    let stub = common::echo_stub(dir.path(), "claude_stub", &stdin_path, &jsonl);

    // 用 claude kind（会追加真实的 claude 参数），命令指向桩程序。
    let h = setup(vec![("甲", stub)], CliKind::Claude);
    let (sink, mut rx) = EventSink::new();
    let (control, cancel) = TurnControl::new();
    let turn = input(&h, "t1", "说点什么", vec![], TurnMode::Sequential);

    tokio::runtime::Runtime::new()
        .unwrap()
        .block_on(run_turn(turn, sink, control, cancel));

    let events: Vec<GroupEvent> = std::iter::from_fn(|| rx.try_recv().ok()).collect();
    assert_eq!(find_turn_status(&events), Some(TurnStatus::Done));

    // 流式增量要发出去（用户看得见「正在打字」）
    assert!(events.iter().any(|e| matches!(
        &e.kind,
        GroupEventKind::MemberText { text, .. } if text == "先"
    )));
    // 终稿是权威值：不能被拼成「先终稿」
    let final_text = events.iter().find_map(|e| match &e.kind {
        GroupEventKind::MemberFinished { text, .. } => Some(text.clone()),
        _ => None,
    });
    assert_eq!(final_text.as_deref(), Some("终稿"));
}
