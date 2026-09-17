//! 测试用的临时目录。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use rustdraw_core::Workspace;

static COUNTER: AtomicU64 = AtomicU64::new(0);

pub struct TempDir {
    path: PathBuf,
}

impl TempDir {
    pub fn new(tag: &str) -> TempDir {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!(
            "rustdraw-test-{tag}-{}-{nanos}-{n}",
            std::process::id()
        ));
        std::fs::create_dir_all(&path).expect("创建临时目录");
        TempDir { path }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

/// 一个典型的测试场景：
///
/// ```text
/// <base>/
/// ├── ws/          ← 工作区
/// └── outside/     ← 工作区外，装着不该被碰到的机密文件
///     └── secret.txt
/// ```
pub struct Sandbox {
    pub base: TempDir,
    pub ws_root: PathBuf,
    pub outside: PathBuf,
    pub ws: Workspace,
}

impl Sandbox {
    pub fn new(tag: &str) -> Sandbox {
        let base = TempDir::new(tag);
        let ws_root = base.path().join("ws");
        let outside = base.path().join("outside");
        std::fs::create_dir(&ws_root).unwrap();
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(outside.join("secret.txt"), "TOP SECRET").unwrap();

        // Workspace::open 会 canonicalize；macOS 上 /var 是 /private/var 的软链接，
        // 所以后面所有断言都得拿 ws.root() 去比，不能拿 ws_root。
        let ws = Workspace::open(&ws_root).expect("打开工作区");

        Sandbox {
            base,
            ws_root,
            outside,
            ws,
        }
    }

    /// 工作区外那个机密文件的内容。
    pub fn secret(&self) -> String {
        std::fs::read_to_string(self.outside.join("secret.txt")).unwrap()
    }

    pub fn write(&self, rel: &str, contents: &str) {
        let p = self.ws_root.join(rel);
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(p, contents).unwrap();
    }

    pub fn mkdir(&self, rel: &str) {
        std::fs::create_dir_all(self.ws_root.join(rel)).unwrap();
    }

    /// 在沙箱里造一个软链接。`target` 是链接指向的位置。
    #[cfg(unix)]
    pub fn symlink(&self, rel: &str, target: &Path) {
        let link = self.ws_root.join(rel);
        if let Some(parent) = link.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::os::unix::fs::symlink(target, &link).unwrap();
    }
}

/// 命令一律返回 `Result`；这里断言它失败了，并给出原始错误方便定位。
#[track_caller]
pub fn expect_err<T: std::fmt::Debug>(result: Result<T, rustdraw_core::CoreError>) -> rustdraw_core::CoreError {
    match result {
        Ok(v) => panic!("本应失败，却成功了：{v:?}"),
        Err(e) => e,
    }
}
