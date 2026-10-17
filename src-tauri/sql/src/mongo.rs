//! MongoDB。
//!
//! # ⚠️ 它不是 SQL，这个文件刻意只做最薄的一层
//!
//! 另外三个引擎是「你写 SQL、我给你表格」。Mongo 的模型不一样：**文档、集合、
//! 查询**。所以这里的口径是：
//!
//! * **查询是 mongosh 那种写法**（`db.users.find({}).sort({age: -1}).limit(10)`）——
//!   解析在 [`crate::mongo_shell`] 里（纯逻辑、不碰驱动，所以能穷举测）；
//! * **结果是一张表**：列 = 这批文档**顶层字段的并集**，一行一份文档。
//!   ⚠️ 2026-10-13 改的：原来是一列、每行一整段 JSON —— 用户的原话是
//!   「不应该是类似于表格一样展示吗，一整个 json 怎么看」。文档参差这件事
//!   用空单元格表达就够了，不必把整份文档糊成一坨；
//! * 嵌套的值（子文档、数组）**压成一行 JSON** 放在单元格里：表格里放不下
//!   深度，但至少要能一眼扫过去、能整段复制走。
//!
//! # 复用表格形状，不新造返回类型
//!
//! `QueryResult`（`columns` + `rows` + `truncated` + `error`）够用：Mongo 只是
//! 「列是算出来的、值是 JSON 文本」而已。加一个 `DocumentResult` 意味着新命令、
//! 新 IPC 契约、前端两套渲染路径、错误处理再写一遍。
//!
//! # ⚠️ 写操作是**真的写**
//!
//! `deleteMany({})` 在这里没有撤销、没有确认弹窗（用户明确要的是「和 mongosh
//! 一样，风险自负」）。这个文件的定位不是「安全的浏览工具」，是一个 shell。
//!
//! # 值怎么变成文本
//!
//! 见 [`humanize`]：ObjectId → 十六进制串、日期 → ISO、二进制 → `BinData(0, "…")`
//! （和 mongosh 打印的一样）。**不是** bson 那套扩展 JSON（`{"$oid": …}`）——
//! 那是给程序读的，表格里看着吵。

use mongodb::bson::{Bson, Document};
use mongodb::options::{ClientOptions, Credential, IndexOptions, ReturnDocument};
use mongodb::IndexModel;
use mongodb::{Client, Database};
use serde_json::{json, Value as Json};

use crate::conn::{ConnectionConfig, Failure, ServerInfo, TableInfo};
use crate::error::SqlError;
use crate::mongo_shell::{parse_command, MongoOp};
use crate::result::{Cell, ColumnInfo, QueryResult, MAX_ROWS};

/// 不填 `limit` 时取多少条。
///
/// 50 是「够看一屏」和「别把界面卡住」之间的折中 —— Mongo 的文档可以很大，
/// 默认行数由调用方给上限（命令层默认 1000，界面上的「再取更多」会调大）；
/// 想精确控制就在查询里写 `.limit(N)` —— 它会原样生效（到硬顶为止）。
const DEFAULT_LIMIT: u32 = 50;

/// 单元格那一列的类型名。
///
/// 文档**没有固定的类型**（同一个字段这份是字符串、那份是数组），所以这里不给
/// 假的具体类型 —— 表格的表头把它当 tooltip 显示，写 `any` 是实话。
const ANY_TYPE: &str = "any";

