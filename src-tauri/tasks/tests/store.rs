//! 任务库的集成测试：**真起一个 SQLite 文件**（临时目录，跑完就删）。
//!
//! 这些断言打在「用户会看到的结果」上：建完能不能读回来、改状态时那两列对不对、
//! 重开应用之后数据还在不在、以及库里被别人手改过时会不会炸。
//!
//! 资料的**文件名清洗**（对字符做手术的那种）不在这个文件里：它是纯字符串函数，
//! 在 `store.rs` 里挂了一个内联单测 —— 不然「带 `%` 的文件名」在 Windows 上
//! 连造都造不出来，那份测试就只在开发机上绿。

use std::path::{Path, PathBuf};

use devtoolkit_tasks::{
    AttachmentKind, TaskError, TaskPatch, TaskStatus, TaskStore,
};

fn open_temp() -> (tempfile::TempDir, TaskStore) {
    let dir = tempfile::tempdir().expect("建临时目录");
    let store = TaskStore::open(&dir.path().join("tasks.db")).expect("开库");
    (dir, store)
}

/// 在临时目录里写一个源文件（准备被 add_file 拷走）
fn write_src(dir: &Path, name: &str, content: &[u8]) -> PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, content).expect("写源文件");
    path
}

/// 资料在盘上的位置（和 `TaskStore` 内部的那套拼法一致：
/// `tasks_files/<任务 id>/<资料 id>_<清洗过的名字>`）
fn stored_path(dir: &Path, task_id: &str, att_id: &str, file_name: &str) -> PathBuf {
    dir.join("tasks_files")
        .join(task_id)
        .join(format!("{att_id}_{file_name}"))
}

#[test]
fn 建一条再读回来() {
    let (_dir, store) = open_temp();

    let task = store.create("写登录页", "支持手机号 + 验证码").expect("建");
    assert_eq!(task.title, "写登录页");
    assert_eq!(task.body, "支持手机号 + 验证码");
    assert_eq!(task.status, TaskStatus::Todo);
    assert!(task.done_at.is_none());
    assert!(task.attachments.is_empty());

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
                body: Some("改过的描述".to_string()),
                ..Default::default()
            },
        )
        .expect("改");

    assert_eq!(updated.title, "标题"); // 没提的不动
    assert_eq!(updated.body, "改过的描述");
    assert_eq!(updated.status, TaskStatus::Todo);
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

// ------------------------------------------------------------------ 资料：文字

#[test]
fn 加文字资料_读回来是加入的先后() {
    let (_dir, store) = open_temp();
    let task = store.create("任务", "").expect("建");

    let first = store.add_text(&task.id, "  第一条：先这样  ").expect("加");
    store.add_text(&task.id, "第二条：再那样").expect("加");

    assert_eq!(first.kind, AttachmentKind::Text);
    assert_eq!(first.text, "第一条：先这样", "两头的空白去掉");
    assert_eq!(first.file_name, "");
    assert_eq!(first.file_size, 0);

    // 连着加，大概率落在同一毫秒 —— 顺序靠 rowid 决胜，必须是加入的先后
    let texts: Vec<String> = store
        .attachments_of(&task.id)
        .expect("读")
        .into_iter()
        .map(|a| a.text)
        .collect();
    assert_eq!(texts, vec!["第一条：先这样", "第二条：再那样"]);

    // 跟着任务一起回来（列表那边用的就是内嵌的这一份）
    let all = store.list().expect("列出来");
    assert_eq!(all[0].attachments.len(), 2);
}

#[test]
fn 空的文字资料加不进去() {
    let (_dir, store) = open_temp();
    let task = store.create("任务", "").expect("建");
    let err = store.add_text(&task.id, "   ").unwrap_err();
    assert!(matches!(err, TaskError::BadInput { .. }));
    assert!(store.attachments_of(&task.id).expect("读").is_empty());
}

