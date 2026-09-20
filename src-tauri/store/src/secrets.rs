//! 系统钥匙串 —— 连接密码该待的地方。
//!
//! # 为什么要有这一层
//!
//! 在那之前，三个连接模块（Redis / 数据库 / SSH）的密码是**明文**存在键值表里的
//! （`profiles.ts` 的 `TODO(security)` 一直在那儿挂着）。这是明确知情的妥协，
//! 但上生产之前必须换掉：任何能读到那个库文件的进程都能拿到用户的密码。
//!
//! 现在密码走**操作系统的凭据存储**：Windows 的凭据管理器、macOS 的钥匙串、
//! Linux 的 Secret Service（GNOME Keyring / KWallet 那一套）。
//! 键值表里**只留非敏感的字段**（主机、端口、用户名……）。
//!
//! # 两条边界，都很要紧
//!
//! 1. **「没存过」和「用不了」是两回事。** 前者是正常的（新连接还没填过密码），
//!    要当成 `Ok(None)`；后者说明这台机器上根本没有可用的钥匙串（服务器、
//!    headless 容器、锁着的桌面会话……）。混成一个错误的话，前端就没法决定
//!    「是提醒用户重填密码，还是该退回明文那条路」—— 那正是用户丢密码的开始。
//! 2. **钥匙串用不了的时候，绝不静默退回明文。** 退回是允许的（否则用户
//!    在服务器上根本用不了这个应用），但**必须让前端知道**，好让界面上说一句。
//!    这条判断由 [`available`] 提供。
//!
//! # 平台
//!
//! `keyring` 4.x 的 `v1` 模式就是老那套平台无关的 API（`Entry::new` / `set_password`
//! / `get_password` / `delete_credential`）。三个平台的后端由 Cargo 的 feature 选：
//! 默认带 Windows 和 Linux（DBus），**macOS 那个要显式开**（见 `Cargo.toml`）。

use keyring::{Entry, Error as KeyringError};

/// 钥匙串里所有条目共用的 service 名。和 bundle id 保持一致，用户去系统
/// 凭据管理器里翻的时候认得出来。
const SERVICE: &str = "com.devtoolkit.desktop";

/// 钥匙串操作失败。
///
/// ⚠️ **`Unavailable` 和别的分开** —— 它说的是「这台机器上没有能用的钥匙串」，
/// 而不是「这一次操作失败了」。前端据此决定要不要退回明文那条路。
#[derive(Debug)]
pub enum SecretError {
    /// 这台机器上拿不到钥匙串：没有桌面会话、服务锁着、平台后端起不来……
    Unavailable(String),
    /// 别的失败（写不进去、读出来不是文本……）
    Failed(String),
}

impl std::fmt::Display for SecretError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unavailable(reason) => write!(f, "这台机器上拿不到系统钥匙串：{reason}"),
            Self::Failed(reason) => write!(f, "钥匙串操作失败：{reason}"),
        }
    }
}

impl std::error::Error for SecretError {}

/// 把 keyring 的错误翻成我们的两种。
///
/// ⚠️ **`NoStorageAccess` 是「用不了」，不是「读失败」** —— 它说的是这台机器上
/// 那个凭据库压根访问不到（服务器上没有 DBus、桌面会话锁着……）。`PlatformFailure`
/// 也一样当「用不了」：真到写不进去那一步（磁盘满、权限）会走别的分支。
fn classify(error: KeyringError) -> SecretError {
    match error {
        KeyringError::NoStorageAccess(e) => SecretError::Unavailable(e.to_string()),
        KeyringError::PlatformFailure(e) => SecretError::Unavailable(e.to_string()),
        other => SecretError::Failed(other.to_string()),
    }
}

/// `service` 下的一个条目名。模块和档案 id 拼起来 —— 三个模块共用一份钥匙串，
/// 不分开的话 `conn_1` 和 `sql_1` 这种撞上了会互相顶掉（id 是各自生成的）。
fn account_of(module: &str, id: &str) -> String {
    format!("{module}/{id}")
}

fn entry(module: &str, id: &str) -> Result<Entry, SecretError> {
    Entry::new(SERVICE, &account_of(module, id)).map_err(classify)
}

/// 存一个密码。空密码 = **删掉这一条**（而不是存一个空串）——
/// 用户清空密码框的意思是「这个连接不要密码」。
pub fn set(module: &str, id: &str, secret: &str) -> Result<(), SecretError> {
    if secret.is_empty() {
        return delete(module, id);
    }
    entry(module, id)?.set_password(secret).map_err(classify)
}

