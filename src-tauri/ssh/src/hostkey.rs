//! 主机密钥的 TOFU（首次信任）校验。
//!
//! # 为什么这件事不能省
//!
//! SSH 的整个信任模型就建立在「这台机器的公钥是它本人」这一个事实上。
//! 一个**静默接受任何主机密钥**的客户端等于没有信任模型 —— 中间人可以随便
//! 冒充任何服务器，用户全程无感。所以这里的默认行为是**拒绝一切**
//! （russh 的 `check_server_key` 默认就返回 `false`），只有两种情况放行：
//!
//! 1. 看到的指纹和用户**已经信任过**的那把一致；
//! 2. 用户刚刚在界面上明确点了「信任并继续」（`accept_new`）。
//!
//! 「静默接受」这个状态在代码里**不存在**，不是靠约定避免的。
//!
//! # 判定放在 Rust 侧，信任状态放在前端
//!
//! 和「连接档案归前端持有、Rust 只存活连接」是同一条分工：指纹是**用户的决定**，
//! 属于配置，归前端持久化；而「这次握手看到的密钥到底可不可信」这个判定必须
//! 在握手现场做，归这里。Rust 侧不存任何信任状态，也就不存在两边漂移的问题。
//!
//! # ⚠️ 指纹只在 `UnknownKey` 时才作数
//!
//! `check_server_key` **每次握手只调一次**，就在最初的密钥交换里
//! （`client/mod.rs` 里 "This is the initial kex" 那一段），认证在它之后。
//! 返回 `false` 会让 `connect_stream` 把 `Error::UnknownKey` 原样抛出来
//! （它 await 了 kex 完成信号，失败时 `join.await??` 会传播会话里的错误）。
//!
//! 但这个「看到了什么」是通过一个旁路写出来的，**任何**结束路径都能读到它。
//! 所以调用方必须只在 `matches!(err, Error::UnknownKey)` 时才把它当回事 ——
//! 否则「密钥被接受 + 认证失败」会被误报成「密钥没见过」，界面上弹出 TOFU 提示，
//! 用户一点「信任」，**攻击者的密钥就被永久钉住了**。这条注释是个警告，
//! 具体的守门在 `session.rs` 的 `connect` 里，测试在 `tests/` 里盯着。

use std::sync::{Arc, Mutex};

use russh::client::Handler;
use russh::keys::{HashAlg, PublicKey};

/// 一次握手实际看到的主机密钥。
///
/// `fingerprint` 是 `SHA256:` 开头的 base64（无填充），和 `ssh-keyscan` /
/// `ssh -o FingerprintHash=sha256` 的输出形式一致 —— 用户能拿它和服务器管理员
/// 给的值**逐字符比对**，这是 TOFU 唯一有意义的使用方式。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeenHostKey {
    /// 算法名，如 `ssh-ed25519`。展示用，不参与判定
    pub algorithm: String,
    pub fingerprint: String,
}

impl SeenHostKey {
    fn from_key(key: &PublicKey) -> Self {
        Self {
            algorithm: key.algorithm().to_string(),
            // 固定用 SHA-256：SHA-1 的指纹已经不该再出现在界面上了，
            // 而 SHA-512 的字符串太长、没法让人眼比对
            fingerprint: key.fingerprint(HashAlg::Sha256).to_string(),
        }
    }
}

/// 旁路：把「这次握手看到的密钥」从 handler 里带出来。
///
/// 为什么是旁路而不是返回值 —— `check_server_key` 只能回一个 `bool`，
/// 而调用方需要知道**看到的是什么**才能给出「之前是 A，现在是 B」这种提示。
/// 而且 handler 被 `connect` 吃进去了（成功时进 `Handle`，失败时直接丢掉），
/// 事后拿不回来，所以只能靠一个共享的格子。
///
/// ⚠️ **每次尝试都要新建一个**，绝不能跨尝试复用：`connect` 外面套的
/// `tokio::time::timeout` **不会取消**已经 spawn 出去的会话，超时之后
/// 那次握手的 `check_server_key` 照样会跑并写进这个格子。复用的话，
/// 用户看到的就是上一次（可能是攻击者的）那把密钥。
pub type SeenSlot = Arc<Mutex<Option<SeenHostKey>>>;

pub fn new_seen_slot() -> SeenSlot {
    Arc::new(Mutex::new(None))
}

/// 把格子里的值取出来（取的时候顺便清空，避免被读第二次）
pub fn take_seen(slot: &SeenSlot) -> Option<SeenHostKey> {
    // 锁中毒只可能来自别的线程持锁时 panic。这里的数据就是一个 Option，
    // 被中断的写入不会让它处于不一致状态，所以直接取出内部值继续用
    let mut guard = slot.lock().unwrap_or_else(|e| e.into_inner());
    guard.take()
}

/// 判定这次握手看到的密钥。
///
/// 三种结局，调用方按 `SshOpenOutcome` 报给前端：
/// - 和已知的一致 → `Match`
/// - 已知但不一致 → `Mismatch`（硬停，不给「就这样继续」的按钮）
/// - 以前没见过 → `Unknown`（弹 TOFU，用户点了才用 `accept_new` 重连）
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostKeyVerdict {
    Match(SeenHostKey),
    Mismatch {
        expected: String,
        actual: SeenHostKey,
    },
    Unknown(SeenHostKey),
}

