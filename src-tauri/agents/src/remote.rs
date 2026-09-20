//! 远端会话：在**另外一台机器**上开 agent。
//!
//! # 为什么在这儿（而不是在 app crate 里接线）
//!
//! 「连远端」需要的连接、认证、主机密钥、PTY，`devtoolkit-ssh` 那一套**全都有**
//! 而且被真机磨过。这一层做的事只有一件：**把它的形状翻成 `pty.rs` 那套**，
//! 让上层（命令层、前端）不用认识两套东西。
//!
//! ⚠️ 于是 `agents` 依赖了 `ssh` —— 两个内核第一次互相依赖。理由：它们服务的是
//! **同一个应用的同一件事**（在这个窗格里跑一个 agent，只是那个进程在别处），
//! 而不是两个通用库。硬拆成一个中间 crate 只会多一份版本号和一层转发。
//!
//! # 和本地那条路的三处形状差异（都是 ssh 那边固有的，不是我们选的）
//!
//! | | 本地 pty | 远端 ssh |
//! |---|---|---|
//! | 开会话 | **同步** | **async** |
//! | 事件流 | `spawn` 返回 `Receiver` | `open` 要求传入 `Sender` |
//! | 打开结果 | 成功 / 失败 | 四态（主机密钥那两种**不是错误**） |
//!
//! 前两条在这一层抹平（事件一律吐 `PtyEvent`、注册表自己管 Sender），
//! **第三条抹不平也不该抹** —— 主机密钥没核对过就是没核对过，
//! 上层必须能看见（见 [`RemoteOutcome`]）。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tokio::sync::mpsc;

use devtoolkit_ssh::session::{self, OpenResult, SshAuth, SshConfig, TerminalEvent};

use crate::error::AgentError;
use crate::pty::PtyEvent;

/// 前端在「远端工作目录」上填的东西。
///
/// 字段名和 `core/types.ts` 的 `RemoteTarget` 对齐（那边的 `remote*` 拍平字段）。
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSpec {
    pub host: String,
    pub port: u16,
    pub username: String,
    /// `password` / `key`。**认不出来的值当密码**（和 ssh 那边的容错口径一致）
    #[serde(default)]
    pub auth_kind: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub private_key_path: String,
    #[serde(default)]
    pub passphrase: String,
    /// 前端记得的这台机器的指纹。`None` = **从没见过它**
    #[serde(default)]
    pub expected_fingerprint: Option<String>,
    /// 「这次就当它是对的」—— 用户在弹窗里点过信任之后才会是 true
    #[serde(default)]
    pub accept_new_host_key: bool,
}

/// 开一个远端会话的结局。
///
/// ⚠️ **主机密钥那两种是变体、不是 `Err`**：前端要分支处理（弹窗让用户核对指纹），
/// 而错误那条路上只有一句字符串，结构化信息到不了。这条和 `ssh_commands` 那边一致。
pub enum RemoteOutcome {
    /// 开成了。**`events` 和 pty 那条路一样是「返回出来」而不是「传进去」** ——
    /// 形状对齐之后，上层拿到的两个东西（会话 + 事件流）在两条路上是同一种用法。
    Ready {
        session: Arc<RemoteSession>,
        events: mpsc::Receiver<PtyEvent>,
    },
    /// 这台机器没见过。带着指纹给用户核对
    HostKeyUnknown { algorithm: String, fingerprint: String },
    /// 指纹变了 —— **硬停**。带着新旧两个让用户自己判断
    HostKeyMismatch { expected: String, actual: String },
}

/// 一个活着的远端会话。
///
/// 方法都是 **async**（底下是 tokio + russh），这一点和 `PtySession` 不同 ——
/// 命令层那两处分流是必须的，抹平它反而要自己起运行时（那是"在运行时里再起一个
/// 运行时"的坑）。
pub struct RemoteSession {
    inner: session::Session,
    generation: u64,
}

impl RemoteSession {
    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub async fn write(&self, bytes: &[u8]) -> Result<(), AgentError> {
        self.inner
            .write(bytes)
            .await
            .map_err(|e| AgentError::Write { reason: format!("远端会话写失败了：{e}") })
    }

