//! 集成测试夹具：造「假 CLI」脚本 + 收集事件。
//!
//! 桩程序是**真进程**（不是 mock）：群组这层的价值就在于「起进程、读流、杀树」，
//! 用假实现测不到那些。Unix 用 `.sh`，Windows 用 `.cmd` —— 后者同时验证
//! `proc::resolve_program` 的 PATHEXT / `cmd.exe /C` 启动器那条真机路径。

#![allow(dead_code)]

use std::path::{Path, PathBuf};

/// 写一个桩脚本。`unix` / `windows` 两段内容由调用方各写一遍
/// （照 agents 的 `common::cmd` 约定）。
///
/// 返回**脚本路径**（直接作为成员的 `command`；Linux 上是可执行的 `.sh`，
/// Windows 上是 `.cmd`，proc 会自动包 `cmd.exe /C`）。
pub fn write_stub(dir: &Path, name: &str, unix: &str, windows: &str) -> PathBuf {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = windows; // 另一半由调用方按平台各写一遍
        let path = dir.join(format!("{name}.sh"));
        std::fs::write(&path, unix).expect("写桩脚本");
        let mut perms = std::fs::metadata(&path).expect("读权限").permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&path, perms).expect("给执行权限");
        path
    }
    #[cfg(windows)]
    {
        let _ = unix;
        let path = dir.join(format!("{name}.cmd"));
        let body = windows.replace('\n', "\r\n");
        std::fs::write(&path, body).expect("写桩脚本");
        path
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (dir, name, unix, windows);
        unimplemented!("这个仓只支持 unix / windows")
    }
}

/// 桩脚本正文：把 stdin 存到 `stdin_path`，再把 `stdout_path` 的内容原样吐出来。
///
/// 参数（stdin/out 路径）直接嵌进脚本 —— 免得在 argv 里和中文/空格/引号较劲。
pub fn echo_stub(dir: &Path, name: &str, stdin_path: &Path, stdout_path: &Path) -> PathBuf {
    let unix = format!(
        "#!/bin/sh\ncat > '{}'\ncat '{}'\n",
        stdin_path.display(),
        stdout_path.display()
    );
    let windows = format!(
        "@echo off\nmore > \"{}\"\ntype \"{}\"\n",
        stdin_path.display(),
        stdout_path.display()
    );
    write_stub(dir, name, &unix, &windows)
}

/// 一个会睡很久的桩（取消/超时用）。`tree=true` 时再起一个孙进程，
/// 并把孙进程 pid 写到 `pid_path`（Unix 上用来断言「整棵树都没了」）。
pub fn slow_stub(dir: &Path, name: &str, stdin_path: &Path, pid_path: &Path, tree: bool) -> PathBuf {
    let unix = if tree {
        format!(
            "#!/bin/sh\nsleep 60 &\necho $! > '{}'\ncat > '{}'\nsleep 60\n",
            pid_path.display(),
            stdin_path.display()
        )
    } else {
        format!(
            "#!/bin/sh\ncat > '{}'\nsleep 60\n",
            stdin_path.display()
        )
    };
    // Windows：直接睡。孙进程（ping）在 Job Object 语义下由 CI 之外的真机确认；
    // 这里至少验证「取消能很快收掉直接子进程」。
    let _ = pid_path;
    let windows = format!(
        "@echo off\nmore > \"{}\"\nping -n 60 127.0.0.1 > nul\n",
        stdin_path.display()
    );
    write_stub(dir, name, &unix, &windows)
}

/// 轮询等一个文件出现（桩脚本写出来之后测试才能继续）。
pub async fn wait_for_file(path: &Path, timeout: std::time::Duration) -> bool {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if path.exists() {
            return true;
        }
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
}