/// 跑一段查询（mongosh 写法，或者老的 JSON 写法）。返回**一张表**。
pub async fn query(
    client: &Client,
    text: &str,
    default_database: Option<&str>,
    max_rows: usize,
) -> Result<QueryResult, Failure> {
    let command = parse_command(text, default_database).map_err(Failure::Sql)?;

    let database_name = command
        .database
        .clone()
        .ok_or_else(|| Failure::Sql("这条连接还没选库，查询里要写 database".to_string()))?;
    let db: Database = client.database(&database_name);

    // 库级操作（`db.dropDatabase()` / `db.createCollection()`）没有集合
    let Some(collection_name) = command.collection.clone() else {
        return db_level(db, database_name, command.op).await;
    };

    // ⚠️ Mongo 的 `find` 对**不存在的集合不报错**（回一个空游标）—— 那是它的
    // 语义，但对用户是个坑：打错集合名和"这个集合是空的"在界面上长得一模一样。
    // 所以**只读的那几个操作**先问一次。（写操作**不能**这么干：往一个不存在的
    // 集合里 insert 是合法的，Mongo 会顺手把它建出来。）
    if reads_collection(&command.op) {
        let names = db.list_collection_names().await.map_err(classify)?;
        if !names.contains(&collection_name) {
            return Err(Failure::Sql(format!("没有这个集合：{collection_name}")));
        }
    }

    let collection = db.collection::<Document>(&collection_name);

    match command.op {
        MongoOp::Find {
            filter,
            projection,
            sort,
            limit,
            skip,
        } => {
            // 显式 `.limit()`：用户写的数字**照给**（到硬顶为止）—— 以前它也被
            // 夹在默认值上，写 `.limit(5000)` 只拿一千，这是「展示不全」的来源之一。
            // 没写：跟着调用方给的上限走（命令层的「再取 1000 行」就是把它调大）。
            let want: u32 = match limit {
                Some(l) => l.clamp(1, crate::result::HARD_MAX_ROWS as i64) as u32,
                None => max_rows.clamp(1, crate::result::HARD_MAX_ROWS) as u32,
            };
            let _ = DEFAULT_LIMIT; // 旧默认值退役（上限现在由调用方带）
            let mut find = collection.find(filter);
            if let Some(projection) = projection {
                find = find.projection(projection);
            }
            if let Some(sort) = sort {
                find = find.sort(sort);
            }
            if let Some(skip) = skip {
                find = find.skip(skip);
            }
            // 多要一条：拿到了就说明被截断了（和 `MAX_ROWS` 那套一个思路）
            find = find.limit(i64::from(want) + 1);

            let mut cursor = find.await.map_err(classify)?;
            let (docs, truncated) = drain(&mut cursor, want as usize).await?;
            Ok(docs_to_table(docs, truncated))
        }

        MongoOp::FindOne {
            filter,
            projection,
            sort,
            skip,
        } => {
            let mut find = collection.find_one(filter);
            if let Some(projection) = projection {
                find = find.projection(projection);
            }
            if let Some(sort) = sort {
                find = find.sort(sort);
            }
            if let Some(skip) = skip {
                find = find.skip(skip);
            }
            let found = find.await.map_err(classify)?;
            Ok(docs_to_table(found.into_iter().collect(), false))
        }

        MongoOp::Count {
            filter,
            skip,
            limit,
        } => {
            let mut count = collection.count_documents(filter);
            if let Some(skip) = skip {
                count = count.skip(skip);
            }
            if let Some(limit) = limit {
                // ⚠️ 驱动这边 `CountOptions::limit` 是 **u64**（find 那边是 i64）——
                // 负数在 Mongo 里本来就是非法的，解析时也拦过，这里 `.max(1)` 只是
                // 兜一层，别让一个负数经 `as u64` 变成天文数字
                count = count.limit(limit.max(1).min(MAX_ROWS as i64) as u64);
            }
            let n = count.await.map_err(classify)?;
            Ok(count_table(n))
        }

        MongoOp::EstimatedCount => {
            let n = collection.estimated_document_count().await.map_err(classify)?;
            Ok(count_table(n))
        }

        MongoOp::Distinct { field, filter } => {
            let values = collection.distinct(&field, filter).await.map_err(classify)?;
            Ok(values_to_table(values, &field))
        }

        MongoOp::Aggregate { pipeline } => {
            let mut cursor = collection.aggregate(pipeline).await.map_err(classify)?;
            // 聚合的条数是管道自己决定的（里面可能已经有 $limit），所以这里只兜
            // 一个硬上限，不替用户"补一条 $limit"
            let (docs, truncated) = drain(&mut cursor, MAX_ROWS).await?;
            Ok(docs_to_table(docs, truncated))
        }

        MongoOp::InsertOne { document } => {
            let result = collection.insert_one(document).await.map_err(classify)?;
            Ok(docs_to_table(
                vec![mongodb::bson::doc! {
                    "acknowledged": true,
                    "insertedId": result.inserted_id,
                }],
                false,
            ))
        }

        MongoOp::InsertMany { documents } => {
            let n = documents.len();
            let result = collection.insert_many(documents).await.map_err(classify)?;
            // ⚠️ `inserted_ids` 是 `HashMap<usize, Bson>`（下标 → id），
            // 直接塞进 `doc!` 会要求 `Bson: From<HashMap<…>>` —— 那个实现不存在。
            // 拼成 `{"0": id0, "1": id1}` 的文档（mongosh 打印的就是这个形状）
            let mut ids = Document::new();
            for (index, id) in result.inserted_ids {
                ids.insert(index.to_string(), id);
            }
            Ok(docs_to_table(
                vec![mongodb::bson::doc! {
                    "acknowledged": true,
                    "insertedCount": n as i64,
                    "insertedIds": ids,
                }],
                false,
            ))
        }

        MongoOp::Update {
            many,
            filter,
            update,
            upsert,
        } => {
            let result = if many {
                collection.update_many(filter, update).upsert(upsert).await
            } else {
                collection.update_one(filter, update).upsert(upsert).await
            }
            .map_err(classify)?;
            Ok(update_table(result.matched_count, result.modified_count, result.upserted_id))
        }

        MongoOp::Replace {
            many,
            filter,
            replacement,
            upsert,
        } => {
            let result = if many {
                // 驱动的 `replace_many` 不存在（Mongo 也没有这个命令）——
                // `replaceOne` 才是那个名字，`many` 只可能来自我们自己的解析失误
                collection.replace_one(filter, replacement).upsert(upsert).await
            } else {
                collection.replace_one(filter, replacement).upsert(upsert).await
            }
            .map_err(classify)?;
            Ok(update_table(result.matched_count, result.modified_count, result.upserted_id))
        }

        MongoOp::Delete { many, filter } => {
            let result = if many {
                collection.delete_many(filter).await
            } else {
                collection.delete_one(filter).await
            }
            .map_err(classify)?;
            Ok(docs_to_table(
                vec![mongodb::bson::doc! {
                    "acknowledged": true,
                    "deletedCount": result.deleted_count as i64,
                }],
                false,
            ))
        }

        MongoOp::FindOneAndUpdate {
            filter,
            update,
            upsert,
            return_after,
            projection,
        } => {
            let mut action = collection
                .find_one_and_update(filter, update)
                .upsert(upsert)
                .return_document(if return_after {
                    ReturnDocument::After
                } else {
                    ReturnDocument::Before
                });
            if let Some(projection) = projection {
                action = action.projection(projection);
            }
            let found = action.await.map_err(classify)?;
            Ok(docs_to_table(found.into_iter().collect(), false))
        }

        MongoOp::FindOneAndReplace {
            filter,
            replacement,
            upsert,
            return_after,
            projection,
        } => {
            let mut action = collection
                .find_one_and_replace(filter, replacement)
                .upsert(upsert)
                .return_document(if return_after {
                    ReturnDocument::After
                } else {
                    ReturnDocument::Before
                });
            if let Some(projection) = projection {
                action = action.projection(projection);
            }
            let found = action.await.map_err(classify)?;
            Ok(docs_to_table(found.into_iter().collect(), false))
        }

        MongoOp::FindOneAndDelete { filter } => {
            let found = collection.find_one_and_delete(filter).await.map_err(classify)?;
            Ok(docs_to_table(found.into_iter().collect(), false))
        }

        MongoOp::GetIndexes => {
            use futures_util::StreamExt as _;
            let mut cursor = collection.list_indexes().await.map_err(classify)?;
            let mut docs = Vec::new();
            while let Some(model) = cursor.next().await {
                docs.push(index_to_doc(model.map_err(classify)?));
            }
            Ok(docs_to_table(docs, false))
        }

        MongoOp::CreateIndex {
            keys,
            name,
            unique,
            sparse,
            expire_after_seconds,
        } => {
            // ⚠️ 和上面 `Credential` 同一个坑：`#[non_exhaustive]` 的结构体
            // **不能用结构体字面量**（连 `..Default::default()` 也不行），
            // 要 default 之后逐个字段赋
            let mut options = IndexOptions::default();
            options.name = name.clone();
            options.unique = unique.then_some(true);
            options.sparse = sparse.then_some(true);
            options.expire_after =
                expire_after_seconds.map(|s| std::time::Duration::from_secs(s.max(0) as u64));
            let index_name = name.unwrap_or_else(|| default_index_name(&keys));
            // ⚠️ `IndexModel` 也是 `#[non_exhaustive]`，但它有 TypedBuilder ——
            // 结构体字面量用不了，builder 可以
            collection
                .create_index(IndexModel::builder().keys(keys).options(options).build())
                .await
                .map_err(classify)?;
            Ok(docs_to_table(
                vec![mongodb::bson::doc! { "createdIndex": index_name }],
                false,
            ))
        }

        MongoOp::DropIndex { name } => {
            collection.drop_index(&name).await.map_err(classify)?;
            Ok(docs_to_table(
                vec![mongodb::bson::doc! { "droppedIndex": name }],
                false,
            ))
        }

        MongoOp::Drop => {
            collection.drop().await.map_err(classify)?;
            Ok(docs_to_table(
                vec![mongodb::bson::doc! { "dropped": &collection_name }],
                false,
            ))
        }

        // 上面那个 `let Some(..) else` 已经把库级操作分流出去了，这里只是为了
        // 让 match 穷尽（编译器要求）
        MongoOp::DropDatabase | MongoOp::CreateCollection { .. } => {
            Err(Failure::Sql("库级操作不需要集合名".to_string()))
        }
    }
}

