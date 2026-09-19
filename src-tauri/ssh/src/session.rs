//! 一个 SSH 会话：连接、认证、开 PTY、双向流、关闭。
//!
//! # 数据流模型和前三个模块**完全不同**
//!
//! Redis / SQL 是请求-响应：一条命令进去，一个结果出来，连接是共享的。
//! SSH 是**长连接上的双向流**：远端随时可能吐字节（`top` 每秒重绘一次），
//! 而写（键盘）、resize、关闭是三条独立的命令。所以这里没有「执行」这个概念，
//! 只有「开一个会话，然后往里灌/往外收」。
//!
//! 出口是一条 `mpsc`，不是 `tauri::ipc::Channel` —— 这个 crate 不依赖 tauri
//! （不然就没有脱离 WebKit 的集成测试了），Channel 的适配在 `ssh_commands.rs`。
//!
//! # 三条容易搞错、且都实际踩过的 russh 行为
//!
//! 这三条都是读源码核实的，写错了不会报错，只会表现得像「说不清哪里不对」：
//!
//! 1. **`Handle` 的 `Drop` 是空操作**（就是一句 `debug!`）。丢掉它**不会**断开
//!    连接 —— 远端 shell 和 PTY 会一直挂着，而且 keepalive 还在每 30 秒发一次。
//!    所以要断必须显式 [`Session::close`]。
//! 2. **`ChannelMsg::Close` 到不了客户端的接收端** —— 协议的 `CHANNEL_CLOSE`
//!    在 `encrypted.rs` 里被处理成 `channels.remove()`，不往接收端发消息。
//!    所以 `ChannelReadHalf::wait()` 返回 `None` 才是**正常的会话结束信号**。
//!    按「匹配 Eof/Close」写读循环的话，要么 panic，要么在关掉的 channel 上
//!    空转 100% CPU。
//! 3. **`request_pty` 的第一个参数是 `want_reply`**。传 `false` 不报错，
//!    只是静默地降级成一个**没有 PTY 的 shell** —— 没有行规程、没有作业控制、
//!    `Ctrl+C` 杀不掉前台进程。

use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use russh::client::{self, AuthResult, Msg};
use russh::keys::{self, PrivateKeyWithHashAlg};
use russh::{ChannelMsg, ChannelWriteHalf};
use serde::{Deserialize, Serialize};

use crate::error::SshError;
use crate::hostkey::{
    new_seen_slot, take_seen, verdict_from, HostKeyVerdict, SeenHostKey, TofuHandler,
};

/// 建连 + 握手的上限。和 redis/sql 那两处保持同一个量级
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
/// 开 PTY / 请求 shell 的应答上限
const SETUP_TIMEOUT: Duration = Duration::from_secs(10);

/// keepalive 间隔。
///
/// **默认是 `None`**，也就是永远不发 —— 一条被中间设备悄悄掐断的连接会一直
/// 显示成「已连接」，用户对着一个死终端打字而没有任何提示。所以这里必须设。
/// russh 在连续 `keepalive_max`（默认 3）次没收到回应后断开，加上本身一轮，
/// 大约 2 分钟后能发现死连接。
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(30);

/// 输出合并的时间窗口。
///
/// 不合并的话，远端每发一个 SSH 包就是一条 IPC 消息（包可以到 32KB），
/// 而 Tauri 在消息超过 8KB 时会**每条多走一次 fetch 往返**。合并之后
/// 一次 `top` 重绘是一个事件而不是几十个。
///
/// 8ms 是「人感觉不到」和「攒得够多」之间的折中：它略高于一帧，
/// 但远低于交互可感知的延迟。
const FLUSH_INTERVAL: Duration = Duration::from_millis(8);

/// 合并的字节上限。取 4KB 而不是更大：base64 之后约 5.4KB，
/// 仍在 JSON 那条 8KB 快速路径之内，不会每条都掉进 fetch 慢路径。
const FLUSH_BYTES: usize = 4 * 1024;

