//! MongoDB。
//!
//! # ⚠️ 它不是 SQL，这个文件刻意只做最薄的一层
//!
//! 另外三个引擎是「你写 SQL、我给你表格」。Mongo 的模型完全不一样：**文档、
//! 集合、JSON 查询**。所以这里的口径是：
//!
//! * **查询就是一段 JSON**，形状见 [`MongoCommand`]。不发明查询语言（`db.users.find(…)`
//!   那种 shell 语法要自己写解析器，而且它本来也不是给程序看的接口）；
//! * **结果是文档**，一行一条，放在**一列**里（列名 [`DOC_COLUMN`]）—— 复用
//!   `QueryResult` 而不是新造一个类型，理由见下面「为什么复用表格形状」;
//! * 文档按 **JSON 文本**存进单元格（`bson` 的 serde 实现给的是扩展 JSON：
//!   `{"$oid": "…"}` / `{"$date": …}`）—— 和 `result.rs` 那条「值一律按文本传」
//!   一个道理：**前端负责把它显示好看**（缩进、折叠），后端只管给准。
//!
//! # 为什么复用表格形状（而不是加一个新的返回类型）
//!
//! 加一个 `DocumentResult` 意味着：新命令、新的 IPC 契约、前端两套渲染路径、
//! 错误处理再写一遍。而「一行一条文档」在表格形状里是**天然的**：一列、每行一段
//! JSON。前端的文档视图只是把这一列**换个渲染方式**，不用碰数据通路。
//!
//! # 这一版能做什么
//!
//! 连上、列库、列集合、按 `filter` 查文档（带 `sort` / `projection` / `limit`）。
//! **不做**聚合管道、写入、索引管理 —— 那些等真有人用再说，`aggregate` 加进来
//! 是一个命令的事。

use mongodb::bson::{Document, Bson};
use mongodb::options::{ClientOptions, Credential};
use mongodb::{Client, Database};

use crate::conn::{ConnectionConfig, Failure, ServerInfo, TableInfo};
use crate::error::SqlError;
use crate::result::{Cell, ColumnInfo, QueryResult, MAX_ROWS};

/// 文档那一列的**名字和类型名**。
///
/// ⚠️ 这两个字符串是**前后端的契约**（协调者定的）：前端那个 Mongo 标签页
/// 靠它们认出"这一列是文档、按 JSON 渲染"，所以**逐字改不得**。
pub const DOC_COLUMN: &str = "document";
pub const DOC_TYPE: &str = "json";

/// 不填 `limit` 时取多少条。
///
/// 50 是「够看一屏」和「别把界面卡住」之间的折中 —— Mongo 的文档可以很大，
/// 默认拉一千条（`MAX_ROWS`）会让人等。想多看点就在查询里写 `limit`。
const DEFAULT_LIMIT: u32 = 50;

/// 前端传进来的「查询」。
///
/// ```json
/// { "collection": "users", "filter": { "age": { "$gt": 18 } }, "limit": 20 }
/// ```
///
/// `collection` 必填；`database` 不填就用连接上配的那个；`filter` 不填就是全部；
/// `sort` / `projection` 原样透传给驱动。
#[derive(Debug, Clone, PartialEq)]
pub struct MongoCommand {
    pub collection: String,
    pub database: Option<String>,
    pub filter: Document,
    pub sort: Option<Document>,
    pub projection: Option<Document>,
    pub limit: u32,
}

