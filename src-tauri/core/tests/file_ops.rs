//! 文件操作的正常路径测试：原子写、目录树、增删改移。

mod common;

use std::fs;

use common::{expect_err, Sandbox};
use rustdraw_core::{CoreError, FileNode};

fn names(nodes: &[FileNode]) -> Vec<String> {
    nodes.iter().map(|n| n.name.clone()).collect()
}

fn kinds(nodes: &[FileNode]) -> Vec<String> {
    nodes.iter().map(|n| n.kind.clone()).collect()
}

// ------------------------------------------------------------------ 原子写

#[test]
fn atomic_write_roundtrip() {
    let sb = Sandbox::new("aw-roundtrip");
    sb.mkdir("图");

    sb.ws
        .write_text_file("图/登录流程.seq.json", "{\"a\":1}")
        .unwrap();
    assert_eq!(
        sb.ws.read_text_file("图/登录流程.seq.json").unwrap(),
        "{\"a\":1}"
    );
    assert_eq!(
        fs::read_to_string(sb.ws_root.join("图/登录流程.seq.json")).unwrap(),
        "{\"a\":1}"
    );
}

#[test]
fn atomic_write_truncates_instead_of_leaving_tail() {
    let sb = Sandbox::new("aw-truncate");

    sb.ws.write_text_file("a.seq.json", "0123456789").unwrap();
    sb.ws.write_text_file("a.seq.json", "abc").unwrap();

    // 如果实现是“打开后覆写”而不是“临时文件 + rename”，
    // 这里会读出 "abc3456789"。
    assert_eq!(sb.ws.read_text_file("a.seq.json").unwrap(), "abc");
}

#[test]
fn atomic_write_leaves_no_temp_files() {
    let sb = Sandbox::new("aw-temp");

    for i in 0..5 {
        sb.ws
            .write_text_file("a.seq.json", &format!("v{i}"))
            .unwrap();
    }

    let entries: Vec<String> = fs::read_dir(&sb.ws_root)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();

    assert_eq!(entries, vec!["a.seq.json".to_string()], "残留了临时文件");
}

#[test]
fn atomic_write_into_missing_dir_fails() {
    let sb = Sandbox::new("aw-missing-dir");

    let err = expect_err(sb.ws.write_text_file("nope/a.seq.json", "x"));
    assert!(matches!(err, CoreError::NotFound { .. }), "实际是 {err:?}");
    assert!(!sb.ws_root.join("nope").exists(), "不该顺手把目录建出来");
}

#[test]
fn atomic_write_rejects_directory_target() {
    let sb = Sandbox::new("aw-dir-target");
    sb.mkdir("adir");

    // 目标是目录，rename 会失败；错误要能透出来，而且不能把目录搞坏。
    expect_err(sb.ws.write_text_file("adir", "x"));
    assert!(sb.ws_root.join("adir").is_dir());
}

// ------------------------------------------------------------------ 目录树

#[test]
fn list_tree_is_sorted_dirs_first_then_by_name() {
    let sb = Sandbox::new("tree-sort");
    // 故意用乱序创建，并且让文件名的大小写/字母序交错。
    for f in ["zebra.seq.json", "Apple.seq.json", "mango.seq.json"] {
        sb.write(f, "{}");
    }
    for d in ["zeta", "Alpha"] {
        sb.mkdir(d);
    }
    sb.write("Alpha/inner.seq.json", "{}");
    sb.write("readme.md", "不是图，不该出现");
    sb.write("notes.txt", "也不该出现");

    let tree = sb.ws.list_tree().unwrap();

    assert_eq!(
        names(&tree),
        vec!["Alpha", "zeta", "Apple.seq.json", "mango.seq.json", "zebra.seq.json"]
    );
    assert_eq!(kinds(&tree), vec!["dir", "dir", "file", "file", "file"]);
}

