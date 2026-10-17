//! 群组协作的 Tauri command。
//!
//! 和前面几个模块的命令层一样**只做搬运**：真正的逻辑在 `devtoolkit-group` 里，
//! 那样它能脱离 WebKit/GTK 跑测试（桩程序 + 内存库）。
//!
//! # 库文件在哪：路径由 Rust 算
//!
//! `app_data_dir()/groups.db`（场景化时 `groups@<场景>.db`）。参数表里没有路径 ——
//! 和任务/知识库同一条规矩。
//!
//! # 命令分工（和 `request_commands` / `assistant_commands` 一致）
//!
//! * `Err` 只表示「这一轮**没起来**」：群不存在、工作目录不对、没有可用成员、
//!   `@` 非法、同群已有一轮、空消息。
//! * 单个 CLI 起不来 / 超时 / 非零退出 → `memberFinished { status: failed }`
//!   走 Channel，不是命令 Err。
//!
//! # Channel 生命周期
//!
//! 每次 `group_send` 前端新建一个 Channel；这里把 Channel **move 进转发任务**，
//! 命令立刻返回 `SendAck`。⚠️ Channel 留在命令函数里的话，一返回就 drop，
//! 前端一条事件都收不到，而且不报错（这个仓踩过）。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use devtoolkit_group::adapter::CliKind;
use devtoolkit_group::event::{EventSink, GroupEvent};
use devtoolkit_group::store::{
    GroupConfigInput, GroupDetail, GroupMessage, GroupStore, GroupSummary,
};
use devtoolkit_group::turn::{self, TurnControl, TurnInput};
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

// ---------------------------------------------------------------- 应用级状态

/// 惰性打开的群组库（按场景缓存）。
pub struct GroupState(Mutex<Option<(String, Arc<GroupStore>)>>);

impl GroupState {
    pub fn new() -> Self {
        GroupState(Mutex::new(None))
    }

    /// 丢掉缓存（切场景时由 `scenario_set` 调；下次用到时按新场景重开）。
    pub fn reset(&self) {
        if let Ok(mut guard) = self.0.lock() {
            *guard = None;
        }
    }
}

impl Default for GroupState {
    fn default() -> Self {
        Self::new()
    }
}

struct ActiveTurn {
    turn_id: String,
    control: TurnControl,
}

/// 正在跑的轮次（按群 id）。`group_stop` 从这里拿杀树开关 —— **不依赖
/// 跑这一轮的那个任务还活着**。
#[derive(Default)]
pub struct GroupRuntime {
    active: Mutex<HashMap<String, ActiveTurn>>,
}

impl GroupRuntime {
    pub fn new() -> Self {
        Self::default()
    }

    /// 停掉所有群：切换场景 / 应用退出时用。
    pub fn stop_all(&self) {
        let turns: Vec<ActiveTurn> = {
            let mut guard = self.active.lock().unwrap_or_else(|e| e.into_inner());
            guard.drain().map(|(_, v)| v).collect()
        };
        for turn in turns {
            turn.control.stop();
        }
    }

    pub fn is_running(&self, group_id: &str) -> bool {
        self.active
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains_key(group_id)
    }

    /// 开一轮前登记。**已经有活跃轮次就返回 false**（同一群不允许并发轮次）。
    fn try_start(&self, group_id: &str, turn_id: &str, control: TurnControl) -> bool {
        let mut guard = self.active.lock().unwrap_or_else(|e| e.into_inner());
        if guard.contains_key(group_id) {
            return false;
        }
        guard.insert(
            group_id.to_string(),
            ActiveTurn {
                turn_id: turn_id.to_string(),
                control,
            },
        );
        true
    }

    /// 停掉某一轮（id 对得上才动手；幂等）。
    pub fn stop(&self, group_id: &str, turn_id: &str) {
        let mut guard = self.active.lock().unwrap_or_else(|e| e.into_inner());
        let matches = guard
            .get(group_id)
            .map(|t| t.turn_id == turn_id)
            .unwrap_or(false);
        if !matches {
            return;
        }
        if let Some(turn) = guard.remove(group_id) {
            turn.control.stop();
        }
    }