/// 读一个密码。**没存过返回 `Ok(None)`** —— 那是正常情况，不是错误。
pub fn get(module: &str, id: &str) -> Result<Option<String>, SecretError> {
    match entry(module, id)?.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(other) => Err(classify(other)),
    }
}

/// 删一个密码。**没存过也算成功**（幂等）—— 调用方在「删连接」那条路上调它，
/// 那时候条目可能本来就不存在。
pub fn delete(module: &str, id: &str) -> Result<(), SecretError> {
    match entry(module, id)?.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(other) => Err(classify(other)),
    }
}

/// 这台机器上能不能用钥匙串。
///
/// 探测办法是**真去读一个探针条目**：读不到而错误是 `NoEntry` 恰恰说明存储是好的
/// （能访问、只是还没存过东西）；`NoStorageAccess` 才是真的用不了。
///
/// ⚠️ 别用「`Entry::new` 成不成功」当判据 —— 那个几乎总是成功，探测不到任何东西。
pub fn available() -> bool {
    match Entry::new(SERVICE, "probe").and_then(|e| e.get_password()) {
        Ok(_) => true,
        Err(KeyringError::NoEntry) => true,
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 模块和档案拼成条目名() {
        // 三个模块共用一份钥匙串，不分开的话同名的 id 会互相顶掉
        assert_eq!(account_of("redis", "conn_1"), "redis/conn_1");
        assert_eq!(account_of("sql", "sql_1"), "sql/sql_1");
    }

    /// 分类：`NoStorageAccess` / `PlatformFailure` 都算「用不了」，
    /// 别的算「这次失败了」。**这条是纯逻辑**，不管机器上有没有钥匙串都能跑。
    #[test]
    fn 拿不到存储和操作失败要分开() {
        let no_access = classify(KeyringError::NoStorageAccess("没有 DBus".into()));
        assert!(
            matches!(no_access, SecretError::Unavailable(_)),
            "访问不到存储要算「用不了」，前端据此决定要不要退回明文"
        );

        let platform = classify(KeyringError::PlatformFailure("后端起不来".into()));
        assert!(matches!(platform, SecretError::Unavailable(_)));

        let other = classify(KeyringError::BadStoreFormat("坏了".into()));
        assert!(
            matches!(other, SecretError::Failed(_)),
            "别的失败不该被当成「这台机器没有钥匙串」"
        );
    }

    #[test]
    fn 两种错误的文案分得清() {
        let unavailable = SecretError::Unavailable("没有桌面会话".into()).to_string();
        assert!(unavailable.contains("拿不到"), "要说得清是环境的问题：{unavailable}");
        assert!(unavailable.contains("没有桌面会话"));

        let failed = SecretError::Failed("写不进去".into()).to_string();
        assert!(failed.contains("失败"), "这个说的是这一次操作：{failed}");
    }

    /// 真的读写一遍。**钥匙串不可用时就跳过** —— 这台开发机是 headless 容器，
    /// 没有桌面会话，跑不了 Secret Service。
    ///
    /// ⚠️ 这**不是**「静默跳过」：服务端那几组测试（redis / pg / mysql）没装会
    /// 明确失败并要求安装命令，因为那是「你该装一个」。钥匙串不一样 ——
    /// 它在服务器/CI 上压根就不存在，那台机器上没有任何东西可以「装」。
    /// 所以这里明确打印一句说明再返回。
    #[test]
    fn 存进去能读出来再删掉() {
        if !available() {
            eprintln!(
                "⚠️ 这台机器上没有可用的系统钥匙串（headless / 没有桌面会话），\
                 这一条跳过。要在真机上验它：Windows 的凭据管理器、macOS 的钥匙串、\
                 或者 Linux 桌面的 GNOME Keyring。"
            );
            return;
        }

        let module = "test";
        let id = "case_roundtrip";
        set(module, id, "s3cret").expect("应当能存");
        assert_eq!(get(module, id).expect("应当能读"), Some("s3cret".into()));

        delete(module, id).expect("应当能删");
        assert_eq!(get(module, id).expect("删完读应当是 None"), None);

        // 删两次不报错（幂等）：调用方在「删连接」那条路上调它
        delete(module, id).expect("重复删应当没事");
    }

    #[test]
    fn 空密码等于删掉那一条() {
        if !available() {
            eprintln!("⚠️ 没有可用的系统钥匙串，跳过");
            return;
        }

        let module = "test";
        let id = "case_empty";
        set(module, id, "先存一个").expect("存");
        set(module, id, "").expect("空密码应当没事");
        assert_eq!(
            get(module, id).expect("读"),
            None,
            "清空密码框的意思是「这个连接不要密码」，不是「存一个空串」"
        );
    }
}
