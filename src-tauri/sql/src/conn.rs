//! 连接管理：两种引擎各一个驱动，外面套一层统一的注册表。
//!
//! 结构和 `devtoolkit-redis` 的 `ConnectionRegistry` 一致（连接表的锁不能跨 await、
//! 失败时把坏连接摘掉、同 id 重连即替换），差异全在驱动细节里。
//!
//! # 两种引擎的一个真实差异：换库
//!
//! * **MySQL**：`USE 库名` 就换了，同一条连接接着用。
//! * **PostgreSQL**：**一个连接绑定一个库，换不了** —— 这是服务端的模型，
//!   不是驱动的限制。所以换库要重新建连接。
//!
//! 两条路都实现在 `use_database` 里，对外是同一个行为。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex as AsyncMutex;

use crate::error::SqlError;
use crate::result::{describe, looks_like_transport, Cell, ColumnInfo, QueryResult, MAX_ROWS};

/// 建连超时。连不上的主机必须在这个时间内报错，不能让界面一直转圈
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SqlKind {
    Postgres,
    Mysql,
}

impl SqlKind {
    pub fn as_str(self) -> &'static str {
        match self {
            SqlKind::Postgres => "postgres",
            SqlKind::Mysql => "mysql",
        }
    }

    /// 默认端口。前端切类型时会跟着换默认值
    pub fn default_port(self) -> u16 {
        match self {
            SqlKind::Postgres => 5432,
            SqlKind::Mysql => 3306,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct ConnectionConfig {
    pub kind: SqlKind,
    pub host: String,
    pub port: u16,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: Option<String>,
    /// 库名。Postgres 必填（不填默认连 username 同名的库），MySQL 可以不填
    #[serde(default)]
    pub database: Option<String>,
}

impl ConnectionConfig {
    fn address(&self) -> String {
        format!("{}:{}", self.host, self.port)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ServerInfo {
    pub address: String,
    /// "postgres" / "mysql"
    pub kind: String,
    /// 引擎版本（`SELECT version()` 的结果）
    pub version: String,
    /// 当前连着的库
    pub database: String,
}

/// 一个库里的表
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TableInfo {
    pub name: String,
    /// BASE TABLE / VIEW
    pub kind: String,
    /// 大致行数。拿不到就是 None（Postgres 要额外查统计表，不值得每条都查）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rows: Option<u64>,
}

enum Handle {
    /// `Client` 不是 `Clone`（它内部持有连接状态），共享要套 Arc
    Postgres(Arc<tokio_postgres::Client>),
    /// MySQL 的连接不能克隆，共享要加锁。用 **tokio 的 Mutex**：
    /// std 的 `MutexGuard` 不是 `Send`，跨 await 持有会让整个 future 不是 `Send`
    Mysql(Arc<AsyncMutex<mysql_async::Conn>>),
}

#[derive(Default)]
pub struct ConnectionRegistry {
    conns: Mutex<HashMap<String, Handle>>,
    /// 每个连接最近一次用的配置。换库要拿它重建连接（Postgres 那条路）
    configs: Mutex<HashMap<String, ConnectionConfig>>,
}

impl ConnectionRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    // ------------------------------------------------------------ 连接

    pub async fn connect(
        &self,
        id: &str,
        config: &ConnectionConfig,
    ) -> Result<ServerInfo, SqlError> {
        if config.host.trim().is_empty() {
            return Err(SqlError::BadConfig { reason: "主机名不能为空".to_string() });
        }

        let (handle, info) = open(config).await?;

        self.lock()?.insert(id.to_string(), handle);
        self.configs
            .lock()
            .map_err(|_| SqlError::Poisoned)?
            .insert(id.to_string(), config.clone());

        Ok(info)
    }

    pub fn disconnect(&self, id: &str) -> Result<bool, SqlError> {
        let removed = self.lock()?.remove(id).is_some();
        self.configs.lock().map_err(|_| SqlError::Poisoned)?.remove(id);
        Ok(removed)
    }

    pub fn is_connected(&self, id: &str) -> Result<bool, SqlError> {
        Ok(self.lock()?.contains_key(id))
    }

    /// 换库。
    ///
    /// MySQL 直接 `USE`；Postgres 重建连接（那边一个连接绑一个库，换不了）。
    pub async fn use_database(&self, id: &str, database: &str) -> Result<ServerInfo, SqlError> {
        let mut config = self.config(id)?;
        config.database = Some(database.to_string());

        let (handle, info) = open(&config).await?;

        // 新的连上了才替换旧的 —— 失败时保留原来那条，用户不至于连当前库都丢了
        self.lock()?.insert(id.to_string(), handle);
        self.configs
            .lock()
            .map_err(|_| SqlError::Poisoned)?
            .insert(id.to_string(), config);

        Ok(info)
    }

    fn config(&self, id: &str) -> Result<ConnectionConfig, SqlError> {
        self.configs
            .lock()
            .map_err(|_| SqlError::Poisoned)?
            .get(id)
            .cloned()
            .ok_or_else(|| SqlError::NotConnected { id: id.to_string() })
    }

    /// 把连接复制一份出来。MySQL 那半边是 `Arc<AsyncMutex<..>>`，克隆很便宜；
    /// **guard 由调用方在 await 前释放**（见下面各方法的写法）
    fn handle(&self, id: &str) -> Result<HandleRef, SqlError> {
        let conns = self.lock()?;
        match conns.get(id) {
            Some(Handle::Postgres(client)) => Ok(HandleRef::Postgres(Arc::clone(client))),
            Some(Handle::Mysql(conn)) => Ok(HandleRef::Mysql(Arc::clone(conn))),
            None => Err(SqlError::NotConnected { id: id.to_string() }),
        }
    }

    fn forget(&self, id: &str) {
        if let Ok(mut conns) = self.lock() {
            conns.remove(id);
        }
    }

    // ------------------------------------------------------------ 查询

    /// 执行一段 SQL。
    ///
    /// **引擎报错（表不存在、语法错）是 `Ok(QueryResult { error: Some(..) })`**，
    /// 不是 `Err` —— 那是一次成功的往返，只是没成功执行。只有连接坏了才 `Err`。
    ///
    /// 支持一次提交多条语句（`simple_query` 天然支持），结果取**最后一条**产出行的那组，
    /// 前面的影响行数会累加进 `affected`。
    pub async fn query(&self, id: &str, sql: &str) -> Result<QueryResult, SqlError> {
        let started = Instant::now();

        let result = match self.handle(id)? {
            HandleRef::Postgres(client) => pg_query(&client, sql).await,
            HandleRef::Mysql(conn) => {
                // 锁在 send 之前拿、答案回来之后放。`AsyncMutexGuard` 是 Send，
                // 跨 await 持有不会让 future 变成非 Send
                let mut guard = conn.lock().await;
                my_query(&mut guard, sql).await
            }
        };

        match result {
            Ok(result) => {
                let elapsed = started.elapsed().as_millis() as u64;
                Ok(QueryResult { elapsed_ms: elapsed, ..result })
            }
            Err(Failure::Sql(reason)) => Ok(QueryResult::failure(
                describe(&reason),
                started.elapsed().as_millis() as u64,
            )),
            Err(Failure::Broken(reason)) => {
                // 连接坏了就从注册表里摘掉 —— 否则界面会一直显示「已连接」
                self.forget(id);
                Err(SqlError::Transport { id: id.to_string(), reason: describe(&reason) })
            }
        }
    }

    // ------------------------------------------------------------ 元数据

    /// 库列表。Postgres 查 `pg_database`，MySQL 用 `SHOW DATABASES`
    pub async fn databases(&self, id: &str) -> Result<Vec<String>, SqlError> {
        let sql = match self.handle(id)? {
            HandleRef::Postgres(_) => {
                "SELECT datname FROM pg_database \
                 WHERE datistemplate = false AND datallowconn = true ORDER BY 1"
            }
            HandleRef::Mysql(_) => "SHOW DATABASES",
        };

        let result = self.query(id, sql).await?;
        if let Some(error) = result.error {
            return Err(SqlError::Transport { id: id.to_string(), reason: error });
        }

        Ok(result
            .rows
            .into_iter()
            .filter_map(|row| row.into_iter().next())
            .filter_map(|cell| cell.text)
            .collect())
    }

    /// 当前库里的表。
    ///
    /// 两边都查 `information_schema`，但过滤条件不同：
    /// Postgres 的 `information_schema.tables` 只覆盖**当前库**，
    /// MySQL 的要显式按 `table_schema` 过滤（否则会把所有库的表都列出来）。
    pub async fn tables(&self, id: &str) -> Result<Vec<TableInfo>, SqlError> {
        let sql = match self.handle(id)? {
            HandleRef::Postgres(_) => {
                "SELECT table_name, table_type FROM information_schema.tables \
                 WHERE table_schema NOT IN ('pg_catalog', 'information_schema') \
                 ORDER BY table_name"
            }
            HandleRef::Mysql(_) => {
                "SELECT table_name, table_type FROM information_schema.tables \
                 WHERE table_schema = DATABASE() \
                 ORDER BY table_name"
            }
        };

        let result = self.query(id, sql).await?;
        if let Some(error) = result.error {
            return Err(SqlError::Transport { id: id.to_string(), reason: error });
        }

        Ok(result
            .rows
            .into_iter()
            .filter_map(|mut row| {
                if row.len() < 2 {
                    return None;
                }
                let kind = row.pop()?.text?;
                let name = row.pop()?.text?;
                Some(TableInfo {
                    name,
                    // information_schema 给的是 "BASE TABLE" / "VIEW"，换成短标签
                    kind: if kind.contains("VIEW") { "view".into() } else { "table".into() },
                    rows: None,
                })
            })
            .collect())
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, HashMap<String, Handle>>, SqlError> {
        self.conns.lock().map_err(|_| SqlError::Poisoned)
    }
}

/// 从注册表里取出来的连接句柄。**不含任何 MutexGuard**，所以能安全地跨 await
enum HandleRef {
    /// `Client` 不是 `Clone`（它内部持有连接状态），共享要套 Arc
    Postgres(Arc<tokio_postgres::Client>),
    Mysql(Arc<AsyncMutex<mysql_async::Conn>>),
}

/// 驱动失败分两类
enum Failure {
    /// 引擎拒绝了这条 SQL —— 是查询结果，不是连接故障
    Sql(String),
    /// 连接坏了
    Broken(String),
}

// ------------------------------------------------------------------ 建连

async fn open(config: &ConnectionConfig) -> Result<(Handle, ServerInfo), SqlError> {
    match config.kind {
        SqlKind::Postgres => open_postgres(config).await,
        SqlKind::Mysql => open_mysql(config).await,
    }
}

async fn open_postgres(
    config: &ConnectionConfig,
) -> Result<(Handle, ServerInfo), SqlError> {
    let mut pg = tokio_postgres::Config::new();
    pg.host(config.host.trim())
        .port(config.port)
        .connect_timeout(CONNECT_TIMEOUT)
        .application_name("Devtoolkit");

    if !config.username.trim().is_empty() {
        pg.user(config.username.trim());
    }
    if let Some(password) = non_empty(&config.password) {
        pg.password(password);
    }
    if let Some(database) = non_empty(&config.database) {
        pg.dbname(database);
    }

    let (client, connection) = pg.connect(tokio_postgres::NoTls).await.map_err(|e| {
        SqlError::Connect { address: config.address(), reason: e.to_string() }
    })?;

    // 连接的驱动任务要一直跑着，否则 client 什么都发不出去。
    // 它自己结束（服务端断开）时这里不做处理 —— 下一次查询会报错，
    // 由 `looks_like_transport` / `as_db_error` 那套逻辑把连接摘掉
    tokio::spawn(async move {
        let _ = connection.await;
    });

    let version = scalar(&client, "SHOW server_version").await.unwrap_or_default();
    let database = scalar(&client, "SELECT current_database()")
        .await
        .unwrap_or_else(|| config.database.clone().unwrap_or_default());

    Ok((
        Handle::Postgres(Arc::new(client)),
        ServerInfo {
            address: config.address(),
            kind: "postgres".to_string(),
            version,
            database,
        },
    ))
}

async fn open_mysql(config: &ConnectionConfig) -> Result<(Handle, ServerInfo), SqlError> {
    let builder = mysql_async::OptsBuilder::default()
        .ip_or_hostname(config.host.trim())
        .tcp_port(config.port)
        // 走 TCP 不走 unix socket：用户填的是主机的端口
        .prefer_socket(false)
        .user(non_empty(&Some(config.username.clone())))
        .pass(non_empty(&config.password))
        .db_name(non_empty(&config.database));

    let _ = &builder;

    // 连接超时：`OptsBuilder` 没有 connect timeout 这个选项（`conn_ttl` 是连接池里
    // 连接的存活时间，不是这个），所以在外面包一层 —— 不设的话连不上的主机会挂很久
    let conn = tokio::time::timeout(
        CONNECT_TIMEOUT,
        mysql_async::Conn::new(mysql_async::Opts::from(builder)),
    )
    .await
    .map_err(|_| SqlError::Connect {
        address: config.address(),
        reason: format!("连接超时（{} 秒）", CONNECT_TIMEOUT.as_secs()),
    })?
    .map_err(|e| SqlError::Connect { address: config.address(), reason: e.to_string() })?;

    let conn = Arc::new(AsyncMutex::new(conn));

    let version = {
        let mut guard = conn.lock().await;
        my_scalar(&mut guard, "SELECT VERSION()").await.unwrap_or_default()
    };
    let database = {
        let mut guard = conn.lock().await;
        my_scalar(&mut guard, "SELECT DATABASE()").await.unwrap_or_default()
    };

    Ok((
        Handle::Mysql(conn),
        ServerInfo {
            address: config.address(),
            kind: "mysql".to_string(),
            version,
            database,
        },
    ))
}

fn non_empty(value: &Option<String>) -> Option<String> {
    value
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

async fn scalar(client: &tokio_postgres::Client, sql: &str) -> Option<String> {
    let messages = client.simple_query(sql).await.ok()?;
    for message in messages {
        if let tokio_postgres::SimpleQueryMessage::Row(row) = message {
            return row.get(0).map(|s| s.to_string());
        }
    }
    None
}

async fn my_scalar(conn: &mut mysql_async::Conn, sql: &str) -> Option<String> {
    use mysql_async::prelude::Queryable;
    let row: Option<mysql_async::Row> = conn.query_first(sql).await.ok()?;
    let row = row?;
    my_cell(row.as_ref(0)?, None).text
}

// ------------------------------------------------------------------ 查询

async fn pg_query(
    client: &tokio_postgres::Client,
    sql: &str,
) -> Result<QueryResult, Failure> {
    // 列信息要**单独问一次**：简单查询协议返回的 `SimpleColumn` 只有列名、没有类型，
    // 而且**零行的 SELECT 连 RowDescription 都不给** —— 那种情况下什么列都拿不到。
    // `prepare` 是一次纯元数据的往返（不执行 SQL），两个问题一起解决。
    //
    // 多语句的 SQL prepare 会失败 —— 那时退化成「只有名字」，不是错误。
    let prepared: Vec<ColumnInfo> = match client.prepare(sql).await {
        Ok(statement) => statement
            .columns()
            .iter()
            .map(|c| ColumnInfo {
                name: c.name().to_string(),
                type_name: c.type_().name().to_string(),
            })
            .collect(),
        Err(_) => Vec::new(),
    };

    let messages = client.simple_query(sql).await.map_err(classify_pg)?;

    // 多条语句时，**每条语句的行要分开算** —— 混在一起的话
    // `SELECT 1; SELECT 2` 会变成「两行」而不是「最后一组」
    let mut current_rows: Vec<Vec<Cell>> = Vec::new();
    let mut current_columns: Vec<ColumnInfo> = Vec::new();
    let mut last_columns: Vec<ColumnInfo> = Vec::new();
    let mut last_rows: Vec<Vec<Cell>> = Vec::new();
    let mut affected: Option<u64> = None;
    let mut truncated = false;

    for message in messages {
        match message {
            tokio_postgres::SimpleQueryMessage::Row(row) => {
                if current_columns.is_empty() {
                    current_columns = row
                        .columns()
                        .iter()
                        .enumerate()
                        .map(|(i, c)| ColumnInfo {
                            name: c.name().to_string(),
                            type_name: prepared.get(i).map(|p| p.type_name.clone()).unwrap_or_default(),
                        })
                        .collect();
                }
                if current_rows.len() >= MAX_ROWS {
                    truncated = true;
                    continue;
                }
                // 简单查询协议下**所有值都是文本**，正好是我们要的：
                // 不用为每种 PG 类型写一遍映射
                current_rows.push(
                    (0..row.len())
                        .map(|i| match row.get(i) {
                            Some(text) => Cell::from_bytes(text.as_bytes().to_vec()),
                            None => Cell::null(),
                        })
                        .collect(),
                );
            }

            tokio_postgres::SimpleQueryMessage::CommandComplete(count) => {
                // 只有**没产出行**的语句才把 count 当影响行数。
                // SELECT 的 CommandComplete 给的也是行数，混进来会显示成「影响 2 行」
                if current_rows.is_empty() && current_columns.is_empty() {
                    affected = Some(affected.unwrap_or(0) + count);
                }
                // 产出行的那条语句记住它的结果；后面的语句没行就不覆盖
                if !current_rows.is_empty() || !current_columns.is_empty() {
                    last_columns = std::mem::take(&mut current_columns);
                    last_rows = std::mem::take(&mut current_rows);
                }
                current_columns = Vec::new();
                current_rows = Vec::new();
            }

            _ => {}
        }
    }

    // 一条语句都没产出行（零行的 SELECT、或者纯 DDL）：
    // 拿 prepare 的元数据兜底，至少列名还在
    let columns = if last_columns.is_empty() && last_rows.is_empty() && affected.is_none() {
        prepared
    } else {
        last_columns
    };

    let truncated = truncated || crate::result::is_truncated(last_rows.len());

    Ok(QueryResult {
        columns,
        rows: last_rows,
        affected,
        truncated,
        elapsed_ms: 0,
        error: None,
    })
}

async fn my_query(conn: &mut mysql_async::Conn, sql: &str) -> Result<QueryResult, Failure> {
    use mysql_async::prelude::Queryable;

    let mut result = conn.query_iter(sql).await.map_err(classify_mysql)?;

    let columns: Vec<ColumnInfo> = result
        .columns()
        .map(|cols| {
            cols.iter()
                .map(|c| ColumnInfo {
                    name: c.name_str().to_string(),
                    type_name: format!("{:?}", c.column_type())
                        .trim_start_matches("MYSQL_TYPE_")
                        .to_lowercase(),
                })
                .collect()
        })
        .unwrap_or_default();

    let mut rows: Vec<Vec<Cell>> = Vec::new();
    let mut truncated = false;

    // 注意：这里的 `next()` 是 QueryResult 的**固有 async 方法**（返回
    // `Result<Option<Row>>`），不是 `StreamExt::next` —— 所以不用也不能
    // 引入 futures_util::StreamExt，引了反而是个未使用的 import
    while let Some(row) = result.next().await.map_err(classify_mysql)? {
        if rows.len() >= MAX_ROWS {
            truncated = true;
            continue;
        }

        rows.push(
            (0..row.len())
                .map(|i| match row.as_ref(i) {
                    Some(value) => my_cell(value, row.columns_ref().get(i)),
                    None => Cell::null(),
                })
                .collect(),
        );
    }

    let affected = {
        let n = result.affected_rows();
        // affected_rows 在没有产出行时才有意义；SELECT 会返回 0，别把它当影响行数显示
        (columns.is_empty() && n > 0).then_some(n)
    };

    let truncated = truncated || crate::result::is_truncated(rows.len());

    Ok(QueryResult {
        columns,
        rows,
        affected,
        truncated,
        elapsed_ms: 0,
        error: None,
    })
}

/// MySQL 的值 → 单元格。
///
/// `column` 用来区分 DATE 和 DATETIME：协议给的都是「年月日时分秒」的拆解形式，
/// 光看值分不出 `2026-09-17` 和 `2026-09-17 00:00:00`，得看列类型。
fn my_cell(value: &mysql_async::Value, column: Option<&mysql_async::Column>) -> Cell {
    use mysql_async::Value;

    match value {
        Value::NULL => Cell::null(),
        Value::Bytes(bytes) => Cell::from_bytes(bytes.clone()),
        Value::Int(n) => Cell::from_bytes(n.to_string().into_bytes()),
        Value::UInt(n) => Cell::from_bytes(n.to_string().into_bytes()),
        Value::Float(f) => Cell::from_bytes(f.to_string().into_bytes()),
        Value::Double(f) => Cell::from_bytes(f.to_string().into_bytes()),
        Value::Date(y, mo, d, h, mi, s, _us) => {
            let date_only = column
                .map(|c| format!("{:?}", c.column_type()) == "MYSQL_TYPE_DATE")
                .unwrap_or(false);
            let text = if date_only {
                format!("{y:04}-{mo:02}-{d:02}")
            } else {
                format!("{y:04}-{mo:02}-{d:02} {h:02}:{mi:02}:{s:02}")
            };
            Cell::from_bytes(text.into_bytes())
        }
        Value::Time(negative, days, h, mi, s, _us) => {
            // MySQL 的 TIME 可以超过 24 小时（用 days 表示），拼回总小时数
            let hours = u32::from(*days) * 24 + u32::from(*h);
            let sign = if *negative { "-" } else { "" };
            Cell::from_bytes(format!("{sign}{hours:02}:{mi:02}:{s:02}").into_bytes())
        }
    }
}

/// 分 Postgres 的失败：有 `DbError` 就是引擎拒绝，否则是连接层的问题。
///
/// 注意**不能直接用 `error.to_string()`** —— 对引擎报错它只会给出 `"db error"`
/// 这种没信息量的顶层描述，真正的原因（表名、语法位置）在 `DbError` 里。
fn classify_pg(error: tokio_postgres::Error) -> Failure {
    if let Some(db) = error.as_db_error() {
        let mut message = format!("{}: {}", db.severity(), db.message());
        if let Some(detail) = db.detail() {
            message.push('\n');
            message.push_str(detail);
        }
        if let Some(hint) = db.hint() {
            message.push_str("\n提示：");
            message.push_str(hint);
        }
        return Failure::Sql(message);
    }

    Failure::Broken(error.to_string())
}

/// 分 MySQL 的失败：`Error::Server` 是引擎拒绝，其余看像不像连接故障
fn classify_mysql(error: mysql_async::Error) -> Failure {
    let reason = error.to_string();
    match error {
        // 引擎拒绝。`Error::to_string()` 给的是驱动包装过的描述，
        // 服务端的原话（表名、语法位置）在 ServerError 里
        mysql_async::Error::Server(server) => {
            Failure::Sql(format!("{}（错误码 {}）", server.message, server.code))
        }
        _ if looks_like_transport(&reason) => Failure::Broken(reason),
        // 既不是引擎拒绝、也不像连接故障：按坏连接处理更安全 ——
        // 留着一条状态可疑的连接，后面每条查询都要再错一次
        _ => Failure::Broken(reason),
    }
}