/// 判定用的输入。抽出来是为了能**脱离网络单测** —— 这是安全关键路径，
/// 不该只能靠端到端测试覆盖。
pub fn judge(
    expected: Option<&str>,
    accept_new: bool,
    seen: Option<SeenHostKey>,
) -> Option<HostKeyVerdict> {
    let seen = seen?;
    Some(match expected {
        Some(expected) if expected == seen.fingerprint => HostKeyVerdict::Match(seen),
        Some(expected) => HostKeyVerdict::Mismatch {
            expected: expected.to_string(),
            actual: seen,
        },
        None if accept_new => HostKeyVerdict::Match(seen),
        None => HostKeyVerdict::Unknown(seen),
    })
}

/// 我们自己的 handler。
///
/// 除了主机密钥什么都不管 —— 认证横幅、通道事件那些默认实现就够用，
/// 需要的通道消息在建立会话之后从 `ChannelReadHalf` 上直接读。
pub struct TofuHandler {
    expected: Option<String>,
    accept_new: bool,
    seen: SeenSlot,
}

impl TofuHandler {
    pub fn new(expected: Option<String>, accept_new: bool, seen: SeenSlot) -> Self {
        Self {
            expected,
            accept_new,
            seen,
        }
    }
}

impl Handler for TofuHandler {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &PublicKey) -> Result<bool, Self::Error> {
        let seen = SeenHostKey::from_key(key);

        // 先记下来再判定：「拒绝了什么」和「接受了什么」一样要能报给用户，
        // 不然界面上只能显示一句「密钥变了」却拿不出新指纹做比对
        {
            let mut guard = self.seen.lock().unwrap_or_else(|e| e.into_inner());
            *guard = Some(seen.clone());
        }

        Ok(match &self.expected {
            Some(expected) => expected == &seen.fingerprint,
            None => self.accept_new,
        })
    }
}

/// 从格子里读出这次握手的判定。
///
/// ⚠️ 调用方**只能**在 `connect` 返回 `Err(russh::Error::UnknownKey)` 时用它，
/// 理由见本文件头部那段。
pub fn verdict_from(slot: &SeenSlot, expected: Option<&str>) -> Option<HostKeyVerdict> {
    // 走到这里说明连接已经结束了，accept_new 不再相关：
    // 能到这一步只可能是「我们拒绝了」，而拒绝的原因只有「没见过」或「变了」
    judge(expected, false, take_seen(slot))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seen(fp: &str) -> SeenHostKey {
        SeenHostKey {
            algorithm: "ssh-ed25519".to_string(),
            fingerprint: fp.to_string(),
        }
    }

    #[test]
    fn 指纹一致就是_match() {
        let v = judge(Some("SHA256:AAA"), false, Some(seen("SHA256:AAA")));
        assert!(matches!(v, Some(HostKeyVerdict::Match(_))));
    }

    #[test]
    fn 指纹不一致就是_mismatch_并把两个都带出来() {
        let v = judge(Some("SHA256:AAA"), false, Some(seen("SHA256:BBB")));
        match v {
            Some(HostKeyVerdict::Mismatch { expected, actual }) => {
                assert_eq!(expected, "SHA256:AAA");
                assert_eq!(actual.fingerprint, "SHA256:BBB");
            }
            other => panic!("该判成 mismatch，实际是 {other:?}"),
        }
    }

    #[test]
    fn 没见过且不接受新的就是_unknown() {
        let v = judge(None, false, Some(seen("SHA256:AAA")));
        assert!(matches!(v, Some(HostKeyVerdict::Unknown(_))));
    }

    #[test]
    fn 没见过但用户点了信任就放行() {
        let v = judge(None, true, Some(seen("SHA256:AAA")));
        assert!(matches!(v, Some(HostKeyVerdict::Match(_))));
    }

    /// 这条是安全关键的一条：**「变了」不能被 `accept_new` 冲掉**。
    ///
    /// 用户点「信任」只意味着「这台机器我没见过，我认了」，
    /// 不意味着「它以前长什么样无所谓」。指纹变更必须永远硬停。
    #[test]
    fn accept_new_不能覆盖指纹变更() {
        let v = judge(Some("SHA256:AAA"), true, Some(seen("SHA256:BBB")));
        assert!(
            matches!(v, Some(HostKeyVerdict::Mismatch { .. })),
            "指纹变了的时候，accept_new 不该让判定变成放行"
        );
    }

    #[test]
    fn 握手根本没走到那一步就没有判定() {
        assert!(judge(None, false, None).is_none());
    }

    #[test]
    fn 取过一次就把格子清空避免被读第二遍() {
        let slot = new_seen_slot();
        {
            let mut g = slot.lock().unwrap();
            *g = Some(seen("SHA256:AAA"));
        }
        assert!(verdict_from(&slot, None).is_some());
        assert!(verdict_from(&slot, None).is_none(), "第二次不该还有值");
    }
}
