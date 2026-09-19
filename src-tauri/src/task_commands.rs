//! 任务模块的 Tauri command。
//!
//! 和前面几个模块的命令层一样**只做搬运**：真正的逻辑在 `devtoolkit-tasks` 里，
//! 那样它能脱离 WebKit/GTK 跑测试（起一个临时库文件就行）。
//!
//! # 库文件在哪：**路径由 Rust 算，前端一个路径参数都没有**
//!
//! `app_data_dir()/tasks.db`。和智能体会话那套（改用户主目录里的文件）同一条
//! 规矩：参数表里不该出现路径 —— 前端即使被 XSS 拿到，也只能在「这个应用自己
//! 的数据目录」里读写，而不是往任意路径写。
//!
//! # 为什么惰性打开
//!
//! **不在启动路径上开库**：磁盘慢、目录不可写、库文件被别人锁着 —— 这些都不该
//! 让应用起不来。第一次真要看任务的时候再开，那时候报错才有意义（用户正盯着
//! 任务列表，他能看懂「任务库打不开」）。
//!
//! # 为什么都丢进 blocking 线程池
//!
//! SQLite 是**同步**的：查一次要读盘。放在 tokio 的工作线程上，磁盘一卡就把
//! 命令通道堵住了 —— 和 `agent_write` 那条一个道理（见 HANDOFF 里那次的教训）。

use std::sync::{Arc, Mutex};

use devtoolkit_tasks::{Task, TaskCounts, TaskPatch, TaskStore};
use tauri::{AppHandle, Manager, State};

/// 惰性打开的库。整个应用一份。
pub struct TasksState(Mutex<Option<TaskStore>>);

impl TasksState {
    pub fn new() -> Self {
        TasksState(Mutex::new(None))
    }
}

impl Default for TasksState {
    fn default() -> Self {
        Self::new()
    }
}

/// 打开（或复用）库，把 `f` 跑在上面。
///
/// 锁只在这段里握着，而且**不 await**（见模块头：整段都在 blocking 线程里跑）。
fn with_store<T>(
    app: &AppHandle,
    state: &TasksState,
    f: impl FnOnce(&TaskStore) -> Result<T, devtoolkit_tasks::TaskError>,
) -> Result<T, String> {
    let mut guard = state.0.lock().map_err(|_| "任务库的锁坏了".to_string())?;

    if guard.is_none() {
        let dir = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("拿不到应用数据目录：{e}"))?;
        let store = TaskStore::open(&dir.join("tasks.db")).map_err(|e| e.to_string())?;
        *guard = Some(store);
    }

    let Some(store) = guard.as_ref() else {
        return Err("任务库没打开".to_string());
    };
    f(store).map_err(|e| e.to_string())
}

/// 把一段活儿丢进 blocking 池跑（见模块头）。
async fn blocking<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("任务库的线程没能跑起来：{e}"))?
}

#[tauri::command]
pub async fn tasks_list(
    app: AppHandle,
    state: State<'_, Arc<TasksState>>,
) -> Result<Vec<Task>, String> {
    let state = state.inner().clone();
    blocking(move || with_store(&app, &state, |store| store.list())).await
}

#[tauri::command]
pub async fn tasks_counts(
    app: AppHandle,
    state: State<'_, Arc<TasksState>>,
) -> Result<TaskCounts, String> {
    let state = state.inner().clone();
    blocking(move || with_store(&app, &state, |store| store.counts())).await
}

#[tauri::command]
pub async fn tasks_create(
    app: AppHandle,
    state: State<'_, Arc<TasksState>>,
    title: String,
    body: String,
) -> Result<Task, String> {
    let state = state.inner().clone();
    blocking(move || with_store(&app, &state, |store| store.create(&title, &body))).await
}

#[tauri::command]
pub async fn tasks_update(
    app: AppHandle,
    state: State<'_, Arc<TasksState>>,
    id: String,
    patch: TaskPatch,
) -> Result<Task, String> {
    let state = state.inner().clone();
    blocking(move || with_store(&app, &state, |store| store.update(&id, &patch))).await
}

#[tauri::command]
pub async fn tasks_delete(
    app: AppHandle,
    state: State<'_, Arc<TasksState>>,
    id: String,
) -> Result<bool, String> {
    let state = state.inner().clone();
    blocking(move || with_store(&app, &state, |store| store.delete(&id))).await
}