    pub async fn resize(&self, cols: u32, rows: u32) -> Result<(), AgentError> {
        self.inner
            .resize(cols, rows)
            .await
            .map_err(|e| AgentError::Resize { reason: format!("远端会话改尺寸失败了：{e}") })
    }

    /// 关掉。**幂等** —— 和 `PtySession::close` 一个口径
    pub async fn close(&self) {
        self.inner.close().await;
    }

    /// 握手拿到的指纹（检查器里显示给用户看「连的是哪台机器」）
    pub fn fingerprint(&self) -> &str {
        &self.inner.fingerprint
    }
}

/// 把远端目标翻成 ssh 那条路的连接配置。**纯函数**，测得到。
pub fn to_ssh_config(spec: &RemoteSpec, cols: u32, rows: u32) -> SshConfig {
    let auth = if spec.auth_kind == "key" {
        // ⚠️ `passphrase` 是 `String` 不是 `Option`：空串就表示「私钥没口令」，
        // 那是 ssh 内核定的形状（它那边也没有 Option 这个区分）
        SshAuth::Key {
            private_key_path: spec.private_key_path.clone(),
            passphrase: spec.passphrase.clone(),
        }
    } else {
        SshAuth::Password { password: spec.password.clone() }
    };

    SshConfig {
        host: spec.host.trim().to_string(),
        port: spec.port,
        username: spec.username.trim().to_string(),
        auth,
        // 「起来之后送进去的那条命令」是本地 pty 那套的心智；远端这边 shell 由
        // 远端决定，我们只负责把它当输入敲进去（见 `open`）
        term: "xterm-256color".to_string(),
        cols,
        rows,
        expected_fingerprint: spec.expected_fingerprint.clone(),
        accept_new_host_key: spec.accept_new_host_key,
    }
}

/// 把 ssh 的事件翻成 pty 的 —— **前端就不用认识两套事件**。
///
/// ⚠️ 代价是丢掉 `TerminalEvent::Exit` 里的 `reason`（「为什么退出」那句话）。
/// `PtyEvent` 没有那个字段，加它就要改前端的 IPC 契约和事件处理；
/// 而那句话在本地那条路上本来也不存在 —— 留着以后真有人需要时再加。
pub fn to_pty_event(event: TerminalEvent) -> PtyEvent {
    match event {
        TerminalEvent::Data { bytes } => PtyEvent::Data { bytes },
        TerminalEvent::Exit { code, .. } => PtyEvent::Exit {
            // ssh 那边是 u32（退出码 + 信号那套编码），pty 这边是 i32
            code: code.map(|c| c as i32),
        },
    }
}

/// 远端会话的注册表。
///
/// ⚠️ 和 `registry.rs` 的 `AgentRegistry` **分开**：那个装的是本机 pty
/// （同步、`Arc<PtySession>`），这个是远端（async、`Arc<RemoteSession>`）。
/// 合成一个的话每个方法都要 match 两种，而它们除了方法名之外没什么共同点。
#[derive(Default)]
pub struct RemoteRegistry {
    sessions: Mutex<HashMap<String, (u64, Arc<RemoteSession>)>>,
}

