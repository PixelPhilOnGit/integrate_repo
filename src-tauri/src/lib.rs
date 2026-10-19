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
mod group_commands;
mod health;
mod kb_commands;
mod kv_commands;
mod local_commands;
mod open;
mod redis_commands;
mod request_commands;
mod scenario_commands;
mod secret_commands;
mod sql_commands;
mod ssh_commands;
mod task_commands;
mod window_commands;

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
        // 会话 → 窗口 的归属表（多窗口）。纯逻辑在 agents crate 里
        // （CI 测得到），这里只是挂上。什么时候登记/收割见 `window_commands.rs`。
        .manage(std::sync::Arc::new(devtoolkit_agents::WindowOwnership::new()))
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
        // 知识库：打开过的 vault 句柄表（vault + 派生索引 + 取消开关），
        // 惰性打开 —— 见 kb_commands.rs
        .manage(std::sync::Arc::new(kb_commands::KbState::new()))
        // 助手：审批闸门 + 正在跑的 run + 会话记录库。包一层 Arc 是因为
        // 跑一次对话要活到 run 结束（转发任务得把 run 从表里摘掉）。
        .manage(std::sync::Arc::new(assistant_commands::AssistantRuntime::new()))
        // 群组协作：惰性打开的库（按场景缓存）+ 正在跑的轮次（杀树开关）。
        // 包 Arc：一轮要活到跑完，命令层和退出收尸都要拿到同一份。
        .manage(std::sync::Arc::new(group_commands::GroupState::new()))
        .manage(std::sync::Arc::new(group_commands::GroupRuntime::new()))
        // ⚠️ **为什么要建一个（在 Linux 上还看不见的）菜单**
        //
        // 用户报过「输入的时候 Ctrl+V 不会被识别为粘贴，例如终端那个页面」。
        // 查下来根因不在前端（七个全局键盘监听没有一处碰 C/V）：**Linux 的
        // webkit2gtk 和 macOS 上，webview 里的剪贴板快捷键要应用注册了带加速键的
        // 菜单项才认** —— 这个应用此前一个菜单都没有，于是三个平台里有两个是坏的
        // （Windows 的 WebView2 自己处理，所以那边一直好的）。
        //
        // 修法是 Hoppscotch 踩过同一个坑之后的办法：**建一个 Edit 菜单带标准加速键，
        // 然后在 Linux 上立刻藏起来**。GTK 把加速键绑在 accel map 里、和菜单栏可不可见
        // 无关，所以藏起来之后快捷键照样能用，界面上一个字都不多。
        //
        // ⚠️ macOS 上**不藏**：那边的惯例是应用必须有菜单栏（在屏幕顶部），
        // 藏了反而怪。而它同样需要那些加速键才认 Cmd+C/V。
        .setup(|app| {
            use tauri::menu::{Menu, PredefinedMenuItem, Submenu};

            // ⚠️ **窗口在这里手动建，不在 `tauri.conf.json` 的 `app.windows` 里。**
            //
            // 因为 `enable_clipboard_access()`（下面那一句，**Windows 和 Linux 上
            // 就是「Ctrl+V 不被识别为粘贴」的修法**）**只有 builder 上有** ——
            // 配置里没有对应的项。改回配置建窗口的话，这个能力会**静默消失**：
            // 应用照常起，只是粘贴又坏了。
            //
            // 官方源码原话（`tauri/src/webview/mod.rs`）：
            //   Enables clipboard access for the page rendered on **Linux** and **Windows**.
            //   **macOS** doesn't provide such method and is always enabled by default,
            //   but you still need to add menu item accelerators to use shortcuts.
            //
            // 也就是说**三个平台各有各的缺口，这个应用一个都没补**（此前没有菜单、
            // 窗口又是配置建的）。用户报的就是 Windows 上那一个。
            // 构造器在 `window_commands.rs`：`main` 和新窗口（多窗口）共用同一份
            // flag —— 这些每窗口的能力（clipboard、drag-drop）漏一个就是一类
            // 悄悄坏掉的交互，两边各写一遍迟早漂移。
            window_commands::build_workspace_window(app, "main", None, None)?;

            let edit = Submenu::with_items(
                app,
                "编辑",
                true,
                &[
                    &PredefinedMenuItem::undo(app, None)?,
                    &PredefinedMenuItem::redo(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, None)?,
                    &PredefinedMenuItem::copy(app, None)?,
                    &PredefinedMenuItem::paste(app, None)?,
                    &PredefinedMenuItem::select_all(app, None)?,
                ],
            )?;
            app.set_menu(Menu::with_items(app, &[&edit])?)?;

            #[cfg(target_os = "linux")]
            {
                // 藏起来 —— 这个应用的设计里没有菜单栏，用户不该看见它。
                // （加速键不跟着消失，见上面那段。）
                let _ = app.hide_menu();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_tree,
            // 文件浏览器（智能体会话的「文件」标签）：单层列目录 + 三态预览 +
            // 用系统程序打开。见 commands.rs 里的 doc 和 core 的 file_browser 测试
            commands::fs_list_dir,
            commands::fs_read_preview,
            commands::fs_open_path,
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
            // 远端目录浏览（添加远端工作目录的两步向导用）
            agent_commands::agent_remote_list_dirs,
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
            // 待办项（任务里的小清单，v4）
            task_commands::tasks_todo_add,
            task_commands::tasks_todo_set_done,
            task_commands::tasks_todo_update_text,
            task_commands::tasks_todo_delete,
            // 资料（备注的升级版：一条任务挂多条「文字 / 文件」）。
            // 挂文件的对话框在 Rust 侧开、读字节走 `ipc::Response` —— 理由都在
            // task_commands.rs 的头部
            task_commands::tasks_add_text_attachment,
            task_commands::tasks_add_file_attachment,
            task_commands::tasks_update_attachment_text,
            task_commands::tasks_delete_attachment,
            task_commands::tasks_attachment_read,
            task_commands::tasks_open_attachment,
            // 资料文字里点出来的链接（只放行 http/https，见 open.rs）
            task_commands::open_url,
            // 「接口调试」：发一个请求，响应走 Channel 流式回来。
            // 所有结局都在通道里（见 request_commands.rs 的头部）
            request_commands::request_send,

            kv_commands::kv_open,
            kv_commands::kv_get,
            kv_commands::kv_set,

            // 系统钥匙串（连接密码）。见 secret_commands.rs
            secret_commands::secret_load,
            secret_commands::secret_store,
            secret_commands::secret_available,

            // 多窗口：开一个新窗口（label 生成/模块白名单/级联偏移都在那边）
            window_commands::open_window,

            // 场景（存储命名空间）：组合根在渲染前调一次；切换走整窗重载
            scenario_commands::scenario_set,

            // 知识库（vault 文件是真相 + 派生索引 + CLI 生成）。
            // 参数表里只有 vault 名和相对路径 —— 绝对路径全在这层算
            kb_commands::kb_vaults,
            kb_commands::kb_vault_create,
            kb_commands::kb_vault_delete,
            kb_commands::kb_vault_reveal,
            kb_commands::kb_sync,
            kb_commands::kb_cards,
            kb_commands::kb_card_read,
            kb_commands::kb_card_set_status,
            kb_commands::kb_card_set_archived,
            kb_commands::kb_card_delete,
            kb_commands::kb_search,
            kb_commands::kb_sources,
            kb_commands::kb_source_add,
            kb_commands::kb_source_delete,
            kb_commands::kb_generate,
            kb_commands::kb_generate_cancel,
            kb_commands::kb_runs,
            // 卡片/来源图片的字节（阅读器内嵌显示用；参数只有 vault 名 + target）
            kb_commands::kb_file_read,
            kb_commands::kb_cli_probe,

            // 助手的凭据。**只写不读** —— 理由见 assistant_commands.rs
            assistant_commands::assistant_api_key_status,
            assistant_commands::assistant_set_api_key,
            // 升级：把老版「按提供方」存的 key 搬到「按配置」的条目上（幂等）
            assistant_commands::assistant_migrate_api_key,
            // 助手跑一次对话 / 回答审批 / 停止 / 清空这个会话的历史。
            // 事件走 `Channel` 流式推回来
            assistant_commands::assistant_send,
            assistant_commands::assistant_approve,
            assistant_commands::assistant_cancel,
            assistant_commands::assistant_clear_session,
            // 配置通不通，一次往返问清楚（**不走 Channel** —— 理由见那个函数）
            assistant_commands::assistant_test_connection,

            // 群组协作：群 / 成员 / 历史 + 跑一轮（事件走 Channel）+ 停止 + 探测。
            // 「起不来」只表示这一轮没起来；单个成员失败在事件里
            group_commands::group_list,
            group_commands::group_create,
            group_commands::group_get,
            group_commands::group_save,
            group_commands::group_delete,
            group_commands::group_history,
            group_commands::group_clear_history,
            group_commands::group_send,
            group_commands::group_stop,
            group_commands::group_probe,
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
        use tauri::Manager as _;
        match event {
            // 应用退出（**最后一个窗口**被销毁时三平台都会走到这里）。
            tauri::RunEvent::Exit => {
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

                // 群组：每个成员都是独立进程，还在改文件 —— 一起收。
                // `stop_all` 只杀树、不等（和 agents 的收尾同一个理由）。
                let groups = handle
                    .state::<std::sync::Arc<group_commands::GroupRuntime>>()
                    .inner()
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
                        groups.stop_all();
                    })
                    .ok();
            }

            // 关掉的是**其中一个**窗口（不是最后一个，最后一个走上面的 Exit）：
            // 按归属表把它名下的会话收干净。不收就是「用户完全看不见、还在
            // 调 API 改文件」的孤儿进程 —— 这个模块的头号大忌，见 agents crate 文档。
            //
            // ⚠️ **只能走归属表，不能用 `get_webview_window(label)`**：Tauri 把
            // `Destroyed` 派发到这里之前，已经先把窗口从 manager 里摘掉了 ——
            // 那个调用**必为 None**，任何「拿到窗口再关」的写法都是死路
            // （`WindowOwnership::take_all` 的注释里也钉了同一条）。
            tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::Destroyed,
                ..
            } => {
                let ownership = handle
                    .state::<std::sync::Arc<devtoolkit_agents::WindowOwnership>>()
                    .inner()
                    .clone();
                let ids = ownership.take_all(&label);
                if ids.is_empty() {
                    return;
                }
                health::line(
                    "WINDOW_DESTROYED",
                    &format!("{label}：收掉名下 {} 个会话", ids.len()),
                );

                let registry = handle
                    .state::<std::sync::Arc<devtoolkit_agents::AgentRegistry>>()
                    .inner()
                    .clone();
                let locals = handle.state::<local_commands::LocalTerminals>().0.clone();
                let ssh = handle
                    .state::<std::sync::Arc<devtoolkit_ssh::SshRegistry>>()
                    .inner()
                    .clone();
                let remotes = handle
                    .state::<std::sync::Arc<devtoolkit_agents::RemoteRegistry>>()
                    .inner()
                    .clone();

                // 本机那两张表是同步 close（杀树 + 拿锁，可能等很久）——
                // 丢线程，理由和上面 Exit 那段一模一样：主线程是窗口事件循环
                let ids_sync = ids.clone();
                std::thread::Builder::new()
                    .name("rd-window-reap".to_string())
                    .spawn(move || {
                        for id in &ids_sync {
                            registry.close(id);
                            locals.close(id);
                        }
                    })
                    .ok();

                // 远端两张表（ssh / remote）的 close 是 async，丢给异步运行时
                tauri::async_runtime::spawn(async move {
                    for id in &ids {
                        ssh.close(id).await;
                        remotes.close(id).await;
                    }
                });
            }

            // 启动期清一次事件目录的过期文件。多窗口的归属过滤（见
            // `events.rs` 的 `scan_filtered`）定的是「无归属的一律不碰」，
            // 于是目录会缓慢积水 —— 唯一安全的清理时机是这里：此刻还没有任何
            // 窗口和会话，归属表是空的，**年龄是唯一可信的信号**。
            tauri::RunEvent::Ready => {
                if let Ok(data_dir) = handle.path().app_data_dir() {
                    let dir = devtoolkit_agents::events_dir(&data_dir);
                    let removed = devtoolkit_agents::events::prune_stale(
                        &dir,
                        std::time::Duration::from_secs(72 * 3600),
                    );
                    if removed > 0 {
                        health::line("EVENTS_PRUNE", &format!("清掉 {removed} 个过期事件文件"));
                    }
                }
            }

            _ => {}
        }
    });
}
