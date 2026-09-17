//! 活连接的管理。
//!
//! # 为什么连接档案不在这里
//!
//! 这个注册表只持有**活连接**（`id → MultiplexedConnection`）。连接的
//! host/port/密码那些「档案」归前端 —— 它们是 UI 状态加持久化数据，放在 Rust 侧
//! 就等于同一份真相存两遍，迟早漂移。`id` 由前端生成后传进来。
//!
//! 唯一的缺口是「前端刷新了，Rust 侧还挂着旧连接」，用**幂等的 connect** 兜住：
//! 同一个 id 再连一次就是替换（`HashMap::insert` 返回的旧值被 drop，连接随之关闭）。
//!
//! # 锁与 await
//!
//! [`ConnectionRegistry`] 用 `std::sync::Mutex`。`MutexGuard` 不是 `Send`，
//! **跨 await 持有它会直接编译不过**（Tauri 的 async command 要求 future 是 `Send`）。
//! 所以这里把「取出连接」封成 [`ConnectionRegistry::clone_conn`]：
//! `MultiplexedConnection` 的 clone 很廉价（共享同一条管线和一个后台任务），
//! 复制一份出来、guard 当场释放，await 的时候手里没有锁。
//!
//! 这条规则是靠结构保证的，不是靠记性 —— 想写成 `self.conns.lock()?.get(id)?.send().await`
//! 那样的话编译器会拦下来。

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

// MultiplexedConnection 在 redis::aio 下，不在 crate 根（根只导出 Value/Cmd 那些低层类型）
use redis::aio::MultiplexedConnection;
use redis::{
    AsyncConnectionConfig, Client, ConnectionAddr, ConnectionInfo, ErrorKind, ProtocolVersion,
    RedisConnectionInfo, Value,
};

use crate::error::RedisError;
use crate::reply::Reply;

/// 建连超时。连不上的主机必须在这个时间内报错，不能让界面一直转圈。
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// 单条命令的响应超时。由驱动内部实现（`set_response_timeout`），
/// 不是在外面套一层 `tokio::time::timeout` —— 后者只是取消调用方的 future，
/// 请求还挂在复用管线的队列里，属于「看起来能跑」的写法。
pub const COMMAND_TIMEOUT: Duration = Duration::from_secs(10);

/// 前端传来的连接参数。
///
/// 刻意**不校验 db 的上界**：Redis 的 `databases` 是可配的（默认 16，也可以配成 1 或 256），
/// 在前端写死 0–15 会在别人的服务器上误伤。越界的库号交给服务端报
/// `ERR DB index is out of range`，那才是真相，顺便也给用户一个真实的反馈。
#[derive(Debug, Clone, serde::Deserialize)]
pub struct ConnectionConfig {
    pub host: String,
    pub port: u16,
    #[serde(default)]
    pub db: i64,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
}

/// 连上之后回给前端的信息（状态栏显示用）。
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct ServerInfo {
    /// `host:port`，原样回显，省得前端自己拼
    pub address: String,
    pub db: i64,
    /// 从 `INFO server` 里解析出来的 `redis_version`；解析不到就是 None
    pub version: Option<String>,
}

#[derive(Default)]
pub struct ConnectionRegistry {
    conns: Mutex<HashMap<String, MultiplexedConnection>>,
}

