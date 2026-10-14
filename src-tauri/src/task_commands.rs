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
//! # 「给任务挂个文件」为什么对话框开在这一侧
//!
//! 挂文件天生要碰「用户的某个文件」，上面那条规矩在这里差点破规矩：如果由
//! 前端 `pickFile` 拿到路径再传进来，参数表里就出现路径了 —— 而且这条链路
//! 能把**任意文件读出来还给前端**（拷进库、再按 id 读走），等于递出去一个
//! 万能读取原语。所以反过来：前端只说「给这条任务挂个文件」（只有 task_id），
//! 系统对话框由 Rust 弹、路径只活在 Rust 里，拷完之后前端拿到的是一个 id。
//! 读字节（缩略图）、用系统程序打开，也一样只收 id —— 路径从库里的行推出来。
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

use devtoolkit_tasks::{Attachment, Progress, Task, TaskCounts, TaskPatch, TaskStore};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

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

/// 一条任务的进度记录（从早到晚）。
#[tauri::command]
pub async fn tasks_progress(
    app: AppHandle,
    state: State<'_, Arc<TasksState>>,
    task_id: String,
) -> Result<Vec<Progress>, String> {
    let state = state.inner().clone();
    blocking(move || with_store(&app, &state, |store| store.progress_of(&task_id))).await
}

/// 记一笔进度。时间由 Rust 侧给（不给前端传 —— 那是这条记录的意义所在）。
#[tauri::command]
pub async fn tasks_add_progress(
    app: AppHandle,
    state: State<'_, Arc<TasksState>>,
    task_id: String,
    text: String,
) -> Result<Progress, String> {
    let state = state.inner().clone();
    blocking(move || with_store(&app, &state, |store| store.add_progress(&task_id, &text))).await
}

// ------------------------------------------------------------------ 资料

/// 给任务加一条**文字**资料。
#[tauri::command]
pub async fn tasks_add_text_attachment(
    app: AppHandle,
    state: State<'_, Arc<TasksState>>,
    task_id: String,
    text: String,
) -> Result<Attachment, String> {
    let state = state.inner().clone();
    blocking(move || with_store(&app, &state, |store| store.add_text(&task_id, &text))).await
}

/// 给任务挂一个**文件**：**系统对话框在 Rust 侧开**（理由见模块头）。
///
/// 返回 `None` = 用户取消了（不是错误）。开框期间**不持任务库的锁、不占
/// worker 线程**：用户可能在文件对话框里挑很久，那段时间别的命令照跑。
///
/// ⚠️ 收结果这段不能用 `unwrap`：插件内部派主线程失败时会把错误静默吞掉
/// （`let _ = run_on_main_thread(...)`），那时回调不落、发送端被 drop，
/// 我们这里收到的就是「通道关了」—— 那要变成一句人话，不能 panicked。
#[tauri::command]
pub async fn tasks_add_file_attachment(
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, Arc<TasksState>>,
    task_id: String,
) -> Result<Option<Attachment>, String> {
    // app crate 里没有 tokio 的 oneshot（见 assistant_commands.rs 那段），
    // 拿 `tauri::async_runtime::channel(1)` 当它用：容量 1 的新通道，
    // 回调侧 `try_send` 必然成功
    let (tx, mut rx) = tauri::async_runtime::channel(1);

    app.dialog()
        .file()
        .set_title("选一个文件挂到这条任务上")
        // 相对主窗口模态：框开着的时候用户切不到别的任务上去点第二次
        .set_parent(&window)
        .pick_file(move |picked| {
            // `into_path` 失败（非本地路径）当取消处理；`.simplified()` 把
            // Windows 的 `\\?\` 前缀化简掉 —— 那个前缀进 `cmd /C start` 会出岔子
            let path = picked
                .map(|p| p.simplified())
                .and_then(|p| p.into_path().ok());
            let _ = tx.try_send(path);
        });

    let picked = rx
        .recv()
        .await
        .ok_or_else(|| "选文件的对话框没能开起来（主线程忙不过来？）".to_string())?;
    let Some(path) = picked else {
        return Ok(None);
    };

    let state = state.inner().clone();
    blocking(move || with_store(&app, &state, |store| store.add_file(&task_id, &path)))
        .await
        .map(Some)
}

/// 改一条文字资料。
#[tauri::command]
pub async fn tasks_update_attachment_text(
    app: AppHandle,
    state: State<'_, Arc<TasksState>>,
    id: String,
    text: String,
) -> Result<Attachment, String> {
    let state = state.inner().clone();
    blocking(move || with_store(&app, &state, |store| store.update_text(&id, &text))).await
}

/// 删一条资料（文件资料连盘上那份一起删）。返回「本来有没有」。
#[tauri::command]
pub async fn tasks_delete_attachment(
    app: AppHandle,
    state: State<'_, Arc<TasksState>>,
    id: String,
) -> Result<bool, String> {
    let state = state.inner().clone();
    blocking(move || with_store(&app, &state, |store| store.remove_attachment(&id))).await
}

