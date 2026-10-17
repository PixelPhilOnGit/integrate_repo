//! 一次性 exec：连上去、跑一条命令、把 stdout / stderr / 退出码收回来。
//!
//! 用途：智能体会话的「远端目录浏览器」—— 连上别人的机器列一下目录，
//! 让用户点选路径（用户 2026-10-16 提的「交互式的体验好点」）。
//!
//! # 为什么不复用 PTY 会话
//!
//! PTY 是**长连接 + 交互**（终端屏幕、行规程、尺寸），而列表目录是
//! **一问一答**：起 shell、跑命令、收完就断。用 PTY 干这个要解析终端回显，
//! 脆弱且没必要。exec 通道没有 PTY 那层噪声，输出就是干净的命令输出。
//!
//! # 信任策略和 PTY 会话**共用一份**（`connect_authenticated`）
//!
//! 主机密钥的 TOFU / 错配硬停只在 `session.rs` 实现一次 —— 这条链路
//! 抄第二份的日子就是两份开始漂移的日子，而它是安全边界上最不能漂的地方。
//! 两个拒绝态原样带出来（前端复用同一套信任弹窗）。

use std::time::Duration;

use russh::ChannelMsg;

use crate::error::SshError;
use crate::hostkey::SeenHostKey;
use crate::session::{connect_authenticated, Connected};
use crate::SshConfig;

/// 单条流的收集上限（目录列表这种量级绰绰有余；防的是「命令意外输出
/// 一大坨」把内存吃穿）。
const STREAM_CAP: usize = 1024 * 1024;

#[derive(Debug, Clone)]
pub struct ExecOutput {
    pub exit_code: Option<u32>,
    /// ⚠️ **按原文收**：有些老服务器的文件名不是合法 UTF-8。展示层用
    /// lossy 转换没问题，但别在这里就丢字节（丢的是真实文件名）
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

impl ExecOutput {
    pub fn stdout_text(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }

    pub fn stderr_text(&self) -> String {
        String::from_utf8_lossy(&self.stderr).into_owned()
    }
}

/// 和 `OpenResult` 同形状：两个拒绝态是 `Ok` 变体（前端要分支处理）。
#[derive(Debug)]
pub enum ExecOutcome {
    Ready(ExecOutput),
    HostKeyUnknown(SeenHostKey),
    HostKeyMismatch {
        expected: String,
        actual: SeenHostKey,
    },
}

/// 连上去跑一条命令。`timeout` 覆盖建连 + 命令全程。
pub async fn exec_capture(
    cfg: &SshConfig,
    command: &str,
    timeout: Duration,
) -> Result<ExecOutcome, SshError> {
    let address = cfg.address();
    let handle = match connect_authenticated(cfg).await? {
        Connected::Ready { handle, .. } => handle,
        Connected::HostKeyUnknown(key) => return Ok(ExecOutcome::HostKeyUnknown(key)),
        Connected::HostKeyMismatch { expected, actual } => {
            return Ok(ExecOutcome::HostKeyMismatch { expected, actual })
        }
    };

    let run = async {
        let mut channel = handle.channel_open_session().await.map_err(|e| SshError::Connect {
            address: address.clone(),
            reason: format!("无法打开会话通道：{e}"),
        })?;

        // want_reply=true：要等服务器接受再收输出（有的服务器会先回一个
        // 失败 —— 比如禁了 exec 的受限账号，那要报出来而不是空等）
        channel.exec(true, command).await.map_err(|e| SshError::Connect {
            address: address.clone(),
            reason: format!("远端拒绝执行命令：{e}"),
        })?;

        let mut out = ExecOutput {
            exit_code: None,
            stdout: Vec::new(),
            stderr: Vec::new(),
        };
        while let Some(msg) = channel.wait().await {
            match msg {
                ChannelMsg::Data { data } => {
                    if out.stdout.len() < STREAM_CAP {
                        out.stdout.extend_from_slice(&data);
                    }
                }
                ChannelMsg::ExtendedData { data, ext } if ext == 1 => {
                    if out.stderr.len() < STREAM_CAP {
                        out.stderr.extend_from_slice(&data);
                    }
                }
                ChannelMsg::ExitStatus { exit_status } => out.exit_code = Some(exit_status),
                ChannelMsg::Eof | ChannelMsg::Close => break,
                _ => {}
            }
        }
        Ok::<ExecOutput, SshError>(out)
    };

    let out = tokio::time::timeout(timeout, run)
        .await
        .map_err(|_| SshError::Connect {
            address: address.clone(),
            reason: format!("命令超过 {} 秒没有返回", timeout.as_secs()),
        })??;

    // 显式断开（丢下 handle 不保证立刻关连接，和 Session::close 第 1 条同理）
    let _ = handle
        .disconnect(russh::Disconnect::ByApplication, "", "zh-CN")
        .await;

    Ok(ExecOutcome::Ready(out))
}
