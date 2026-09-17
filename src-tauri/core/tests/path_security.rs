//! 路径安全的攻击向量测试。
//!
//! 这些不是“形式主义”的测试：每一条都对应一种真实可用的沙箱逃逸手法。
//! 工作区外的文件绝不能被读写——这是后端的核心安全边界。

mod common;

use common::{expect_err, Sandbox};
use devtoolkit_core::CoreError;

// ---------------------------------------------------------------- `..` 逃逸

#[test]
fn rejects_parent_dir_traversal() {
    let sb = Sandbox::new("parent");

    let err = expect_err(sb.ws.resolve("../outside/secret.txt"));
    assert!(
        matches!(
            err,
            CoreError::ParentTraversal { .. } | CoreError::OutsideWorkspace { .. }
        ),
        "应当拒绝 `..`，实际是：{err:?}"
    );

    // 端到端：真去读，必须失败，而且拿不到内容。
    let err = expect_err(sb.ws.read_text_file("../outside/secret.txt"));
    assert!(!err.to_string().contains("TOP SECRET"));

    // 端到端：真去写，必须失败，而且工作区外不能冒出文件来。
    expect_err(sb.ws.write_text_file("../outside/pwned.txt", "x"));
    assert!(
        !sb.outside.join("pwned.txt").exists(),
        "写到工作区外面去了！"
    );
}

#[test]
fn rejects_deep_parent_traversal() {
    let sb = Sandbox::new("deep");

    expect_err(sb.ws.resolve("../../etc/passwd"));
    expect_err(sb.ws.read_text_file("../../etc/passwd"));
    expect_err(sb.ws.write_text_file("../../../../../../tmp/devtoolkit-escape.txt", "x"));
    assert!(!std::path::Path::new("/tmp/devtoolkit-escape.txt").exists());

    // 爬到根之后再往下走，同样要拦。
    expect_err(sb.ws.resolve("../../../../../../../../../../etc/passwd"));
}

#[test]
fn rejects_nested_traversal() {
    let sb = Sandbox::new("nested");
    sb.mkdir("sub");
    sb.write("sub/ok.seq.json", "{}");

    expect_err(sb.ws.resolve("sub/../../escape.json"));
    expect_err(sb.ws.resolve("sub/../.."));
    expect_err(sb.ws.write_text_file("sub/../../escape.json", "{}"));

    assert!(!sb.base.path().join("escape.json").exists());
    assert!(!sb.ws_root.join("escape.json").exists());

    // 夹在中间的 `..` 只要不越界也一律拒绝：不做“规范化后再看”的猜测，
    // 规则简单一致，才不会有意外的绕过方式。
    expect_err(sb.ws.resolve("sub/../ok.seq.json"));
}

// ------------------------------------------------------------------ 绝对路径

#[test]
fn rejects_absolute_paths() {
    let sb = Sandbox::new("absolute");

    for p in [
        "/etc/passwd",
        "/tmp/devtoolkit-absolute-escape.txt",
        "//etc/passwd",
    ] {
        let err = expect_err(sb.ws.resolve(p));
        assert!(
            matches!(err, CoreError::AbsolutePath { .. }),
            "`{p}` 应当被判为绝对路径，实际是：{err:?}"
        );
    }

    expect_err(sb.ws.read_text_file("/etc/passwd"));
    expect_err(sb.ws.write_text_file("/tmp/devtoolkit-absolute-escape.txt", "x"));
    assert!(!std::path::Path::new("/tmp/devtoolkit-absolute-escape.txt").exists());

    // 删除同样不能拿绝对路径去删。
    expect_err(sb.ws.delete_entry("/etc/passwd"));

    // 剩下几个吃路径的命令也逐一确认：不留任何一个可以拿绝对路径捅出去的口子。
    sb.write("a.seq.json", "{}");
    expect_err(sb.ws.move_entry("a.seq.json", "/tmp"));
    expect_err(sb.ws.rename_entry("a.seq.json", "/tmp/x"));
    expect_err(sb.ws.create_diagram("/tmp", "x"));
    expect_err(sb.ws.create_folder("/tmp", "x"));
    expect_err(sb.ws.read_text_file("//etc/passwd"));
}