#[test]
fn 改文字资料_两头空白去掉_空的存不进去() {
    let (_dir, store) = open_temp();
    let task = store.create("任务", "").expect("建");
    let att = store.add_text(&task.id, "初稿").expect("加");

    let updated = store.update_text(&att.id, "  第二版  ").expect("改");
    assert_eq!(updated.text, "第二版");

    // 空的不收 —— 要删就用删，别让「清空」变成一个藏起来的删除动作
    let err = store.update_text(&att.id, "   ").unwrap_err();
    assert!(matches!(err, TaskError::BadInput { .. }));
    assert_eq!(
        store.attachments_of(&task.id).expect("读")[0].text,
        "第二版",
        "被拒之后内容原样还在"
    );
}

#[test]
fn 文件资料不能当文字改() {
    let (dir, store) = open_temp();
    let task = store.create("任务", "").expect("建");
    let src = write_src(dir.path(), "文档.txt", b"x");
    let att = store.add_file(&task.id, &src).expect("挂");

    let err = store.update_text(&att.id, "想改成文字").unwrap_err();
    assert!(matches!(err, TaskError::BadInput { .. }));
}

#[test]
fn 给不存在的任务加资料会明确报错() {
    let (dir, store) = open_temp();
    assert!(matches!(
        store.add_text("task_没有这条", "x").unwrap_err(),
        TaskError::NotFound { .. }
    ));

    // 文件也一样：任务都不存在，别急着去碰文件
    let src = write_src(dir.path(), "文档.txt", b"x");
    let err = store.add_file("task_没有这条", &src).unwrap_err();
    assert!(matches!(err, TaskError::NotFound { .. }));
}

#[test]
fn 加一条资料会把任务顶到列表最前面() {
    let (_dir, store) = open_temp();
    let a = store.create("第一条", "").expect("建");
    let _b = store.create("第二条", "").expect("建");

    std::thread::sleep(std::time::Duration::from_millis(2));
    store.add_text(&a.id, "冒个泡").expect("加");

    assert_eq!(store.list().expect("列出来")[0].id, a.id);
}

// ------------------------------------------------------------------ 资料：文件

#[test]
fn 文件资料会拷一份进库目录_原文件删了也还在() {
    let (dir, store) = open_temp();
    let task = store.create("带附件的", "").expect("建");

    let content = "# 需求\n这样那样\n";
    let src = write_src(dir.path(), "需求文档.md", content.as_bytes());

    let att = store.add_file(&task.id, &src).expect("挂文件");
    assert_eq!(att.kind, AttachmentKind::File);
    assert_eq!(att.file_name, "需求文档.md");
    assert_eq!(att.file_size, content.len() as i64);
    assert_eq!(att.text, "");

    // 盘上那份在库目录里，名字 = 资料 id + 原名
    let stored = stored_path(dir.path(), &task.id, &att.id, "需求文档.md");
    assert!(stored.is_file(), "拷进来的那份要在 tasks_files 下面");
    assert_eq!(std::fs::read(&stored).expect("读盘上的"), content.as_bytes());

    // 原文件没了也不影响 —— 拷的就是这个意思
    std::fs::remove_file(&src).expect("删原文件");
    let bytes = store.read_attachment(&att.id, 1024 * 1024).expect("读回来");
    assert_eq!(bytes, content.as_bytes());

    // 列表里跟着任务一起回来
    let all = store.list().expect("列出来");
    assert_eq!(all[0].attachments.len(), 1);
    assert_eq!(all[0].attachments[0].id, att.id);
}

#[test]
fn 源文件不在_或者选的是文件夹_都不留半条记录() {
    let (dir, store) = open_temp();
    let task = store.create("任务", "").expect("建");

    let err = store
        .add_file(&task.id, &dir.path().join("没有这个文件.txt"))
        .unwrap_err();
    match err {
        TaskError::File { reason, .. } => assert!(reason.contains("读不到"), "要说清是哪一步：{reason}"),
        other => panic!("应该是 File 错，实际：{other:?}"),
    }

    let err = store.add_file(&task.id, &dir.path().to_path_buf()).unwrap_err();
    match err {
        TaskError::File { reason, .. } => assert!(reason.contains("文件夹"), "{reason}"),
        other => panic!("应该是 File 错，实际：{other:?}"),
    }

    assert!(store.attachments_of(&task.id).expect("读").is_empty(), "失败不该留下记录");
    assert!(
        !dir.path().join("tasks_files").join(&task.id).exists(),
        "连目录都不该建出来"
    );
}