/// 库级操作。
async fn db_level(db: Database, name: String, op: MongoOp) -> Result<QueryResult, Failure> {
    match op {
        MongoOp::DropDatabase => {
            db.drop().await.map_err(classify)?;
            Ok(docs_to_table(
                vec![mongodb::bson::doc! { "droppedDatabase": name }],
                false,
            ))
        }
        MongoOp::CreateCollection { name: collection } => {
            db.create_collection(&collection).await.map_err(classify)?;
            Ok(docs_to_table(
                vec![mongodb::bson::doc! { "createdCollection": collection }],
                false,
            ))
        }
        _ => Err(Failure::Sql("这个操作要指定集合".to_string())),
    }
}

/// 这个操作是不是「读一个已经存在的集合」。
///
/// ⚠️ 只有读的那几个要做存在性检查：`insertOne` 到不存在的集合是**合法**的
/// （Mongo 会顺手把它建出来），拦下来反而挡了正常用法。
fn reads_collection(op: &MongoOp) -> bool {
    matches!(
        op,
        MongoOp::Find { .. }
            | MongoOp::FindOne { .. }
            | MongoOp::Count { .. }
            | MongoOp::EstimatedCount
            | MongoOp::Distinct { .. }
            | MongoOp::Aggregate { .. }
            | MongoOp::GetIndexes
            | MongoOp::DropIndex { .. }
    )
}

