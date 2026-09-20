//! 任务库的集成测试：**真起一个 SQLite 文件**（临时目录，跑完就删）。
//!
//! 这些断言打在「用户会看到的结果」上：建完能不能读回来、改状态时那两列对不对、
//! 重开应用之后数据还在不在、以及库里被别人手改过时会不会炸。

use devtoolkit_tasks::{TaskError, TaskPatch, TaskStatus, TaskStore};

fn open_temp() -> (tempfile::TempDir, TaskStore) {
    let dir = tempfile::tempdir().expect("建临时目录");
    let store = TaskStore::open(&dir.path().join("tasks.db")).expect("开库");
    (dir, store)
}

#[test]
fn 建一条再读回来() {
    let (_dir, store) = open_temp();

    let task = store.create("写登录页", "支持手机号 + 验证码").expect("建");
    assert_eq!(task.title, "写登录页");
    assert_eq!(task.body, "支持手机号 + 验证码");
    assert_eq!(task.status, TaskStatus::Todo);
    assert!(task.done_at.is_none());

    let all = store.list().expect("列出来");
    assert_eq!(all.len(), 1);
    assert_eq!(all[0], task);
}

#[test]
fn 标题两头的空白去掉_空的存不进去() {
    let (_dir, store) = open_temp();

    let task = store.create("  写登录页  ", "").expect("建");
    assert_eq!(task.title, "写登录页");

    let err = store.create("   ", "").unwrap_err();
    assert!(matches!(err, TaskError::BadInput { .. }));
    // 报错的那一句要能照着改
    assert!(err.to_string().contains("标题"));
}

#[test]
fn 改的时候只动提到的字段() {
    let (_dir, store) = open_temp();
    let task = store.create("标题", "描述").expect("建");

    let updated = store
        .update(
            &task.id,
            &TaskPatch {
                note: Some("备注".to_string()),
                ..Default::default()
            },
        )
        .expect("改");

    assert_eq!(updated.title, "标题"); // 没提的不动
    assert_eq!(updated.body, "描述");
    assert_eq!(updated.note, "备注");
}

#[test]
fn 备注可以改成空串_那是清除不是没动() {
    let (_dir, store) = open_temp();
    let task = store.create("标题", "").expect("建");
    store
        .update(
            &task.id,
            &TaskPatch {
                note: Some("先写点什么".to_string()),
                ..Default::default()
            },
        )
        .expect("写备注");

    let cleared = store
        .update(
            &task.id,
            &TaskPatch {
                note: Some(String::new()),
                ..Default::default()
            },
        )
        .expect("清掉");
    assert_eq!(cleared.note, "");
}

#[test]
fn 标成完成时记下时间_改回去就清掉() {
    let (_dir, store) = open_temp();
    let task = store.create("干活", "").expect("建");
    assert!(task.done_at.is_none());

    let done = store
        .update(
            &task.id,
            &TaskPatch {
                status: Some(TaskStatus::Done),
                ..Default::default()
            },
        )
        .expect("标完成");
    assert_eq!(done.status, TaskStatus::Done);
    let done_at = done.done_at.expect("完成时刻要有");
    assert!(done_at >= task.created_at);

    // 又发现没干完，改回进行中 —— 那个时刻必须清掉，否则「什么时候做完的」
    // 会留着一个假的时间
    let back = store
        .update(
            &task.id,
            &TaskPatch {
                status: Some(TaskStatus::Doing),
                ..Default::default()
            },
        )
        .expect("改回去");
    assert!(back.done_at.is_none());
}

#[test]
fn 列表里最近改过的排在最前面() {
    let (_dir, store) = open_temp();
    let a = store.create("第一条", "").expect("建");
    let b = store.create("第二条", "").expect("建");

    // a 和 b 是同一毫秒建的可能性很大 —— 手动把 a 的 updated_at 往后推，
    // 不然这条用例会因为时间戳相同而假绿
    std::thread::sleep(std::time::Duration::from_millis(2));
    store
        .update(
            &a.id,
            &TaskPatch {
                body: Some("改一下".to_string()),
                ..Default::default()
            },
        )
        .expect("改 a");

    let ids: Vec<String> = store.list().expect("列出来").into_iter().map(|t| t.id).collect();
    assert_eq!(ids, vec![a.id.clone(), b.id.clone()]);
}

#[test]
fn 删掉之后就不在了_再删一次返回false() {
    let (_dir, store) = open_temp();
    let task = store.create("要删的", "").expect("建");

    assert!(store.delete(&task.id).expect("删"));
    assert!(!store.delete(&task.id).expect("再删"), "第二次删不该说删掉了");
    assert!(store.list().expect("列出来").is_empty());
}