/// 读循环和后端转发之间的缓冲条数。
///
/// **有界是重点**：前端卡住时，读循环会在 `send` 上等，于是不再从 SSH 读，
/// 于是 TCP 窗口填满，于是远端自己减速 —— 这就是整条链路的流控。
/// 无界的话前端一慢，内存就开始涨，最后是一起崩。
pub const EVENT_BUFFER: usize = 256;

/// 认证方式。字段名要和前端 `core/types.ts` 的判别联合对上。
///
/// ⚠️ **`rename_all_fields` 不能省，也不能用 `rename_all` 顶替。**
/// 枚举上的 `rename_all` 只改**变体名**（`Key` → `key`），
/// **不改变体内部的字段名** —— 少了 `rename_all_fields` 的话，
/// 前端发来的 `privateKeyPath` 对不上 Rust 的 `private_key_path`，
/// 报出来的是 `missing field 'private_key_path'`。
///
/// 这个坑很隐蔽：浏览器版走假实现（根本不经过 serde）、Rust 集成测试在 Rust 里
/// 构造 `SshConfig`（不经过反序列化）—— **两条测试路径都盖不到这条缝**，
/// 只有真机跑一次才看得见。所以下面还有一组钉死 IPC 契约的测试。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum SshAuth {
    Password {
        password: String,
    },
    Key {
        private_key_path: String,
        passphrase: String,
    },
}

/// 开一个会话需要的全部参数
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: SshAuth,
    /// 终端类型，作为 `TERM` 报给远端
    pub term: String,
    pub cols: u32,
    pub rows: u32,
    /// 已经信任的指纹，没见过就是 `None`
    pub expected_fingerprint: Option<String>,
    /// 用户是否刚刚在界面上明确点了「信任并继续」
    pub accept_new_host_key: bool,
}

impl SshConfig {
    fn address(&self) -> String {
        format!("{}:{}", self.host, self.port)
    }
}

/// 推给前端的事件
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TerminalEvent {
    /// 终端输出。`bytes` 是 **base64**，理由见 `core/types.ts` 里那段
    Data { bytes: String },
    /// 会话结束。**这永远是最后一个事件**
    Exit { code: Option<u32>, reason: String },
}

/// [`open`] 的结局。
///
/// 主机密钥的两种拒绝是**变体不是 `Err`**，理由见 `error.rs` 和
/// `hostkey.rs` 的头部注释 —— 简单说：前端要分支处理，而 `Err` 那条路上
/// 只有一句字符串。
#[derive(Debug)]
pub enum OpenResult {
    Ready(Box<Session>),
    HostKeyUnknown(SeenHostKey),
    HostKeyMismatch {
        expected: String,
        actual: SeenHostKey,
    },
}

/// 一个活着的会话。
///
/// 内部三样东西各有各的作用，缺一不可：
/// - `write`：发键盘、改尺寸、关通道。`ChannelWriteHalf` **不是 `Clone`**
///   （它持有的是 `tokio::sync::mpsc::Sender`，但结构体没有 derive），
///   所以外面套一层 `Arc` 才能在 `&self` 的方法里用。
/// - `handle`：**只为了让它活着**。它一被丢下，会话循环就结束了。
/// - `reader`：读循环任务，关闭时 abort 掉。
pub struct Session {
    write: Arc<ChannelWriteHalf<Msg>>,
    handle: client::Handle<TofuHandler>,
    reader: tokio::task::JoinHandle<()>,
    /// 会话代次。
    ///
    /// 用来做「摘除自己」时的身份校验：读循环结束时要把它从表里删掉，
    /// 但如果这个 id 已经被一个新会话顶替了（TOFU 重试就是同 id 重连），
    /// 删掉的会是**新会话**。代次在一次进程内单调递增、不会重复，
    /// 所以 `表里那个代次 == 我的代次` 就足以确认「那个确实是我」。
    ///
    /// 不用 `Arc::as_ptr` 做身份：地址会被回收，新会话有可能恰好落在同一个
    /// 地址上 —— 那正是这个校验要防的 ABA 问题。
    generation: u64,
    /// 这次握手实际用的主机密钥
    pub fingerprint: String,
    pub algorithm: String,
    pub address: String,
    pub username: String,
}

