//! ClickHouse。
//!
//! # 它和另外两个引擎的两个真实差异
//!
//! 1. **走 HTTP 接口**（默认 8123），不是 9000 那个原生协议口。原生协议要自己
//!    实现一套二进制编解码；HTTP 口是官方支持的，而且结果能直接要 JSON。
//! 2. **一次请求只跑一条语句**。pg / mysql 那边 `simple_query` 天然支持多语句，
//!    这边不支持 —— 用户粘一段多条 SQL 进去会得到一条语法错误。这不是我们的
//!    限制，是接口的模型，所以**如实报错**，不去拆他的语句（拆了就更难解释）。
//!
//! # 结果的拿法：`default_format=JSON`
//!
//! 不用往用户的 SQL 后面拼 `FORMAT JSON` —— 那样 `CREATE TABLE` 会直接语法错 ✗。
//! 改成把它当 **URL 参数**传：SELECT 照常回 JSON、DDL / INSERT 照常执行（回一个空
//! body）✓。见 [`parse_body`]。
//!
//! ⚠️ 这一步 **`fetch_bytes("JSON")` 自己会做**（`do_execute` 把格式拼进 URL），
//! **别在建客户端时再 `with_setting` 一遍** —— 那样 URL 里会出现两个同名的
//! `default_format`（抓包实测如此），纯噪音；`fetch_one` 那条路上它还和
//! `RowBinaryWithNamesAndTypes` 撞在一起。

use clickhouse::{Client, Compression};

use crate::conn::{ConnectionConfig, Failure, ServerInfo};
use crate::error::SqlError;
use crate::result::{Cell, ColumnInfo, QueryResult, MAX_ROWS};

/// 建一个客户端。**换库也是重建客户端**（库名是客户端上的一个设置）
pub fn build(config: &ConnectionConfig) -> Client {
    let mut client = Client::default()
        .with_url(format!("http://{}:{}", config.host.trim(), config.port))
        // ⚠️ 这个默认用户是 ClickHouse 的出厂设置，用户没填就按它来
        .with_user(if config.username.trim().is_empty() { "default" } else { config.username.trim() })
        // ⚠️ **关掉响应压缩**，理由不是省事，是这个 crate 的解压路径在错误响应上真的会坏：
        // 它默认带 `compress=1`（ClickHouse 自己的分块格式，不是标准 lz4 frame），
        // 而**错误响应的分块和正常响应不一样** —— 解压失败就退回一个错误码，
        // 用户看到的是 `Code: 62`，完全不知道哪儿错了（真机实测）。
        // 关掉之后错误正文是一段 JSON，引擎原话就在 `exception` 字段里（见 `classify`）。
        // 代价是正常结果也不压缩 —— 结果集有 `MAX_ROWS` 上限，拿传输量换错误可读性划算。
        .with_compression(Compression::None);

    if let Some(password) = config.password.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        client = client.with_password(password);
    }
    if let Some(database) = config.database.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        client = client.with_database(database);
    }
    client
}

/// 建客户端 + 握一次手。**客户端要交出去**（注册表拿它跑后续的查询），
/// 所以这里返回 `(Client, ServerInfo)` 而不是只返回信息。
pub async fn open(config: &ConnectionConfig) -> Result<(Client, ServerInfo), SqlError> {
    let client = build(config);

    // 一条最便宜的查询当"握手"：连不上/认证不对都在这里暴露出来
    let version = scalar(&client, "version()").await.map_err(|e| {
        SqlError::Connect { address: config.address(), reason: e.to_string() }
    })?;

    let database = config
        .database
        .clone()
        .filter(|d| !d.trim().is_empty())
        .unwrap_or_else(|| "default".to_string());

    Ok((
        client,
        ServerInfo {
            address: config.address(),
            kind: "clickhouse".to_string(),
            version,
            database,
        },
    ))
}