#[test]
fn 读文件资料有大小上限_不在的文件要报人话() {
    let (dir, store) = open_temp();
    let task = store.create("任务", "").expect("建");
    let src = write_src(dir.path(), "大文件.bin", &[7u8; 4096]);
    let att = store.add_file(&task.id, &src).expect("挂");

    let err = store.read_attachment(&att.id, 1024).unwrap_err();
    match err {
        TaskError::File { reason, .. } => assert!(reason.contains("有点大"), "{reason}"),
        other => panic!("应该是 File 错，实际：{other:?}"),
    }

    // 文件被人从盘上删了：读和「打开」都要给「不在了」，不是一句裸的 IO 错
    std::fs::remove_file(stored_path(dir.path(), &task.id, &att.id, "大文件.bin")).expect("手动删掉");
    let err = store.read_attachment(&att.id, 1024 * 1024).unwrap_err();
    assert!(matches!(err, TaskError::File { .. }));
    assert!(err.to_string().contains("不在了"));
    assert!(matches!(
        store.attachment_file(&att.id).unwrap_err(),
        TaskError::File { .. }
    ));
}

#[test]
fn 删一条文件资料_盘上那份跟着没() {
    let (dir, store) = open_temp();
    let task = store.create("任务", "").expect("建");
    let src = write_src(dir.path(), "随手记.txt", b"x");
    let att = store.add_file(&task.id, &src).expect("挂");
    let stored = stored_path(dir.path(), &task.id, &att.id, "随手记.txt");
    assert!(stored.is_file());

    assert!(store.remove_attachment(&att.id).expect("删"));
    assert!(!stored.exists(), "盘上那份也要走");
    assert!(store.attachments_of(&task.id).expect("读").is_empty());
    assert!(
        !store.remove_attachment(&att.id).expect("再删"),
        "第二次删不该说删掉了"
    );
}

#[test]
fn 删任务时_资料行和文件夹一起没() {
    let (dir, store) = open_temp();
    let task = store.create("要删的", "").expect("建");
    store.add_text(&task.id, "留个念").expect("加文字");
    let src = write_src(dir.path(), "图.txt", b"x");
    store.add_file(&task.id, &src).expect("挂文件");

    let folder = dir.path().join("tasks_files").join(&task.id);
    assert!(folder.is_dir());

    assert!(store.delete(&task.id).expect("删任务"));
    assert!(store.attachments_of(&task.id).expect("读").is_empty(), "级联");
    assert!(!folder.exists(), "资料文件夹也要清");
}

#[test]
fn 库里被手改的_id_指不到库外面() {
    // ⚠️ 这个库是**手改过**的：任务 id 被写成 `../evil`。删它的时候
    // 「清 tasks_files/<id>/」那一步如果照单全收，就会去删库外面的目录 ——
    // 哨兵目录就是钉这条的
    let dir = tempfile::tempdir().expect("建临时目录");
    let path = dir.path().join("tasks.db");
    drop(TaskStore::open(&path).expect("先建出来"));

    let sentinel = dir.path().join("evil");
    std::fs::create_dir_all(&sentinel).expect("造哨兵目录");
    std::fs::write(sentinel.join("keep.txt"), "别动我").expect("放个文件");

    let conn = rusqlite::Connection::open(&path).expect("直接开库");
    conn.execute(
        "INSERT INTO tasks (id, title, body, status, created_at, updated_at, done_at, archived)
         VALUES ('../evil', '手工造的', '', 'todo', 1, 1, NULL, 0)",
        [],
    )
    .expect("塞一条坏数据");
    drop(conn);

    let store = TaskStore::open(&path).expect("再开");
    assert!(store.delete("../evil").expect("删"));
    assert!(
        sentinel.join("keep.txt").is_file(),
        "tasks_files 外面的目录一个都不许动"
    );
}