impl Session {
    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// 往远端发键盘输入
    pub async fn write(&self, bytes: &[u8]) -> Result<(), SshError> {
        if bytes.is_empty() {
            return Ok(());
        }
        // `data` 收的是 AsyncRead，`&[u8]` 正好实现了它。
        // 内部会按通道窗口和最大包长切块，不用我们操心。
        self.write
            .data(bytes)
            .await
            .map_err(|e| map_channel_error(&self.address, e))
    }

    /// 告诉远端窗口大小变了。
    ///
    /// 不发这个的话，`vim`、`top` 这些全屏程序会按旧尺寸排版：
    /// 拉伸窗口之后它们既不重排也不重绘，看起来就是花屏。
    pub async fn resize(&self, cols: u32, rows: u32) -> Result<(), SshError> {
        self.write
            .window_change(cols, rows, 0, 0)
            .await
            .map_err(|e| map_channel_error(&self.address, e))
    }

    /// 主动关掉会话。
    ///
    /// ⚠️ **必须显式做这件事** —— 丢下 `Session` 什么都不会发生，
    /// 见文件头部第 1 条。三步都要走：
    /// 先 `eof` 让远端知道没有更多输入了（交互式 shell 会因此退出），
    /// 再 `close` 关掉通道，最后 `disconnect` 断连接。
    ///
    /// 幂等：每一步的失败都忽略 —— 用户点「关闭标签」的时候，
    /// 会话可能早就自己结束了，这时候报错没有任何意义。
    pub async fn close(&self) {
        let _ = self.write.eof().await;
        let _ = self.write.close().await;
        let _ = self
            .handle
            .disconnect(russh::Disconnect::ByApplication, "", "zh-CN")
            .await;
        self.reader.abort();
    }
}

impl std::fmt::Debug for Session {
    /// 手写而不是 derive：`Handle` 和 `JoinHandle` 都没有好用的 Debug，
    /// 而真正想看的就那几样。顺带保证**凭据永远不出现在日志里** ——
    /// 这个结构体里根本没有密码和口令字段，从类型上就杜绝了。
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Session")
            .field("address", &self.address)
            .field("username", &self.username)
            .field("fingerprint", &self.fingerprint)
            .field("algorithm", &self.algorithm)
            .field("generation", &self.generation)
            .finish_non_exhaustive()
    }
}

// ------------------------------------------------------------------ 建立会话

