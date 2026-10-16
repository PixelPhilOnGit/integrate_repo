//! 文件浏览器（智能体会话的「文件」标签）用到的两条只读操作：
//! `list_dir`（单层、不过滤）和 `read_preview`（三态、先 stat 再谈读）。
//!
//! 和 `file_ops.rs` 分开写：那一组盯的是「图工作区」的读写契约，这一组盯的是
//! **拿任意用户目录当浏览对象**之后新出现的边界（隐藏项、FIFO、2 MiB 上限、
//! 符号链接的两种命运）。

mod common;

use devtoolkit_core::{CoreError, Preview, PREVIEW_MAX_BYTES};
use std::fs;

use common::{expect_err, Sandbox};

// ------------------------------------------------------------------ list_dir

#[test]
fn list_dir_是单层且不过滤() {
    let sb = Sandbox::new("ld-single");
    sb.mkdir("子目录");
    sb.mkdir("子目录/更深一层");
    fs::write(sb.ws_root.join("README.md"), "x").unwrap();
    fs::write(sb.ws_root.join(".env"), "x").unwrap(); // 隐藏项：要列（和 list_tree 相反）
    fs::write(sb.ws_root.join("archive.zip"), "x").unwrap(); // 任意后缀：要列

    let entries = sb.ws.list_dir("").unwrap();
    let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();

    assert!(names.contains(&"README.md"));
    assert!(names.contains(&".env"), "隐藏项必须列出来（列的是用户自己的项目目录）");
    assert!(names.contains(&"archive.zip"), "后缀不该被过滤");
    assert!(names.contains(&"子目录"));
    assert!(
        !names.contains(&"更深一层"),
        "只列单层：更深一层属于子目录的展开，不该出现在根列表里"
    );

    // kind 对得上
    let dir = entries.iter().find(|e| e.name == "子目录").unwrap();
    assert_eq!(dir.kind, "dir");
    let file = entries.iter().find(|e| e.name == "README.md").unwrap();
    assert_eq!(file.kind, "file");
    assert!(!file.is_symlink);
}

#[test]
fn list_dir_目录在前_忽略大小写排序() {
    let sb = Sandbox::new("ld-sort");
    for name in ["b.txt", "A.txt", "zeta"] {
        fs::write(sb.ws_root.join(name), "x").unwrap();
    }
    sb.mkdir("m-dir");

    let entries = sb.ws.list_dir("").unwrap();
    let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
    // 目录在前；文件里 A/a.txt 忽略大小写排最前
    assert_eq!(names, vec!["m-dir", "A.txt", "b.txt", "zeta"]);
}

#[test]
fn list_dir_空目录给空列表_子目录用相对路径列() {
    let sb = Sandbox::new("ld-empty");
    sb.mkdir("空目录");
    assert!(sb.ws.list_dir("空目录").unwrap().is_empty());

    fs::write(sb.ws_root.join("空目录").join("里面.txt"), "x").unwrap();
    let entries = sb.ws.list_dir("空目录").unwrap();
    assert_eq!(entries[0].path, "空目录/里面.txt", "相对路径用正斜杠拼");
}

/// 新入口不许在安全闸门上开侧门：`resolve` 拒什么，这里就拒什么。
#[test]
fn list_dir_和_read_preview_的闸门和别的操作一样() {
    let sb = Sandbox::new("ld-gate");
    assert!(matches!(
        sb.ws.list_dir("../.."),
        Err(CoreError::ParentTraversal { .. })
    ));
    assert!(matches!(
        sb.ws.list_dir("/etc"),
        Err(CoreError::AbsolutePath { .. })
    ));
    assert!(matches!(
        sb.ws.read_preview("../secret.txt"),
        Err(CoreError::ParentTraversal { .. })
    ));
}

#[cfg(unix)]
#[test]
fn list_dir_列符号链接但不跟随它判类型() {
    let sb = Sandbox::new("ld-symlink");
    let target = sb.ws_root.join("真文件.txt");
    fs::write(&target, "真内容").unwrap();
    sb.symlink("链接.txt", &target);
    // 指向工作区外的链接：也照样列出来（裁决在点开时）
    sb.symlink("外链", &sb.outside);

    let entries = sb.ws.list_dir("").unwrap();
    let link = entries.iter().find(|e| e.name == "链接.txt").unwrap();
    assert_eq!(link.kind, "file", "不管指向什么，链接本体的呈现都是 file + is_symlink");
    assert!(link.is_symlink, "要标出来给前端画小箭头");

    // 指向根内的链接：点开（read_preview）能正常读到
    let preview = sb.ws.read_preview("链接.txt").unwrap();
    assert_eq!(preview, Preview::Text { text: "真内容".to_string() });

    // 指向根外的链接：read_preview 被 resolve 的闸门拦下（这是「唯一的裁决」）
    assert!(matches!(
        sb.ws.read_preview("外链"),
        Err(CoreError::OutsideWorkspace { .. }) | Err(CoreError::WrongKind { .. })
    ));
}