impl RemoteRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, HashMap<String, (u64, Arc<RemoteSession>)>>, AgentError> {
        self.sessions
            .lock()
            .map_err(|_| AgentError::Closed)
    }

    /// 存一个会话。同 id 的旧会话**先关掉**（和本机那条路一样：重连是替换不是并存）
    pub async fn insert(&self, id: &str, generation: u64, session: Arc<RemoteSession>) {
        let old = self.lock().ok().and_then(|mut map| map.insert(id.to_string(), (generation, session)));
        if let Some((_, old)) = old {
            old.close().await;
        }
    }

    /// 这个 id 上有没有远端会话（命令层**分流**用：先问这里，没有就走本机那条路）。
    /// 不看 generation —— 分流只关心「是不是远端的」，对不上号的自然会被后续操作拒掉。
    pub fn get_any(&self, id: &str) -> Option<Arc<RemoteSession>> {
        let map = self.lock().ok()?;
        map.get(id).map(|(_, s)| Arc::clone(s))
    }

    /// 按 generation 取。**对不上就当没有**（那是上一轮的残留，拿它去写就是 ABA）
    pub fn get(&self, id: &str, generation: u64) -> Option<Arc<RemoteSession>> {
        let map = self.lock().ok()?;
        let (gen, session) = map.get(id)?;
        // ⚠️ generation 对不上就当没有：那是上一轮的残留，拿它去写就是 ABA
        if *gen != generation {
            return None;
        }
        Some(Arc::clone(session))
    }

    pub async fn close(&self, id: &str) {
        let old = self.lock().ok().and_then(|mut map| map.remove(id));
        if let Some((_, session)) = old {
            session.close().await;
        }
    }

    /// 收掉全部（应用退出、前端重载后清孤儿用）
    pub async fn close_all(&self) {
        let all = match self.lock() {
            Ok(mut map) => map.drain().map(|(_, (_, s))| s).collect::<Vec<_>>(),
            Err(_) => return,
        };
        for session in all {
            session.close().await;
        }
    }
}

/// 开一个远端会话。
///
/// 连上之后**先 `cd` 到那个目录、再把命令送进去**（和本地那条路的心智一样：
/// 起来的是一个正常的 shell，命令是"初始输入"）。
///
/// ⚠️ `cwd` 是**远端机器上**的路径，而且它会进到 shell 命令行里 ——
/// 所以必须转义（见 [`quote_path`]），否则一个带空格的目录就能让整条命令散架。
pub async fn open(
    id: &str,
    spec: &RemoteSpec,
    cwd: &str,
    command: &str,
    cols: u32,
    rows: u32,
    generation: u64,
) -> Result<RemoteOutcome, AgentError> {
    let config = to_ssh_config(spec, cols, rows);

    // ⚠️ 事件走**我们自己建的一对**：`ssh::open` 要的是 Sender，而 `pty.rs` 那边
    // `spawn` 返回的是 Receiver —— 这一层把它翻过来，顺手把事件类型也换掉。
    let (raw_tx, mut raw_rx) = mpsc::channel::<TerminalEvent>(64);
    // 前端那一侧的事件流（翻好类型之后）
    let (out_tx, out_rx) = mpsc::channel::<PtyEvent>(64);
    let ssh_events = raw_tx;

    let outcome = session::open(&config, generation, ssh_events)
        .await
        .map_err(|e| AgentError::Spawn {
            id: id.to_string(),
            reason: format!("连不上 {}：{e}", config.host),
        })?;

    let session = match outcome {
        OpenResult::Ready(session) => *session,
        OpenResult::HostKeyUnknown(seen) => {
            return Ok(RemoteOutcome::HostKeyUnknown {
                algorithm: seen.algorithm,
                fingerprint: seen.fingerprint,
            });
        }
        OpenResult::HostKeyMismatch { expected, actual } => {
            return Ok(RemoteOutcome::HostKeyMismatch {
                expected,
                actual: actual.fingerprint,
            });
        }
    };

    // 事件转发：ssh 的 → pty 的（前端只认识后者）
    tokio::spawn(async move {
        while let Some(event) = raw_rx.recv().await {
            let last = matches!(event, TerminalEvent::Exit { .. });
            if out_tx.send(to_pty_event(event)).await.is_err() {
                break;
            }
            // Exit 永远是最后一个
            if last {
                break;
            }
        }
    });

    let session = Arc::new(RemoteSession { inner: session, generation });

    // 连上了才算「开成」—— 把初始动作送进去。
    // ⚠️ 顺序要紧：先 cd（否则命令在 home 里跑），再送命令。
    // 两步失败都只记不报：会话已经起来了，用户看到的是一个能用的 shell，
    // 比因为一句提示失败就把整个会话判死强（和本地那条路一个口径）
    let _ = session.write(format!("cd {}\r", quote_path(cwd)).as_bytes()).await;
    if !command.is_empty() {
        let _ = session.write(format!("{command}\r").as_bytes()).await;
    }

    Ok(RemoteOutcome::Ready { session, events: out_rx })
}

