//! rustDraw 的 Tauri 后端。
//!
//! 分层：
//!
//! * [`rustdraw_core`] —— 纯逻辑：工作区路径安全边界、目录树、文件读写。
//!   不依赖 tauri，可以单独 `cargo test -p rustdraw-core`。
//! * `commands` —— 薄薄一层 `#[tauri::command]` 包装。
//! * 本模块 —— 组装 Tauri 应用：注册插件、挂载 command。
//!
//! 「选目录 / 选文件」用 `tauri-plugin-dialog`，「偏好持久化」用
//! `tauri-plugin-store`，两者都在前端通过 JS 插件调用，这里只负责注册。

mod commands;

/// 供 `main.rs`（以及将来的移动端入口）调用。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 前端 invoke('plugin:dialog|open', ...) / open() from @tauri-apps/plugin-dialog
        .plugin(tauri_plugin_dialog::init())
        // 前端 Store.load('settings.json') —— 最近工作区、窗口尺寸等
        .plugin(tauri_plugin_store::Builder::default().build())
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
        ])
        .run(tauri::generate_context!())
        .unwrap_or_else(|e| {
            eprintln!("rustDraw 启动失败：{e}");
            std::process::exit(1);
        });
}
