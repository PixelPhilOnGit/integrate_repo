//! `write_export` 的测试。
//!
//! 这是全程序唯一一个不受工作区校验约束的写入口，所以除了"能写成功"之外，
//! 更要紧的是验证它在**拿到坏路径时仍然拒绝**：空路径、相对路径、目录、
//! 不存在的父目录。这些值虽然号称来自系统对话框，但不能假设上游一定给了
//! 合法输入 —— 防御要落在这一层。

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use rustdraw_core::write_export;

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// 建一个本次测试独有的临时目录
fn temp_dir(tag: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "rustdraw-export-{tag}-{}-{nanos}-{seq}",
        std::process::id()
    ));
    fs::create_dir_all(&dir).expect("无法创建临时目录");
    dir
}

/// 目录里以 `.` 开头的残留临时文件
fn leftover_temp_files(dir: &PathBuf) -> Vec<String> {
    fs::read_dir(dir)
        .expect("读目录失败")
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with('.') && n.contains(".tmp-"))
        .collect()
}

#[test]
fn writes_bytes_to_an_absolute_path_outside_any_workspace() {
    let dir = temp_dir("basic");
    let target = dir.join("图.svg");
    let data = "<?xml version=\"1.0\"?><svg>中文内容</svg>".as_bytes();

    write_export(&target.to_string_lossy(), data).expect("导出应当成功");

    let back = fs::read(&target).expect("文件应当存在");
    assert_eq!(back, data);
    assert!(leftover_temp_files(&dir).is_empty(), "不应留下临时文件");
}

#[test]
fn binary_data_survives_round_trip() {
    let dir = temp_dir("binary");
    let target = dir.join("图.png");
    // 一个真的 PNG 文件头 + 一些高位字节，确认不会被当文本处理坏
    let data: Vec<u8> = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00, 0xfe];

    write_export(&target.to_string_lossy(), &data).expect("导出应当成功");
    assert_eq!(fs::read(&target).unwrap(), data);
}

#[test]
fn overwrites_an_existing_file() {
    let dir = temp_dir("overwrite");
    let target = dir.join("a.svg");
    fs::write(&target, "旧内容").unwrap();

    write_export(&target.to_string_lossy(), b"new").expect("重复导出应当成功");

    assert_eq!(fs::read_to_string(&target).unwrap(), "new");
    assert!(leftover_temp_files(&dir).is_empty());
}

#[test]
fn rejects_empty_path() {
    let err = write_export("   ", b"x").expect_err("空路径必须被拒绝");
    let msg = err.to_string();
    assert!(msg.contains("空"), "错误信息应当说明原因，实际是：{msg}");
}

#[test]
fn rejects_relative_path() {
    // 相对路径的含义取决于进程的工作目录，对"用户选了哪里"这件事毫无保证
    let err = write_export("相对路径.svg", b"x").expect_err("相对路径必须被拒绝");
    assert!(err.to_string().contains("绝对路径"), "实际是：{err}");
}

#[test]
fn rejects_a_directory_as_target() {
    let dir = temp_dir("isdir");
    let err = write_export(&dir.to_string_lossy(), b"x").expect_err("目录不能作为导出目标");
    let msg = err.to_string();
    assert!(
        msg.contains("目录") || msg.contains("不是一个文件"),
        "实际是：{msg}"
    );
}

#[test]
fn rejects_missing_parent_directory() {
    let dir = temp_dir("noparent");
    let target = dir.join("不存在的子目录").join("x.svg");
    let err = write_export(&target.to_string_lossy(), b"x").expect_err("父目录不存在应当报错");
    let msg = err.to_string();
    assert!(
        msg.contains("不存在") || msg.contains("找不到"),
        "错误信息应当能看懂，实际是：{msg}"
    );
}

#[test]
fn accepts_paths_with_non_ascii_directory_names() {
    let dir = temp_dir("cjK");
    let sub = dir.join("我的文档");
    fs::create_dir_all(&sub).unwrap();
    let target = sub.join("流程图-v2.svg");

    write_export(&target.to_string_lossy(), b"ok").expect("中文路径应当可用");
    assert_eq!(fs::read_to_string(&target).unwrap(), "ok");
}

#[test]
fn empty_content_is_allowed() {
    // 空白图导出成 0 字节文件是合法结果，不该被当成错误
    let dir = temp_dir("empty");
    let target = dir.join("empty.svg");
    write_export(&target.to_string_lossy(), b"").expect("空内容应当允许");
    assert_eq!(fs::read(&target).unwrap().len(), 0);
}

#[test]
fn does_not_leave_temp_files_behind_on_success() {
    let dir = temp_dir("clean");
    for i in 0..5 {
        let target = dir.join(format!("out{i}.svg"));
        write_export(&target.to_string_lossy(), b"content").unwrap();
    }
    assert!(
        leftover_temp_files(&dir).is_empty(),
        "残留：{:?}",
        leftover_temp_files(&dir)
    );
}
