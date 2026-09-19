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
