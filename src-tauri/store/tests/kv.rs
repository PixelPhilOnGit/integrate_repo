//! 键值存储的集成测试：真起一个 SQLite 文件（临时目录，跑完就删）。
//!
//! 重头戏是**搬迁**那一组：那些 JSON 里装的是用户的连接档案和主机指纹，
//! 所以「导入失败时老文件原封不动」这条是硬要求，专门有测试钉着。

use std::path::Path;

use devtoolkit_store::{Store, StoreError};

fn temp() -> tempfile::TempDir {
    tempfile::tempdir().expect("建临时目录")
}

fn open(dir: &Path) -> Store {
    Store::open(&dir.join("kv.db")).expect("开库")
}

/// 造一个「老版本的模块文件」：一个 JSON 对象，键值都在顶层
fn write_legacy(dir: &Path, module: &str, body: &str) {
    std::fs::write(dir.join(format!("{module}.json")), body).expect("写老文件");
}

#[test]
fn 写进去读得回来() {
    let dir = temp();
    let store = open(dir.path());

    store.set("redis", "profiles", r#"[{"id":"p1"}]"#).expect("写");
    assert_eq!(
        store.get("redis", "profiles").expect("读").as_deref(),
        Some(r#"[{"id":"p1"}]"#)
    );
}

#[test]
fn 没有的键是_none_而不是报错() {
    let dir = temp();
    let store = open(dir.path());
    assert!(store.get("redis", "没有这个键").expect("读").is_none());
}

#[test]
fn 同一个键再写一次是覆盖() {
    let dir = temp();
    let store = open(dir.path());
    store.set("ssh", "profiles", "\"第一次\"").expect("写");
    store.set("ssh", "profiles", "\"第二次\"").expect("写");

    assert_eq!(
        store.get("ssh", "profiles").expect("读").as_deref(),
        Some("\"第二次\"")
    );
}

#[test]
fn 模块之间不串_同名键各是各的() {
    let dir = temp();
    let store = open(dir.path());
    store.set("redis", "profiles", "\"redis 的\"").expect("写");
    store.set("sql", "profiles", "\"sql 的\"").expect("写");

    assert_eq!(
        store.get("redis", "profiles").expect("读").as_deref(),
        Some("\"redis 的\"")
    );
    assert_eq!(
        store.get("sql", "profiles").expect("读").as_deref(),
        Some("\"sql 的\"")
    );
}

// ------------------------------------------------------------------ 搬迁

#[test]
fn 老_JSON_能搬进来_而且原文件只改名不删() {
    let dir = temp();
    write_legacy(dir.path(), "redis", r#"{"profiles":[{"id":"p1"}],"history":["GET a"]}"#);

    let store = open(dir.path());
    store
        .import_legacy_json(dir.path(), "redis")
        .expect("搬迁");

    // 值进库了，而且是**原样**的 JSON 文本
    assert_eq!(
        store.get("redis", "profiles").expect("读").as_deref(),
        Some(r#"[{"id":"p1"}]"#)
    );
    assert_eq!(
        store.get("redis", "history").expect("读").as_deref(),
        Some(r#"["GET a"]"#)
    );

    // 老文件改名成 .bak 了 —— **没删**（用户看得见，出事了能捞回来）
    assert!(
        !dir.path().join("redis.json").exists(),
        "老文件应该已经改名"
    );
    assert!(
        dir.path().join("redis.json.bak").is_file(),
        "老文件应该在 .bak 里留着"
    );
}

#[test]
fn 搬迁是幂等的_搬过之后用户的新数据不会被老文件盖回去() {
    let dir = temp();
    write_legacy(dir.path(), "ssh", r#"{"profiles":["老的"]}"#);

    let store = open(dir.path());
    store.import_legacy_json(dir.path(), "ssh").expect("第一次搬");
    // 用户在新版本里改了东西
    store.set("ssh", "profiles", "\"新的\"").expect("改");

    // 再搬一次（重启应用会走到这儿）
    store.import_legacy_json(dir.path(), "ssh").expect("第二次搬");

    assert_eq!(
        store.get("ssh", "profiles").expect("读").as_deref(),
        Some("\"新的\""),
        "第二次搬迁不该拿老文件把新数据盖回去"
    );
}

#[test]
fn 没有老文件时搬迁什么都不做_也不报错() {
    let dir = temp();
    let store = open(dir.path());
    store
        .import_legacy_json(dir.path(), "agents")
        .expect("没有老文件是正常情况");

    assert!(store.get("agents", "profiles").expect("读").is_none());
}

#[test]
fn 老文件是坏的_json_时报错_而且原文件一个字都没动() {
    // ⚠️ 这是整个搬迁里最要紧的一条：宁可这次还用老数据，也不能把用户的档案搞丢
    let dir = temp();
    let broken = r#"{"profiles": [{"id":"p1"}"#; // 少了个括号
    write_legacy(dir.path(), "sql", broken);

    let store = open(dir.path());
    let err = store.import_legacy_json(dir.path(), "sql").unwrap_err();
    assert!(matches!(err, StoreError::Import { .. }), "应当是 Import 那一类：{err}");

    // 原文件**原封不动**
    let file = dir.path().join("sql.json");
    assert!(file.is_file(), "搬迁失败时老文件必须还在原地");
    assert_eq!(std::fs::read_to_string(&file).expect("读"), broken);
    assert!(!dir.path().join("sql.json.bak").exists());
    // 库里也不该留下半截数据
    assert!(store.get("sql", "profiles").expect("读").is_none());
}

#[test]
fn 老文件顶层不是对象时也不动它() {
    let dir = temp();
    write_legacy(dir.path(), "settings", r#"[1,2,3]"#);

    let store = open(dir.path());
    let err = store.import_legacy_json(dir.path(), "settings").unwrap_err();
    assert!(matches!(err, StoreError::Import { .. }));
    assert!(dir.path().join("settings.json").is_file(), "老文件要留在原地");
}

#[test]
fn 搬迁之后_读到的还是同一份数据_不只是写进去了() {
    let dir = temp();
    write_legacy(
        dir.path(),
        "agents",
        r#"{"workspaces":[{"id":"ws_1","path":"D:\\work\\api","name":"api"}],"git_bash":"D:\\Git\\bin\\bash.exe"}"#,
    );

    let store = open(dir.path());
    store.import_legacy_json(dir.path(), "agents").expect("搬");

    // 值原样（转义、反斜杠都不许动）
    assert_eq!(
        store.get("agents", "workspaces").expect("读").as_deref(),
        Some(r#"[{"id":"ws_1","path":"D:\\work\\api","name":"api"}]"#)
    );
    assert_eq!(
        store.get("agents", "git_bash").expect("读").as_deref(),
        Some(r#""D:\\Git\\bin\\bash.exe""#)
    );
}

#[test]
fn 重开一个库_数据还在_进程重启是常态() {
    let dir = temp();
    {
        let store = open(dir.path());
        store.set("redis", "profiles", "\"跨进程\"").expect("写");
    }
    let store = open(dir.path());
    assert_eq!(
        store.get("redis", "profiles").expect("读").as_deref(),
        Some("\"跨进程\"")
    );
}