/// 跑一条 SQL。
///
/// **引擎拒绝（表不存在、语法错）算 `Failure::Sql`**，和另外两个引擎一个口径 ——
/// 见 `conn.rs` 里 `Failure` 的说明。
pub async fn query(client: &Client, sql: &str) -> Result<QueryResult, Failure> {
    let body = client
        .query(sql)
        .fetch_bytes("JSON")
        .map_err(classify)?
        .collect()
        .await
        .map_err(classify)?;

    let text = String::from_utf8_lossy(&body).into_owned();
    parse_body(&text)
}

/// 取一个标量（版本号这种）。入参是**表达式**，不是整条 SQL。
///
/// ⚠️ 别名是**必须的**：`SELECT version()` 回的列名就叫 `version`，而下面的
/// 结构体字段是 `value` —— 对不上时 `clickhouse` crate 报的是
/// `schema mismatch: ... a column version(): String that was not found in the
/// struct definition`，那句话绕得看不出是「列名没对齐」。
/// （真机上就是这么红的：握手那句 `SELECT version()` 直接连不上。）
async fn scalar(client: &Client, expr: &str) -> Result<String, clickhouse::error::Error> {
    use clickhouse::Row;
    use serde::Deserialize;

    #[derive(Row, Deserialize)]
    struct One {
        value: String,
    }

    let row: One = client
        .query(&format!("SELECT {expr} AS value"))
        .fetch_one()
        .await?;
    Ok(row.value)
}

/// 分 ClickHouse 的失败。
///
/// ⚠️ **它没有「服务端错误」这个变体** —— 引擎拒绝一条 SQL 时 HTTP 回 400/500，
/// 错误正文就是引擎原话，crate 把它归到 `Error::BadResponse(text)` 里。
///
/// 按契约，**服务端明确回了一条错误 = 一次成功的往返**（见 `conn.rs` 的 `Failure`），
/// 所以 `BadResponse` 一律算 `Failure::Sql` —— 认不出正文内容也要这么分，
/// 否则写错一个表名就会把连接显示成断开（那正是这条契约要防的）。
/// 真正的连接故障走 `Network` / `TimedOut` 那些变体，不在这条路上。
fn classify(error: clickhouse::error::Error) -> Failure {
    if let clickhouse::error::Error::BadResponse(body) = &error {
        return Failure::Sql(extract_exception(body));
    }

    // 其余（网络、超时、解析失败…）：**宁可当连接故障**（和 mysql 那边同一个判断）
    // —— 留着一条状态可疑的连接，后面每条查询都要再错一次
    Failure::Broken(error.to_string())
}

/// 从错误正文里挖出**引擎的原话**。
///
/// 正常情况：正文是一段 JSON（`default_format` 的副作用 —— 连错误也按 JSON 回），
/// 原话在 `exception` 字段里：
///
/// ```json
/// { "meta": [], "data": [], "rows": 0,
///   "exception": "Code: 62. DB::Exception: Syntax error: failed at position 15 …" }
/// ```
///
/// # ⚠️ 有时候只剩一个错误码，这条要说清楚为什么
///
/// ClickHouse 报错时会**回显用户 SQL 的片段**，而且是**按字节**截的 ——
/// `SELECT * FROM 不存在的表` 报出来是 `failed at position 15 ('<0xE4>')`，
/// 那个孤零零的 `0xE4` 是「不」的首字节，**单独出现不是合法 UTF-8**。
/// 而 crate 在「立即失败」这条路上用的是严格的 `String::from_utf8`，一失败就把
/// 整段正文丢掉（同一个 crate 在流式那条路上用的是 `from_utf8_lossy`，还专门写了
/// 一行注释说「不该因此丢掉异常消息」—— 我们走的这条它没改）。
///
/// **所以中文 SQL 出错时，引擎原话在真机上是拿不到的**（这条有测试钉着，别当成
/// 我们偷懒）。能拿到的只有错误码，那就至少给个人话提示 —— 让用户对着一个数字
/// 发呆是最没用的失败模式。
fn extract_exception(body: &str) -> String {
    if let Some(text) = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|value| value.get("exception")?.as_str().map(str::to_string))
    {
        return text.trim().to_string();
    }

    let trimmed = body.trim();
    match trimmed.strip_prefix("Code: ").and_then(hint_for_code) {
        Some(hint) => format!("{trimmed} —— {hint}"),
        None => trimmed.to_string(),
    }
}