#[test]
fn list_tree_nests_children_and_uses_forward_slash_relative_paths() {
    let sb = Sandbox::new("tree-nest");
    sb.write("设计/登录.seq.json", "{}");
    sb.write("设计/子目录/深.seq.json", "{}");

    let tree = sb.ws.list_tree().unwrap();
    assert_eq!(names(&tree), vec!["设计"]);

    let design = &tree[0];
    assert_eq!(design.path, "设计");
    assert_eq!(design.kind, "dir");

    let children = design.children.as_ref().unwrap();
    assert_eq!(names(children), vec!["子目录", "登录.seq.json"]);
    assert_eq!(children[1].path, "设计/登录.seq.json");
    assert_eq!(children[1].children, None, "文件节点的 children 必须是 None");

    let sub = &children[0];
    assert_eq!(sub.path, "设计/子目录");
    assert_eq!(
        sub.children.as_ref().unwrap()[0].path,
        "设计/子目录/深.seq.json"
    );
}

#[test]
fn list_tree_keeps_empty_dirs() {
    let sb = Sandbox::new("tree-empty-dir");
    sb.mkdir("刚建好的空目录");

    // 空目录必须留在树里，否则用户一建文件夹它就“消失”了。
    let tree = sb.ws.list_tree().unwrap();
    assert_eq!(names(&tree), vec!["刚建好的空目录"]);
    assert_eq!(tree[0].children.as_ref().unwrap().len(), 0);
}

#[test]
fn list_tree_skips_hidden_entries() {
    let sb = Sandbox::new("tree-hidden");
    sb.write("visible.seq.json", "{}");
    sb.mkdir(".git");
    sb.write(".git/config", "x");
    sb.write(".hidden.seq.json", "{}");

    let tree = sb.ws.list_tree().unwrap();
    assert_eq!(names(&tree), vec!["visible.seq.json"]);
}

#[cfg(unix)]
#[test]
fn list_tree_skips_symlinks() {
    let sb = Sandbox::new("tree-symlink");
    sb.write("real.seq.json", "{}");
    // 自指软链接：不跳过的话递归就下不来了。
    sb.symlink("loop", sb.ws_root.as_path());
    // 指向同一目录下文件的软链接。
    let target = sb.ws_root.join("real.seq.json");
    sb.symlink("alias.seq.json", &target);

    let tree = sb.ws.list_tree().unwrap();
    assert_eq!(names(&tree), vec!["real.seq.json"], "软链接必须被跳过");
}

#[test]
fn list_tree_on_empty_workspace() {
    let sb = Sandbox::new("tree-empty");
    assert!(sb.ws.list_tree().unwrap().is_empty());
}

#[test]
fn file_node_json_contract() {
    let sb = Sandbox::new("json-contract");
    sb.write("d/a.seq.json", "{}");

    let v = serde_json::to_value(sb.ws.list_tree().unwrap()).unwrap();

    // 前端 TS 类型就是照这个写的，字段名不能变。
    assert_eq!(v[0]["name"], "d");
    assert_eq!(v[0]["path"], "d");
    assert_eq!(v[0]["kind"], "dir");
    assert!(v[0]["children"].is_array());

    assert_eq!(v[0]["children"][0]["name"], "a.seq.json");
    assert_eq!(v[0]["children"][0]["path"], "d/a.seq.json");
    assert_eq!(v[0]["children"][0]["kind"], "file");
    assert!(v[0]["children"][0]["children"].is_null());
}

// ------------------------------------------------------------ 新建图 / 目录