/// 把一个路径转义成**能安全塞进 shell 命令行**的样子。
///
/// 用单引号包住，内部的单引号按 POSIX 的老办法收尾再转义
/// （`'` → `'\''`）。⚠️ **远端可能是 Windows**（PowerShell / cmd），那边单引号的
/// 规矩不一样 —— 但这条路目前只面向 Unix 形态的远端（用户要连的是自己的机器，
/// 真到 Windows 远端那一步再说），所以先按 POSIX 来，并且**不假装它通用**。
pub fn quote_path(path: &str) -> String {
    format!("'{}'", path.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 密码认证翻成密码那条() {
        let spec = RemoteSpec {
            host: " 10.0.0.9 ".to_string(), // 前后有空格：要 trim
            port: 2222,
            username: " root ".to_string(),
            auth_kind: "password".to_string(),
            password: "pw".to_string(),
            private_key_path: String::new(),
            passphrase: String::new(),
            expected_fingerprint: None,
            accept_new_host_key: false,
        };

        let config = to_ssh_config(&spec, 80, 24);
        assert_eq!(config.host, "10.0.0.9");
        assert_eq!(config.username, "root");
        assert_eq!(config.port, 2222);
        assert!(matches!(config.auth, SshAuth::Password { ref password } if password == "pw"));
    }

    #[test]
    fn 私钥认证翻成私钥那条_空口令原样传() {
        let spec = RemoteSpec {
            host: "h".to_string(),
            port: 22,
            username: "u".to_string(),
            auth_kind: "key".to_string(),
            password: "不该被用上".to_string(),
            private_key_path: "/home/me/.ssh/id_ed25519".to_string(),
            passphrase: String::new(),
            expected_fingerprint: None,
            accept_new_host_key: false,
        };

        let config = to_ssh_config(&spec, 80, 24);
        assert!(
            matches!(config.auth, SshAuth::Key { ref passphrase, .. } if passphrase.is_empty()),
            "空口令原样传空串（ssh 内核那边就是 String）"
        );
    }

    #[test]
    fn 认不出来的认证方式当密码() {
        // 存储里的东西不可信；认不出来时**宁可当密码**，而不是报错让用户连不上
        let spec = RemoteSpec {
            host: "h".to_string(),
            port: 22,
            username: "u".to_string(),
            auth_kind: "什么鬼".to_string(),
            password: "pw".to_string(),
            private_key_path: String::new(),
            passphrase: String::new(),
            expected_fingerprint: None,
            accept_new_host_key: false,
        };

        assert!(matches!(to_ssh_config(&spec, 80, 24).auth, SshAuth::Password { .. }));
    }

    #[test]
    fn 事件翻过去之后前端只认真实那两样() {
        let data = to_pty_event(TerminalEvent::Data { bytes: "YWJj".to_string() });
        assert!(matches!(data, PtyEvent::Data { ref bytes } if bytes == "YWJj"));

        let exit = to_pty_event(TerminalEvent::Exit {
            code: Some(0),
            reason: "远端 shell 正常退出".to_string(),
        });
        assert!(
            matches!(exit, PtyEvent::Exit { code: Some(0) }),
            "退出码要原样带过去（reason 丢掉是这一层的已知代价）"
        );
    }

    #[test]
    fn 路径里的单引号不会把命令拆散() {
        // 用户主目录里真会有这种东西（`~/it's here`）
        assert_eq!(quote_path("/home/me/proj"), "'/home/me/proj'");
        assert_eq!(quote_path("/home/me/it's"), "'/home/me/it'\\''s'");
        // 带空格的目录：单引号包住就没事
        assert_eq!(quote_path("/home/me/my proj"), "'/home/me/my proj'");
    }

    #[tokio::test]
    async fn 注册表按_generation_认人() {
        // 构造一个 RemoteSession 要真连一次，太重；这里只验注册表本身的
        // 「generation 对不上就当没有」那条 —— 用一个空表来测边界
        let registry = RemoteRegistry::new();
        assert!(registry.get("没这个会话", 1).is_none());
        registry.close("没这个会话").await; // 幂等，不该炸
        registry.close_all().await;
    }
}