/// 读一条**文件**资料的字节（缩略图 / 应用内大图用）。
///
/// 返回的是**原始字节**（`ipc::Response`），不是 JSON —— 图片动辄几个 MB，
/// 走 serde 的数组会膨胀好几倍。前端 `invoke` 拿到的是 `ArrayBuffer`。
///
/// 上限 32 MiB：预览不该让一个 4 GB 的文件进内存。前端在库里的 `fileSize`
/// 上先看一眼，正常走不到这个上限；走到了（手改过的库、外面塞进来的行）
/// 有一句人话兜着。
#[tauri::command]
pub async fn tasks_attachment_read(
    app: AppHandle,
    state: State<'_, Arc<TasksState>>,
    id: String,
) -> Result<tauri::ipc::Response, String> {
    const MAX_PREVIEW: u64 = 32 * 1024 * 1024;

    let state = state.inner().clone();
    let bytes =
        blocking(move || with_store(&app, &state, |store| store.read_attachment(&id, MAX_PREVIEW)))
            .await?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// 用系统默认程序打开一条**文件**资料。路径只在 Rust 侧从库里那一行解析。
#[tauri::command]
pub async fn tasks_open_attachment(
    app: AppHandle,
    state: State<'_, Arc<TasksState>>,
    id: String,
) -> Result<(), String> {
    let state = state.inner().clone();
    let path = blocking(move || with_store(&app, &state, |store| store.attachment_file(&id))).await?;
    crate::open::open_path(&path)
}

/// 用系统浏览器打开一个链接（资料文字里点出来的）。只放行 http/https。
#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    crate::open::open_url(&url)
}

// ------------------------------------------------------------------ 契约测试

/// ⚠️ 和前几组一个理由（见 `request_commands.rs` 里那段说明）：这测的是
/// **前端和 Rust 之间那条缝** —— 浏览器版 e2e 走 `services/web.ts` 的假实现
/// （根本不过 serde），内核的测试又住在 Rust 里。字面量是**手写的
/// 「前端会读到的东西」**，不是照着结构体拼的。
#[cfg(test)]
mod contract {
    use super::*;
    use devtoolkit_tasks::{Attachment, AttachmentKind, TaskStatus};
    use serde_json::json;

    #[test]
    fn attachment_的_json_形状和前端那份类型对得上() {
        let text = Attachment {
            id: "att_ff_1".into(),
            task_id: "task_ff_0".into(),
            kind: AttachmentKind::Text,
            text: "一段结论".into(),
            file_name: String::new(),
            file_size: 0,
            created_at: 1_750_000_000_000,
        };
        assert_eq!(
            serde_json::to_value(&text).unwrap(),
            json!({
                "id": "att_ff_1",
                "taskId": "task_ff_0",
                "kind": "text",
                "text": "一段结论",
                "fileName": "",
                "fileSize": 0,
                "createdAt": 1_750_000_000_000_i64
            })
        );

        let file = Attachment {
            id: "att_ff_2".into(),
            task_id: "task_ff_0".into(),
            kind: AttachmentKind::File,
            text: String::new(),
            file_name: "截图.png".into(),
            file_size: 12_345,
            created_at: 1_750_000_000_001,
        };
        let v = serde_json::to_value(&file).unwrap();
        assert_eq!(v["kind"], json!("file"));
        assert_eq!(v["fileName"], json!("截图.png"));
        assert_eq!(v["fileSize"], json!(12_345));
    }

    #[test]
    fn task_里内嵌的附件字段名也是_camelcase_而且_note_不再出现() {
        // 内嵌一层的字段名最容易漏 rename_all —— 漏了前端拿到的是 fileName
        // 对不上、TS 那边是 undefined，界面上「条目名字是空的」这类 bug
        // 特别难往回查
        let task = Task {
            id: "task_ff_0".into(),
            title: "标题".into(),
            body: "描述".into(),
            status: TaskStatus::Doing,
            created_at: 1,
            updated_at: 2,
            done_at: None,
            archived: false,
            attachments: vec![Attachment {
                id: "att_ff_2".into(),
                task_id: "task_ff_0".into(),
                kind: AttachmentKind::File,
                text: String::new(),
                file_name: "截图.png".into(),
                file_size: 12_345,
                created_at: 3,
            }],
        };
        let v = serde_json::to_value(&task).unwrap();
        assert_eq!(v["attachments"][0]["taskId"], json!("task_ff_0"));
        assert_eq!(v["attachments"][0]["fileName"], json!("截图.png"));
        assert_eq!(v["attachments"][0]["fileSize"], json!(12_345));
        assert!(v.get("note").is_none(), "note 不该再出现在 IPC 上");
    }
}