#[test]
fn create_diagram_appends_suffix_and_returns_rel_path() {
    let sb = Sandbox::new("create-diagram");

    let rel = sb.ws.create_diagram("", "登录流程").unwrap();
    assert_eq!(rel, "登录流程.seq.json");
    assert!(sb.ws_root.join("登录流程.seq.json").is_file());

    // 前端可能带上后缀，也不能变成 xxx.seq.json.seq.json。
    let rel = sb.ws.create_diagram("", "带后缀.seq.json").unwrap();
    assert_eq!(rel, "带后缀.seq.json");

    // 子目录里建。
    sb.mkdir("子目录");
    let rel = sb.ws.create_diagram("子目录", "多层级").unwrap();
    assert_eq!(rel, "子目录/多层级.seq.json");
    assert!(sb.ws_root.join("子目录/多层级.seq.json").is_file());

    // 相对路径永远用正斜杠。
    assert!(!rel.contains('\\'));
}

#[test]
fn create_diagram_dedupes_existing_names() {
    let sb = Sandbox::new("create-dedupe");

    sb.ws.create_diagram("", "同名").unwrap();
    // 先把内容写成有辨识度的，确认新建不会覆盖已有文件。
    sb.ws.write_text_file("同名.seq.json", "原件").unwrap();

    let second = sb.ws.create_diagram("", "同名").unwrap();
    let third = sb.ws.create_diagram("", "同名").unwrap();

    assert_eq!(second, "同名 (2).seq.json");
    assert_eq!(third, "同名 (3).seq.json");
    assert_eq!(sb.ws.read_text_file("同名.seq.json").unwrap(), "原件");
    assert_eq!(sb.ws.read_text_file("同名 (2).seq.json").unwrap(), "");
}

#[test]
fn create_diagram_rejects_bad_names() {
    let sb = Sandbox::new("create-bad");

    for bad in ["", "   ", "..", ".", "a/b", "a\\b", "C:evil", "a:b", "con", "NUL", "结尾点."] {
        expect_err(sb.ws.create_diagram("", bad));
    }

    // 首尾空白会被裁掉而不是报错——用户手滑多打个空格是常事。
    assert_eq!(sb.ws.create_diagram("", "  两边有空格  ").unwrap(), "两边有空格.seq.json");

    // 目录不存在时直接报错，不猜。
    expect_err(sb.ws.create_diagram("不存在的目录", "x"));
    // 目标是文件而不是目录。
    sb.write("afile.seq.json", "{}");
    expect_err(sb.ws.create_diagram("afile.seq.json", "x"));
}

#[test]
fn create_folder_works_and_dedupes() {
    let sb = Sandbox::new("create-folder");

    assert_eq!(sb.ws.create_folder("", "新目录").unwrap(), "新目录");
    assert_eq!(sb.ws.create_folder("", "新目录").unwrap(), "新目录 (2)");
    assert_eq!(
        sb.ws.create_folder("新目录", "嵌套").unwrap(),
        "新目录/嵌套"
    );

    assert!(sb.ws_root.join("新目录/嵌套").is_dir());
    expect_err(sb.ws.create_folder("", "a/b"));
}

// -------------------------------------------------------------------- 重命名

#[test]
fn rename_file_keeps_diagram_suffix() {
    let sb = Sandbox::new("rename-file");
    sb.write("旧名.seq.json", "内容");

    // 不带后缀地重命名 → 自动补上。
    assert_eq!(
        sb.ws.rename_entry("旧名.seq.json", "新名").unwrap(),
        "新名.seq.json"
    );
    assert_eq!(sb.ws.read_text_file("新名.seq.json").unwrap(), "内容");
    assert!(!sb.ws_root.join("旧名.seq.json").exists());

    // 带后缀地重命名 → 结果一样，不会变成双后缀。
    assert_eq!(
        sb.ws.rename_entry("新名.seq.json", "再改.seq.json").unwrap(),
        "再改.seq.json"
    );
    assert!(sb.ws_root.join("再改.seq.json").exists());
}

#[test]
fn rename_folder_does_not_add_suffix() {
    let sb = Sandbox::new("rename-folder");
    sb.mkdir("旧目录");
    sb.write("旧目录/a.seq.json", "{}");

    assert_eq!(sb.ws.rename_entry("旧目录", "新目录").unwrap(), "新目录");
    assert!(sb.ws_root.join("新目录/a.seq.json").exists());
    assert!(!sb.ws_root.join("旧目录").exists());
}