// --------------------------------------------------------------- 符号链接逃逸

#[cfg(unix)]
#[test]
fn rejects_symlink_dir_escape() {
    let sb = Sandbox::new("symlink-dir");
    // ws/link -> 工作区外的 outside/
    let outside = sb.outside.clone();
    sb.symlink("link", &outside);

    // 直接指向链接本身。
    let err = expect_err(sb.ws.resolve("link"));
    assert!(
        matches!(err, CoreError::OutsideWorkspace { .. }),
        "指向工作区外的软链接目录应当被拦下，实际是：{err:?}"
    );

    // 穿过去读文件。
    let err = expect_err(sb.ws.read_text_file("link/secret.txt"));
    assert!(matches!(err, CoreError::OutsideWorkspace { .. }));
    assert!(!err.to_string().contains("TOP SECRET"));

    // 穿过去写新文件（目标还不存在，走的是“规范化父目录”那条分支）。
    expect_err(sb.ws.write_text_file("link/pwned.json", "{}"));
    assert!(!sb.outside.join("pwned.json").exists(), "顺着软链接写出去了！");

    // 穿过去删除。
    expect_err(sb.ws.delete_entry("link/secret.txt"));
    assert!(sb.outside.join("secret.txt").exists(), "顺着软链接删了外面的文件！");

    // 移动同理。
    expect_err(sb.ws.move_entry("link/secret.txt", ""));
}

#[cfg(unix)]
#[test]
fn rejects_symlink_file_escape() {
    let sb = Sandbox::new("symlink-file");
    // 工作区里一个看起来人畜无害的 .seq.json，实际指向外面的机密文件。
    let target = sb.outside.join("secret.txt");
    sb.symlink("innocent.seq.json", &target);

    let err = expect_err(sb.ws.read_text_file("innocent.seq.json"));
    assert!(
        matches!(err, CoreError::OutsideWorkspace { .. }),
        "指向工作区外的软链接文件应当被拦下，实际是：{err:?}"
    );
    assert!(!err.to_string().contains("TOP SECRET"));

    // 覆盖写也不行。
    expect_err(sb.ws.write_text_file("innocent.seq.json", "{}"));
    assert_eq!(sb.secret(), "TOP SECRET", "外面的文件被覆盖了！");
}

#[cfg(unix)]
#[test]
fn rejects_symlink_escape_to_sibling_with_same_prefix() {
    let sb = Sandbox::new("prefix");
    // 关键用例：`/x/ws-evil` 的字符串前缀是 `/x/ws`，
    // 但按路径分量比较就不算“在工作区里”。用软链接把它摆到工作区里试试。
    let evil = sb.base.path().join("ws-evil");
    std::fs::create_dir(&evil).unwrap();
    std::fs::write(evil.join("secret.txt"), "TOP SECRET").unwrap();

    sb.symlink("evil", &evil);

    let err = expect_err(sb.ws.read_text_file("evil/secret.txt"));
    assert!(
        matches!(err, CoreError::OutsideWorkspace { .. }),
        "同前缀的兄弟目录被误判成工作区内部了：{err:?}"
    );
    assert!(!err.to_string().contains("TOP SECRET"));
}

#[cfg(unix)]
#[test]
fn rejects_dangling_symlink_pointing_outside() {
    let sb = Sandbox::new("dangling");
    let target = sb.outside.join("does-not-exist.json");
    sb.symlink("dangling.seq.json", &target);

    // 软链接自身存在（symlink_metadata 成功）但目标不存在，
    // canonicalize 会失败——同样要报错，不能放行。
    expect_err(sb.ws.read_text_file("dangling.seq.json"));
    expect_err(sb.ws.write_text_file("dangling.seq.json", "{}"));
    assert!(!target.exists(), "穿过悬空软链接建出了文件！");
}

// ------------------------------------------------- Windows 风格分隔符混用