/// 从游标里取到 `want` 条为止（多要一条用来判断「是不是还有」）。
async fn drain(
    cursor: &mut mongodb::Cursor<Document>,
    want: usize,
) -> Result<(Vec<Document>, bool), Failure> {
    use futures_util::StreamExt as _;
    let mut docs = Vec::new();
    let mut truncated = false;
    while let Some(next) = cursor.next().await {
        let document = next.map_err(classify)?;
        if docs.len() >= want || docs.len() >= MAX_ROWS {
            truncated = true;
            break;
        }
        docs.push(document);
    }
    Ok((docs, truncated))
}

// ------------------------------------------------------------------ 结果成形

/// 一批文档 → 一张表。
///
/// 列 = 顶层字段的**并集**（`_id` 排最前），一行一份文档；某一列在某个文档里
/// 没有就是**空单元格**（`Cell::null`，界面上显示成 NULL）—— 文档是参差的，
/// 这一点不该被藏起来（那正是「文档不是表格」这件事的痕迹）。
pub(crate) fn docs_to_table(docs: Vec<Document>, truncated: bool) -> QueryResult {
    let names = column_names(&docs);
    let columns = names
        .iter()
        .map(|name| ColumnInfo {
            name: name.clone(),
            type_name: ANY_TYPE.to_string(),
        })
        .collect();

    let rows = docs
        .iter()
        .map(|doc| {
            names
                .iter()
                .map(|name| match doc.get(name) {
                    None | Some(Bson::Null) => Cell::null(),
                    Some(value) => Cell::from_bytes(cell_text(value).into_bytes()),
                })
                .collect()
        })
        .collect();

    QueryResult {
        columns,
        rows,
        // MongoDB 没有「影响行数」这个概念（契约里也定的 null）——
        // 写操作的影响条数在**结果文档**里（`deletedCount` 那种，和 mongosh 一样）
        affected: None,
        truncated,
        elapsed_ms: 0,
        error: None,
    }
}

