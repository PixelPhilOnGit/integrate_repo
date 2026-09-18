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

mod agent_commands;
mod commands;
mod redis_commands;
mod sql_commands;
mod ssh_commands;

/// 供 `main.rs`（以及将来的移动端入口）调用。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        // 前端 invoke('plugin:dialog|open', ...) / open() from @tauri-apps/plugin-dialog
        .plugin(tauri_plugin_dialog::init())
        // 前端 Store.load('settings.json') —— 最近工作区、窗口尺寸等
        .plugin(tauri_plugin_store::Builder::default().build())
        // 活连接表。空表构造，不会碰 tokio 运行时，启动期是安全的。
        .manage(devtoolkit_redis::ConnectionRegistry::new())
        .manage(devtoolkit_sql::ConnectionRegistry::new())
        // SSH 的会话表包了一层 Arc：转发任务要活到会话结束，还要回头把会话
        // 从表里摘掉，所以它得拿到一份能搬进 tokio::spawn 的句柄。
        // 另外两个模块不需要 —— 它们的命令都是「一次往返、拿到就返回」。
        .manage(std::sync::Arc::new(devtoolkit_ssh::SshRegistry::new()))
        // 智能体会话的 pane 表。同样包一层 Arc：读线程和等待线程要活到会话结束，
        // 而它们收尾时（转发任务里）要回头把会话从表里摘掉（`forget`）。
        .manage(std::sync::Arc::new(devtoolkit_agents::AgentRegistry::new()))
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
            ssh_commands::ssh_open,
            ssh_commands::ssh_write,
            ssh_commands::ssh_resize,
            ssh_commands::ssh_close,
            ssh_commands::ssh_close_all,
            agent_commands::agent_open,
            agent_commands::agent_write,
            agent_commands::agent_resize,
            agent_commands::agent_close,
            agent_commands::agent_close_all,
            agent_commands::agent_take_events,
            agent_commands::agent_events_dir,
            agent_commands::agent_integration_status,
            agent_commands::agent_integration_apply,
            agent_commands::agent_integration_revert,
        ])
        .build(tauri::generate_context!())
        .unwrap_or_else(|e| {
            eprintln!("Devtoolkit 启动失败：{e}");
            std::process::exit(1);
        });

    // 退出时**必须**把那一屏 pane 收干净。
    //
    // ⚠️ 这一条和别的模块不一样：用户点「关闭窗口」之后，Rust 侧那些进程
    // **不会自己死**（它们是独立的进程，不是我们的线程）—— 留下的是一屏
    // 还在跑的 agent：还在调 API、还在改文件、下次开机还在。用户完全看不见它们。
    //
    // 为什么是 `RunEvent::Exit` 而不是 `ExitRequested`：后者可以被前端取消
    // （比如「还有没保存的东西」那种确认框），在能取消的时候就去杀进程，
    // 一旦用户点了「取消」，agent 已经被杀了 —— 而界面还开着。
    //
    // Windows 上还有一道更硬的保险：每个 pane 都在一个 Job Object 里
    // （`KILL_ON_JOB_CLOSE`），Devtoolkit **崩了**也一样收尸。Unix 上则靠
    // pty 主端被关掉时内核给前台进程组发的 SIGHUP 兜底。
    app.run(|handle, event| {
        if let tauri::RunEvent::Exit = event {
            use tauri::Manager as _;
            let registry = handle.state::<std::sync::Arc<devtoolkit_agents::AgentRegistry>>();
            registry.close_all();
        }
    });
}
