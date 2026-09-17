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

use crate::browse::{self, DbInfo, KeyDetail, ScanPage};
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

    // ------------------------------------------------------------ 浏览

    /// 库列表。
    ///
    /// 要**合并两个来源**：`INFO keyspace` 只列出**有 key 的库**，空库根本不出现；
    /// `CONFIG GET databases` 才能拿到总数。少了后者，一个全新实例的库列表会是空的。
    ///
    /// `CONFIG` 在有些环境里被禁用或改名 —— 那种情况下退化成「INFO 里出现过的库」，
    /// 而不是整个列表都拿不出来。
    pub async fn keyspace(&self, id: &str) -> Result<Vec<DbInfo>, RedisError> {
        let mut conn = self.clone_conn(id)?;

        // 两条命令互不依赖，**管道一起发** —— 一次往返而不是两次。
        //
        // 顺带解决一个边界：`CONFIG` 在有些环境里被禁用，那时它回一条 `-ERR`。
        // 管道里每条命令各占一个回复位置，一条报错不影响另一条 —— 这里正好需要
        // 这种「各自独立」的语义。
        let mut pipeline = redis::Pipeline::new();
        pipeline
            .cmd("CONFIG")
            .arg("GET")
            .arg("databases")
            .cmd("INFO")
            .arg("keyspace");

        let values = conn
            .send_packed_commands(&pipeline, 0, 2)
            .await
            .map_err(|e| self.classify_failure(id, "INFO", e))?;

        let total = values
            .first()
            .and_then(|value| match value {
                Value::Array(items) => items.get(1).and_then(browse::as_text),
                _ => None,
            })
            .and_then(|text| text.trim().parse::<i64>().ok());

        let text = values.get(1).and_then(browse::as_text).unwrap_or_default();
        Ok(browse::merge_keyspace(total, &browse::parse_keyspace(&text)))
    }

    /// 切到另一个库。
    ///
    /// 注意 `SELECT` 是**连接级**的：这条连接的所有克隆都会跟着切
    /// （它们共用同一个 socket）。前端一个连接同时只对应一个库，所以这正是想要的。
    pub async fn select(&self, id: &str, db: i64) -> Result<(), RedisError> {
        let mut conn = self.clone_conn(id)?;
        let value = conn
            .send_packed_command(redis::cmd("SELECT").arg(db))
            .await
            .map_err(|e| self.classify_failure(id, "SELECT", e))?;

        match value {
            // 库号越界时服务端回 `-ERR DB index is out of range` —— 那是一条回复，
            // 不是传输失败，所以单独归一类，前端弹提示而不是把连接标成断开
            Value::ServerError(e) => Err(RedisError::Rejected {
                reason: crate::reply::server_error_text(e.code(), e.details()),
            }),
            _ => Ok(()),
        }
    }

    /// 扫一页 key。`cursor` 传 0 开始，返回的 `cursor` 是 0 就说明翻完了。
    ///
    /// 每个 key 的类型是**另外问的**：`SCAN` 只给 key 名。用管道一次问完 ——
    /// N 次往返在大库上会慢到没法用。
    pub async fn scan(
        &self,
        id: &str,
        pattern: &str,
        cursor: u64,
        count: u32,
    ) -> Result<ScanPage, RedisError> {
        let mut conn = self.clone_conn(id)?;

        let value = conn
            .send_packed_command(
                redis::cmd("SCAN")
                    .arg(cursor)
                    .arg("MATCH")
                    .arg(pattern)
                    .arg("COUNT")
                    .arg(count),
            )
            .await
            .map_err(|e| self.classify_failure(id, "SCAN", e))?;

        let (next, names) = split_scan_page(&value);
        if names.is_empty() {
            return Ok(ScanPage { cursor: next, keys: Vec::new() });
        }

        let mut pipeline = redis::Pipeline::new();
        for name in &names {
            pipeline.cmd("TYPE").arg(name.as_slice());
        }

        let types = conn
            .send_packed_commands(&pipeline, 0, names.len())
            .await
            .map_err(|e| self.classify_failure(id, "TYPE", e))?;

        let keys = names
            .into_iter()
            .zip(types.iter())
            .map(|(name, value)| {
                browse::make_key_meta(name, browse::as_text(value).unwrap_or_else(|| "none".into()))
            })
            .collect();

        Ok(ScanPage { cursor: next, keys })
    }

    /// 一个 key 的类型、TTL 和值。
    ///
    /// 值只取前 `limit` 项 —— 一个百万字段的 hash 全拉过来能把内存和界面一起打爆。
    /// 容器一律用 `SCAN` 家族（`HSCAN`/`SSCAN`）而不是 `HGETALL`/`SMEMBERS`，
    /// 前者天然支持分页。
    /// `known_type` 是调用方**从 key 列表里带过来的**类型提示。
    ///
    /// 给了它就能把「TTL + 值 + 总数」压进一个管道，**一次往返**搞定；
    /// 不给（或者给的已经过时）就走「先问类型、再取值」的慢路径，两次往返。
    ///
    /// 这个提示在浏览场景里几乎总是有效的：用户是从列表里点的 key，
    /// 而那份列表刚刚才问过每个 key 的类型。
    pub async fn key_detail(
        &self,
        id: &str,
        key: &[u8],
        limit: u64,
        known_type: Option<&str>,
    ) -> Result<KeyDetail, RedisError> {
        let mut conn = self.clone_conn(id)?;

        // 快路径
        if let Some(key_type) = known_type {
            if let Some(hit) = fetch_by_type(&mut conn, key, key_type, limit).await {
                return Ok(build_detail(key, key_type, hit));
            }
        }

        // 慢路径：先问类型和 TTL
        let mut head = redis::Pipeline::new();
        head.cmd("TYPE").arg(key).cmd("TTL").arg(key);
        let head_values = conn
            .send_packed_commands(&head, 0, 2)
            .await
            .map_err(|e| self.classify_failure(id, "TYPE", e))?;

        let key_type = head_values
            .first()
            .and_then(browse::as_text)
            .unwrap_or_else(|| "none".into());

        let ttl = int_of(head_values.get(1)).unwrap_or(-2);

        if key_type == "none" {
            return Ok(build_detail(key, &key_type, (ttl, None, Reply::Nil, false)));
        }

        // 认不出的类型（将来 Redis 加了新类型）、或者取值失败：不猜，如实说
        let hit = match fetch_by_type(&mut conn, key, &key_type, limit).await {
            Some(hit) => hit,
            None => (ttl, None, Reply::Nil, false),
        };

        Ok(build_detail(key, &key_type, hit))
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

/// 一次取值的结果：TTL、元素总数、值、是否被截断
type ValueHit = (i64, Option<u64>, Reply, bool);

/// 按已知类型一次取回「TTL + 值 + 总数」—— 三条命令一个管道，**一次往返**。
///
/// 返回 `None` 表示这个类型提示用不通：值的位置回来了一个错误回复，
/// 说明扫描之后那个 key 被改成了别的类型。调用方该退回慢路径。
async fn fetch_by_type(
    conn: &mut MultiplexedConnection,
    key: &[u8],
    key_type: &str,
    limit: u64,
) -> Option<ValueHit> {
    let (value_cmd, size_cmd) = value_commands(key, key_type, limit)?;

    let mut pipe = redis::Pipeline::new();
    pipe.cmd("TTL").arg(key).add_command(value_cmd).add_command(size_cmd);

    let values = conn.send_packed_commands(&pipe, 0, 3).await.ok()?;

    if matches!(values.get(1), Some(Value::ServerError(_))) {
        return None;
    }

    let ttl = int_of(values.first()).unwrap_or(-2);
    let size = int_of(values.get(2)).filter(|n| *n >= 0).map(|n| n as u64);
    let (value, truncated) = normalize_value(
        key_type,
        values.into_iter().nth(1).unwrap_or(Value::Nil),
        limit,
    );

    Some((ttl, size, value, truncated))
}

/// 从回复里取一个整数
fn int_of(value: Option<&Value>) -> Option<i64> {
    match value {
        Some(Value::Int(n)) => Some(*n),
        _ => None,
    }
}

fn build_detail(key: &[u8], key_type: &str, hit: ValueHit) -> KeyDetail {
    let (ttl, size, value, truncated) = hit;
    KeyDetail {
        key: String::from_utf8_lossy(key).into_owned(),
        // 非法 UTF-8 的 key 要带上原始字节，前端才查得回来
        key_bytes: std::str::from_utf8(key).is_err().then(|| key.to_vec()),
        key_type: key_type.to_string(),
        ttl,
        size,
        value,
        truncated,
    }
}

/// 拆开 `SCAN` 的回复：`[游标, [key...]]`。
fn split_scan_page(value: &Value) -> (u64, Vec<Vec<u8>>) {
    let Value::Array(items) = value else {
        return (0, Vec::new());
    };

    let cursor = items
        .first()
        .and_then(browse::as_text)
        .and_then(|text| text.trim().parse::<u64>().ok())
        .unwrap_or(0);

    let names = match items.get(1) {
        Some(Value::Array(keys)) => keys.iter().filter_map(browse::as_bytes).collect(),
        _ => Vec::new(),
    };

    (cursor, names)
}

/// 每种类型怎么取「前若干项」和「总数」。
///
/// 容器一律用 `SCAN` 家族（`HSCAN` / `SSCAN`）而不是 `HGETALL` / `SMEMBERS`：
/// 后者会一次把整个容器拉过来，一个百万字段的 hash 能把内存和界面一起打爆。
fn value_commands(key: &[u8], key_type: &str, limit: u64) -> Option<(redis::Cmd, redis::Cmd)> {
    let last = limit.saturating_sub(1);
    // 先声明后赋值：下面每个分支都要构造两条命令，写成 `let (a, b) = match ...`
    // 会把每条命令都挤成一行，反而看不清参数
    let mut value;
    let mut size;

    match key_type {
        "string" => {
            value = redis::cmd("GET");
            value.arg(key);
            size = redis::cmd("STRLEN");
            size.arg(key);
        }
        "list" => {
            value = redis::cmd("LRANGE");
            value.arg(key).arg(0).arg(last);
            size = redis::cmd("LLEN");
            size.arg(key);
        }
        "hash" => {
            value = redis::cmd("HSCAN");
            value.arg(key).arg(0).arg("COUNT").arg(limit);
            size = redis::cmd("HLEN");
            size.arg(key);
        }
        "set" => {
            value = redis::cmd("SSCAN");
            value.arg(key).arg(0).arg("COUNT").arg(limit);
            size = redis::cmd("SCARD");
            size.arg(key);
        }
        "zset" => {
            value = redis::cmd("ZRANGE");
            value.arg(key).arg(0).arg(last).arg("WITHSCORES");
            size = redis::cmd("ZCARD");
            size.arg(key);
        }
        "stream" => {
            value = redis::cmd("XRANGE");
            value.arg(key).arg("-").arg("+").arg("COUNT").arg(limit);
            size = redis::cmd("XLEN");
            size.arg(key);
        }
        // 认不出的类型（将来 Redis 加了新类型）：不猜
        _ => return None,
    }

    Some((value, size))
}

/// 把容器类的回复整形成前端好用的形状。
///
/// `HSCAN` / `SSCAN` 返回的是 `[游标, [项...]]`，这里拆掉外面那层信封 ——
/// 否则前端要为 hash 和 set 各写一套解包逻辑，而 list 又不用，很别扭。
///
/// 另外判断有没有被截断：元素数正好顶到上限时标记出来（可能还有更多）。
fn normalize_value(key_type: &str, raw: Value, limit: u64) -> (Reply, bool) {
    match key_type {
        "hash" | "set" => {
            let items = match &raw {
                Value::Array(outer) => match outer.get(1) {
                    Some(Value::Array(items)) => items.clone(),
                    _ => Vec::new(),
                },
                _ => Vec::new(),
            };
            let truncated = items.len() as u64 >= limit;
            (
                Reply::Array {
                    items: items.into_iter().map(Reply::from_value).collect(),
                },
                truncated,
            )
        }
        "list" | "zset" | "stream" => {
            let truncated = match &raw {
                Value::Array(items) => items.len() as u64 >= limit,
                _ => false,
            };
            (Reply::from_value(raw), truncated)
        }
        _ => (Reply::from_value(raw), false),
    }
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