/// 一列值（`distinct` 用）→ 一张表。
fn values_to_table(values: Vec<Bson>, column: &str) -> QueryResult {
    let rows = values
        .into_iter()
        .map(|value| {
            vec![match value {
                Bson::Null => Cell::null(),
                other => Cell::from_bytes(cell_text(&other).into_bytes()),
            }]
        })
        .collect();
    QueryResult {
        columns: vec![ColumnInfo {
            name: column.to_string(),
            type_name: ANY_TYPE.to_string(),
        }],
        rows,
        affected: None,
        truncated: false,
        elapsed_ms: 0,
        error: None,
    }
}

/// `count*` 的结果（一行一列）。
fn count_table(n: u64) -> QueryResult {
    QueryResult {
        columns: vec![ColumnInfo {
            name: "count".to_string(),
            type_name: "number".to_string(),
        }],
        rows: vec![vec![Cell::from_bytes(n.to_string().into_bytes())]],
        affected: None,
        truncated: false,
        elapsed_ms: 0,
        error: None,
    }
}

/// `update*` / `replace*` 的结果文档（和 mongosh 打印的那几个字段一致）。
fn update_table(matched: u64, modified: u64, upserted: Option<Bson>) -> QueryResult {
    let mut doc = mongodb::bson::doc! {
        "acknowledged": true,
        "matchedCount": matched as i64,
        "modifiedCount": modified as i64,
    };
    if let Some(id) = upserted {
        doc.insert("upsertedId", id);
    }
    docs_to_table(vec![doc], false)
}

/// 索引 → 一行（`getIndexes()` 的表格）。
fn index_to_doc(model: IndexModel) -> Document {
    let mut doc = Document::new();
    let options = model.options.unwrap_or_default();
    doc.insert(
        "name",
        options.name.clone().unwrap_or_else(|| default_index_name(&model.keys)),
    );
    doc.insert("key", model.keys);
    if options.unique == Some(true) {
        doc.insert("unique", true);
    }
    if options.sparse == Some(true) {
        doc.insert("sparse", true);
    }
    if let Some(expire) = options.expire_after {
        doc.insert("expireAfterSeconds", expire.as_secs() as i64);
    }
    doc
}

/// 没起名字时 Mongo 自己会用的名字：`a_1_b_-1`（字段名 + 方向，下划线连起来）。
fn default_index_name(keys: &Document) -> String {
    keys.iter()
        .map(|(key, value)| format!("{key}_{}", index_direction(value)))
        .collect::<Vec<_>>()
        .join("_")
}

fn index_direction(value: &Bson) -> String {
    match value {
        Bson::Int32(n) => n.to_string(),
        Bson::Int64(n) => n.to_string(),
        Bson::Double(n) => n.to_string(),
        Bson::String(s) => s.clone(),
        other => format!("{other}"),
    }
}

/// 二进制的子类型编号（`BinData(0, "…")` 里那个 0）。
///
/// ⚠️ `BinarySubtype` 没有 `as_u8()`（驱动没给），但实现了 `From<&BinarySubtype> for u8`。
fn subtype_code(subtype: &mongodb::bson::spec::BinarySubtype) -> u8 {
    u8::from(*subtype)
}

/// 表格的列：顶层字段的并集，`_id` 排最前。
fn column_names(docs: &[Document]) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    let mut has_id = false;
    for doc in docs {
        for key in doc.keys() {
            if key == "_id" {
                has_id = true;
                continue;
            }
            if !names.iter().any(|n| n == key) {
                names.push(key.clone());
            }
        }
    }
    if has_id {
        names.insert(0, "_id".to_string());
    }
    names
}