#[test]
fn 改一条不存在的任务会明确报错() {
    let (_dir, store) = open_temp();
    let err = store
        .update(
            "task_不存在",
            &TaskPatch {
                title: Some("x".to_string()),
                ..Default::default()
            },
        )
        .unwrap_err();
    assert!(matches!(err, TaskError::NotFound { .. }));
}

#[test]
fn 各状态的数量() {
    let (_dir, store) = open_temp();
    let a = store.create("a", "").expect("建");
    store.create("b", "").expect("建");
    store.create("c", "").expect("建");

    store
        .update(
            &a.id,
            &TaskPatch {
                status: Some(TaskStatus::Done),
                ..Default::default()
            },
        )
        .expect("标完成");

    let counts = store.counts().expect("数一下");
    assert_eq!(counts.todo, 2);
    assert_eq!(counts.doing, 0);
    assert_eq!(counts.done, 1);
}

#[test]
fn 重开一个库数据还在() {
    let dir = tempfile::tempdir().expect("建临时目录");
    let path = dir.path().join("tasks.db");

    let id = {
        let store = TaskStore::open(&path).expect("第一次开");
        store.create("跨进程要还在", "描述").expect("建").id
    };

    // 关掉（drop）之后再开一次，模拟重开应用
    let store = TaskStore::open(&path).expect("第二次开");
    let task = store.get(&id).expect("还在");
    assert_eq!(task.title, "跨进程要还在");
}

#[test]
fn 状态列被手改成不认识的值时_读出来当待办_而不是整条读不出来() {
    let dir = tempfile::tempdir().expect("建临时目录");
    let path = dir.path().join("tasks.db");
    let store = TaskStore::open(&path).expect("开库");
    let task = store.create("手改过的库", "").expect("建");
    drop(store);

    // 模拟用户（或者一个更新的版本）往状态列里写了别的东西
    let conn = rusqlite::Connection::open(&path).expect("直接开库");
    conn.execute(
        "UPDATE tasks SET status = 'archived' WHERE id = ?1",
        [&task.id],
    )
    .expect("手改");
    drop(conn);

    let store = TaskStore::open(&path).expect("再开");
    let all = store.list().expect("整份列表都还要读得出来");
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].status, TaskStatus::Todo, "不认识的状态当待办");
}

#[test]
fn 库是更新的版本建的时_明确报错_而不是乱改它() {
    let dir = tempfile::tempdir().expect("建临时目录");
    let path = dir.path().join("tasks.db");
    drop(TaskStore::open(&path).expect("先建出来"));

    let conn = rusqlite::Connection::open(&path).expect("直接开库");
    conn.execute_batch("PRAGMA user_version = 999;").expect("伪装成新版");
    drop(conn);

    // `TaskStore` 没有 Debug（rusqlite 的连接不是），所以这里用 match 而不是
    // `unwrap_err()`
    let err = match TaskStore::open(&path) {
        Ok(_) => panic!("更新的版本建的库不该被当成能用的"),
        Err(e) => e,
    };
    assert!(matches!(err, TaskError::Migrate { .. }));
    // 那句话要能告诉用户怎么办
    assert!(err.to_string().contains("更新的版本"));
}

// ------------------------------------------------------------------ 归档

#[test]
fn 新建的任务默认没归档() {
    let (_dir, store) = open_temp();
    let task = store.create("还没做完", "").expect("建");
    assert!(!task.archived);
}

#[test]
fn 能归档也能取消归档() {
    let (_dir, store) = open_temp();
    let task = store.create("做完了", "").expect("建");

    let archived = store
        .update(
            &task.id,
            &TaskPatch {
                archived: Some(true),
                ..Default::default()
            },
        )
        .expect("归档");
    assert!(archived.archived);
    // 归档**不动状态**：状态说的是「做没做完」，归档说的是「还要不要摆在眼前」
    assert_eq!(archived.status, TaskStatus::Todo);

    let back = store
        .update(
            &task.id,
            &TaskPatch {
                archived: Some(false),
                ..Default::default()
            },
        )
        .expect("取消归档");
    assert!(!back.archived);
}

#[test]
fn 归档的不算进各状态的数量() {
    // 角标和筛选器数的是「手头还有多少事」—— 归档的意思是「这些不用看了」
    let (_dir, store) = open_temp();
    let a = store.create("归档掉", "").expect("建");
    store.create("留着", "").expect("建");

    store
        .update(
            &a.id,
            &TaskPatch {
                archived: Some(true),
                ..Default::default()
            },
        )
        .expect("归档");

    let counts = store.counts().expect("数一下");
    assert_eq!(counts.todo, 1, "归档的那条不该还算在待办里");
}

