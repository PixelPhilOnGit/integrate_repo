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
mod assistant_commands;
mod commands;
mod health;
mod kv_commands;
mod local_commands;
mod redis_commands;
mod secret_commands;
mod sql_commands;
mod ssh_commands;
mod task_commands;

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
        // 远端会话（连别的机器开 agent）。**单独一张表**：本机那两个注册表
        // 装的是同步的 `Arc<PtySession>`，这个装的是 async 的远端会话 ——
        // 合并的话每个方法都要 match 两种（见 `agents/src/remote.rs` 的说明）
        .manage(std::sync::Arc::new(devtoolkit_agents::RemoteRegistry::new()))
        // 本地终端（SSH 模块里那一类「本地连接」）。**第二份** AgentRegistry：
        // Tauri 的 state 按类型索引，同一个类型 manage 两次会 panic，而两张表
        // 必须分开（会话 id 是各自前端生成的，撞了会互相顶掉）—— 见 local_commands.rs
        .manage(local_commands::LocalTerminals::new())
        // 任务库。惰性打开（第一次真看任务的时候才碰磁盘）—— 见 task_commands.rs
        .manage(std::sync::Arc::new(task_commands::TasksState::new()))
        // 键值库（各模块的档案/指纹/偏好）。同样惰性打开 —— 见 kv_commands.rs
        .manage(std::sync::Arc::new(kv_commands::KvState::new()))
        // 助手：审批闸门 + 正在跑的 run + 会话记录库。包一层 Arc 是因为
        // 跑一次对话要活到 run 结束（转发任务得把 run 从表里摘掉）。
        .manage(std::sync::Arc::new(assistant_commands::AssistantRuntime::new()))
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
            agent_commands::agent_probe,
            local_commands::local_open,
            local_commands::local_write,
            local_commands::local_resize,
            local_commands::local_close,
            local_commands::local_close_all,
            task_commands::tasks_list,
            task_commands::tasks_counts,
            task_commands::tasks_create,
            task_commands::tasks_update,
            task_commands::tasks_delete,
            task_commands::tasks_progress,
            task_commands::tasks_add_progress,
            kv_commands::kv_open,
            kv_commands::kv_get,
            kv_commands::kv_set,

            // 系统钥匙串（连接密码）。见 secret_commands.rs
            secret_commands::secret_load,
            secret_commands::secret_store,
            secret_commands::secret_available,

            // 助手的凭据。**只写不读** —— 理由见 assistant_commands.rs
            assistant_commands::assistant_api_key_status,
            assistant_commands::assistant_set_api_key,
            // 助手跑一次对话 / 回答审批 / 停止 / 清空这个会话的历史。
            // 事件走 `Channel` 流式推回来
            assistant_commands::assistant_send,
            assistant_commands::assistant_approve,
            assistant_commands::assistant_cancel,
            assistant_commands::assistant_clear_session,
            // 配置通不通，一次往返问清楚（**不走 Channel** —— 理由见那个函数）
            assistant_commands::assistant_test_connection,
        ])
        .build(tauri::generate_context!())
        .unwrap_or_else(|e| {
            eprintln!("Devtoolkit 启动失败：{e}");
            std::process::exit(1);
        });

    // 健康日志。**为什么需要、记什么、文件在哪**，见 `health.rs` 的头部注释。
    // 一句话：真机上出过「跑一个多小时之后界面完全没反应、连窗口都关不掉」，
    // 而那种问题没有现场记录就只能猜。
    {
        use tauri::Manager as _;
        if let Ok(dir) = app.path().app_log_dir() {
            health::init(&dir);
        }
        // 崩了也要留一行（默认的 panic 输出在 GUI 子系统的 Windows 上没有控制台，
        // 等于什么也没留下）
        std::panic::set_hook(Box::new(|info| {
            health::line("PANIC", &format!("{info}"));
            eprintln!("Devtoolkit 崩了：{info}");
        }));

        let agents = app
            .state::<std::sync::Arc<devtoolkit_agents::AgentRegistry>>()
            .inner()
            .clone();
        let ssh = app
            .state::<std::sync::Arc<devtoolkit_ssh::SshRegistry>>()
            .inner()
            .clone();
        health::start_watchdog(app.handle().clone(), agents, ssh);
    }

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
            let registry = handle
                .state::<std::sync::Arc<devtoolkit_agents::AgentRegistry>>()
                .inner()
                .clone();

            // ⚠️ **不能在主线程上同步收尾。**
            //
            // `close_all` 里是 `TerminateJobObject`（**等整棵树死**）加两把锁，
            // 每一项都可能等很久（锁可能被一个卡在写 PTY 的线程握着）。
            // 主线程是**窗口事件循环**那根线：在这儿等，窗口就再也关不上了 ——
            // 用户看到的是「点了关闭没反应，只能去任务管理器杀进程」（真机上出过）。
            //
            // 所以丢给一个线程，然后**由进程退出兜底**：exit 之后内核会关掉
            // 我们持有的 Job Object 句柄，`KILL_ON_JOB_CLOSE` 保证那一树进程
            // 一起走。也就是说这条线程只是「尽量收拾得干净点」，不是最后一道保险
            // —— 最后一道保险一直是作业对象本身（见上面那段注释）。
            // 本地终端也是**独立进程**（shell），同样不能留着 —— 一起收
            let locals = handle
                .state::<local_commands::LocalTerminals>()
                .0
                .clone();

            // 远端会话（连别的机器那几个）：收拾它是**锦上添花**而不是保险 ——
            // 它是 SSH 连接，进程一退 socket 就断，远端那个 shell 自己会结束。
            // 所以这里丢给异步运行时就行，不占上面那个线程（`close_all` 是 async）
            let remotes = handle
                .state::<std::sync::Arc<devtoolkit_agents::RemoteRegistry>>()
                .inner()
                .clone();
            tauri::async_runtime::spawn(async move {
                remotes.close_all().await;
            });

            std::thread::Builder::new()
                .name("agents-exit".to_string())
                .spawn(move || {
                    registry.close_all();
                    locals.close_all();
                })
                .ok();
        }
    });
}
