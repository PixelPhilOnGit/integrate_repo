//! 状态事件目录：白名单、一次性消费、杂物容忍。
//!
//! 这个目录的输入**来自应用外面**（钩子脚本、notify 程序，以及用户往里面扔的
//! 任何东西），所以每一组用例都在问同一个问题：**认错东西的后果是什么**。
//! 认错成「不是我们的」= 状态不更新；认错成「是我们的」= 删掉别人的文件。

mod common;

use std::time::{Duration, SystemTime};

use common::TempDir;
use devtoolkit_agents::events::{events_dir, parse_name, scan, EVENT_STATES, PANE_ID_MAX};

/// 写一个事件文件，顺手把 mtime 设成指定时刻（时间戳是我们唯一的排序依据）。
fn write_event(dir: &std::path::Path, name: &str, at: u64) {
    let path = dir.join(name);
    std::fs::write(&path, b"").expect("写事件文件");
    let when = SystemTime::UNIX_EPOCH + Duration::from_millis(at);
    let f = std::fs::File::options()
        .write(true)
        .open(&path)
        .expect("打开事件文件");
    f.set_modified(when).expect("设置 mtime");
}

#[test]
fn 正常的事件_名字和_mtime_都带出来() {
    let dir = TempDir::new("events-basic");
    let events_dir = dir.path().join("agent-events");
    std::fs::create_dir_all(&events_dir).expect("建事件目录");
    write_event(&events_dir, "waiting.pane_k3f9x2a1", 1_700_000_000_123);

    let events = scan(&events_dir).expect("扫描");
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].name, "waiting.pane_k3f9x2a1");
    assert_eq!(events[0].at, 1_700_000_000_123, "时间戳必须是文件的 mtime");
}

#[test]
fn 三个状态都认() {
    let dir = TempDir::new("events-states");
    for state in EVENT_STATES {
        let events_dir = dir.path().join(state);
        std::fs::create_dir_all(&events_dir).expect("建事件目录");
        write_event(&events_dir, &format!("{state}.s1"), 1);
        let events = scan(&events_dir).expect("扫描");
        assert_eq!(events.len(), 1, "状态 {state} 没认出来");
    }
}

/// 状态段**不区分大小写**（Windows 的文件名本来就不区分），
/// 而会话 id **区分大小写**（它是我们自己生成的随机串）。
#[test]
fn 状态不区分大小写_会话_id_区分() {
    assert_eq!(parse_name("WAITING.s1"), Some(("waiting", "s1")));
    assert_eq!(parse_name("Done.s1"), Some(("done", "s1")));
    assert_eq!(parse_name("done.AbC_1"), Some(("done", "AbC_1")));
}

/// ⚠️ **目录里的杂物一律静静跳过，绝不能报错。**
///
/// 报错的后果很具体：用户会看到一条莫名其妙的红色错误条，而原因只是某个编辑器
/// 在这个目录里留了个 `.swp`。这条同时也是「白名单」那半边的守门测试。
#[test]
fn 目录里的杂物一律静静跳过() {
    let dir = TempDir::new("events-junk");
    for junk in [
        "README.txt",
        "waiting.s1.swp",
        ".gitignore",
        "tmp",
        "waiting",
        "waiting.a.b",
    ] {
        std::fs::write(dir.path().join(junk), b"x").expect("写杂物");
    }
    std::fs::create_dir_all(dir.path().join("subdir")).expect("建子目录");

    let events = scan(dir.path()).expect("杂物不该让整次扫描失败");
    assert!(events.is_empty(), "把杂物当成事件了：{events:?}");
}

/// 脚本写不出来的状态（`exited` / `idle` / `starting`）一律不认 ——
/// `exited` 由 pty 自己报，它比脚本可靠得多，两者混在一起只会互相打架。
#[test]
fn 脚本写不出来的状态不认() {
    let dir = TempDir::new("events-bad-states");
    for name in ["exited.s1", "idle.s1", "starting.s1", "running.s1"] {
        std::fs::write(dir.path().join(name), b"x").expect("写文件");
    }
    assert!(scan(dir.path()).expect("扫描").is_empty());
}

/// ⚠️ **会话 id 里不能有路径分隔符或点** —— 这是防目录穿越的那一道。
///
/// 文件名会被拼成路径（`目录 + 名称`），名字里带上 `..` 或者 `/` 就能指到
/// 目录外面去。这一层挡不住的话，下面的删除动作就会去删别的目录里的东西。
#[test]
fn 会话_id_里的路径分隔符和点都不认() {
    for name in [
        "waiting.../../etc/passwd",
        "waiting.a/b",
        "waiting.a\\b",
        "waiting..",
        "waiting...",
        "waiting.s1/",
    ] {
        assert_eq!(parse_name(name), None, "{name} 不该被认成事件");
    }
}