/// 解析前端那段 JSON。**纯函数**（不碰驱动），所以各种畸形输入都能在这里测干净。
pub fn parse_command(text: &str, default_database: Option<&str>) -> Result<MongoCommand, String> {
    let value: serde_json::Value = serde_json::from_str(text)
        .map_err(|e| format!("查询不是合法的 JSON：{e}"))?;
    let object = value
        .as_object()
        .ok_or_else(|| "查询要是一个 JSON 对象，比如 {\"collection\": \"users\"}".to_string())?;

    let collection = object
        .get("collection")
        .and_then(|c| c.as_str())
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .ok_or_else(|| "要指定查哪个集合：{\"collection\": \"users\"}".to_string())?
        .to_string();

    let database = object
        .get("database")
        .and_then(|d| d.as_str())
        .map(str::trim)
        .filter(|d| !d.is_empty())
        .map(str::to_string)
        .or_else(|| default_database.map(str::to_string));

    // ⚠️ 一律**先过一遍 JSON 解析**再交给驱动：直接丢给驱动的话，一个拼错的
    // filter 会变成一条底层报错（`invalid document`），看不出是哪儿的问题
    let as_doc = |key: &str| -> Result<Option<Document>, String> {
        match object.get(key) {
            None | Some(serde_json::Value::Null) => Ok(None),
            Some(value) => serde_json::from_value::<Document>(value.clone())
                .map(Some)
                .map_err(|e| format!("{key} 不是一个合法的查询对象：{e}")),
        }
    };

    let filter = as_doc("filter")?.unwrap_or_default();
    let sort = as_doc("sort")?;
    let projection = as_doc("projection")?;

    // 上限夹到 MAX_ROWS：一次查询把几万条文档拉进内存和界面是事故
    let limit = object
        .get("limit")
        .and_then(|l| l.as_u64())
        .map(|l| l.clamp(1, MAX_ROWS as u64) as u32)
        .unwrap_or(DEFAULT_LIMIT);

    Ok(MongoCommand { collection, database, filter, sort, projection, limit })
}

/// 建客户端 + 握一次手（`ping`）。**客户端要交出去** —— 注册表拿它跑后续查询。
pub async fn open(config: &ConnectionConfig) -> Result<(Client, ServerInfo), SqlError> {
    let uri = format!("mongodb://{}:{}", config.host.trim(), config.port);

    let mut options = ClientOptions::parse(uri)
        .await
        .map_err(|e| SqlError::Connect { address: config.address(), reason: e.to_string() })?;

    // 用户名密码**走 options 而不是拼进 URI**：拼进去要做百分号编码，
    // 而密码里带 `@` `/` `:` 是常事（不编码就是一条莫名其妙的连接失败）
    let username = config.username.trim();
    if !username.is_empty() {
        // ⚠️ `Credential` 是 `#[non_exhaustive]` 的普通结构体（不是 builder）——
        // **不能用结构体字面量**，要 default 之后逐个字段赋。
        // 用户名允许为空（本地常常不开鉴权），空的话整段跳过 = 无凭据连接
        let mut credential = Credential::default();
        credential.username = Some(username.to_string());
        credential.password = config.password.as_deref().filter(|p| !p.is_empty()).map(str::to_string);
        options.credential = Some(credential);
    }

    // 连接超时：不设的话连不上的主机会挂很久（和其它引擎一个口径）
    options.connect_timeout = Some(crate::conn::CONNECT_TIMEOUT);
    options.server_selection_timeout = Some(crate::conn::CONNECT_TIMEOUT);

    let client = Client::with_options(options)
        .map_err(|e| SqlError::Connect { address: config.address(), reason: e.to_string() })?;

    // 「握手」：这条命令要真到服务端才知道认证/网络对不对
    client
        .database("admin")
        .run_command(mongodb::bson::doc! { "ping": 1 })
        .await
        .map_err(|e| SqlError::Connect { address: config.address(), reason: describe(e) })?;

    let version = client
        .database("admin")
        .run_command(mongodb::bson::doc! { "buildInfo": 1 })
        .await
        .ok()
        .and_then(|info| info.get_str("version").ok().map(str::to_string))
        .unwrap_or_default();

    Ok((
        client,
        ServerInfo {
            address: config.address(),
            kind: "mongodb".to_string(),
            version,
            // 没配库就按驱动的默认来（URI 里没有库名时它落在 `test`）
            database: config
                .database
                .clone()
                .filter(|d| !d.trim().is_empty())
                .unwrap_or_else(|| "test".to_string()),
        },
    ))
}