/// 常见错误码 → 人话。
///
/// ⚠️ **这是查表，不是引擎的原话** —— 只放含义稳定、不随版本变的几个
/// （ClickHouse 承诺错误码本身不变）。查不到就只报码：宁可少说，不要编。
fn hint_for_code(code: &str) -> Option<&'static str> {
    Some(match code.trim() {
        "47" => "未知的标识符：列名或别名对不上",
        "60" => "表不存在（也可能是没权限）",
        "62" => "语法错误",
        "81" => "库不存在",
        "516" => "认证失败",
        _ => return None,
    })
}

/// ClickHouse 的 JSON body → `QueryResult`。
///
/// 形状是固定的（HTTP 接口的 JSON 格式）：
///
/// ```json
/// {
///   "meta": [{ "name": "id", "type": "UInt64" }, …],
///   "data": [{ "id": 1, "name": "张三" }, …],
///   "rows": 2
/// }
/// ```
///
/// 三种 body 要分别对待：
/// * **空 body** —— DDL / INSERT 的正常返回（也见下面「影响行数」那段）
/// * **正常 JSON** —— 按 meta + data 建表
/// * **别的**（比如服务端直接回的一段纯文本）—— 当成引擎错误报出去，
///   而不是硬解析成空结果（那会让人以为"查询成功但没数据"）
pub fn parse_body(body: &str) -> Result<QueryResult, Failure> {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        // DDL / INSERT 走这儿。⚠️ **影响行数报不出来**：ClickHouse 把
        // `written_rows` 放在响应头（`X-ClickHouse-Summary`）里，而这个客户端
        // 不把响应头交出来。说不了的不编 —— 空着比编一个假数字强
        return Ok(QueryResult {
            columns: Vec::new(),
            rows: Vec::new(),
            affected: None,
            truncated: false,
            elapsed_ms: 0,
            error: None,
        });
    }

    let value: serde_json::Value = serde_json::from_str(trimmed)
        .map_err(|e| Failure::Sql(format!("服务端返回的不是 JSON（{e}）：{}", crate::result::describe(trimmed))))?;

    let columns: Vec<ColumnInfo> = value
        .get("meta")
        .and_then(|m| m.as_array())
        .map(|meta| {
            meta.iter()
                .map(|c| ColumnInfo {
                    name: c.get("name").and_then(|n| n.as_str()).unwrap_or_default().to_string(),
                    type_name: c.get("type").and_then(|t| t.as_str()).unwrap_or_default().to_string(),
                })
                .collect()
        })
        .unwrap_or_default();

    let data = value.get("data").and_then(|d| d.as_array());
    let mut rows: Vec<Vec<Cell>> = Vec::new();
    let mut truncated = false;

    if let Some(data) = data {
        // 列顺序以 meta 为准：`data` 里是对象，键的顺序不保证
        let names: Vec<&str> = columns.iter().map(|c| c.name.as_str()).collect();
        for item in data {
            if rows.len() >= MAX_ROWS {
                truncated = true;
                break;
            }
            let mut row = Vec::with_capacity(names.len());
            for name in &names {
                row.push(cell_of(item.get(*name)));
            }
            rows.push(row);
        }
    }

    let truncated = truncated || crate::result::is_truncated(rows.len());

    Ok(QueryResult { columns, rows, affected: None, truncated, elapsed_ms: 0, error: None })
}