impl ConnectionRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// 建立连接（同 id 已存在则替换），返回服务端信息。
    ///
    /// 建连时会先 `PING` 一次：认证失败、库号越界这类问题在这一步就暴露出来，
    /// 而不是等用户敲第一条命令才报错。**失败时不会动已有的连接**。
    pub async fn connect(
        &self,
        id: &str,
        cfg: &ConnectionConfig,
    ) -> Result<ServerInfo, RedisError> {
        let address = format!("{}:{}", cfg.host, cfg.port);
        if cfg.host.trim().is_empty() {
            return Err(RedisError::BadConfig {
                reason: "主机名不能为空".to_string(),
            });
        }

        let info = ConnectionInfo {
            addr: ConnectionAddr::Tcp(cfg.host.clone(), cfg.port),
            redis: RedisConnectionInfo {
                db: cfg.db,
                // 空用户名/空密码必须是 None 而不是 Some("")：
                // Some("") 会让驱动发出一条 `AUTH ""`，参数个数在旧版 Redis 上还会报错。
                username: non_empty(&cfg.username),
                password: non_empty(&cfg.password),
                protocol: ProtocolVersion::RESP2,
            },
        };

        let client = Client::open(info).map_err(|e| RedisError::BadConfig {
            reason: e.to_string(),
        })?;

        let options = AsyncConnectionConfig::new()
            .set_connection_timeout(CONNECT_TIMEOUT)
            .set_response_timeout(COMMAND_TIMEOUT);

        let mut conn = client
            .get_multiplexed_async_connection_with_config(&options)
            .await
            .map_err(|e| RedisError::Connect {
                address: address.clone(),
                reason: e.to_string(),
            })?;

        // 确认这条连接真的可用（认证 / 选库有问题的话在这里就报出来）。
        //
        // ⚠️ 不能只看 `send_packed_command` 有没有 Err：服务器回 `-NOAUTH` 时
        // 它返回的是 `Ok(Value::ServerError(..))` —— 「一条错误回复」。只看 Err
        // 的话，一条没通过认证的连接会被当成建连成功，然后用户敲什么都是 NOAUTH。
        let pong = conn
            .send_packed_command(&redis::cmd("PING"))
            .await
            .map_err(|e| RedisError::Connect {
                address: address.clone(),
                reason: e.to_string(),
            })?;
        if let Value::ServerError(e) = &pong {
            return Err(RedisError::Connect {
                address,
                reason: crate::reply::server_error_text(e.code(), e.details()),
            });
        }

        let version = fetch_version(&mut conn).await;

        // 旧值被 drop —— 那就是「同一个 id 重连」时旧连接被关掉的方式
        self.lock()?.insert(id.to_string(), conn);

        Ok(ServerInfo {
            address,
            db: cfg.db,
            version,
        })
    }

    /// 断开并忘掉这个连接。返回是否真的有连接被断掉。
    pub fn disconnect(&self, id: &str) -> Result<bool, RedisError> {
        Ok(self.lock()?.remove(id).is_some())
    }

    /// 这个 id 上有没有活动连接。
    pub fn is_connected(&self, id: &str) -> Result<bool, RedisError> {
        Ok(self.lock()?.contains_key(id))
    }

    /// 执行一条命令。
    ///
    /// `args[0]` 是命令名，其余是参数 —— 分词在前端做，这里只收 token 数组，
    /// 而且**逐个塞进 `Cmd`**，绝不拼字符串：`Cmd` 会把每个参数打包成独立的
    /// bulk string，天然免疫 RESP 注入（否则 `GET a\r\nFLUSHALL` 就能挟持连接）。
    ///
    /// 服务端返回的错误是 `Ok(Reply::Error)`，不是 `Err`（见 crate 文档）。
    pub async fn exec(&self, id: &str, args: &[String]) -> Result<Reply, RedisError> {
        let (name, rest) = args.split_first().ok_or_else(|| RedisError::BadConfig {
            reason: "命令不能为空".to_string(),
        })?;
        if name.trim().is_empty() {
            return Err(RedisError::BadConfig {
                reason: "命令不能为空".to_string(),
            });
        }

        let mut cmd = redis::cmd(name);
        for arg in rest {
            cmd.arg(arg);
        }

        let mut conn = self.clone_conn(id)?;

        match conn.send_packed_command(&cmd).await {
            Ok(value) => Ok(Reply::from_value(value)),
            Err(e) => Err(self.classify_failure(id, name, e)),
        }
    }

    /// 把连接复制一份出来，guard 当场释放（见模块文档）。
    fn clone_conn(&self, id: &str) -> Result<MultiplexedConnection, RedisError> {
        self.lock()?
            .get(id)
            .cloned()
            .ok_or_else(|| RedisError::NotConnected { id: id.to_string() })
    }

    /// 执行失败时判断是「连接坏了」还是别的。
    ///
    /// 连接坏了就从注册表里摘掉 —— 否则前端会一直显示「已连接」，而每条命令都失败。
    fn classify_failure(&self, id: &str, name: &str, e: redis::RedisError) -> RedisError {
        let broken = e.is_io_error()
            || e.is_timeout()
            || e.is_connection_dropped()
            || e.is_connection_refusal()
            || e.is_unrecoverable_error()
            // 认证类错误是建连时就该暴露的，走到这里说明凭据被服务端中途改过
            || e.kind() == ErrorKind::AuthenticationFailed;

        if broken {
            if let Ok(mut conns) = self.lock() {
                conns.remove(id);
            }
        }

        RedisError::Transport {
            id: id.to_string(),
            reason: describe_command_failure(name, &e),
        }
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, HashMap<String, MultiplexedConnection>>, RedisError> {
        self.conns.lock().map_err(|_| RedisError::Poisoned)
    }
}

