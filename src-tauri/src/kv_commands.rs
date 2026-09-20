//! 键值存储的 Tauri command。
//!
//! 和任务那套一样**只做搬运**：逻辑在 `devtoolkit-store` 里（能脱离 WebKit 测）。
//!
//! # 三个命令，一个关键约定
//!
//! * `kv_open(module)` —— 开库 + **把老 JSON 搬进来**（幂等）；
//! * `kv_get` / `kv_set` —— 读写，值一律是**原样的 JSON 文本**。
//!
//! ⚠️ **`kv_open` 失败时前端要退回老的 JSON 实现**（继续用 `tauri-plugin-store`），
//! 而不是把错误弹给用户看：搬迁这一步宁可这次不做，也不能让用户打不开自己的档案。
//! 前端那一侧的判断在 `shared/platform/kv.ts` 里。
//!
//! # 库文件
//!
//! `app_data_dir()/devtoolkit.db` —— **和老 JSON 同一个目录**（那套插件也是落在
//! `BaseDirectory::AppData`），所以搬迁就是同目录里读一个文件、写一张表。

use std::sync::{Arc, Mutex};

use devtoolkit_store::Store;
use tauri::{AppHandle, Manager, State};

/// 惰性打开的库。整个应用一份（各模块共用这一个文件，靠 key 前缀分家）。
pub struct KvState(Mutex<Option<Store>>);

impl KvState {
    pub fn new() -> Self {
        KvState(Mutex::new(None))
    }
}

impl Default for KvState {
    fn default() -> Self {
        Self::new()
    }
}

/// 打开（或复用）库，把 `f` 跑在上面。
fn with_store<T>(
    app: &AppHandle,
    state: &KvState,
    f: impl FnOnce(&Store) -> Result<T, devtoolkit_store::StoreError>,
) -> Result<T, String> {
    let mut guard = state.0.lock().map_err(|_| "键值库的锁坏了".to_string())?;

    if guard.is_none() {
        let dir = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("拿不到应用数据目录：{e}"))?;
        let store = Store::open(&dir.join("devtoolkit.db")).map_err(|e| e.to_string())?;
        *guard = Some(store);
    }

    let Some(store) = guard.as_ref() else {
        return Err("键值库没打开".to_string());
    };
    f(store).map_err(|e| e.to_string())
}

async fn blocking<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("键值库的线程没能跑起来：{e}"))?
}

/// 开这个模块 + 搬迁老文件。
///
/// **只有这个命令会返回「搬迁失败」那类错误** —— 前端看到它就该退回老实现。
#[tauri::command]
pub async fn kv_open(
    app: AppHandle,
    state: State<'_, Arc<KvState>>,
    module: String,
) -> Result<(), String> {
    let state = state.inner().clone();
    blocking(move || {
        let dir = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("拿不到应用数据目录：{e}"))?;
        with_store(&app, &state, |store| store.import_legacy_json(&dir, &module))
    })
    .await
}

#[tauri::command]
pub async fn kv_get(
    app: AppHandle,
    state: State<'_, Arc<KvState>>,
    module: String,
    key: String,
) -> Result<Option<String>, String> {
    let state = state.inner().clone();
    blocking(move || with_store(&app, &state, |store| store.get(&module, &key))).await
}

#[tauri::command]
pub async fn kv_set(
    app: AppHandle,
    state: State<'_, Arc<KvState>>,
    module: String,
    key: String,
    value: String,
) -> Result<(), String> {
    let state = state.inner().clone();
    blocking(move || with_store(&app, &state, |store| store.set(&module, &key, &value))).await
}