    /// 一轮收尾：把自己从表里摘掉（id 对不上就不动 —— 那是更新的一轮）。
    fn finish(&self, group_id: &str, turn_id: &str) {
        let mut guard = self.active.lock().unwrap_or_else(|e| e.into_inner());
        let matches = guard
            .get(group_id)
            .map(|t| t.turn_id == turn_id)
            .unwrap_or(false);
        if matches {
            guard.remove(group_id);
        }
    }
}

// ---------------------------------------------------------------- 开库 / 线程

fn store(app: &AppHandle, state: &GroupState) -> Result<Arc<GroupStore>, String> {
    let want = crate::scenario_commands::current();
    let mut guard = state.0.lock().map_err(|_| "群组库的锁坏了".to_string())?;

    // 纵深防御：正常路径由 `scenario_set` 清过；漏清一次就是跨场景串数据。
    if guard.as_ref().map(|(s, _)| s.as_str()) != Some(want.as_str()) {
        *guard = None;
    }
    if guard.is_none() {
        let dir = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("拿不到应用数据目录：{e}"))?;
        let file = devtoolkit_group::store::db_file_name(&want);
        let opened = GroupStore::open(&dir.join(file)).map_err(|e| e.to_string())?;
        *guard = Some((want, Arc::new(opened)));
    }
    let Some((_, store)) = guard.as_ref() else {
        return Err("群组库没打开".to_string());
    };
    Ok(Arc::clone(store))
}

async fn blocking<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("群组库的线程没能跑起来：{e}"))?
}

fn new_turn_id() -> String {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("turn_{ms}_{n}")
}