#[test]
fn rejects_windows_style_separator_mixing() {
    let sb = Sandbox::new("winsep");
    sb.mkdir("sub");

    // 只用反斜杠的爬升。
    let err = expect_err(sb.ws.resolve("..\\outside\\secret.txt"));
    assert!(
        matches!(err, CoreError::ParentTraversal { .. }),
        "反斜杠分隔的 `..` 没被识别：{err:?}"
    );

    // 正反斜杠混用 —— 正是想骗过“只按 / 切分”的实现。
    expect_err(sb.ws.resolve("sub\\..\\..\\escape.json"));
    expect_err(sb.ws.resolve("sub/..\\..\\escape.json"));
    expect_err(sb.ws.resolve("..\\..\\..\\..\\etc\\passwd"));
    expect_err(sb.ws.resolve("sub\\./../\\..\\escape.json"));

    // 端到端：确认真的没文件漏出去。
    expect_err(sb.ws.write_text_file("sub\\..\\..\\escape.json", "{}"));
    expect_err(sb.ws.write_text_file("..\\..\\tmp\\devtoolkit-win-escape.txt", "x"));
    assert!(!sb.base.path().join("escape.json").exists());
    assert!(!std::path::Path::new("/tmp/devtoolkit-win-escape.txt").exists());

    // Windows 盘符 / UNC 路径在 Linux 上也是普通字符串，一律拒。
    let err = expect_err(sb.ws.resolve("C:\\Windows\\System32\\drivers\\etc\\hosts"));
    assert!(
        matches!(err, CoreError::AbsolutePath { .. }),
        "盘符路径没被识别：{err:?}"
    );
    expect_err(sb.ws.resolve("\\\\server\\share\\evil.json"));
    expect_err(sb.ws.resolve("C:relative-escape.json"));
    expect_err(sb.ws.resolve("sub/C:/evil.json"));
}

// ------------------------------------------------------------------ 合法路径

#[test]
fn accepts_legitimate_paths() {
    let sb = Sandbox::new("legit");

    let root = sb.ws.root().to_path_buf();

    // 空串和 `.` 都表示工作区根目录（`list_tree` 之类要用）。
    assert_eq!(sb.ws.resolve("").unwrap(), root);
    assert_eq!(sb.ws.resolve(".").unwrap(), root);
    assert_eq!(sb.ws.resolve("./").unwrap(), root);

    // 常规相对路径。
    for rel in [
        "a.seq.json",
        "sub/b.seq.json",
        "./sub/b.seq.json",
        "sub//b.seq.json",
        "sub/./b.seq.json",
        "中文目录/登录流程.seq.json",
        "a b/c d.seq.json",
        "sub/带-连字符_和下划线.seq.json",
    ] {
        let p = sb.ws.resolve(rel).expect("合法路径不该被拒");
        assert!(p.starts_with(&root), "`{rel}` 解析到了工作区外：{p:?}");
    }

    // 路径里的空格和点用不着转义。
    assert_eq!(
        sb.ws.resolve("a b/c d.seq.json").unwrap(),
        root.join("a b").join("c d.seq.json")
    );
}

#[test]
fn accepts_paths_whose_ancestors_do_not_exist_yet() {
    let sb = Sandbox::new("newfile");

    let p = sb.ws.resolve("very/deep/tree/new.seq.json").unwrap();
    assert!(p.starts_with(sb.ws.root()));
    assert_eq!(p, sb.ws.root().join("very/deep/tree/new.seq.json"));
}

#[test]
fn rejects_nul_byte_in_path() {
    let sb = Sandbox::new("nul");
    expect_err(sb.ws.resolve("a\0b.seq.json"));
    expect_err(sb.ws.write_text_file("evil\0.seq.json", "x"));
}

// ------------------------------------------------------------ 边界：根目录

#[test]
fn root_itself_cannot_be_deleted_or_moved() {
    let sb = Sandbox::new("rootguard");

    expect_err(sb.ws.delete_entry(""));
    expect_err(sb.ws.delete_entry("."));
    assert!(sb.ws_root.exists(), "工作区根目录被删掉了！");

    // 根目录也读不出内容（它是目录，不是文件）。
    expect_err(sb.ws.read_text_file(""));
}