/// 建连、认证、开 PTY、起读循环。
///
/// `generation` 由注册表分配，`events` 是输出流。
pub async fn open(
    cfg: &SshConfig,
    generation: u64,
    events: tokio::sync::mpsc::Sender<TerminalEvent>,
) -> Result<OpenResult, SshError> {
    validate(cfg)?;
    let address = cfg.address();

    // 私钥**在连接之前**读掉。路径写错、口令记错这类问题该立刻报出来，
    // 而不是等 TCP 建好、握手走完，再拿一个语焉不详的认证失败打发用户。
    let private_key = match &cfg.auth {
        SshAuth::Key {
            private_key_path,
            passphrase,
        } => Some(load_private_key(private_key_path, passphrase)?),
        SshAuth::Password { .. } => None,
    };

    // ⚠️ 每次尝试一个全新的格子。`connect` 外面套的 timeout **不会取消**
    // 已经 spawn 出去的会话，超时之后那次握手的 check_server_key 照样会跑并
    // 写进格子。复用的话，用户看到的会是上一次（可能是攻击者的）那把密钥。
    let seen = new_seen_slot();
    let handler = TofuHandler::new(
        cfg.expected_fingerprint.clone(),
        cfg.accept_new_host_key,
        seen.clone(),
    );

    let config = Arc::new(client::Config {
        // 不设的话死连接永远发现不了，见 KEEPALIVE_INTERVAL 的注释
        keepalive_interval: Some(KEEPALIVE_INTERVAL),
        // 终端是对延迟最敏感的东西：敲一个键要立刻出去，不能等 Nagle 凑包
        nodelay: true,
        ..Default::default()
    });

    let connecting = client::connect(config, (cfg.host.as_str(), cfg.port), handler);
    let mut handle = match tokio::time::timeout(CONNECT_TIMEOUT, connecting).await {
        Ok(Ok(handle)) => handle,

        // ⚠️ 这条分支是主机密钥判定**唯一**作数的地方。
        //
        // 只有 `connect` 明确回 `UnknownKey`（也就是我们的 `check_server_key`
        // 回了 false）时，格子里的「看到了什么」才可信。其它任何错误都可能是
        // 「密钥已经接受了、但后面某一步失败」—— 那时候如果把格子里的密钥当成
        // 「用户需要确认的新密钥」报上去，用户一点信任，攻击者的密钥就被钉死了。
        Ok(Err(russh::Error::UnknownKey)) => {
            return match verdict_from(&seen, cfg.expected_fingerprint.as_deref()) {
                Some(HostKeyVerdict::Unknown(key)) => Ok(OpenResult::HostKeyUnknown(key)),
                Some(HostKeyVerdict::Mismatch { expected, actual }) => {
                    Ok(OpenResult::HostKeyMismatch { expected, actual })
                }
                // 判定是「一致」却收到 UnknownKey，只可能是并发下的极端时序。
                // 不猜，如实报成连接失败 —— 安全路径上宁可多失败一次。
                _ => Err(SshError::Connect {
                    address,
                    reason: "主机密钥校验没有通过".to_string(),
                }),
            };
        }
        Ok(Err(e)) => {
            return Err(SshError::Connect {
                address,
                reason: e.to_string(),
            })
        }
        Err(_) => {
            return Err(SshError::Connect {
                address,
                reason: format!("握手超过 {} 秒没有完成", CONNECT_TIMEOUT.as_secs()),
            })
        }
    };

    authenticate(&mut handle, cfg, &address, private_key).await?;

    // ---------------------------------------------------------------- 开通道
    let channel = handle.channel_open_session().await.map_err(|e| SshError::Connect {
        address: address.clone(),
        reason: format!("无法打开会话通道：{e}"),
    })?;
    let (mut read_half, write_half) = channel.split();
    let write = Arc::new(write_half);

    // want_reply 传 true：传 false 不报错，只是静默地没有 PTY，见文件头部第 3 条
    write
        .request_pty(true, &cfg.term, cfg.cols, cfg.rows, 0, 0, &[])
        .await
        .map_err(|e| SshError::Connect {
            address: address.clone(),
            reason: format!("申请 PTY 失败：{e}"),
        })?;
    write
        .request_shell(true)
        .await
        .map_err(|e| SshError::Connect {
            address: address.clone(),
            reason: format!("申请 shell 失败：{e}"),
        })?;

    // ------------------------------------------------------- 等 PTY 的应答
    //
    // 服务端可能在我们等到应答之前就已经开始发东西了（登录横幅、MOTD、
    // 甚至一个立刻退出的 shell），**那些字节一个都不能丢** —— 所以把它们
    // 先攒在 `pending` 里，读循环起来之后再补发。
    let mut pending: Vec<ChannelMsg> = Vec::new();
    let mut succeeded = 0usize;
    let setup_deadline = tokio::time::Instant::now() + SETUP_TIMEOUT;
    while succeeded < 2 {
        let next = tokio::time::timeout_at(setup_deadline, read_half.wait()).await;
        match next {
            Ok(Some(ChannelMsg::Success)) => succeeded += 1,
            Ok(Some(ChannelMsg::Failure)) => {
                // 服务端明确拒绝了 PTY 或 shell。这通常意味着它的 sshd 配了
                // 限制（比如 `PermitTTY no`），是个值得说清楚的失败
                return Err(SshError::Connect {
                    address,
                    reason: "服务端拒绝了 PTY 或 shell 请求（可能配置了禁用终端）".to_string(),
                });
            }
            Ok(Some(other)) => pending.push(other),
            // None 意味着会话在建立过程中就结束了 —— 多半是远端立刻退出了
            Ok(None) => break,
            Err(_) => {
                // 超时不当作致命错误：有些服务端就是不爱回 want_reply。
                // 继续往下走，会话能用就行 —— 但要记一笔，因为它通常
                // 说明这台服务器有点特别
                break;
            }
        }
    }

    // ---------------------------------------------------------------- 读循环
    let reader = tokio::spawn(read_loop(read_half, pending, events));

    // 走到这里握手已经成功了，格子里的密钥就是这次实际用的那把。
    //
    // 取不到是理论上不该发生的事（check_server_key 一定在握手时被调过），
    // 但真到那一步也不该 panic —— 会话是好的，只是指纹显示不出来，
    // 那比整个会话开不起来好。空指纹在前端会显示成「未记录」，不会假装成已信任。
    let seen_key = take_seen(&seen).unwrap_or(SeenHostKey {
        algorithm: String::new(),
        fingerprint: String::new(),
    });

    Ok(OpenResult::Ready(Box::new(Session {
        write,
        handle,
        reader,
        generation,
        fingerprint: seen_key.fingerprint,
        algorithm: seen_key.algorithm,
        address,
        username: cfg.username.clone(),
    })))
}