/// 跑一段查询（就是 [`MongoCommand`] 那段 JSON）。返回一张**一列**的表。
pub async fn query(client: &Client, text: &str, default_database: Option<&str>) -> Result<QueryResult, Failure> {
    let command = parse_command(text, default_database).map_err(Failure::Sql)?;

    let database_name = command
        .database
        .clone()
        .ok_or_else(|| Failure::Sql("这条连接还没选库，查询里要写 database".to_string()))?;
    let db: Database = client.database(&database_name);

    // ⚠️ Mongo 的 `find` 对**不存在的集合不报错**（回一个空游标）—— 那是它的
    // 语义，但对用户是个坑：打错集合名和"这个集合是空的"在界面上长得一模一样。
    // 所以先问一次。前端那个假实现（`core/fakeSql.ts`）和 e2e 都按「报出来」
    // 这个契约来，文案也保持一致。
    let names = db.list_collection_names().await.map_err(classify)?;
    if !names.contains(&command.collection) {
        return Err(Failure::Sql(format!("没有这个集合：{}", command.collection)));
    }

    let collection = db.collection::<Document>(&command.collection);

    let mut find = collection.find(command.filter);
    if let Some(sort) = command.sort {
        find = find.sort(sort);
    }
    if let Some(projection) = command.projection {
        find = find.projection(projection);
    }

    // 多要一条：拿到了就说明被截断了（和 `MAX_ROWS` 那套一个思路）
    find = find.limit(i64::from(command.limit) + 1);

    let mut cursor = find.await.map_err(classify)?;

    let mut rows: Vec<Vec<Cell>> = Vec::new();
    let mut truncated = false;

    use futures_util::StreamExt as _;
    while let Some(next) = cursor.next().await {
        let document = next.map_err(classify)?;
        if rows.len() >= command.limit as usize || rows.len() >= MAX_ROWS {
            truncated = true;
            break;
        }
        rows.push(vec![document_cell(document)]);
    }

    Ok(QueryResult {
        // 只有一列：这一行是一条**文档**（前端按 JSON 渲染）
        columns: vec![ColumnInfo {
            name: DOC_COLUMN.to_string(),
            type_name: DOC_TYPE.to_string(),
        }],
        rows,
        // MongoDB 没有「影响行数」这个概念，契约里也定的 null
        affected: None,
        truncated,
        elapsed_ms: 0,
        error: None,
    })
}

/// 文档 → 单元格。
///
/// # 三条约定（前后端契约，见 [`DOC_COLUMN`]）
///
/// 1. **美化过**（`to_string_pretty`）：前端直接把它贴进 `<pre>` 就行，
///    不用自己再缩进一次；
/// 2. **`$binary` 用简化的占位**：`{"$binary": "<base64>"}`。bson 自己的扩展
///    JSON 给的是 `{"$binary":{"base64":…,"subType":…}}`，那一坨前后端的
///    理解成本都不值 —— 但**编码必须是真的 base64**，不是我们编的东西；
/// 3. 其它特殊类型（ObjectId / Date / Decimal128…）**用 bson 的扩展 JSON**
///    （`{"$oid": …}` / `{"$date": …}`）：那是 Mongo 世界的通用写法，
///    用户认得出来，而且信息一个不少。
fn document_cell(document: Document) -> Cell {
    let value = to_json(Bson::Document(document));
    let text = match serde_json::to_string_pretty(&value) {
        Ok(text) => text,
        // 转不出来（理论上不会）：至少把值给出去，别让整条查询因为一条文档失败
        Err(_) => format!("{value}"),
    };
    Cell::from_bytes(text.into_bytes())
}