// --------------------------------------------------------------- read_preview

#[test]
fn read_preview_文本原样带回() {
    let sb = Sandbox::new("rp-text");
    fs::write(sb.ws_root.join("中文.md"), "# 标题\n正文🧪").unwrap();
    let preview = sb.ws.read_preview("中文.md").unwrap();
    assert_eq!(preview, Preview::Text { text: "# 标题\n正文🧪".to_string() });
}

#[test]
fn read_preview_含_nul_字节判二进制() {
    let sb = Sandbox::new("rp-nul");
    // 前半段是合法 UTF-8，但带一个 NUL —— 二进制这关先过 NUL（git 同款启发式）
    fs::write(sb.ws_root.join("假文本.bin"), b"hello\0world").unwrap();
    assert_eq!(sb.ws.read_preview("假文本.bin").unwrap(), Preview::Binary);
}

#[test]
fn read_preview_非法_utf8_判二进制() {
    let sb = Sandbox::new("rp-badutf8");
    fs::write(sb.ws_root.join("乱码.bin"), [0xff, 0xfe, 0x41]).unwrap();
    assert_eq!(sb.ws.read_preview("乱码.bin").unwrap(), Preview::Binary);
}

/// 上限的两侧各恰一步，外加一条「多字节文字不截断」的守门
/// （上限判断在读之前，所以截断逻辑在源头不存在 —— 这条钉住这个事实）。
#[test]
fn read_preview_的_2mib_边界() {
    let sb = Sandbox::new("rp-cap");

    // 恰好 2 MiB：Text（内容也原样，证明没有偷偷截断）
    let exact = "a".repeat(PREVIEW_MAX_BYTES as usize);
    fs::write(sb.ws_root.join("恰好.txt"), &exact).unwrap();
    match sb.ws.read_preview("恰好.txt").unwrap() {
        Preview::Text { text } => assert_eq!(text.len(), PREVIEW_MAX_BYTES as usize),
        other => panic!("恰好 2 MiB 应该是 Text，拿到 {other:?}"),
    }

    // 2 MiB + 1：TooLarge，且**不读内容**只报大小
    fs::write(sb.ws_root.join("超一线.txt"), "a".repeat(PREVIEW_MAX_BYTES as usize + 1)).unwrap();
    assert_eq!(
        sb.ws.read_preview("超一线.txt").unwrap(),
        Preview::TooLarge { size: PREVIEW_MAX_BYTES + 1 }
    );

    // 多字节文字：一个 2 MiB 内、字符不落边界的 CJK 文件读回来一字不差
    let cjk = "汉".repeat(10_000); // 30 KB，远小于上限
    fs::write(sb.ws_root.join("中文.txt"), &cjk).unwrap();
    match sb.ws.read_preview("中文.txt").unwrap() {
        Preview::Text { text } => assert_eq!(text, cjk),
        other => panic!("中文文本应该是 Text，拿到 {other:?}"),
    }
}

#[test]
fn read_preview_目录_给_wrong_kind() {
    let sb = Sandbox::new("rp-dir");
    sb.mkdir("一个目录");
    let err = expect_err(sb.ws.read_preview("一个目录"));
    assert!(matches!(err, CoreError::WrongKind { .. }), "拿到 {err:?}");
}

#[test]
fn read_preview_不存在的文件_报_not_found() {
    let sb = Sandbox::new("rp-missing");
    let err = expect_err(sb.ws.read_preview("没有这个.txt"));
    assert!(matches!(err, CoreError::NotFound { .. }), "拿到 {err:?}");
}

/// FIFO 会被**永久阻塞**地读 —— 所以先 stat、`!is_file()` 直接拒。
/// 这里真建一个 FIFO 钉住这条（读它的话这个测试会挂死，正是我们要防的）。
#[cfg(unix)]
#[test]
fn read_preview_拒绝_fifo_拒不掉会挂死() {
    let sb = Sandbox::new("rp-fifo");
    let fifo = sb.ws_root.join("管道");
    let status = std::process::Command::new("mkfifo")
        .arg(&fifo)
        .status()
        .expect("mkfifo 起不来（这个用例只在有 mkfifo 的机器上有意义）");
    assert!(status.success());

    let err = expect_err(sb.ws.read_preview("管道"));
    assert!(matches!(err, CoreError::WrongKind { .. }), "拿到 {err:?}");
}