// ---------------------------------------------------------------- 对外类型

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendAck {
    pub turn_id: String,
    pub member_ids: Vec<String>,
    pub user_message_id: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliProbe {
    pub available: bool,
    pub program: String,
    pub version: Option<String>,
    pub error: Option<String>,
}

// ---------------------------------------------------------------- 群 CRUD

#[tauri::command]
pub async fn group_list(
    app: AppHandle,
    state: State<'_, Arc<GroupState>>,
) -> Result<Vec<GroupSummary>, String> {
    let state = Arc::clone(state.inner());
    blocking(move || {
        let store = store(&app, &state)?;
        store.list_groups().map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn group_create(
    app: AppHandle,
    state: State<'_, Arc<GroupState>>,
    name: String,
) -> Result<GroupDetail, String> {
    let state = Arc::clone(state.inner());
    blocking(move || {
        let store = store(&app, &state)?;
        store.create_group(&name).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn group_get(
    app: AppHandle,
    state: State<'_, Arc<GroupState>>,
    group_id: String,
) -> Result<GroupDetail, String> {
    let state = Arc::clone(state.inner());
    blocking(move || {
        let store = store(&app, &state)?;
        store.get_group(&group_id).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn group_save(
    app: AppHandle,
    state: State<'_, Arc<GroupState>>,
    config: GroupConfigInput,
) -> Result<GroupDetail, String> {
    let state = Arc::clone(state.inner());
    blocking(move || {
        let store = store(&app, &state)?;
        store.save_group(&config).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn group_delete(
    app: AppHandle,
    state: State<'_, Arc<GroupState>>,
    runtime: State<'_, Arc<GroupRuntime>>,
    group_id: String,
) -> Result<bool, String> {
    if runtime.is_running(&group_id) {
        return Err("这个群还有一轮在跑 —— 先停止，或者等它跑完".to_string());
    }
    let state = Arc::clone(state.inner());
    blocking(move || {
        let store = store(&app, &state)?;
        store.delete_group(&group_id).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn group_history(
    app: AppHandle,
    state: State<'_, Arc<GroupState>>,
    group_id: String,
    limit: Option<u32>,
) -> Result<Vec<GroupMessage>, String> {
    let limit = limit.unwrap_or(200).clamp(1, 1000) as usize;
    let state = Arc::clone(state.inner());
    blocking(move || {
        let store = store(&app, &state)?;
        store.history(&group_id, limit).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn group_clear_history(
    app: AppHandle,
    state: State<'_, Arc<GroupState>>,
    runtime: State<'_, Arc<GroupRuntime>>,
    group_id: String,
) -> Result<(), String> {
    if runtime.is_running(&group_id) {
        return Err("这个群还有一轮在跑 —— 先停止，或者等它跑完".to_string());
    }
    let state = Arc::clone(state.inner());
    blocking(move || {
        let store = store(&app, &state)?;
        store.clear_history(&group_id).map_err(|e| e.to_string())
    })
    .await
}

// ---------------------------------------------------------------- 跑一轮

/// 发一句话，跑一轮。立即返回；事件走 `Channel`。
#[tauri::command]
pub async fn group_send(
    app: AppHandle,
    state: State<'_, Arc<GroupState>>,
    runtime: State<'_, Arc<GroupRuntime>>,
    group_id: String,
    text: String,
    mention_ids: Vec<String>,
    channel: Channel<GroupEvent>,
) -> Result<SendAck, String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("消息不能为空".to_string());
    }

    let state = Arc::clone(state.inner());
    let runtime = Arc::clone(runtime.inner());
    let store = blocking({
        let app = app.clone();
        let state = Arc::clone(&state);
        move || store(&app, &state)
    })
    .await?;

    // ① 读群 + 校验工作目录 + 选成员（@ 在这里就报错，不静默退化）。
    let (group, selected) = blocking({
        let store = Arc::clone(&store);
        let group_id = group_id.clone();
        let mentions = mention_ids.clone();
        move || {
            let group = store.get_group(&group_id).map_err(|e| e.to_string())?;
            if group.workspace.trim().is_empty() {
                return Err("先给这个群选一个工作目录".to_string());
            }
            let ws = devtoolkit_core::Workspace::open(&group.workspace)
                .map_err(|e| format!("工作目录不能用：{e}"))?;
            let mut group = group;
            group.workspace = ws.root().display().to_string();
            let selected =
                turn::select_members(&group, &mentions).map_err(|e| e.to_string())?;
            Ok((group, selected))
        }
    })
    .await?;

    let turn_id = new_turn_id();
    let (sink, rx) = EventSink::new();
    let (control, cancel_rx) = TurnControl::new();

    // ② 同一群只允许一轮（原子登记；DB 里的 running 只用于崩溃恢复）。
    if !runtime.try_start(&group.id, &turn_id, control.clone()) {
        return Err("这个群还有一轮在跑 —— 先停止，或者等它跑完".to_string());
    }

    // ③ 开轮次 + 取历史（不含本轮）。
    let started = blocking({
        let store = Arc::clone(&store);
        let group = group.clone();
        let turn_id = turn_id.clone();
        let text = text.clone();
        let mentions = mention_ids.clone();
        move || {
            let started = store
                .begin_turn(&turn_id, &group.id, &text, &mentions, group.mode)
                .map_err(|e| e.to_string())?;
            let history = store
                .recent_context(&group.id, group.context_turns.max(1) as usize)
                .map_err(|e| e.to_string())?;
            Ok((started, history))
        }
    })
    .await;

    let (started, history) = match started {
        Ok(v) => v,
        Err(e) => {
            runtime.finish(&group.id, &turn_id);
            return Err(e);
        }
    };

    let member_ids: Vec<String> = selected.iter().map(|m| m.id.clone()).collect();
    let input = TurnInput {
        group: group.clone(),
        turn_id: turn_id.clone(),
        user_text: text,
        mention_ids,
        mode: group.mode,
        history: turn::context_from_history(&history),
        store: Arc::clone(&store),
        user_message_id: started.user_message_id,
        started_at: started.started_at,
    };

    // ④ 起跑。Channel 必须 move 进来（见模块头）。
    let finish_group = group.id.clone();
    let finish_turn = turn_id.clone();
    let runtime_for_task = Arc::clone(&runtime);
    tauri::async_runtime::spawn(async move {
        let pump = tauri::async_runtime::spawn(async move {
            let mut rx = rx;
            while let Some(event) = rx.recv().await {
                let _ = channel.send(event);
            }
        });
        turn::run_turn(input, sink, control, cancel_rx).await;
        let _ = pump.await;
        runtime_for_task.finish(&finish_group, &finish_turn);
    });

    Ok(SendAck {
        turn_id,
        member_ids,
        user_message_id: started.user_message_id,
    })
}

/// 停止某一轮。幂等：找不到也 Ok（用户可能连点两下）。
#[tauri::command]
pub fn group_stop(
    runtime: State<'_, Arc<GroupRuntime>>,
    group_id: String,
    turn_id: String,
) {
    runtime.stop(&group_id, &turn_id);
}

// ---------------------------------------------------------------- 探测

/// 探测一个 CLI 能不能跑（`--version`，5 秒超时）。
///
/// 「起不来」是**结果**不是错误：前端要显示版本或失败原因。
#[tauri::command]
pub async fn group_probe(
    kind: CliKind,
    command: Option<String>,
) -> Result<CliProbe, String> {
    let program = command
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty())
        .unwrap_or_else(|| kind.default_program().to_string());
    if program.is_empty() {
        return Err("自定义工具要先填命令".to_string());
    }

    match devtoolkit_group::proc::probe(&program, Duration::from_secs(5)).await {
        Ok(version) => Ok(CliProbe {
            available: true,
            program,
            version: Some(version),
            error: None,
        }),
        Err(e) => Ok(CliProbe {
            available: false,
            program,
            version: None,
            error: Some(e.to_string()),
        }),
    }
}

// ---------------------------------------------------------------- 契约测试

#[cfg(test)]
mod contract {
    //! 手写前端会读到的 JSON，钉住字段名。
    //!
    //! 这条缝两端各自的测试都盖不到（前端跑假实现、Rust 测试直接构造值）。
    //! 和 `request_commands` / `assistant_commands` 的 contract 测试同一个理由。

    use super::*;

    #[test]
    fn send_ack_字段名是前端读的那一套() {
        let ack = SendAck {
            turn_id: "t1".into(),
            member_ids: vec!["m1".into()],
            user_message_id: 7,
        };
        let json = serde_json::to_value(&ack).unwrap();
        assert_eq!(json["turnId"], "t1");
        assert_eq!(json["memberIds"][0], "m1");
        assert_eq!(json["userMessageId"], 7);
    }

    #[test]
    fn 配置反序列化认前端那套_camel_case() {
        let input: GroupConfigInput = serde_json::from_value(serde_json::json!({
            "id": "g1",
            "name": "项目群",
            "workspace": "/work",
            "mode": "sequential",
            "contextTurns": 6,
            "contextChars": 24000,
            "timeoutSecs": 600,
            "members": [{
                "id": "",
                "name": "甲",
                "kind": "claude",
                "command": "",
                "model": "sonnet",
                "rolePrompt": "你负责后端",
                "permission": "workspaceWrite",
                "extraArgs": [],
                "position": 0,
                "enabled": true
            }]
        }))
        .expect("前端形状该能反序列化");

        assert_eq!(input.context_turns, 6);
        assert_eq!(input.members[0].role_prompt, "你负责后端");
        assert_eq!(input.members[0].permission.as_str(), "workspace-write");
    }

    #[test]
    fn 探测结果字段名() {
        let probe = CliProbe {
            available: true,
            program: "claude".into(),
            version: Some("1.2.3".into()),
            error: None,
        };
        let json = serde_json::to_value(&probe).unwrap();
        assert_eq!(json["available"], true);
        assert_eq!(json["program"], "claude");
        assert_eq!(json["version"], "1.2.3");
    }
}