#[test]
fn rename_rejects_collisions_and_bad_names() {
    let sb = Sandbox::new("rename-bad");
    sb.write("a.seq.json", "A");
    sb.write("b.seq.json", "B");

    let err = expect_err(sb.ws.rename_entry("a.seq.json", "b"));
    assert!(matches!(err, CoreError::AlreadyExists { .. }), "实际是 {err:?}");
    assert_eq!(sb.ws.read_text_file("a.seq.json").unwrap(), "A");
    assert_eq!(sb.ws.read_text_file("b.seq.json").unwrap(), "B");

    expect_err(sb.ws.rename_entry("a.seq.json", "../escape"));
    expect_err(sb.ws.rename_entry("a.seq.json", "sub/x"));
    expect_err(sb.ws.rename_entry("a.seq.json", "  "));
    expect_err(sb.ws.rename_entry("a.seq.json", "."));
    // 不存在的源。
    expect_err(sb.ws.rename_entry("nope.seq.json", "x"));

    // 重命名成自己：不算冲突，原样返回。
    assert_eq!(sb.ws.rename_entry("a.seq.json", "a").unwrap(), "a.seq.json");
}

// -------------------------------------------------------------------- 删除

#[test]
fn delete_file_and_dir() {
    let sb = Sandbox::new("delete");
    sb.write("a.seq.json", "{}");
    sb.write("dir/inner.seq.json", "{}");
    sb.write("dir/sub/deep.seq.json", "{}");

    sb.ws.delete_entry("a.seq.json").unwrap();
    assert!(!sb.ws_root.join("a.seq.json").exists());

    // 目录递归删除。
    sb.ws.delete_entry("dir").unwrap();
    assert!(!sb.ws_root.join("dir").exists());

    expect_err(sb.ws.delete_entry("a.seq.json"));
    expect_err(sb.ws.delete_entry("../outside/secret.txt"));
    assert_eq!(sb.secret(), "TOP SECRET");
}

// -------------------------------------------------------------------- 移动

#[test]
fn move_file_between_folders() {
    let sb = Sandbox::new("move");
    sb.write("a.seq.json", "内容");
    sb.mkdir("目标");

    assert_eq!(sb.ws.move_entry("a.seq.json", "目标").unwrap(), "目标/a.seq.json");
    assert_eq!(sb.ws.read_text_file("目标/a.seq.json").unwrap(), "内容");
    assert!(!sb.ws_root.join("a.seq.json").exists());

    // 移回根目录。
    assert_eq!(sb.ws.move_entry("目标/a.seq.json", "").unwrap(), "a.seq.json");

    // 已经在该目录下 → 原地返回。
    assert_eq!(sb.ws.move_entry("a.seq.json", "").unwrap(), "a.seq.json");
}

#[test]
fn move_dir_and_reject_self_nesting() {
    let sb = Sandbox::new("move-dir");
    sb.mkdir("outer/inner");
    sb.write("outer/inner/a.seq.json", "{}");
    sb.mkdir("target");

    assert_eq!(sb.ws.move_entry("outer", "target").unwrap(), "target/outer");

    // 不能把目录搬进自己的子孙里。
    let err = expect_err(sb.ws.move_entry("target/outer", "target/outer/inner"));
    assert!(matches!(err, CoreError::Denied { .. }), "实际是 {err:?}");
    assert!(sb.ws_root.join("target/outer/inner/a.seq.json").exists());

    // 目标目录不存在 / 不是目录。
    expect_err(sb.ws.move_entry("target/outer", "不存在"));
    expect_err(sb.ws.move_entry("target/outer", "target/outer/inner/a.seq.json"));

    // 工作区外的目标目录。
    expect_err(sb.ws.move_entry("target/outer", "../outside"));
    assert!(sb.outside.join("outer").exists() == false);
}