/// 读循环：把远端吐的字节合并成事件推出去。
///
/// 结束的**主要信号是 `None`**（通道被关掉了），不是 `ChannelMsg::Close` ——
/// 后者根本到不了这里，见文件头部第 2 条。
async fn read_loop(
    mut read_half: russh::ChannelReadHalf,
    pending: Vec<ChannelMsg>,
    events: tokio::sync::mpsc::Sender<TerminalEvent>,
) {
    let mut buffer: Vec<u8> = Vec::new();
    let mut exit_code: Option<u32> = None;

    // 定时器的作用是「攒够时间就发」，不是为了轮询。
    // 没有数据的时候它什么也不做（下面判了空），所以不会空转。
    let mut ticker = tokio::time::interval(FLUSH_INTERVAL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    let mut closed_by_us = false;

    for first in pending {
        if !absorb(first, &mut buffer, &mut exit_code, &mut closed_by_us) {
            break;
        }
    }

    if !closed_by_us {
        loop {
            tokio::select! {
                incoming = read_half.wait() => {
                    match incoming {
                        Some(msg) => {
                            if !absorb(msg, &mut buffer, &mut exit_code, &mut closed_by_us) {
                                break;
                            }
                            // 攒够了就立刻发，别等定时器
                            if buffer.len() >= FLUSH_BYTES && !flush(&mut buffer, &events).await {
                                return;
                            }
                        }
                        // 会话结束的主要信号
                        None => break,
                    }
                }
                _ = ticker.tick() => {
                    if !buffer.is_empty() && !flush(&mut buffer, &events).await {
                        return;
                    }
                }
            }
        }
    }

    // 收尾：最后一点没发完的字节，然后是结束事件。
    // Exit **永远是最后一个事件**，前端靠它来收尾。
    flush(&mut buffer, &events).await;
    let reason = if exit_code.is_some() {
        "已退出".to_string()
    } else if closed_by_us {
        "已关闭".to_string()
    } else {
        // 没收到退出码就断了，那就是连接掉了
        "连接已断开".to_string()
    };
    let _ = events
        .send(TerminalEvent::Exit {
            code: exit_code,
            reason,
        })
        .await;
}

/// 处理一条通道消息。返回 `false` 表示读循环该收尾了。
fn absorb(
    msg: ChannelMsg,
    buffer: &mut Vec<u8>,
    exit_code: &mut Option<u32>,
    closed_by_us: &mut bool,
) -> bool {
    match msg {
        ChannelMsg::Data { data } => {
            buffer.extend_from_slice(&data);
            true
        }
        // 带外数据（`ext == 1` 就是 stderr）。
        // 有 PTY 的时候 stderr 通常已经并进主流了，但没并的时候也不能丢 ——
        // 用户宁可在终端里看到两遍，也不该看不到报错
        ChannelMsg::ExtendedData { data, .. } => {
            buffer.extend_from_slice(&data);
            true
        }
        ChannelMsg::ExitStatus { exit_status } => {
            *exit_code = Some(exit_status);
            true
        }
        ChannelMsg::Eof => true,
        ChannelMsg::Close => {
            *closed_by_us = true;
            false
        }
        _ => true,
    }
}

/// 把攒下的字节作为事件发出去。返回 `false` 表示接收端没了。
///
/// ⚠️ **单条事件必须守住 [`FLUSH_BYTES`]。** 那个常量管的是「什么时候 flush」，
/// 但一条 russh 包本身可能就有 32KB（`cat` 一个大文件、编译输出），
/// `absorb` 会先把它整个塞进缓冲 —— 于是这一条 flush 出来的事件远超 4KB，
/// 掉进 Tauri 的**慢路径**：超过 8KB 的消息不放 `webview.eval`，而是存进
/// Rust 侧一张表等 WebView 执行一段 fetch 回来取，那张表**没有上限也没有超时**
/// （WebView 被系统节流或卡住时就没人来取，数据一直堆在 Rust 进程里）。
/// 所以这里**按 [`FLUSH_BYTES`] 切片**：代价只是事件条数多一点，
/// 换来「这一路永远走快路径」这个保证。
async fn flush(
    buffer: &mut Vec<u8>,
    events: &tokio::sync::mpsc::Sender<TerminalEvent>,
) -> bool {
    if buffer.is_empty() {
        return true;
    }

    for chunk in buffer.chunks(FLUSH_BYTES) {
        let payload = base64::engine::general_purpose::STANDARD.encode(chunk);
        if events
            .send(TerminalEvent::Data { bytes: payload })
            .await
            .is_err()
        {
            buffer.clear();
            return false;
        }
    }
    buffer.clear();
    true
}

// ------------------------------------------------------------------ 小工具

fn validate(cfg: &SshConfig) -> Result<(), SshError> {
    if cfg.host.trim().is_empty() {
        return Err(SshError::BadConfig {
            reason: "主机名不能为空".to_string(),
        });
    }
    if cfg.port == 0 {
        return Err(SshError::BadConfig {
            reason: "端口必须在 1–65535 之间".to_string(),
        });
    }
    if cfg.username.trim().is_empty() {
        return Err(SshError::BadConfig {
            reason: "用户名不能为空".to_string(),
        });
    }
    match &cfg.auth {
        SshAuth::Password { password } if password.is_empty() => Err(SshError::BadConfig {
            reason: "密码不能为空".to_string(),
        }),
        SshAuth::Key {
            private_key_path, ..
        } if private_key_path.trim().is_empty() => Err(SshError::BadConfig {
            reason: "私钥文件路径不能为空".to_string(),
        }),
        _ => Ok(()),
    }
}

fn load_private_key(path: &str, passphrase: &str) -> Result<keys::PrivateKey, SshError> {
    // 空口令要传 None 而不是 Some("")：`decode_secret_key` 拿 Some("")
    // 去解一把没加密的钥匙会失败
    let pass = if passphrase.is_empty() {
        None
    } else {
        Some(passphrase)
    };
    keys::load_secret_key(path, pass).map_err(|e| SshError::KeyFile {
        path: path.to_string(),
        reason: e.to_string(),
    })
}

async fn authenticate(
    handle: &mut client::Handle<TofuHandler>,
    cfg: &SshConfig,
    address: &str,
    private_key: Option<keys::PrivateKey>,
) -> Result<(), SshError> {
    let result = match (&cfg.auth, private_key) {
        (SshAuth::Password { password }, _) => {
            handle.authenticate_password(&cfg.username, password).await
        }
        (SshAuth::Key { .. }, Some(key)) => {
            // RSA 的签名算法要和服务器谈。非 RSA 的钥匙这个值是 None，
            // 传进去也会被忽略；拿不到就退回默认，不让它挡住认证
            let hash_alg = handle
                .best_supported_rsa_hash()
                .await
                .ok()
                .flatten()
                .flatten();
            handle
                .authenticate_publickey(&cfg.username, PrivateKeyWithHashAlg::new(Arc::new(key), hash_alg))
                .await
        }
        // validate 已经拦了，走不到这里
        (SshAuth::Key { .. }, None) => {
            return Err(SshError::BadConfig {
                reason: "私钥认证缺少私钥".to_string(),
            })
        }
    };

    match result {
        Ok(AuthResult::Success) => Ok(()),
        Ok(AuthResult::Failure {
            remaining_methods, ..
        }) => {
            // 把服务端还允许的方式带出来：用户拿到的「密码不对」和
            // 「这台机器不让用密码登录，只能用密钥」是两件要做不同事的事
            let hint = if remaining_methods.is_empty() {
                String::new()
            } else {
                format!("服务端可接受的认证方式：{remaining_methods:?}")
            };
            Err(SshError::Auth {
                address: address.to_string(),
                reason: if hint.is_empty() {
                    "服务器拒绝了这组凭据".to_string()
                } else {
                    format!("服务器拒绝了这组凭据。{hint}")
                },
            })
        }
        Err(e) => Err(SshError::Auth {
            address: address.to_string(),
            reason: e.to_string(),
        }),
    }
}

fn map_channel_error(address: &str, e: russh::Error) -> SshError {
    SshError::Transport {
        id: address.to_string(),
        reason: e.to_string(),
    }
}

/// IPC 契约。
///
/// # 为什么这组测试非有不可
///
/// 前端和 Rust 之间那条缝**两边的测试都盖不到**：
///
/// - 浏览器版 e2e 走 `services/web.ts` 的假实现，**根本不经过 serde**；
/// - Rust 的集成测试在 Rust 里构造 `SshConfig`，**不经过反序列化**。
///
/// 所以字段名对不上这种错（实测踩过一次：枚举上的 `rename_all` 不改变体
/// 内部的字段名，`privateKeyPath` 对不上 `private_key_path`）会一路溜到
/// 真机才炸，报的还是 `missing field '...'` 这种让人摸不着头脑的话。
///
/// 这里拿**前端实际会发出来的那个 JSON 字面量**去反序列化 —— 手写字段名，
/// 不照着 Rust 结构体拼，否则就变成自己跟自己对了。
#[cfg(test)]
mod contract {
    use super::*;
    use crate::{OpenOutcome, SshSessionInfo};

    #[test]
    fn 前端发来的密码认证能解出来() {
        // 这份 JSON 是照着 modules/ssh/services/tauri.ts 里 `ssh_open` 的
        // config 参数逐字写的
        let raw = r#"{
            "host": "127.0.0.1",
            "port": 2222,
            "username": "root",
            "auth": { "kind": "password", "password": "secret" },
            "term": "xterm-256color",
            "cols": 80,
            "rows": 24,
            "expectedFingerprint": null,
            "acceptNewHostKey": false
        }"#;

        let cfg: SshConfig = serde_json::from_str(raw).expect("前端发来的形状必须能解出来");
        assert_eq!(cfg.host, "127.0.0.1");
        assert_eq!(cfg.port, 2222);
        assert_eq!(cfg.accept_new_host_key, false);
        assert_eq!(cfg.expected_fingerprint, None);
        assert_eq!(
            cfg.auth,
            SshAuth::Password {
                password: "secret".to_string()
            }
        );
    }

    /// ⚠️ 这条就是真机上炸掉的那条。
    ///
    /// `privateKeyPath` 是 camelCase，而 Rust 字段是 `private_key_path` ——
    /// 枚举上的 `rename_all` **不负责这个**，得靠 `rename_all_fields`。
    #[test]
    fn 前端发来的私钥认证能解出来_字段名是_camelCase() {
        let raw = r#"{
            "host": "127.0.0.1",
            "port": 2222,
            "username": "root",
            "auth": {
                "kind": "key",
                "privateKeyPath": "/tmp/ssh-live/client_key",
                "passphrase": ""
            },
            "term": "xterm-256color",
            "cols": 80,
            "rows": 24,
            "expectedFingerprint": "SHA256:vWrmtL0x9uAa9Mkep7yEAsPK0UxwVlFPeY90U58/0A4",
            "acceptNewHostKey": true
        }"#;

        let cfg: SshConfig = serde_json::from_str(raw).expect("前端发来的形状必须能解出来");
        assert_eq!(
            cfg.auth,
            SshAuth::Key {
                private_key_path: "/tmp/ssh-live/client_key".to_string(),
                passphrase: String::new(),
            }
        );
        assert_eq!(
            cfg.expected_fingerprint.as_deref(),
            Some("SHA256:vWrmtL0x9uAa9Mkep7yEAsPK0UxwVlFPeY90U58/0A4")
        );
        assert!(cfg.accept_new_host_key);
    }

    #[test]
    fn 认证方式的变体名是_kind_标签的小写() {
        assert_eq!(
            serde_json::to_value(SshAuth::Password {
                password: "x".to_string()
            })
            .expect("序列化"),
            serde_json::json!({ "kind": "password", "password": "x" })
        );
        assert_eq!(
            serde_json::to_value(SshAuth::Key {
                private_key_path: "/k".to_string(),
                passphrase: String::new(),
            })
            .expect("序列化"),
            serde_json::json!({ "kind": "key", "privateKeyPath": "/k", "passphrase": "" })
        );
    }

    /// 前端 `core/types.ts` 里 `SshOpenOutcome` 的三个分支
    #[test]
    fn 开会话的三种结局形状对得上前端的判别联合() {
        assert_eq!(
            serde_json::to_value(OpenOutcome::Ready(SshSessionInfo {
                address: "127.0.0.1:22".to_string(),
                username: "root".to_string(),
                fingerprint: "SHA256:AAA".to_string(),
                algorithm: "ssh-ed25519".to_string(),
            }))
            .expect("序列化"),
            serde_json::json!({
                "kind": "ready",
                "address": "127.0.0.1:22",
                "username": "root",
                "fingerprint": "SHA256:AAA",
                "algorithm": "ssh-ed25519",
            })
        );

        assert_eq!(
            serde_json::to_value(OpenOutcome::HostKeyUnknown {
                host: "example.com".to_string(),
                port: 22,
                algorithm: "ssh-ed25519".to_string(),
                fingerprint: "SHA256:AAA".to_string(),
            })
            .expect("序列化"),
            serde_json::json!({
                "kind": "hostKeyUnknown",
                "host": "example.com",
                "port": 22,
                "algorithm": "ssh-ed25519",
                "fingerprint": "SHA256:AAA",
            })
        );

        assert_eq!(
            serde_json::to_value(OpenOutcome::HostKeyMismatch {
                host: "example.com".to_string(),
                port: 22,
                algorithm: "ssh-ed25519".to_string(),
                expected: "SHA256:OLD".to_string(),
                actual: "SHA256:NEW".to_string(),
            })
            .expect("序列化"),
            serde_json::json!({
                "kind": "hostKeyMismatch",
                "host": "example.com",
                "port": 22,
                "algorithm": "ssh-ed25519",
                "expected": "SHA256:OLD",
                "actual": "SHA256:NEW",
            })
        );
    }

    #[test]
    fn 会话事件形状对得上前端的_TerminalEvent() {
        assert_eq!(
            serde_json::to_value(TerminalEvent::Data {
                bytes: "aGVsbG8=".to_string(),
            })
            .expect("序列化"),
            serde_json::json!({ "kind": "data", "bytes": "aGVsbG8=" })
        );

        assert_eq!(
            serde_json::to_value(TerminalEvent::Exit {
                code: Some(3),
                reason: "已退出".to_string(),
            })
            .expect("序列化"),
            serde_json::json!({ "kind": "exit", "code": 3, "reason": "已退出" })
        );

        // 连接断掉这类非正常结束没有退出码
        assert_eq!(
            serde_json::to_value(TerminalEvent::Exit {
                code: None,
                reason: "连接已断开".to_string(),
            })
            .expect("序列化"),
            serde_json::json!({ "kind": "exit", "code": null, "reason": "连接已断开" })
        );
    }
}