/// 会话 id 太长或者为空都不认（前端的上限也是 64，两边必须一致）。
#[test]
fn 会话_id_太长或为空都不认() {
    assert!(parse_name(&format!("waiting.{}", "x".repeat(PANE_ID_MAX))).is_some());
    assert_eq!(parse_name(&format!("waiting.{}", "x".repeat(PANE_ID_MAX + 1))), None);
    assert_eq!(parse_name("waiting."), None);
    assert_eq!(parse_name("waiting"), None);
    assert_eq!(parse_name(".pane1"), None);
}

/// **一个事件只用一次**：读走之后就删掉，第二次扫描什么都没有。
///
/// 不删的话，前端每次扫描都会重新看一遍历史事件 —— 状态机会被一堆旧信号
/// 反复冲刷，用户看见状态点在闪。
#[test]
fn 读走的事件会被删掉() {
    let dir = TempDir::new("events-once");
    write_event(dir.path(), "waiting.p1", 100);

    let first = scan(dir.path()).expect("第一次扫描");
    assert_eq!(first.len(), 1);

    let second = scan(dir.path()).expect("第二次扫描");
    assert!(second.is_empty(), "同一个事件被读了两次：{second:?}");
    assert!(
        !dir.path().join("waiting.p1").exists(),
        "读走之后文件该没了"
    );
}

/// **应用没开着的时候事件会攒下来**，下次启动要能读到。
///
/// 这条是那套约定的核心好处之一（比起「钩子直连应用」）：钩子照写不误，
/// 我们什么时候开机什么时候收。
#[test]
fn 应用没开着时攒下的事件下次启动能读到() {
    let dir = TempDir::new("events-offline");
    // 模拟「应用没开的时候钩子写了三条」
    write_event(dir.path(), "working.p1", 100);
    write_event(dir.path(), "done.p1", 300);
    write_event(dir.path(), "waiting.p2", 200);

    let events = scan(dir.path()).expect("启动时扫描");
    assert_eq!(events.len(), 3);
    // 顺序是**时间升序**：前端逐条喂给状态机，顺序错了状态就错了
    assert_eq!(
        events.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(),
        vec!["working.p1", "waiting.p2", "done.p1"]
    );
}

/// 目录不存在就建出来 —— 应用第一次跑的时候它还不存在，
/// 这时候报错只会让用户以为装坏了。
#[test]
fn 目录不存在会自动创建() {
    let dir = TempDir::new("events-create");
    let events_dir = dir.path().join("还没有").join("agent-events");

    let events = scan(&events_dir).expect("目录不存在不该报错");
    assert!(events.is_empty());
    assert!(events_dir.is_dir(), "目录该被建出来");
}

/// `events_dir` 是**应用数据目录下的固定子目录** ——
/// 应用数据目录由 Tauri 给，前端只能拿到这个算好的绝对路径。
#[test]
fn 事件目录是数据目录的子目录() {
    let data = TempDir::new("events-dir");
    let d = events_dir(data.path());
    assert!(d.starts_with(data.path()));
    assert_eq!(d.file_name().unwrap(), "agent-events");
}

/// 子目录（哪怕名字长得像事件）不碰：不是我们写的东西，删掉是破坏。
#[test]
fn 长得像事件的目录不会被当成事件() {
    let dir = TempDir::new("events-dirname");
    std::fs::create_dir_all(dir.path().join("waiting.pane1")).expect("建同名目录");

    let events = scan(dir.path()).expect("扫描");
    assert!(events.is_empty());
    assert!(
        dir.path().join("waiting.pane1").is_dir(),
        "同名目录被删掉了 —— 那不是我们的东西"
    );
}

/// 同一毫秒的事件顺序要**稳定**（按文件名排），否则每次扫描的顺序都可能不一样，
/// 前端状态机的行为就成了随机的。
#[test]
fn 同一时刻的事件顺序是稳定的() {
    let dir = TempDir::new("events-tie");
    write_event(dir.path(), "done.b", 500);
    write_event(dir.path(), "done.a", 500);
    write_event(dir.path(), "done.c", 500);

    let first: Vec<String> = scan(dir.path()).expect("扫描").into_iter().map(|e| e.name).collect();
    assert_eq!(first, vec!["done.a", "done.b", "done.c"]);
}