#[test]
fn move_dedupes_target_name() {
    let sb = Sandbox::new("move-dedupe");
    sb.mkdir("src");
    sb.mkdir("dst");
    sb.write("src/a.seq.json", "来自src");
    sb.write("dst/a.seq.json", "已在dst");

    let rel = sb.ws.move_entry("src/a.seq.json", "dst").unwrap();
    assert_eq!(rel, "dst/a (2).seq.json");
    assert_eq!(sb.ws.read_text_file("dst/a.seq.json").unwrap(), "已在dst");
    assert_eq!(sb.ws.read_text_file("dst/a (2).seq.json").unwrap(), "来自src");
}

// ------------------------------------------------------------ 非图文件被忽略

#[test]
fn non_diagram_files_are_not_listed() {
    let sb = Sandbox::new("non-diagram");
    sb.mkdir("导出");
    sb.write("导出/ok.seq.json", "{}");

    // 用户可能自己往工作区里丢 PNG 之类的东西（或者导出到工作区旁边）。
    // 非 UTF-8 的二进制也一样：目录树只认 .seq.json。
    let png: [u8; 11] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe];
    fs::write(sb.ws_root.join("导出/图.png"), png).unwrap();
    fs::write(sb.ws_root.join("导出/说明.txt"), "文字").unwrap();
    fs::write(sb.ws_root.join("导出/伪装.json"), "{}").unwrap(); // .json 但不是 .seq.json

    let tree = sb.ws.list_tree().unwrap();
    assert_eq!(names(&tree), vec!["导出"]);

    let children = tree[0].children.as_ref().unwrap();
    assert_eq!(
        names(children),
        vec!["ok.seq.json"],
        "只有 .seq.json 该出现在目录树里"
    );

    // 但也只是“不显示”——文件本身还在，没被删掉。
    assert!(sb.ws_root.join("导出/图.png").exists());
}

// ------------------------------------------------------------------ 读文件

#[test]
fn read_text_file_errors_are_friendly() {
    let sb = Sandbox::new("read-err");

    expect_err(sb.ws.read_text_file("不存在.seq.json"));
    sb.mkdir("adir");
    expect_err(sb.ws.read_text_file("adir"));

    // 非 UTF-8 内容要报错而不是给出乱码。
    fs::write(sb.ws_root.join("bad.seq.json"), [0xff, 0xfe, 0x00]).unwrap();
    let err = expect_err(sb.ws.read_text_file("bad.seq.json"));
    assert!(
        err.to_string().contains("UTF-8"),
        "错误信息不够明确：{err}"
    );
}

// ------------------------------------------------------------ 工作区根目录

#[test]
fn open_rejects_invalid_roots() {
    let sb = Sandbox::new("bad-root");

    expect_err(rustdraw_core::Workspace::open(""));
    expect_err(rustdraw_core::Workspace::open(
        sb.base.path().join("根本不存在"),
    ));
    // 是文件不是目录。
    expect_err(rustdraw_core::Workspace::open(
        sb.outside.join("secret.txt"),
    ));
}

#[cfg(unix)]
#[test]
fn open_canonicalizes_symlinked_root() {
    let sb = Sandbox::new("symlink-root");
    // 用户通过软链接选工作区时，root 要规范化成真实路径，
    // 否则后面所有 starts_with 比较都会错。
    let link = sb.base.path().join("ws-link");
    std::os::unix::fs::symlink(&sb.ws_root, &link).unwrap();

    let ws = rustdraw_core::Workspace::open(&link).unwrap();
    assert_eq!(ws.root(), sb.ws_root.canonicalize().unwrap());

    ws.write_text_file("a.seq.json", "{}").unwrap();
    assert!(sb.ws_root.join("a.seq.json").exists());
}