/// 一个 JSON 值 → 单元格。
///
/// 字符串**原样**（不加引号）；null 是 SQL 的 NULL（和空串两回事）；其余
/// （数字、布尔、数组、嵌套对象）转成 JSON 文本 —— 契约就是"值一律按文本传"，
/// 见 `result.rs` 的模块文档。
fn cell_of(value: Option<&serde_json::Value>) -> Cell {
    match value {
        None | Some(serde_json::Value::Null) => Cell::null(),
        Some(serde_json::Value::String(text)) => Cell::from_bytes(text.as_bytes().to_vec()),
        Some(other) => Cell::from_bytes(other.to_string().into_bytes()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 正常的_json_结果按_meta_的列顺序成表() {
        let body = r#"{
            "meta": [{"name": "id", "type": "UInt64"}, {"name": "name", "type": "String"}],
            "data": [{"name": "张三", "id": 1}, {"name": "李四", "id": 2}],
            "rows": 2
        }"#;

        let result = parse_body(body).expect("应当解析成功");
        // ⚠️ 列顺序按 meta（data 里对象键的顺序不保证），值按列名取
        assert_eq!(result.columns.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["id", "name"]);
        assert_eq!(result.columns[0].type_name, "UInt64");
        assert_eq!(result.rows[0][0].text.as_deref(), Some("1"));
        assert_eq!(result.rows[0][1].text.as_deref(), Some("张三"));
    }

    #[test]
    fn 空_body_是_ddl_的正常返回() {
        // CREATE TABLE / INSERT 都回空 body —— 不是错误，也不该编影响行数出来
        let result = parse_body("  \n ").expect("空 body 不该报错");
        assert!(result.columns.is_empty());
        assert!(result.rows.is_empty());
        assert_eq!(result.affected, None, "拿不到影响行数时不能编一个");
    }

    #[test]
    fn 不是_json_的_body_当引擎错误报出来() {
        // 与其硬解析成"查询成功但没数据"，不如把它当错误 —— 后者会让人
        // 以为表是空的
        let failure = parse_body("Code: 60. DB::Exception: Table x doesn't exist");
        assert!(matches!(failure, Err(Failure::Sql(_))));
    }

    #[test]
    fn null_和空串是两回事() {
        let body = r#"{"meta":[{"name":"a","type":"Nullable(String)"},{"name":"b","type":"String"}],
                       "data":[{"a":null,"b":""}]}"#;
        let result = parse_body(body).expect("解析");
        assert_eq!(result.rows[0][0].text, None, "null 是 SQL 的 NULL");
        assert_eq!(result.rows[0][1].text.as_deref(), Some(""), "空串是空串");
    }

    #[test]
    fn 数字_数组_嵌套对象都转成文本() {
        let body = r#"{"meta":[{"name":"n","type":"Float64"},{"name":"arr","type":"Array(UInt8)"},{"name":"obj","type":"Map"}],
                       "data":[{"n":1.5,"arr":[1,2],"obj":{"k":"v"}}]}"#;
        let result = parse_body(body).expect("解析");
        assert_eq!(result.rows[0][0].text.as_deref(), Some("1.5"));
        assert_eq!(result.rows[0][1].text.as_deref(), Some("[1,2]"));
        assert_eq!(result.rows[0][2].text.as_deref(), Some(r#"{"k":"v"}"#));
    }

    #[test]
    fn 结果缺列时给_null_而不是整行丢掉() {
        // 服务端少给键（版本差异之类）时，行还是要出来的 —— 少一列比少一行好
        let body = r#"{"meta":[{"name":"a","type":"UInt8"},{"name":"b","type":"UInt8"}],
                       "data":[{"a":1}]}"#;
        let result = parse_body(body).expect("解析");
        assert_eq!(result.rows[0][0].text.as_deref(), Some("1"));
        assert_eq!(result.rows[0][1].text, None);
    }

    #[test]
    fn 没有_meta_的_json_当空表处理而不是崩掉() {
        let result = parse_body(r#"{"rows": 0}"#).expect("解析");
        assert!(result.columns.is_empty());
        assert!(result.rows.is_empty());
    }
}