// ------------------------------------------------------------------ 迁移

#[test]
fn v1_的库升到最新_数据一条不丢_老备注变成第一条资料() {
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
    assert_eq!(task.status, TaskStatus::Doing);
    assert_eq!(task.created_at, 1000);
    // 新列有默认值
    assert!(!task.archived);
    // 老备注搬成了第一条文字资料；时间用任务最后被动过的时刻（updated_at）
    assert_eq!(task.attachments.len(), 1, "老备注要变成一条资料");
    assert_eq!(task.attachments[0].kind, AttachmentKind::Text);
    assert_eq!(task.attachments[0].text, "备注也还在吗");
    assert_eq!(task.attachments[0].created_at, 2000);
    // 新表能接着用，进度那套照旧
    store.add_text("task_old", "升级之后加的第一条").expect("加");
    assert_eq!(store.attachments_of("task_old").expect("读").len(), 2);
    store.add_progress("task_old", "升级之后记的第一笔").expect("记");
    assert_eq!(store.progress_of("task_old").expect("读").len(), 1);

    drop(store);

    // note 列该被删掉了（概念由资料表接管，留着只会让人以为是活的）
    let conn = rusqlite::Connection::open(&path).expect("再开看列");
    let mut stmt = conn.prepare("PRAGMA table_info(tasks)").expect("查列");
    let cols: Vec<String> = stmt
        .query_map([], |row| row.get(1))
        .expect("列出来")
        .collect::<Result<_, _>>()
        .expect("收起来");
    assert!(!cols.iter().any(|c| c == "note"), "note 列该没了：{cols:?}");
}

#[test]
fn v2_的库升到最新_归档和进度都在_老备注搬进资料() {
    // v2 就是当前线上那版的结构（0.5 起的库）：有归档、有进度表、有 note。
    // 手工照抄一份，验证「用户现在的库直接升上来」是干净的。
    let dir = tempfile::tempdir().expect("建临时目录");
    let path = dir.path().join("tasks.db");

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
             done_at    INTEGER,
             archived   INTEGER NOT NULL DEFAULT 0
         );
         CREATE INDEX tasks_status_updated ON tasks(status, updated_at DESC);
         CREATE TABLE task_progress (
             id      TEXT PRIMARY KEY,
             task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
             at      INTEGER NOT NULL,
             text    TEXT NOT NULL
         );
         CREATE INDEX task_progress_task ON task_progress(task_id, at);
         INSERT INTO tasks (id, title, body, note, status, created_at, updated_at, done_at, archived)
         VALUES ('task_v2', 'v2 建的', '描述', '这段备注要搬过去', 'done', 1000, 3000, 2500, 1),
                ('task_空备注', '备注是空白的', '', '   ', 'todo', 1000, 1000, NULL, 0);
         INSERT INTO task_progress (id, task_id, at, text) VALUES ('prog_old', 'task_v2', 2000, '当时记的一笔');
         PRAGMA user_version = 2;",
    )
    .expect("造 v2 库");
    drop(conn);

    let store = TaskStore::open(&path).expect("升上来");

    let task = store.get("task_v2").expect("还在");
    assert!(task.archived, "归档标记不能丢");
    assert_eq!(task.done_at, Some(2500));
    assert_eq!(task.status, TaskStatus::Done);
    assert_eq!(store.progress_of("task_v2").expect("读").len(), 1, "进度不能丢");
    assert_eq!(task.attachments.len(), 1, "老备注要变成一条资料");
    assert_eq!(task.attachments[0].text, "这段备注要搬过去");
    assert_eq!(task.attachments[0].created_at, 3000, "时间用任务最后被动过的时刻");

    // 纯空白的备注不该变成一条看不见的空资料
    let blank = store.get("task_空备注").expect("还在");
    assert!(blank.attachments.is_empty());
}