/// `bson::Bson` → `serde_json::Value`，**二进制那一支按契约简化**。
///
/// 别的类型直接走 bson 自己的 serde 实现（它给的就是扩展 JSON ✓），
/// 只有 `Binary` 要在这里拦一道 —— 契约要的形状和它的默认形状不一样。
fn to_json(value: Bson) -> serde_json::Value {
    match value {
        Bson::Binary(binary) => {
            use base64::Engine as _;
            // base64 标准字母表：Mongo 的 shell 和驱动都用它
            let encoded = base64::engine::general_purpose::STANDARD.encode(&binary.bytes);
            serde_json::json!({ "$binary": encoded })
        }
        // 数组和文档要**递归**下去（里面可能嵌着二进制）
        Bson::Array(items) => serde_json::Value::Array(items.into_iter().map(to_json).collect()),
        Bson::Document(document) => serde_json::Value::Object(
            document
                .into_iter()
                .map(|(key, value)| (key, to_json(value)))
                .collect(),
        ),
        other => serde_json::to_value(other).unwrap_or(serde_json::Value::Null),
    }
}

pub async fn databases(client: &Client) -> Result<Vec<String>, SqlError> {
    let mut names = client
        .list_database_names()
        .await
        .map_err(|e| SqlError::Transport { id: String::new(), reason: describe(e) })?;
    names.sort();
    Ok(names)
}

/// 一个库里的**集合**。
///
/// `kind` 给的是 `"collection"`（不是 `"table"`）—— 前端靠它决定这棵树下面
/// 挂的东西该叫什么、点开之后走哪套界面。
pub async fn collections(client: &Client, database: &str) -> Result<Vec<TableInfo>, SqlError> {
    let mut names = client
        .database(database)
        .list_collection_names()
        .await
        .map_err(|e| SqlError::Transport { id: String::new(), reason: describe(e) })?;
    names.sort();

    Ok(names
        .into_iter()
        // `schema` 就是库名 —— 四个引擎的契约统一成「schema + name + kind」，
        // 前端一套渲染（见 `TableInfo::schema`）
        .map(|name| TableInfo {
            schema: database.to_string(),
            name,
            kind: "collection".to_string(),
            rows: None,
        })
        .collect())
}

fn classify(error: mongodb::error::Error) -> Failure {
    use mongodb::error::ErrorKind;
    match *error.kind {
        // 服务端明确回了一条错误：集合不存在、命令不合法…… —— 那是结果
        ErrorKind::Command(_) => Failure::Sql(describe(error)),
        // 连不上、选不到节点、超时 —— 连接这一层的事
        _ => Failure::Broken(describe(error)),
    }
}

/// 驱动的错误文案：它自己会带一层 `Kind: …` 的包装，太长也照裁剪一遍
fn describe(error: mongodb::error::Error) -> String {
    crate::result::describe(&error.to_string())
}