/// 一个值 → 单元格里的那段文本。
///
/// ⚠️ 顶层是**字符串**时原样给（不要 JSON 那层引号）；别的类型先过 [`humanize`]，
/// 结果是字符串就直接用，是对象/数组就压成一行 JSON。
fn cell_text(value: &Bson) -> String {
    if let Bson::String(s) = value {
        return s.clone();
    }
    match humanize(value) {
        Json::String(s) => s,
        other => other.to_string(),
    }
}

/// bson 值 → **给人看的** JSON。
///
/// ⚠️ 刻意**不用** bson 那套扩展 JSON（`{"$oid": …}` / `{"$date": …}`）：
/// 那是给程序读的形状，放进表格里每一格都多一层噪音。这里按 mongosh 打印的
/// 样子来 —— ObjectId 就是那串十六进制、日期就是 ISO、二进制是
/// `BinData(0, "…")`。
///
/// 代价写清楚：**类型信息会丢**（一串十六进制看不出它是 ObjectId 还是字符串）。
/// 表格本来就是「扫一眼」的地方；要精确看某一格，`findOne` + `.project()`
/// 或者换 `find` 去别处看。
pub(crate) fn humanize(value: &Bson) -> Json {
    match value {
        Bson::Double(n) => serde_json::Number::from_f64(*n)
            .map(Json::Number)
            .unwrap_or(Json::Null),
        Bson::String(s) => Json::String(s.clone()),
        Bson::Array(items) => Json::Array(items.iter().map(humanize).collect()),
        Bson::Document(doc) => Json::Object(
            doc.iter()
                .map(|(key, value)| (key.clone(), humanize(value)))
                .collect(),
        ),
        Bson::Boolean(b) => Json::Bool(*b),
        Bson::Null => Json::Null,
        Bson::RegularExpression(regex) => Json::String(format!("/{}/{}", regex.pattern, regex.options)),
        Bson::JavaScriptCode(code) => Json::String(code.clone()),
        Bson::JavaScriptCodeWithScope(_) => Json::String("[一段带作用域的函数]".to_string()),
        Bson::Int32(n) => json!(n),
        Bson::Int64(n) => json!(n),
        Bson::Timestamp(ts) => Json::String(format!("Timestamp({}, {})", ts.time, ts.increment)),
        Bson::Binary(binary) => {
            use base64::Engine as _;
            let encoded = base64::engine::general_purpose::STANDARD.encode(&binary.bytes);
            Json::String(format!("BinData({}, \"{encoded}\")", subtype_code(&binary.subtype)))
        }
        Bson::ObjectId(id) => Json::String(id.to_hex()),
        Bson::DateTime(datetime) => Json::String(
            datetime
                .try_to_rfc3339_string()
                .unwrap_or_else(|_| format!("{datetime:?}")),
        ),
        Bson::Symbol(s) => Json::String(s.clone()),
        Bson::Decimal128(decimal) => Json::String(decimal.to_string()),
        Bson::Undefined => Json::Null,
        Bson::MinKey => Json::String("MinKey".to_string()),
        Bson::MaxKey => Json::String("MaxKey".to_string()),
        Bson::DbPointer(_) => Json::String("[DBPointer]".to_string()),
    }
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

/// 所有库名字（侧栏第一层）。
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


#[cfg(test)]
mod tests {
    use super::*;
    use mongodb::bson::spec::BinarySubtype;
    use mongodb::bson::{doc, oid::ObjectId, Binary, DateTime};

    /// 单元格的文本（`None` 表示 NULL）。
    fn cell(result: &QueryResult, row: usize, col: usize) -> Option<String> {
        result.rows[row][col].text.clone()
    }

    /// 表头那一行的名字。
    fn names(result: &QueryResult) -> Vec<String> {
        result.columns.iter().map(|c| c.name.clone()).collect()
    }

    #[test]
    fn 列是顶层字段的并集_id_排最前() {
        let table = docs_to_table(
            vec![
                doc! { "_id": 1, "name": "张三", "age": 30 },
                doc! { "_id": 2, "email": "li@example.com" },
            ],
            false,
        );
        // ⚠️ `_id` 一定在最前（扫一行文档先看的就是它），其余按**第一次出现**的顺序
        assert_eq!(names(&table), vec!["_id", "name", "age", "email"]);
        assert_eq!(table.rows.len(), 2);
    }

    #[test]
    fn 没有_id_的文档也不会乱() {
        let table = docs_to_table(vec![doc! { "a": 1 }, doc! { "b": 2 }], false);
        assert_eq!(names(&table), vec!["a", "b"]);
    }

    #[test]
    fn 参差的那几格是_null_不是空串() {
        // ⚠️ 「这份文档没有 email」和「email 是空字符串」是两件事 ——
        // 文档是参差的，这一点不该被藏起来（那正是「文档不是表格」的痕迹）
        let table = docs_to_table(
            vec![doc! { "_id": 1, "email": "a@b.c" }, doc! { "_id": 2 }],
            false,
        );
        assert_eq!(cell(&table, 0, 1), Some("a@b.c".to_string()));
        assert_eq!(cell(&table, 1, 1), None, "缺的字段应当是 NULL");
        assert_eq!(cell(&table, 1, 0), Some("2".to_string()));
    }

    #[test]
    fn 显式的_null_也是_null() {
        let table = docs_to_table(vec![doc! { "a": Bson::Null }], false);
        assert_eq!(cell(&table, 0, 0), None);
    }

    #[test]
    fn 占位的那一列仍然画得出来() {
        // 一份有 a、一份只有 _id：a 那一列要在（哪怕这行是空的）——
        // 列是**并集**，不是按第一份文档定的
        let table = docs_to_table(vec![doc! { "_id": 1, "a": 1 }, doc! { "_id": 2 }], false);
        assert_eq!(names(&table), vec!["_id", "a"]);
        assert_eq!(cell(&table, 1, 1), None);
    }

    #[test]
    fn 嵌套的文档和数组压成一行_json() {
        let table = docs_to_table(
            vec![doc! {
                "_id": 1,
                "addr": { "city": "北京", "zip": "100000" },
                "tags": ["a", "b"],
            }],
            false,
        );
        assert_eq!(
            cell(&table, 0, 1),
            Some(r#"{"city":"北京","zip":"100000"}"#.to_string()),
            "嵌套文档压成一行紧凑 JSON（表格里放不下深度）"
        );
        assert_eq!(cell(&table, 0, 2), Some(r#"["a","b"]"#.to_string()));
    }

    #[test]
    fn objectid_给出十六进制_日期给出_iso() {
        let id = ObjectId::parse_str("507f1f77bcf86cd799439011").unwrap();
        let when = DateTime::parse_rfc3339_str("2026-10-13T08:00:00Z").unwrap();
        let table = docs_to_table(vec![doc! { "_id": id, "at": when }], false);

        // ⚠️ 不是 bson 那套扩展 JSON（`{"$oid": …}`）—— 那是给程序读的，
        // 表格里每一格都多一层噪音
        assert_eq!(cell(&table, 0, 0), Some("507f1f77bcf86cd799439011".to_string()));
        assert_eq!(cell(&table, 0, 1), Some("2026-10-13T08:00:00Z".to_string()));
    }

    #[test]
    fn 二进制按_mongosh_的样子() {
        let table = docs_to_table(
            vec![doc! { "blob": Binary { subtype: BinarySubtype::Generic, bytes: vec![1, 2, 3] } }],
            false,
        );
        assert_eq!(cell(&table, 0, 0), Some(r#"BinData(0, "AQID")"#.to_string()));
    }

    #[test]
    fn 数字_布尔_正则_各自的样子() {
        let table = docs_to_table(
            vec![doc! {
                "i": 3,
                "big": 9_000_000_000i64,
                "f": 1.5,
                "ok": true,
                "re": Bson::RegularExpression(mongodb::bson::Regex {
                    pattern: "^张".to_string(),
                    options: "i".to_string(),
                }),
            }],
            false,
        );
        assert_eq!(cell(&table, 0, 0), Some("3".to_string()));
        assert_eq!(cell(&table, 0, 1), Some("9000000000".to_string()));
        assert_eq!(cell(&table, 0, 2), Some("1.5".to_string()));
        assert_eq!(cell(&table, 0, 3), Some("true".to_string()));
        assert_eq!(cell(&table, 0, 4), Some("/^张/i".to_string()));
    }

    #[test]
    fn 字符串不加引号_别的要() {
        // 表格里 `"张三"` 和 `张三` 看着一样，但复制走的时候少一层引号更顺手
        let table = docs_to_table(vec![doc! { "s": "张三", "n": "5" }], false);
        assert_eq!(cell(&table, 0, 0), Some("张三".to_string()));
        // ⚠️ 恰好长得像数字的字符串**不还原成数字**：那会把类型信息弄错
        assert_eq!(cell(&table, 0, 1), Some("5".to_string()));
    }

    #[test]
    fn 写操作的结果文档和_mongosh_打印的一致() {
        let inserted = docs_to_table(vec![doc! { "acknowledged": true, "insertedId": "x" }], false);
        assert_eq!(names(&inserted), vec!["acknowledged", "insertedId"]);
        assert_eq!(cell(&inserted, 0, 1), Some("x".to_string()));

        let updated = update_table(3, 2, None);
        assert_eq!(names(&updated), vec!["acknowledged", "matchedCount", "modifiedCount"]);
        assert_eq!(cell(&updated, 0, 2), Some("2".to_string()));

        // upsert 插进去了才会有这一列
        let upserted = update_table(0, 0, Some(Bson::String("new".into())));
        assert_eq!(
            names(&upserted),
            vec!["acknowledged", "matchedCount", "modifiedCount", "upsertedId"]
        );
    }

    #[test]
    fn count_是一行一列() {
        let table = count_table(42);
        assert_eq!(names(&table), vec!["count"]);
        assert_eq!(cell(&table, 0, 0), Some("42".to_string()));
    }

    #[test]
    fn distinct_的列名就是那个字段() {
        let table = values_to_table(
            vec![Bson::String("北京".into()), Bson::Null, Bson::Int32(3)],
            "city",
        );
        assert_eq!(names(&table), vec!["city"]);
        assert_eq!(cell(&table, 0, 0), Some("北京".to_string()));
        assert_eq!(cell(&table, 1, 0), None, "真的有一个 null 值时它还是 NULL");
        assert_eq!(cell(&table, 2, 0), Some("3".to_string()));
    }

    #[test]
    fn 索引名按_mongo_的规矩拼() {
        // Mongo 自己在没给名字时用的是 `字段_方向` 用下划线连起来
        assert_eq!(default_index_name(&doc! { "email": 1 }), "email_1");
        assert_eq!(default_index_name(&doc! { "a": 1, "b": -1 }), "a_1_b_-1");
    }

    #[test]
    fn getIndexes_的那张表() {
        use mongodb::options::IndexOptions;
        let mut options = IndexOptions::default();
        options.name = Some("email_1".to_string());
        options.unique = Some(true);
        let row = index_to_doc(
            mongodb::IndexModel::builder()
                .keys(doc! { "email": 1 })
                .options(options)
                .build(),
        );
        assert_eq!(row.get_str("name").unwrap(), "email_1");
        assert_eq!(row.get_bool("unique").unwrap(), true);
        assert!(!row.contains_key("sparse"), "没设的选项不该冒出来");
    }

    #[test]
    fn 读操作才做集合存在性检查() {
        // ⚠️ `insertOne` 往不存在的集合里写是**合法**的（Mongo 会顺手建出来）——
        // 拦下来反而挡了正常用法
        assert!(reads_collection(&MongoOp::Find {
            filter: Document::new(),
            projection: None,
            sort: None,
            limit: None,
            skip: None,
        }));
        assert!(reads_collection(&MongoOp::Aggregate { pipeline: vec![] }));
        assert!(!reads_collection(&MongoOp::InsertOne {
            document: Document::new()
        }));
        assert!(!reads_collection(&MongoOp::Drop));
        assert!(!reads_collection(&MongoOp::DropDatabase));
    }
}