// ------------------------------------------------------------------ 进度记录

#[test]
fn 记一笔进度_从早到晚读回来() {
    let (_dir, store) = open_temp();
    let task = store.create("重构连接池", "").expect("建");

    store.add_progress(&task.id, "先看了一遍现有实现").expect("记");
    store.add_progress(&task.id, "发现是定时器没清").expect("记");

    let list = store.progress_of(&task.id).expect("读");
    assert_eq!(list.len(), 2);
    assert_eq!(list[0].text, "先看了一遍现有实现");
    assert_eq!(list[1].text, "发现是定时器没清");
    // 时间戳单调（同一毫秒也算过得去：不反转就行）
    assert!(list[0].at <= list[1].at);
    assert_eq!(list[0].task_id, task.id);
}

#[test]
fn 空的一笔记不进去() {
    let (_dir, store) = open_temp();
    let task = store.create("任务", "").expect("建");
    let err = store.add_progress(&task.id, "   ").unwrap_err();
    assert!(matches!(err, TaskError::BadInput { .. }));
}

#[test]
fn 给不存在的任务记进度会明确报错() {
    let (_dir, store) = open_temp();
    let err = store.add_progress("task_没有这条", "写点什么").unwrap_err();
    assert!(matches!(err, TaskError::NotFound { .. }));
}

#[test]
fn 记一笔进度会把任务顶到列表最前面() {
    // 列表按 updated_at 排 —— 用户记完进度应该看到它冒上来，
    // 不然「我刚记的那条呢」会很迷惑
    let (_dir, store) = open_temp();
    let a = store.create("第一条", "").expect("建");
    let _b = store.create("第二条", "").expect("建");

    std::thread::sleep(std::time::Duration::from_millis(2));
    store.add_progress(&a.id, "动了一下").expect("记");

    assert_eq!(store.list().expect("列出来")[0].id, a.id);
}

#[test]
fn 删掉任务时它的进度一起走_不留孤儿() {
    // 外键 + ON DELETE CASCADE。这条**必须有**：不然回顾时会看到一堆
    // 指向已经不存在的任务的记录，而且永远清不掉
    let (_dir, store) = open_temp();
    let task = store.create("要删的", "").expect("建");
    store.add_progress(&task.id, "第一笔").expect("记");

    assert!(store.delete(&task.id).expect("删"));
    assert!(store.progress_of(&task.id).expect("读").is_empty());
}

// ------------------------------------------------------------------ 迁移

#[test]
fn v1_的库升到_v2_数据一条不丢_而且新字段有默认值() {
    // ⚠️ 这条是这一版最要紧的测试：用户机器上那个 tasks.db 是 **v1** 建的
    //（0.4.2 那次），里面可能有真数据。升级只许加列加表，不许重建表。
    let dir = tempfile::tempdir().expect("建临时目录");
    let path = dir.path().join("tasks.db");

    // 手工造一个 v1 的库（结构就是 0.4.2 时那一版）
    let conn = rusqlite::Connection::open(&path).expect("开库");
    conn.execute_batch(
        "CREATE TABLE tasks (
             id         TEXT PRIMARY KEY,
             title      TEXT NOT NULL,
             body       TEXT NOT NULL DEFAULT '',
             note       TEXT NOT NULL DEFAULT '',
             status     TEXT NOT NULL,
             created_at INTEGER NOT NULL,
             updated_at INTEGER NOT NULL,
             done_at    INTEGER
         );
         CREATE INDEX tasks_status_updated ON tasks(status, updated_at DESC);
         INSERT INTO tasks (id, title, body, note, status, created_at, updated_at, done_at)
         VALUES ('task_old', '老版本建的', '描述还在吗', '备注也还在吗', 'doing', 1000, 2000, NULL);
         PRAGMA user_version = 1;",
    )
    .expect("造 v1 库");
    drop(conn);

    // 用现在的代码打开它
    let store = TaskStore::open(&path).expect("升上来");

    let task = store.get("task_old").expect("老数据还在");
    assert_eq!(task.title, "老版本建的");
    assert_eq!(task.body, "描述还在吗");
    assert_eq!(task.note, "备注也还在吗");
    assert_eq!(task.status, TaskStatus::Doing);
    assert_eq!(task.created_at, 1000);
    // 新列有默认值
    assert!(!task.archived);
    // 新表能用了
    store.add_progress("task_old", "升级之后记的第一笔").expect("记");
    assert_eq!(store.progress_of("task_old").expect("读").len(), 1);
}