/// `bson` 的一个小工具：把一个值当文档看（`sort`/`projection` 用）
#[allow(dead_code)]
fn as_document(value: Option<&Bson>) -> Option<&Document> {
    match value {
        Some(Bson::Document(document)) => Some(document),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 最小可用的查询只要一个集合名() {
        let command = parse_command(r#"{"collection":"users"}"#, None).expect("应当解析成功");
        assert_eq!(command.collection, "users");
        assert!(command.filter.is_empty(), "不写 filter 就是全查");
        assert_eq!(command.limit, DEFAULT_LIMIT);
        assert_eq!(command.database, None);
    }

    #[test]
    fn filter_sort_projection_limit_原样过给驱动() {
        let command = parse_command(
            r#"{"collection":"users","filter":{"age":{"$gt":18}},
                "sort":{"age":-1},"projection":{"name":1},"limit":20}"#,
            None,
        )
        .expect("解析");

        assert!(command.filter.contains_key("age"), "filter 要原样留着");
        assert!(command.sort.is_some());
        assert!(command.projection.is_some());
        assert_eq!(command.limit, 20);
    }

    #[test]
    fn 连接上配了库就用它_查询里写了的优先() {
        let from_connection = parse_command(r#"{"collection":"c"}"#, Some("app")).expect("解析");
        assert_eq!(from_connection.database.as_deref(), Some("app"));

        let from_query =
            parse_command(r#"{"collection":"c","database":"other"}"#, Some("app")).expect("解析");
        assert_eq!(from_query.database.as_deref(), Some("other"));
    }

    #[test]
    fn 缺集合名时报的错要能照着改() {
        let error = parse_command(r#"{"filter":{}}"#, None).unwrap_err();
        assert!(error.contains("collection"), "错误里要点名缺什么：{error}");
        assert!(error.contains("users"), "最好给个能直接抄的例子：{error}");
    }

    #[test]
    fn 不是_json_或者不是对象时都说清楚() {
        assert!(parse_command("db.users.find({})", None).unwrap_err().contains("JSON"));
        assert!(parse_command("[1,2]", None).unwrap_err().contains("对象"));
    }

    #[test]
    fn filter_写错了要点名是_filter_的问题() {
        let error = parse_command(r#"{"collection":"c","filter":"张三"}"#, None).unwrap_err();
        assert!(error.contains("filter"), "要点名是哪个字段：{error}");
    }

    #[test]
    fn limit_被夹在上限之内() {
        // 一次拉几万条文档进内存和界面是事故
        assert_eq!(parse_command(r#"{"collection":"c","limit":999999}"#, None).expect("解析").limit, MAX_ROWS as u32);
        // 0 或负数当 1：`limit: 0` 在 Mongo 里是「不限」，那是更危险的东西
        assert_eq!(parse_command(r#"{"collection":"c","limit":0}"#, None).expect("解析").limit, 1);
    }

    #[test]
    fn 文档转成的文本是美化过的合法_json() {
        let document = mongodb::bson::doc! { "name": "张三", "age": 30 };
        let cell = document_cell(document);
        let text = cell.text.expect("有文本");
        assert!(!cell.binary, "走 base64 那条之后，单元格永远是干净文本");

        let parsed: serde_json::Value = serde_json::from_str(&text).expect("必须是合法 JSON");
        assert_eq!(parsed["name"], "张三");
        assert_eq!(parsed["age"], 30);
        assert!(text.contains('\n'), "契约要求美化过，前端不再自己缩进");
    }

    #[test]
    fn 二进制按契约简化成_binary_加_base64() {
        // bson 自己的形状是 {"$binary":{"base64":…,"subType":…}} —— 契约要的是
        // 简化的那一层，但**编码必须是真的 base64**
        let document = mongodb::bson::doc! { "blob": mongodb::bson::Binary { subtype: mongodb::bson::spec::BinarySubtype::Generic, bytes: vec![0xff, 0xfe, 0x01] } };
        let cell = document_cell(document);
        let text = cell.text.expect("有文本");
        let parsed: serde_json::Value = serde_json::from_str(&text).expect("合法 JSON");

        let encoded = parsed["blob"]["$binary"].as_str().expect("按 $binary 给");
        assert_eq!(encoded, "//4B", "是真的 base64（3 字节 → 4 字符）");
        // 而且解码回来是原字节
        use base64::Engine as _;
        let decoded = base64::engine::general_purpose::STANDARD.decode(encoded).expect("能解回来");
        assert_eq!(decoded, vec![0xff, 0xfe, 0x01]);
    }

    #[test]
    fn 嵌套文档和数组里的二进制也走同一条路() {
        let document = mongodb::bson::doc! {
            "nested": { "blob": mongodb::bson::Binary { subtype: mongodb::bson::spec::BinarySubtype::Generic, bytes: vec![1] } },
            "list": [mongodb::bson::Binary { subtype: mongodb::bson::spec::BinarySubtype::Generic, bytes: vec![2] }],
        };
        let text = document_cell(document).text.expect("有文本");
        let parsed: serde_json::Value = serde_json::from_str(&text).expect("合法 JSON");
        assert!(parsed["nested"]["blob"]["$binary"].is_string(), "嵌套文档里也要简化");
        assert!(parsed["list"][0]["$binary"].is_string(), "数组里也要");
    }
}
