//! Devtoolkit 的 Tauri 后端。
//!
//! 分层：
//!
//! * [`devtoolkit_core`] —— 纯逻辑：工作区路径安全边界、目录树、文件读写。
//!   不依赖 tauri，可以单独 `cargo test -p devtoolkit-core`。
//! * `commands` —— 薄薄一层 `#[tauri::command]` 包装。
//! * 本模块 —— 组装 Tauri 应用：注册插件、挂载 command。
//!
//! 「选目录 / 选文件」用 `tauri-plugin-dialog`，「偏好持久化」用
//! `tauri-plugin-store`，两者都在前端通过 JS 插件调用，这里只负责注册。

mod commands;
mod redis_commands;
mod sql_commands;

/// 供 `main.rs`（以及将来的移动端入口）调用。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 前端 invoke('plugin:dialog|open', ...) / open() from @tauri-apps/plugin-dialog
        .plugin(tauri_plugin_dialog::init())
        // 前端 Store.load('settings.json') —— 最近工作区、窗口尺寸等
        .plugin(tauri_plugin_store::Builder::default().build())
        // 活连接表。空表构造，不会碰 tokio 运行时，启动期是安全的。
        .manage(devtoolkit_redis::ConnectionRegistry::new())
        .manage(devtoolkit_sql::ConnectionRegistry::new())
        .invoke_handler(tauri::generate_handler![
            commands::list_tree,
            commands::read_text_file,
            commands::write_text_file,
            commands::create_diagram,
            commands::create_folder,
            commands::rename_entry,
            commands::delete_entry,
            commands::move_entry,
            commands::write_export,
            redis_commands::redis_connect,
            redis_commands::redis_disconnect,
            redis_commands::redis_exec,
            redis_commands::redis_keyspace,
            redis_commands::redis_select,
            redis_commands::redis_scan,
            redis_commands::redis_key_detail,
            sql_commands::sql_connect,
            sql_commands::sql_disconnect,
            sql_commands::sql_query,
            sql_commands::sql_databases,
            sql_commands::sql_tables,
            sql_commands::sql_use_database,
        ])
        .run(tauri::generate_context!())
        .unwrap_or_else(|e| {
            eprintln!("Devtoolkit 启动失败：{e}");
            std::process::exit(1);
        });
}