/// 空串按「没给」处理 —— 前端清空密码框后传过来的是 `""`。
fn non_empty(value: &Option<String>) -> Option<String> {
    value
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

/// 失败的文案里带上命令名，用户才知道是**哪一条**命令挂了。
fn describe_command_failure(name: &str, e: &redis::RedisError) -> String {
    format!("{name}：{e}")
}

async fn fetch_version(conn: &mut MultiplexedConnection) -> Option<String> {
    let value = conn
        .send_packed_command(redis::cmd("INFO").arg("server"))
        .await
        .ok()?;
    match value {
        Value::BulkString(bytes) => parse_version(&String::from_utf8_lossy(&bytes)),
        Value::SimpleString(text) | Value::VerbatimString { text, .. } => parse_version(&text),
        _ => None,
    }
}

/// 从 `INFO` 的文本里抠出 `redis_version`。
///
/// 单独拆出来是为了能脱离 Redis 单测 —— 这不需要一台服务器也能验证。
fn parse_version(info: &str) -> Option<String> {
    info.lines()
        .find_map(|line| line.strip_prefix("redis_version:"))
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_version_out_of_info_text() {
        let info = "# Server\r\nredis_version:7.0.15\r\nredis_git_sha1:00000000\r\n";
        assert_eq!(parse_version(info), Some("7.0.15".to_string()));

        // 只有 redis_version 一行也要能认出来
        assert_eq!(parse_version("redis_version:6.2.7"), Some("6.2.7".to_string()));

        // 大小写敏感：INFO 的字段名就是小写，别顺手 to_lowercase 把别的行匹配进来
        assert_eq!(parse_version("REDIS_VERSION:7.0.15"), None);

        // 没有这个字段 / 值为空 → None，而不是 Some("")
        assert_eq!(parse_version("# Server\r\nuptime_in_seconds:12\r\n"), None);
        assert_eq!(parse_version("redis_version:\r\n"), None);
        assert_eq!(parse_version(""), None);
    }

    #[test]
    fn blank_credentials_are_treated_as_absent() {
        // 前端清空密码框后传过来的是空串，必须当成「没给密码」，
        // 否则驱动会发出一条 AUTH ""（旧版 Redis 上直接报参数个数错误）。
        assert_eq!(non_empty(&None), None);
        assert_eq!(non_empty(&Some(String::new())), None);
        assert_eq!(non_empty(&Some("   ".to_string())), None);
        assert_eq!(non_empty(&Some(" s3cret ".to_string())), Some("s3cret".to_string()));
    }

    #[test]
    fn disconnect_and_is_connected_on_a_cold_registry() {
        let registry = ConnectionRegistry::new();
        // 什么都没连过的时候，两个方法都不该炸
        assert!(!registry.is_connected("nope").unwrap());
        assert!(!registry.disconnect("nope").unwrap());
    }
}
