//! 推给前端的事件协议。
//!
//! # 两条不变量
//!
//! 1. **`seq` 严格递增，而且顺序 == 投递顺序** —— 在 `EventSink` 的同一把锁里
//!    分配序号并入队。两个成员各自 `fetch_add` 再 send 的话，序号顺序和到达
//!    顺序可能不一致，前端按 seq 排就会把并行事件排错。
//! 2. **`turnFinished` 一定是最后一条**。任何提前返回/内部错误都必须先发它 ——
//!    否则前端的「正在跑」永远停不下来（漏终态事件是这个仓反复踩过的坑）。
//!
//! TS 侧的类型在 `src/modules/group/services/types.ts`，**字段名必须一字不差**
//! （Rust 侧有 contract 测试钉着；这条缝两端各自的测试都盖不到）。

use std::sync::Mutex;

use serde::Serialize;
use tokio::sync::mpsc;

use crate::adapter::TurnMode;

/// 一条群组事件：全局序号 + 具体内容。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupEvent {
    pub seq: u64,
    #[serde(flatten)]
    pub kind: GroupEventKind,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum GroupEventKind {
    /// 一轮开始。前端在这一刻按 `member_ids` 顺序插入**所有成员的占位气泡**，
    /// 这样并行模式下气泡位置稳定，不会按完成顺序跳来跳去。
    TurnStarted {
        turn_id: String,
        group_id: String,
        user_message_id: i64,
        user_text: String,
        member_ids: Vec<String>,
        mode: TurnMode,
        started_at: i64,
    },
    MemberQueued {
        member_id: String,
        position: usize,
    },
    MemberStarted {
        member_id: String,
        started_at: i64,
    },
    MemberText {
        member_id: String,
        text: String,
    },
    MemberActivity {
        member_id: String,
        activity: MemberActivity,
    },
    MemberTool {
        member_id: String,
        tool_id: Option<String>,
        name: String,
        display: String,
        state: ToolState,
    },
    MemberFinished {
        member_id: String,
        /// 落库成功才有 id；前端用它把占位消息换成正式 id。
        message_id: Option<i64>,
        status: MemberStatus,
        /// **权威终稿**（不是增量拼接的结果）。
        text: String,
        error: Option<String>,
        usage: Option<String>,
        elapsed_ms: u64,
    },
    /// 一定是最后一条。
    TurnFinished {
        turn_id: String,
        status: TurnStatus,
        error: Option<String>,
        elapsed_ms: u64,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MemberActivity {
    Thinking,
    Tool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolState {
    Started,
    Finished,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MemberStatus {
    Done,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TurnStatus {
    Done,
    Failed,
    Cancelled,
}

/// 事件出口。克隆是廉价的（内部是 mpsc 的发送端 + 一把短锁）。
#[derive(Clone)]
pub struct EventSink {
    tx: mpsc::UnboundedSender<GroupEvent>,
    seq: std::sync::Arc<Mutex<u64>>,
}

impl EventSink {
    pub fn new() -> (Self, mpsc::UnboundedReceiver<GroupEvent>) {
        let (tx, rx) = mpsc::unbounded_channel();
        (
            Self {
                tx,
                seq: std::sync::Arc::new(Mutex::new(0)),
            },
            rx,
        )
    }

    /// 分配序号 + 入队（同一把锁）。接收端没了就丢掉 —— 事件是「告知」，
    /// 不该为了它停住循环。
    pub fn send(&self, kind: GroupEventKind) {
        let mut seq = self.seq.lock().unwrap_or_else(|e| e.into_inner());
        *seq += 1;
        let event = GroupEvent { seq: *seq, kind };
        let _ = self.tx.send(event);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seq_从_1_开始严格递增_且和投递顺序一致() {
        let (sink, mut rx) = EventSink::new();
        sink.send(GroupEventKind::MemberActivity {
            member_id: "a".into(),
            activity: MemberActivity::Thinking,
        });
        sink.send(GroupEventKind::MemberActivity {
            member_id: "b".into(),
            activity: MemberActivity::Tool,
        });

        let first = rx.try_recv().expect("第一条");
        let second = rx.try_recv().expect("第二条");
        assert_eq!((first.seq, second.seq), (1, 2));
    }

    #[test]
    fn 事件字段名是前端读的那一套() {
        // 这条是内核侧的护栏；app crate 里还有一组手写 JSON 的 contract 测试。
        let kind = GroupEventKind::TurnStarted {
            turn_id: "t1".into(),
            group_id: "g1".into(),
            user_message_id: 7,
            user_text: "你好".into(),
            member_ids: vec!["m1".into()],
            mode: TurnMode::Sequential,
            started_at: 1,
        };
        let json = serde_json::to_value(&kind).unwrap();
        assert_eq!(json["kind"], "turnStarted");
        assert_eq!(json["turnId"], "t1");
        assert_eq!(json["userMessageId"], 7);
        assert_eq!(json["memberIds"][0], "m1");
        assert_eq!(json["mode"], "sequential");
    }

    #[test]
    fn 嵌套枚举的字段名也转成_camel_case() {
        let kind = GroupEventKind::MemberFinished {
            member_id: "m1".into(),
            message_id: Some(3),
            status: MemberStatus::Done,
            text: "好".into(),
            error: None,
            usage: None,
            elapsed_ms: 12,
        };
        let json = serde_json::to_value(&kind).unwrap();
        assert_eq!(json["kind"], "memberFinished");
        assert_eq!(json["memberId"], "m1");
        assert_eq!(json["messageId"], 3);
        assert_eq!(json["elapsedMs"], 12);
        assert_eq!(json["status"], "done");
    }
}
