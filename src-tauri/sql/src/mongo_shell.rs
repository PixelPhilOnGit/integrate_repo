//! mongosh 风格的查询解析：`db.<集合>.<操作>(...)`。
//!
//! # 为什么单独一个文件
//!
//! 和 `assistant/src/tool.rs` 那条切法同一个理由：**「参数合不合法」是最容易
//! 写错、又最不该出错的一件事**。这一层**不碰驱动、不开连接**，所以
//! 「括号少一个」「filter 写成字符串了」这类输入能在毫秒级的单测里穷举 ——
//! 混进 `mongo.rs` 的话，测一条语法得先起一个 MongoDB。
//!
//! # 为什么要有它（原来只有 JSON 形式）
//!
//! 原来查询写的是 `{"collection":"users","filter":{}}` —— 一个我们自己发明的
//! 形状。用户的原话是「查询不应该是 db.xxx 语法吗，应该要都能查」：**他脑子里的
//! Mongo 就是 mongosh 那个样子**，而那才是能直接粘进任何地方的写法
//!（文档、同事的聊天记录、工单）。自己发明一种形状的代价是：用户得先学我们这套。
//!
//! ⚠️ **JSON 形式保留着**（`parse_command` 先看是不是 `db.` 开头，不是就走老路）：
//! 用户的历史记录里躺着那种形状的查询，删掉它等于让人家的历史失效。
//!
//! # 覆盖面（**边界是明确的，不是"缺了"**）
//!
//! **支持**：
//!
//! | 类别 | 操作 |
//! |---|---|
//! | 查 | `find` · `findOne` · `count` · `countDocuments` · `estimatedDocumentCount` · `distinct` · `aggregate` |
//! | 写 | `insertOne` · `insertMany` · `updateOne` · `updateMany` · `replaceOne` · `deleteOne` · `deleteMany` · `findOneAndUpdate` · `findOneAndReplace` · `findOneAndDelete` |
//! | 集合 | `drop` · `createIndex` · `dropIndex` · `getIndexes` |
//! | 库 | `db.dropDatabase()` · `db.createCollection(name)` |
//! | 游标 | `.sort()` `.limit()` `.skip()` `.project()` `.count()` `.toArray()` |
//!
//! **不支持**（写了会得到一句「不支持」+ 支持的清单，而不是猜）：
//! `show dbs` / `use`（侧栏本来就在列库和集合）、JS 那一套（变量、`forEach`、
//! `$where`）、`explain()`、事务、`bulkWrite`、`mapReduce`。
//! ⚠️ **`db` 就是连接上选中的那个库**（JSON 形式可以用 `database` 覆盖）——
//! 我们不做 `use`，因为「当前库」在界面上是侧栏里那个高亮的节点。
//!
//! # ⚠️ 写入是**真的写**
//!
//! `deleteMany({})` 在这个界面里没有撤销、没有确认弹窗（用户明确要的是
//! 「和 mongosh 一样，风险自负」）。所以别在文档里写成「安全浏览」——
//! 它现在就是一个 shell。

use mongodb::bson::oid::ObjectId;
use mongodb::bson::{Bson, DateTime, Document, Regex};

/// 一条解析好的操作。
///
/// 每个变体只放**执行时需要的东西**（解析器那边多认出来的形状在这里就消化掉了，
/// 不让它漏到执行层去）。
#[derive(Debug, Clone, PartialEq)]
pub enum MongoOp {
    /// `find(filter, projection?)` + 游标链。
    Find {
        filter: Document,
        projection: Option<Document>,
        sort: Option<Document>,
        limit: Option<i64>,
        skip: Option<u64>,
    },
    /// `findOne(filter, projection?)` —— 没有 limit（它本来就只取一条）。
    FindOne {
        filter: Document,
        projection: Option<Document>,
        sort: Option<Document>,
        skip: Option<u64>,
    },
    /// `countDocuments(filter, {skip, limit})` / 老式的 `count()`。
    Count {
        filter: Document,
        skip: Option<u64>,
        limit: Option<i64>,
    },
    /// `estimatedDocumentCount()` —— 查的是元数据，不带 filter。
    EstimatedCount,
    /// `distinct("字段", filter?)`。
    Distinct { field: String, filter: Document },
    /// `aggregate([...])`。
    Aggregate { pipeline: Vec<Document> },
    /// `insertOne(doc)`。
    InsertOne { document: Document },
    /// `insertMany([doc, ...])`。
    InsertMany { documents: Vec<Document> },
    /// `updateOne` / `updateMany`（只差 `many`）。
    Update {
        many: bool,
        filter: Document,
        update: Document,
        upsert: bool,
    },
    /// `replaceOne(...)` —— 整个文档替换，和 `update` 是两个操作（驱动也是两个）。
    Replace {
        many: bool,
        filter: Document,
        replacement: Document,
        upsert: bool,
    },
    /// `deleteOne` / `deleteMany`。
    Delete { many: bool, filter: Document },
    /// `findOneAndUpdate(filter, update, {upsert, returnDocument, projection})`。
    FindOneAndUpdate {
        filter: Document,
        update: Document,
        upsert: bool,
        /// `returnDocument: "after"` / `returnNew: true` —— 返回改之前还是改之后。
        return_after: bool,
        projection: Option<Document>,
    },
    /// `findOneAndReplace(...)`。
    FindOneAndReplace {
        filter: Document,
        replacement: Document,
        upsert: bool,
        return_after: bool,
        projection: Option<Document>,
    },
    /// `findOneAndDelete(filter)`。
    FindOneAndDelete { filter: Document },
    /// `db.<集合>.drop()`。
    Drop,
    /// `createIndex(keys, {name, unique, sparse, expireAfterSeconds})`。
    CreateIndex {
        keys: Document,
        name: Option<String>,
        unique: bool,
        sparse: bool,
        expire_after_seconds: Option<i32>,
    },
    /// `dropIndex("name")` / `dropIndex({...})`。
    DropIndex { name: String },
    /// `getIndexes()`。
    GetIndexes,
    /// `db.createCollection("name", {...})`。
    CreateCollection { name: String },
    /// `db.dropDatabase()`。
    DropDatabase,
}

/// 解析结果：库 + 集合 + 操作。
///
/// `collection` 在库级操作上是 `None`（`db.dropDatabase()` / `db.createCollection()`）。
#[derive(Debug, Clone, PartialEq)]
pub struct MongoCommand {
    /// 不填就用连接上配的那个库（`db` 就是它）。
    pub database: Option<String>,
    pub collection: Option<String>,
    pub op: MongoOp,
}

/// 解析一段查询：**`db` 开头走 mongosh 语法，否则当 JSON**（老形式，见文件头）。
pub fn parse_command(text: &str, default_database: Option<&str>) -> Result<MongoCommand, String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err("查询是空的。写一句，比如 db.users.find({})".to_string());
    }

    if is_shell(trimmed) {
        let mut parser = Parser::new(trimmed);
        let command = parser.parse_command()?;
        parser.finish()?;
        return Ok(MongoCommand {
            database: default_database.map(str::to_string),
            ..command
        });
    }

    parse_json_command(trimmed, default_database)
}

/// 是不是 mongosh 风格。
///
/// ⚠️ 判据故意**很窄**（`db` 后面紧跟 `.` 或 `[`）：宁可把一段奇怪的输入丢给
/// JSON 那条路（它会报「不是合法的 JSON」），也不要因为猜错而给出一句
/// 让人摸不着头脑的语法错。
fn is_shell(text: &str) -> bool {
    // ⚠️ 开头的空白和 `//` 注释要先跳过：用户粘过来的查询常带着一行说明，
    // 而那种输入**必须**走 shell 那条路（丢给 JSON 解析只会得到一句
    // 「不是合法的 JSON」，看不出问题在哪儿）
    let mut rest = text;
    loop {
        rest = rest.trim_start();
        match rest.strip_prefix("//") {
            Some(after) => rest = match after.find('\n') {
                Some(i) => &after[i + 1..],
                None => return false,
            },
            None => break,
        }
    }

    let rest = match rest.strip_prefix("db") {
        Some(rest) => rest,
        None => return false,
    };
    matches!(rest.trim_start().chars().next(), Some('.') | Some('['))
}

// ------------------------------------------------------------------ JSON 老形式

/// 前端的「点集合 → 生成一段查询」曾经长这样，用户历史里也躺着这种。
#[derive(serde::Deserialize)]
struct JsonQuery {
    collection: String,
    database: Option<String>,
    #[serde(default)]
    filter: Option<Document>,
    sort: Option<Document>,
    projection: Option<Document>,
    limit: Option<u32>,
}

fn parse_json_command(text: &str, default_database: Option<&str>) -> Result<MongoCommand, String> {
    let query: JsonQuery = serde_json::from_str(text).map_err(|e| {
        // 两种都认不出来时，把「怎么写」一起说了 —— 只报一句 JSON 语法错，
        // 用户（尤其是照着 `db.x.find()` 打错一个字符的人）会不知道往哪走
        format!(
            "这段既不是合法的 JSON、也不是 db.<集合>.<操作>(...) 那种写法：{e}\n\
             比如：db.users.find({{}})"
        )
    })?;

    let collection = query.collection.trim();
    if collection.is_empty() {
        return Err("要指定查哪个集合：{\"collection\": \"users\"}".to_string());
    }

    Ok(MongoCommand {
        database: query
            .database
            .map(|d| d.trim().to_string())
            .filter(|d| !d.is_empty())
            .or_else(|| default_database.map(str::to_string)),
        collection: Some(collection.to_string()),
        op: MongoOp::Find {
            filter: query.filter.unwrap_or_default(),
            projection: query.projection,
            sort: query.sort,
            limit: query.limit.map(i64::from),
            skip: None,
        },
    })
}

// ------------------------------------------------------------------ 解析器

/// 手写递归下降。**不用正则**：`{a: {b: [1, "}"]}}` 这种嵌套一进去，正则就没法
/// 正确地数括号了，而「字符串里的括号不算括号」正是这类解析器的第一个坑。
struct Parser {
    chars: Vec<char>,
    pos: usize,
}

type PResult<T> = Result<T, String>;

impl Parser {
    fn new(text: &str) -> Parser {
        Parser {
            chars: text.chars().collect(),
            pos: 0,
        }
    }

    // ------------------------------------------------------------ 基础

    fn peek(&self) -> Option<char> {
        self.chars.get(self.pos).copied()
    }

    fn bump(&mut self) -> Option<char> {
        let c = self.peek();
        if c.is_some() {
            self.pos += 1;
        }
        c
    }

    /// 跳过空白和 `//` 注释（查询里常带着一行说明）。
    fn skip_ws(&mut self) {
        loop {
            match self.peek() {
                Some(c) if c.is_whitespace() => {
                    self.pos += 1;
                }
                Some('/') if self.chars.get(self.pos + 1) == Some(&'/') => {
                    while let Some(c) = self.bump() {
                        if c == '\n' {
                            break;
                        }
                    }
                }
                _ => return,
            }
        }
    }

    /// 当前位置往后一小段——报错时给用户看「是在哪儿断的」。
    fn here(&self) -> String {
        let rest: String = self.chars[self.pos.min(self.chars.len())..]
            .iter()
            .take(24)
            .collect();
        if rest.is_empty() {
            "（已经到结尾了）".to_string()
        } else {
            format!("…{rest}")
        }
    }

    fn err<T>(&self, what: &str) -> PResult<T> {
        Err(format!("{what}（读到 {}", self.here()))
    }

    fn expect(&mut self, want: char) -> PResult<()> {
        self.skip_ws();
        match self.bump() {
            Some(c) if c == want => Ok(()),
            Some(c) => self.err(&format!("这里应当是 `{want}`，读到的是 `{c}`）")),
            None => self.err(&format!("这里应当是 `{want}`，但查询结束了）")),
        }
    }

    fn eat(&mut self, want: char) -> bool {
        self.skip_ws();
        if self.peek() == Some(want) {
            self.pos += 1;
            return true;
        }
        false
    }

    /// 认一个标识符（操作名、字段名）。
    fn identifier(&mut self) -> PResult<String> {
        self.skip_ws();
        let start = self.pos;
        if let Some(c) = self.peek() {
            if c == '_' || c == '$' || c.is_alphabetic() {
                self.pos += 1;
            } else {
                return self.err("这里应当是一个名字（字母、下划线或 $ 开头））");
            }
        } else {
            return self.err("这里应当是一个名字，但查询结束了）");
        }
        while let Some(c) = self.peek() {
            if c == '_' || c == '$' || c.is_alphanumeric() {
                self.pos += 1;
            } else {
                break;
            }
        }
        Ok(self.chars[start..self.pos].iter().collect())
    }

    /// 一个字符串（单双引号都认）。
    fn string(&mut self) -> PResult<String> {
        self.skip_ws();
        let quote = match self.peek() {
            Some(q @ ('"' | '\'')) => {
                self.pos += 1;
                q
            }
            _ => return self.err("这里应当是一个字符串（引号包起来））"),
        };

        let mut out = String::new();
        loop {
            match self.bump() {
                None => return self.err("字符串没有结尾的引号）"),
                Some(c) if c == quote => return Ok(out),
                Some('\\') => match self.bump() {
                    Some('n') => out.push('\n'),
                    Some('t') => out.push('\t'),
                    Some('r') => out.push('\r'),
                    Some('0') => out.push('\0'),
                    Some('b') => out.push('\u{8}'),
                    Some('f') => out.push('\u{c}'),
                    Some('\\') => out.push('\\'),
                    Some('\'') => out.push('\''),
                    Some('"') => out.push('"'),
                    Some('/') => out.push('/'),
                    Some('u') => {
                        let mut hex = String::new();
                        for _ in 0..4 {
                            match self.bump() {
                                Some(c) if c.is_ascii_hexdigit() => hex.push(c),
                                _ => return self.err("\\u 后面要跟四个十六进制数字）"),
                            }
                        }
                        let code = u32::from_str_radix(&hex, 16)
                            .map_err(|_| format!("\\u{hex} 不是合法的转义"))?;
                        out.push(char::from_u32(code).unwrap_or('\u{fffd}'));
                    }
                    other => {
                        return self.err(&format!(
                            "认不出的转义 `\\{}`（支持 \\n \\t \\r \\0 \\\\ \\\" \\' \\uXXXX））",
                            other.unwrap_or(' ')
                        ))
                    }
                },
                Some(c) => out.push(c),
            }
        }
    }

    // ------------------------------------------------------------ 值

    /// 一个 JS 字面量 → BSON 值。
    fn value(&mut self) -> PResult<Bson> {
        self.skip_ws();
        match self.peek() {
            Some('{') => Ok(Bson::Document(self.document()?)),
            Some('[') => Ok(Bson::Array(self.array()?)),
            Some('"' | '\'') => Ok(Bson::String(self.string()?)),
            Some('/') => self.regex(),
            Some(c) if c == '-' || c.is_ascii_digit() => self.number(),
            Some(c) if c == '_' || c == '$' || c.is_alphabetic() => {
                let word = self.identifier()?;
                match word.as_str() {
                    "true" => Ok(Bson::Boolean(true)),
                    "false" => Ok(Bson::Boolean(false)),
                    "null" => Ok(Bson::Null),
                    // `ObjectId("…")` / `ISODate("…")` / `new Date("…")` —— 这三个
                    // 在真实查询里出现频率极高（按 _id 找、按时间筛），
                    // 不支持的话用户每次都得手写成扩展 JSON
                    "ObjectId" | "ObjectID" => {
                        let hex = self.parenthesised_string("ObjectId")?;
                        ObjectId::parse_str(&hex)
                            .map(Bson::ObjectId)
                            .map_err(|_| format!("ObjectId(\"{hex}\") 不是合法的 id（要 24 位十六进制）"))
                    }
                    "ISODate" => {
                        let text = self.parenthesised_string("ISODate")?;
                        DateTime::parse_rfc3339_str(&text)
                            .map(Bson::DateTime)
                            .map_err(|e| format!("ISODate(\"{text}\") 读不出来：{e}"))
                    }
                    "Date" => {
                        let text = self.parenthesised_string("Date")?;
                        DateTime::parse_rfc3339_str(&text)
                            .map(Bson::DateTime)
                            .map_err(|e| format!("Date(\"{text}\") 读不出来：{e}"))
                    }
                    "new" => {
                        let what = self.identifier()?;
                        if what != "Date" {
                            return self.err(&format!("`new {what}` 不支持（只认 new Date(\"…\")））"));
                        }
                        let text = self.parenthesised_string("new Date")?;
                        DateTime::parse_rfc3339_str(&text)
                            .map(Bson::DateTime)
                            .map_err(|e| format!("new Date(\"{text}\") 读不出来：{e}"))
                    }
                    // ⚠️ 裸名字当值是最常见的一种手误（`{name: 张三}`）。
                    // 说清楚要加引号，别只说「语法错」
                    other => self.err(&format!(
                        "认不出的值 `{other}` —— 字符串要加引号（\"{other}\"），\
                         或者它是个函数的话还没支持）"
                    )),
                }
            }
            Some('.') => self.number(),
            _ => self.err("这里应当是一个值（数字 / 字符串 / 对象 / 数组 / true / false / null））"),
        }
    }

    fn parenthesised_string(&mut self, who: &str) -> PResult<String> {
        self.expect('(')?;
        let text = self.string()?;
        self.expect(')')?;
        let _ = who;
        Ok(text)
    }

    /// 数字。
    ///
    /// 映射规则（和 mongosh 的直觉一致）：带小数点或指数的当 `Double`，
    /// 整数按大小落到 `Int32` / `Int64`。⚠️ Mongo 的等值比较**跨数值类型成立**，
    /// 所以 `{age: 18}` 打 i32 也能匹配上存成 double 的 18 —— 这一点不用解释给用户。
    fn number(&mut self) -> PResult<Bson> {
        self.skip_ws();
        let start = self.pos;
        if self.peek() == Some('-') {
            self.pos += 1;
        }
        let mut fractional = false;
        while let Some(c) = self.peek() {
            if c.is_ascii_digit() {
                self.pos += 1;
            } else if c == '.' && !fractional {
                fractional = true;
                self.pos += 1;
            } else if (c == 'e' || c == 'E') && !fractional {
                fractional = true;
                self.pos += 1;
                if matches!(self.peek(), Some('+') | Some('-')) {
                    self.pos += 1;
                }
            } else {
                break;
            }
        }

        let text: String = self.chars[start..self.pos].iter().collect();
        if text.is_empty() || text == "-" {
            return self.err("这里应当是一个数字）");
        }

        if fractional {
            return text
                .parse::<f64>()
                .map(Bson::Double)
                .map_err(|_| format!("数字 `{text}` 读不出来"));
        }
        match text.parse::<i64>() {
            Ok(n) if i32::try_from(n).is_ok() => Ok(Bson::Int32(n as i32)),
            Ok(n) => Ok(Bson::Int64(n)),
            // 超过 i64 的整数：当 double（mongosh 那边也是这样，精度取舍由用户认）
            Err(_) => text
                .parse::<f64>()
                .map(Bson::Double)
                .map_err(|_| format!("数字 `{text}` 读不出来")),
        }
    }

    /// 正则字面量 `/pattern/flags`。
    ///
    /// mongosh 里 `{name: /^张/}` 是最常见的写法之一，而它的 JSON 等价物
    /// （`{"$regex": "^张"}`）又长又容易写错。
    fn regex(&mut self) -> PResult<Bson> {
        self.expect('/')?;
        let mut pattern = String::new();
        loop {
            match self.bump() {
                None => return self.err("正则没有结尾的 `/`）"),
                Some('\\') => {
                    pattern.push('\\');
                    if let Some(c) = self.bump() {
                        pattern.push(c);
                    }
                }
                Some('/') => break,
                Some(c) => pattern.push(c),
            }
        }
        let mut options = String::new();
        while let Some(c) = self.peek() {
            if c.is_ascii_alphabetic() {
                options.push(c);
                self.pos += 1;
            } else {
                break;
            }
        }
        Ok(Bson::RegularExpression(Regex {
            pattern,
            options,
        }))
    }

    fn array(&mut self) -> PResult<Vec<Bson>> {
        self.expect('[')?;
        let mut items = Vec::new();
        if self.eat(']') {
            return Ok(items);
        }
        loop {
            items.push(self.value()?);
            if self.eat(']') {
                return Ok(items);
            }
            self.expect(',')?;
            // 尾随逗号：JS 允许，用户也常这么写
            if self.eat(']') {
                return Ok(items);
            }
        }
    }

    fn document(&mut self) -> PResult<Document> {
        self.expect('{')?;
        let mut doc = Document::new();
        if self.eat('}') {
            return Ok(doc);
        }
        loop {
            let key = self.object_key()?;
            self.expect(':')?;
            let value = self.value()?;
            doc.insert(key, value);

            if self.eat('}') {
                return Ok(doc);
            }
            self.expect(',')?;
            if self.eat('}') {
                return Ok(doc);
            }
        }
    }

    /// 对象的键：标识符、字符串，或者（少见但不罕见）裸数字。
    fn object_key(&mut self) -> PResult<String> {
        self.skip_ws();
        match self.peek() {
            Some('"' | '\'') => self.string(),
            Some(c) if c.is_ascii_digit() => {
                let start = self.pos;
                while matches!(self.peek(), Some(c) if c.is_ascii_digit() || c == '.') {
                    self.pos += 1;
                }
                Ok(self.chars[start..self.pos].iter().collect())
            }
            _ => self.identifier(),
        }
    }

    /// 解析参数表 `(a, b, c)`。**空参也返回空 vec**（`drop()` / `{}` 都合法）。
    fn args(&mut self) -> PResult<Vec<Bson>> {
        self.expect('(')?;
        let mut out = Vec::new();
        if self.eat(')') {
            return Ok(out);
        }
        loop {
            out.push(self.value()?);
            if self.eat(')') {
                return Ok(out);
            }
            self.expect(',')?;
            if self.eat(')') {
                return Ok(out);
            }
        }
    }

    // ------------------------------------------------------------ 命令

    /// `db.<集合>.<操作>(...)` 或 `db.<库级操作>(...)`，后面可以跟游标链。
    fn parse_command(&mut self) -> PResult<MongoCommand> {
        self.skip_ws();
        let word = self.identifier()?;
        if word != "db" {
            return self.err(&format!("查询要从 `db` 开始，这里是 `{word}`）"));
        }

        // `db.dropDatabase()` / `db.createCollection(...)`：库级，没有集合名。
        // ⚠️ 这一段是**试探**：不管认没认出来，最后都要把位置放回 `db` 之后 ——
        // `collection_name` 自己会去吃那个 `.`（探测完停在别处的话，它会从 `.`
        // 开始读标识符，报一句谁也看不懂的「这里应当是一个名字」）
        let after_db = self.pos;
        self.skip_ws();
        if self.peek() == Some('.') {
            self.pos += 1;
            if let Ok(name) = self.identifier() {
                if name == "dropDatabase" || name == "createCollection" {
                    return self.db_level_op(&name);
                }
                if matches!(name.as_str(), "getCollectionNames" | "stats" | "version") {
                    return Err(format!(
                        "`db.{name}()` 还不支持。支持的是：db.<集合>.<操作>(...) 或 \
                         db.dropDatabase() / db.createCollection(名字)——\
                         要列库和集合，直接看左边的树。"
                    ));
                }
            }
        }
        self.pos = after_db;

        let collection = self.collection_name()?;

        // 集合级操作
        self.expect('.')?;
        let op_name = self.identifier()?;

        let mut command = MongoCommand {
            database: None,
            collection: Some(collection),
            op: self.collection_op(&op_name)?,
        };

        // 游标链（只有 find / findOne 那一族才有意义）
        loop {
            self.skip_ws();
            if self.peek() != Some('.') {
                break;
            }
            let save = self.pos;
            self.pos += 1;
            let method = match self.identifier() {
                Ok(m) => m,
                Err(_) => {
                    self.pos = save;
                    break;
                }
            };
            let args = self.args()?;
            self.apply_cursor_method(&method, args, &mut command.op)?;
        }

        Ok(command)
    }

    /// 集合名字的三种写法：`db.users` / `db["my-name"]` / `db.getCollection("my-name")`。
    ///
    /// ⚠️ 后两种不是装饰：真实的集合名里常有 `-` 和 `.`（`logs-2026.10`），
    /// 而它们在 JS 里不是合法标识符 —— mongosh 自己也要求走 `getCollection`。
    fn collection_name(&mut self) -> PResult<String> {
        self.skip_ws();
        if self.peek() == Some('[') {
            self.expect('[')?;
            let name = self.string()?;
            self.expect(']')?;
            return self.checked_collection(name);
        }

        // 调用方读掉的只有 `db`，那个 `.` 归这里吃
        self.expect('.')?;
        let word = self.identifier()?;
        if word == "getCollection" {
            let name = self.parenthesised_string("getCollection")?;
            return self.checked_collection(name);
        }
        self.checked_collection(word)
    }

    fn checked_collection(&self, name: String) -> PResult<String> {
        if name.trim().is_empty() {
            return self.err("集合名是空的）");
        }
        Ok(name)
    }

    fn db_level_op(&mut self, name: &str) -> PResult<MongoCommand> {
        let args = self.args()?;
        let op = match name {
            "dropDatabase" => {
                if !args.is_empty() {
                    return Err("db.dropDatabase() 不带参数".to_string());
                }
                MongoOp::DropDatabase
            }
            "createCollection" => {
                let first = args
                    .first()
                    .ok_or_else(|| "db.createCollection(名字) 要一个集合名".to_string())?;
                let name = match first {
                    Bson::String(s) => s.clone(),
                    _ => return Err("db.createCollection(\"名字\") —— 名字要加引号".to_string()),
                };
                MongoOp::CreateCollection { name }
            }
            other => return Err(format!("不支持的库级操作：db.{other}()")),
        };
        Ok(MongoCommand {
            database: None,
            collection: None,
            op,
        })
    }

    /// 集合级操作 → [`MongoOp`]。
    fn collection_op(&mut self, name: &str) -> PResult<MongoOp> {
        let args = self.args()?;
        let take_filter = |index: usize| -> PResult<Document> {
            match args.get(index) {
                None => Ok(Document::new()),
                Some(Bson::Document(d)) => Ok(d.clone()),
                Some(_) => Err("filter 要是一个对象，比如 find({age: {$gt: 18}})".to_string()),
            }
        };
        let opt_doc = |index: usize, what: &str| -> PResult<Option<Document>> {
            match args.get(index) {
                None | Some(Bson::Null) => Ok(None),
                Some(Bson::Document(d)) => Ok(Some(d.clone())),
                Some(_) => Err(format!("{what} 要是一个对象")),
            }
        };

        match name {
            "find" => Ok(MongoOp::Find {
                filter: take_filter(0)?,
                projection: opt_doc(1, "projection")?,
                sort: None,
                limit: None,
                skip: None,
            }),
            "findOne" => Ok(MongoOp::FindOne {
                filter: take_filter(0)?,
                projection: opt_doc(1, "projection")?,
                sort: None,
                skip: None,
            }),
            "countDocuments" | "count" => {
                let options = opt_doc(1, "count 的选项")?;
                let (skip, limit) = count_options(options)?;
                Ok(MongoOp::Count {
                    filter: take_filter(0)?,
                    skip,
                    limit,
                })
            }
            "estimatedDocumentCount" => {
                if !args.is_empty() {
                    return Err(
                        "estimatedDocumentCount() 不带参数（要按条件数就用 countDocuments(filter))"
                            .to_string(),
                    );
                }
                Ok(MongoOp::EstimatedCount)
            }
            "distinct" => {
                let field = match args.first() {
                    Some(Bson::String(s)) => s.clone(),
                    Some(_) => return Err("distinct(\"字段名\") —— 字段名要加引号".to_string()),
                    None => return Err("distinct(\"字段名\") 要一个字段名".to_string()),
                };
                Ok(MongoOp::Distinct {
                    field,
                    filter: take_filter(1)?,
                })
            }
            "aggregate" => {
                let pipeline = match args.first() {
                    Some(Bson::Array(items)) => items
                        .iter()
                        .map(|item| match item {
                            Bson::Document(d) => Ok(d.clone()),
                            _ => Err("aggregate 的管道里每一项都要是对象，比如 {$match: {}}".to_string()),
                        })
                        .collect::<Result<Vec<Document>, String>>()?,
                    Some(_) => {
                        return Err(
                            "aggregate 要一个**数组**（管道阶段），比如 aggregate([{$group: {_id: \"$city\", n: {$sum: 1}}}])"
                                .to_string(),
                        )
                    }
                    None => return Err("aggregate([...]) 要一个管道数组".to_string()),
                };
                Ok(MongoOp::Aggregate { pipeline })
            }
            "insertOne" => Ok(MongoOp::InsertOne {
                document: take_filter(0).map_err(|_| "insertOne(文档) 要一个对象".to_string())?,
            }),
            "insertMany" => {
                let documents = match args.first() {
                    Some(Bson::Array(items)) if !items.is_empty() => items
                        .iter()
                        .map(|item| match item {
                            Bson::Document(d) => Ok(d.clone()),
                            _ => Err("insertMany 里每一项都要是对象".to_string()),
                        })
                        .collect::<Result<Vec<Document>, String>>()?,
                    Some(Bson::Array(_)) => return Err("insertMany([]) 是空数组 —— 没东西可插".to_string()),
                    _ => return Err("insertMany([文档, ...]) 要一个数组".to_string()),
                };
                Ok(MongoOp::InsertMany { documents })
            }
            "updateOne" | "updateMany" => Ok(MongoOp::Update {
                many: name == "updateMany",
                filter: take_filter(0)?,
                update: update_doc(&args, name)?,
                upsert: upsert_option(&args)?,
            }),
            "replaceOne" => Ok(MongoOp::Replace {
                many: false,
                filter: take_filter(0)?,
                replacement: update_doc(&args, name)?,
                upsert: upsert_option(&args)?,
            }),
            "deleteOne" | "deleteMany" => Ok(MongoOp::Delete {
                many: name == "deleteMany",
                filter: take_filter(0)?,
            }),
            // ⚠️ findOneAnd* 的第三个参数是**它自己那一套**（returnDocument /
            // projection / upsert），和 updateOne 那个只认 upsert 的选项不是一回事 ——
            // 早先这里复用了同一段校验，于是 `{returnDocument: "after"}` 会被
            // 「还不支持 returnDocument」拦下来（夹具里那条用例抓到的）
            "findOneAndUpdate" => {
                let options = opt_doc(2, "findOneAndUpdate 的选项")?;
                let (return_after, projection, upsert) = find_and_modify_options(options)?;
                Ok(MongoOp::FindOneAndUpdate {
                    filter: take_filter(0)?,
                    update: update_doc(&args, name)?,
                    upsert,
                    return_after,
                    projection,
                })
            }
            "findOneAndReplace" => {
                let options = opt_doc(2, "findOneAndReplace 的选项")?;
                let (return_after, projection, upsert) = find_and_modify_options(options)?;
                Ok(MongoOp::FindOneAndReplace {
                    filter: take_filter(0)?,
                    replacement: update_doc(&args, name)?,
                    upsert,
                    return_after,
                    projection,
                })
            }
            "findOneAndDelete" => Ok(MongoOp::FindOneAndDelete {
                filter: take_filter(0)?,
            }),
            "drop" => {
                if !args.is_empty() {
                    return Err("drop() 不带参数".to_string());
                }
                Ok(MongoOp::Drop)
            }
            "getIndexes" => Ok(MongoOp::GetIndexes),
            "createIndex" => {
                let keys = match args.first() {
                    Some(Bson::Document(d)) => d.clone(),
                    _ => {
                        return Err(
                            "createIndex({字段: 1}) 要一个对象，比如 createIndex({email: 1}, {unique: true})"
                                .to_string(),
                        )
                    }
                };
                let options = opt_doc(1, "createIndex 的选项")?;
                let (name, unique, sparse, expire) = index_options(options)?;
                Ok(MongoOp::CreateIndex {
                    keys,
                    name,
                    unique,
                    sparse,
                    expire_after_seconds: expire,
                })
            }
            "dropIndex" => {
                let name = match args.first() {
                    Some(Bson::String(s)) => s.clone(),
                    Some(Bson::Document(d)) => d
                        .iter()
                        .map(|(k, v)| format!("{}_{}", k, value_text(v)))
                        .collect::<Vec<_>>()
                        .join("_"),
                    _ => return Err("dropIndex(\"名字\") 要一个索引名".to_string()),
                };
                Ok(MongoOp::DropIndex { name })
            }
            other => Err(format!(
                "不支持的操作：{other}。能用的有：\n\
                 查：find / findOne / countDocuments / count / estimatedDocumentCount / distinct / aggregate\n\
                 写：insertOne / insertMany / updateOne / updateMany / replaceOne / deleteOne / deleteMany\n\
                    findOneAndUpdate / findOneAndReplace / findOneAndDelete\n\
                 集合：drop / createIndex / dropIndex / getIndexes"
            )),
        }
    }

    /// 游标链上的一个方法。
    fn apply_cursor_method(&self, method: &str, args: Vec<Bson>, op: &mut MongoOp) -> PResult<()> {
        let as_i64 = |index: usize, what: &str| -> PResult<i64> {
            match args.get(index) {
                Some(Bson::Int32(n)) => Ok(i64::from(*n)),
                Some(Bson::Int64(n)) => Ok(*n),
                Some(Bson::Double(n)) => Ok(*n as i64),
                _ => Err(format!("{what} 要一个整数")),
            }
        };

        match (&mut *op, method) {
            (MongoOp::Find { sort, .. }, "sort") | (MongoOp::FindOne { sort, .. }, "sort") => {
                *sort = Some(match args.first() {
                    Some(Bson::Document(d)) => d.clone(),
                    _ => return Err("sort({字段: 1 或 -1}) 要一个对象".to_string()),
                });
                Ok(())
            }
            (MongoOp::Find { limit, .. }, "limit") => {
                *limit = Some(as_i64(0, "limit(数字)")?);
                Ok(())
            }
            (MongoOp::Find { skip, .. }, "skip") | (MongoOp::FindOne { skip, .. }, "skip") => {
                *skip = Some(as_i64(0, "skip(数字)")?.max(0) as u64);
                Ok(())
            }
            (MongoOp::Find { projection, .. }, "project")
            | (MongoOp::Find { projection, .. }, "projection")
            | (MongoOp::FindOne { projection, .. }, "project") => {
                *projection = Some(match args.first() {
                    Some(Bson::Document(d)) => d.clone(),
                    _ => return Err("project({字段: 1}) 要一个对象".to_string()),
                });
                Ok(())
            }
            // `.count()`：老式的游标方法，mongosh 里仍然常见。
            // 它会把整条链的 filter 带过去 —— 这里只能近似（我们只保留 filter），
            // 所以**明说**，别让用户以为 sort/skip 也算进去了
            (MongoOp::Find { filter, .. }, "count") => {
                if !args.is_empty() {
                    return Err(".count() 不带参数（要条件就写在 find 里）".to_string());
                }
                *op = MongoOp::Count {
                    filter: filter.clone(),
                    skip: None,
                    limit: None,
                };
                Ok(())
            }
            // 我们本来就一次性取回来，`.toArray()` 是等价写法 —— 认了但什么都不做
            (_, "toArray") => Ok(()),
            (_, "explain") => Err(
                "explain() 还不支持（要看执行计划的话，等这个功能做出来）".to_string(),
            ),
            (_, other) => Err(format!(
                "`{other}()` 不能跟在这个操作后面。find/findOne 后面能跟的是：\
                 sort / limit / skip / project / count / toArray"
            )),
        }
    }

    /// 整段解析完了没有（多余的尾巴要说出来，别当没看见）。
    fn finish(&mut self) -> PResult<()> {
        self.skip_ws();
        // mongosh 里以分号结尾是常态
        if self.peek() == Some(';') {
            self.pos += 1;
            self.skip_ws();
        }
        match self.peek() {
            None => Ok(()),
            Some(c) => self.err(&format!("这里多出来一段看不懂的东西（`{c}` 起））")),
        }
    }
}

/// `countDocuments` / `count` 的选项：**只认 skip 和 limit**，别的键明说。
fn count_options(options: Option<Document>) -> Result<(Option<u64>, Option<i64>), String> {
    let Some(options) = options else {
        return Ok((None, None));
    };
    for key in options.keys() {
        if key != "skip" && key != "limit" {
            return Err(format!(
                "count 的选项里还不支持 `{key}`（现在只认 skip 和 limit）"
            ));
        }
    }
    Ok((as_u64(options.get("skip")), as_i64(options.get("limit"))))
}

/// `updateOne(filter, update, {upsert})` 的后两个参数。
/// 第二个参数：更新对象（`updateOne` 那一族）或者整个新文档（`replaceOne`）。
fn update_doc(args: &[Bson], op: &str) -> Result<Document, String> {
    match args.get(1) {
        Some(Bson::Document(d)) => Ok(d.clone()),
        Some(_) => Err(format!(
            "`{op}` 的第二个参数要是对象，比如 {{$set: {{name: \"李四\"}}}}"
        )),
        None => Err(format!(
            "`{op}` 要写改什么：{op}(filter, {{$set: {{...}}}})（要替换整个文档用 replaceOne）"
        )),
    }
}

/// `updateOne` / `updateMany` / `replaceOne` 的第三个参数：**只认 upsert**。
fn upsert_option(args: &[Bson]) -> Result<bool, String> {
    match args.get(2) {
        None => Ok(false),
        Some(Bson::Document(options)) => {
            for key in options.keys() {
                if key != "upsert" {
                    return Err(format!(
                        "更新选项里还不支持 `{key}`（现在只认 upsert）—— 「悄悄忽略」\
                         比报错更坏：你会以为它生效了"
                    ));
                }
            }
            Ok(matches!(options.get("upsert"), Some(Bson::Boolean(true))))
        }
        Some(_) => Err("第三个参数要是选项对象，比如 {upsert: true}".to_string()),
    }
}

/// `findOneAnd*` 的选项：认 `upsert` / `returnDocument` / `returnNew` / `projection`。
fn find_and_modify_options(
    options: Option<Document>,
) -> Result<(bool, Option<Document>, bool), String> {
    let Some(options) = options else {
        return Ok((false, None, false));
    };
    for key in options.keys() {
        if !matches!(
            key.as_str(),
            "upsert" | "returnDocument" | "returnNew" | "projection" | "fields"
        ) {
            return Err(format!(
                "findOneAnd* 的选项里还不支持 `{key}`（现在只认 upsert / returnDocument \
                 / returnNew / projection）"
            ));
        }
    }
    let return_after = match options.get("returnDocument") {
        Some(Bson::String(s)) => s.eq_ignore_ascii_case("after"),
        _ => matches!(options.get("returnNew"), Some(Bson::Boolean(true))),
    };
    let projection = options
        .get("projection")
        .or_else(|| options.get("fields"))
        .and_then(|v| match v {
            Bson::Document(d) => Some(d.clone()),
            _ => None,
        });
    let upsert = matches!(options.get("upsert"), Some(Bson::Boolean(true)));
    Ok((return_after, projection, upsert))
}

/// `createIndex` 的选项：只认这四个（别的键明说，理由同 [`update_args`]）。
fn index_options(
    options: Option<Document>,
) -> Result<(Option<String>, bool, bool, Option<i32>), String> {
    let Some(options) = options else {
        return Ok((None, false, false, None));
    };
    for key in options.keys() {
        if !matches!(
            key.as_str(),
            "name" | "unique" | "sparse" | "expireAfterSeconds"
        ) {
            return Err(format!(
                "createIndex 的选项里还不支持 `{key}`（现在只认 name / unique / sparse \
                 / expireAfterSeconds）"
            ));
        }
    }
    Ok((
        options.get("name").and_then(|v| match v {
            Bson::String(s) => Some(s.clone()),
            _ => None,
        }),
        matches!(options.get("unique"), Some(Bson::Boolean(true))),
        matches!(options.get("sparse"), Some(Bson::Boolean(true))),
        options.get("expireAfterSeconds").and_then(as_i32),
    ))
}

fn as_i64(value: Option<&Bson>) -> Option<i64> {
    match value {
        Some(Bson::Int32(n)) => Some(i64::from(*n)),
        Some(Bson::Int64(n)) => Some(*n),
        Some(Bson::Double(n)) => Some(*n as i64),
        _ => None,
    }
}

fn as_i32(value: &Bson) -> Option<i32> {
    as_i64(Some(value)).and_then(|n| i32::try_from(n).ok())
}

fn as_u64(value: Option<&Bson>) -> Option<u64> {
    as_i64(value).filter(|n| *n >= 0).map(|n| n as u64)
}

/// 索引名/`dropIndex({a: 1})` 那种写法里，值怎么变名字（`a_1`）。
fn value_text(value: &Bson) -> String {
    match value {
        Bson::Int32(n) => n.to_string(),
        Bson::Int64(n) => n.to_string(),
        Bson::Double(n) => n.to_string(),
        Bson::String(s) => s.clone(),
        other => format!("{other}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn parse(text: &str) -> MongoCommand {
        parse_command(text, Some("默认库")).expect("应当解析成功")
    }

    fn err(text: &str) -> String {
        parse_command(text, Some("默认库")).expect_err("应当报错")
    }

    // ---------------------------------------------------------- 语法

    #[test]
    fn 最小的查询() {
        let command = parse("db.users.find({})");
        assert_eq!(command.collection.as_deref(), Some("users"));
        assert_eq!(command.database.as_deref(), Some("默认库"), "库取连接上的那个");
        assert_eq!(
            command.op,
            MongoOp::Find {
                filter: Document::new(),
                projection: None,
                sort: None,
                limit: None,
                skip: None,
            }
        );
    }

    #[test]
    fn filter_和_projection_两个位置参数() {
        let command = parse(r#"db.users.find({ age: { "$gt": 18 } }, { name: 1 })"#);
        match command.op {
            MongoOp::Find {
                filter, projection, ..
            } => {
                assert_eq!(filter.get_i32("age").ok(), None, "age 的值是对象");
                assert!(filter.contains_key("age"));
                // projection 是第二个参数（mongosh 的位置约定）
                assert_eq!(projection.and_then(|p| p.get_i32("name").ok()), Some(1));
            }
            other => panic!("应当是 find：{other:?}"),
        }
    }

    #[test]
    fn 游标链按写的顺序生效() {
        let command = parse("db.users.find({}).sort({ age: -1 }).limit(10).skip(5)");
        match command.op {
            MongoOp::Find {
                sort, limit, skip, ..
            } => {
                assert_eq!(sort.and_then(|s| s.get_i32("age").ok()), Some(-1));
                assert_eq!(limit, Some(10));
                assert_eq!(skip, Some(5));
            }
            other => panic!("应当是 find：{other:?}"),
        }
    }

    #[test]
    fn 老式的_count_游标方法也认() {
        let command = parse("db.users.find({ city: \"北京\" }).count()");
        match command.op {
            MongoOp::Count { filter, .. } => assert!(filter.contains_key("city")),
            other => panic!("应当是 count：{other:?}"),
        }
    }

    #[test]
    fn toArray_认但什么都不做() {
        // 我们本来就一次性取回来，`.toArray()` 在 mongosh 里是显式取数组的写法
        assert!(matches!(parse("db.users.find({}).toArray()").op, MongoOp::Find { .. }));
    }

    #[test]
    fn 集合名有三种写法() {
        assert_eq!(parse("db.users.find({})").collection.as_deref(), Some("users"));
        assert_eq!(
            parse(r#"db["my-col"].find({})"#).collection.as_deref(),
            Some("my-col")
        );
        // ⚠️ 真实集合名里常有 `-` 和 `.`，而它们在 JS 里不是标识符 —— mongosh
        // 自己也要求走 getCollection
        assert_eq!(
            parse(r#"db.getCollection("logs-2026.10").find({})"#)
                .collection
                .as_deref(),
            Some("logs-2026.10")
        );
    }

    #[test]
    fn 字符串_转义_和两种引号() {
        let command = parse(r#"db.t.find({ a: '单引号', b: "双引号", c: "换行\n制表\t结束" })"#);
        match command.op {
            MongoOp::Find { filter, .. } => {
                assert_eq!(filter.get_str("a").unwrap(), "单引号");
                assert_eq!(filter.get_str("b").unwrap(), "双引号");
                assert_eq!(filter.get_str("c").unwrap(), "换行\n制表\t结束");
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn 嵌套_数组_尾随逗号_多行() {
        let command = parse(
            "db.t.find({\n  a: { b: [1, 2, { c: 3 },], },\n  d: \"x\",\n})",
        );
        match command.op {
            MongoOp::Find { filter, .. } => {
                assert!(filter.contains_key("a"));
                assert!(filter.contains_key("d"));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn 数字按大小落成_int32_int64_或_double() {
        let command = parse("db.t.find({ a: 18, b: 3000000000, c: 1.5, d: -2 })");
        match command.op {
            MongoOp::Find { filter, .. } => {
                assert_eq!(filter.get("a"), Some(&Bson::Int32(18)));
                // 超过 i32 的整数落 Int64（不是 double —— 那会在大整数上丢精度）
                assert_eq!(filter.get("b"), Some(&Bson::Int64(3_000_000_000)));
                assert_eq!(filter.get("c"), Some(&Bson::Double(1.5)));
                assert_eq!(filter.get("d"), Some(&Bson::Int32(-2)));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn 布尔_和_null() {
        match parse("db.t.find({ ok: true, no: false, gone: null })").op {
            MongoOp::Find { filter, .. } => {
                assert_eq!(filter.get("ok"), Some(&Bson::Boolean(true)));
                assert_eq!(filter.get("no"), Some(&Bson::Boolean(false)));
                assert_eq!(filter.get("gone"), Some(&Bson::Null));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn 分号_注释_换行都不碍事() {
        let command = parse("// 查一下用户\n db.users.find({}) ; \n");
        assert_eq!(command.collection.as_deref(), Some("users"));
    }

    // ---------------------------------------------------------- 错误信息

    #[test]
    fn 空查询说清楚要写什么() {
        assert!(err("   ").contains("db.users.find"));
    }

    #[test]
    fn 认不出的操作会把支持的列出来() {
        let message = err("db.users.finds({})");
        assert!(message.contains("finds"), "{message}");
        assert!(message.contains("findOne"), "要列出支持的：{message}");
        assert!(message.contains("aggregate"), "{message}");
    }

    #[test]
    fn 括号少一个会指出在哪儿断的() {
        let message = err("db.users.find({ a: 1 ");
        assert!(message.contains("}") || message.contains("结束"), "{message}");
    }

    #[test]
    fn 裸名字当值时要提示加引号() {
        // `{name: 张三}` 是最常见的一种手误
        let message = err("db.users.find({ name: 张三 })");
        assert!(message.contains("引号"), "{message}");
        assert!(message.contains("张三"), "要点出是哪个词：{message}");
    }

    #[test]
    fn filter_给了字符串要说清该给对象() {
        assert!(err(r#"db.users.find("name")"#).contains("对象"));
    }

    #[test]
    fn aggregate_要数组_要的不是对象() {
        assert!(err("db.users.aggregate({ $match: {} })").contains("数组"));
    }

    #[test]
    fn distinct_要字段名() {
        assert!(err("db.users.distinct()").contains("字段名"));
        assert!(err("db.users.distinct({ a: 1 })").contains("引号"));
    }

    #[test]
    fn 不支持的选项要明说_不能悄悄忽略() {
        // ⚠️ 悄悄忽略比报错坏得多：用户会以为它生效了
        assert!(err("db.users.countDocuments({}, { hint: \"x\" })").contains("hint"));
        assert!(err("db.users.updateOne({}, { $set: {} }, { hint: \"x\" })").contains("hint"));
        assert!(err("db.users.createIndex({ a: 1 }, { collation: {} })").contains("collation"));
    }

    #[test]
    fn explain_还不支持_而且说清楚() {
        assert!(err("db.users.find({}).explain()").contains("explain"));
    }

    #[test]
    fn 库级那几个认不出的操作会指向侧栏() {
        let message = err("db.getCollectionNames()");
        assert!(message.contains("还不支持"), "{message}");
        assert!(message.contains("树"), "要告诉用户去哪儿看：{message}");
    }

    #[test]
    fn 多余的内容不会被当没看见() {
        assert!(err("db.users.find({}) db.users.find({})").contains("多出来"));
    }

    // ---------------------------------------------------------- 老 JSON 形式

    #[test]
    fn 老_json_形式照样能解析() {
        let command = parse(r#"{"collection":"users","filter":{"a":1},"limit":20}"#);
        assert_eq!(command.collection.as_deref(), Some("users"));
        match command.op {
            MongoOp::Find { filter, limit, .. } => {
                assert_eq!(filter.get_i32("a").ok(), Some(1));
                assert_eq!(limit, Some(20));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn 老_json_形式里的_database_能覆盖默认库() {
        let command = parse(r#"{"collection":"users","database":"别的库"}"#);
        assert_eq!(command.database.as_deref(), Some("别的库"));
    }

    #[test]
    fn 两种都不是的时候_把两种写法都提一遍() {
        let message = err("{这不是 JSON");
        assert!(message.contains("db.users.find"), "{message}");
    }

    // ---------------------------------------------------------- 共享夹具

    /// 把解析结果压成一段**可比较的** JSON（只写非默认的字段）。
    fn summary(command: &MongoCommand) -> serde_json::Value {
        let mut out = serde_json::Map::new();
        if let Some(collection) = &command.collection {
            out.insert("collection".into(), json!(collection));
        }
        let value = |v: &Bson| crate::mongo::humanize(v);
        let doc = |d: &Document| value(&Bson::Document(d.clone()));
        let opt_doc = |d: &Option<Document>| d.as_ref().map(doc);

        let op = match &command.op {
            MongoOp::Find {
                filter,
                projection,
                sort,
                limit,
                skip,
            } => {
                if !filter.is_empty() {
                    out.insert("filter".into(), doc(filter));
                }
                if let Some(v) = opt_doc(projection) {
                    out.insert("projection".into(), v);
                }
                if let Some(v) = opt_doc(sort) {
                    out.insert("sort".into(), v);
                }
                if let Some(v) = limit {
                    out.insert("limit".into(), json!(v));
                }
                if let Some(v) = skip {
                    out.insert("skip".into(), json!(v));
                }
                "find"
            }
            MongoOp::FindOne {
                filter,
                projection,
                sort,
                skip,
            } => {
                if !filter.is_empty() {
                    out.insert("filter".into(), doc(filter));
                }
                if let Some(v) = opt_doc(projection) {
                    out.insert("projection".into(), v);
                }
                if let Some(v) = opt_doc(sort) {
                    out.insert("sort".into(), v);
                }
                if let Some(v) = skip {
                    out.insert("skip".into(), json!(v));
                }
                "findOne"
            }
            MongoOp::Count {
                filter,
                skip,
                limit,
            } => {
                if !filter.is_empty() {
                    out.insert("filter".into(), doc(filter));
                }
                if let Some(v) = skip {
                    out.insert("skip".into(), json!(v));
                }
                if let Some(v) = limit {
                    out.insert("limit".into(), json!(v));
                }
                "count"
            }
            MongoOp::EstimatedCount => "estimatedDocumentCount",
            MongoOp::Distinct { field, filter } => {
                out.insert("field".into(), json!(field));
                if !filter.is_empty() {
                    out.insert("filter".into(), doc(filter));
                }
                "distinct"
            }
            MongoOp::Aggregate { pipeline } => {
                out.insert(
                    "pipeline".into(),
                    json!(pipeline.iter().map(doc).collect::<Vec<_>>()),
                );
                "aggregate"
            }
            MongoOp::InsertOne { document } => {
                out.insert("document".into(), doc(document));
                "insertOne"
            }
            MongoOp::InsertMany { documents } => {
                out.insert(
                    "documents".into(),
                    json!(documents.iter().map(doc).collect::<Vec<_>>()),
                );
                "insertMany"
            }
            MongoOp::Update {
                many,
                filter,
                update,
                upsert,
            } => {
                out.insert("filter".into(), doc(filter));
                out.insert("update".into(), doc(update));
                out.insert("many".into(), json!(many));
                if *upsert {
                    out.insert("upsert".into(), json!(true));
                }
                "update"
            }
            MongoOp::Replace {
                filter,
                replacement,
                upsert,
                ..
            } => {
                out.insert("filter".into(), doc(filter));
                out.insert("replacement".into(), doc(replacement));
                if *upsert {
                    out.insert("upsert".into(), json!(true));
                }
                "replace"
            }
            MongoOp::Delete { many, filter } => {
                out.insert("filter".into(), doc(filter));
                out.insert("many".into(), json!(many));
                "delete"
            }
            MongoOp::FindOneAndUpdate {
                filter,
                update,
                upsert,
                return_after,
                ..
            } => {
                out.insert("filter".into(), doc(filter));
                out.insert("update".into(), doc(update));
                if *upsert {
                    out.insert("upsert".into(), json!(true));
                }
                if *return_after {
                    out.insert("returnAfter".into(), json!(true));
                }
                "findOneAndUpdate"
            }
            MongoOp::FindOneAndReplace {
                filter,
                replacement,
                return_after,
                ..
            } => {
                out.insert("filter".into(), doc(filter));
                out.insert("replacement".into(), doc(replacement));
                if *return_after {
                    out.insert("returnAfter".into(), json!(true));
                }
                "findOneAndReplace"
            }
            MongoOp::FindOneAndDelete { filter } => {
                out.insert("filter".into(), doc(filter));
                "findOneAndDelete"
            }
            MongoOp::Drop => "drop",
            MongoOp::CreateIndex {
                keys,
                name,
                unique,
                sparse,
                expire_after_seconds,
            } => {
                out.insert("keys".into(), doc(keys));
                if let Some(v) = name {
                    out.insert("name".into(), json!(v));
                }
                if *unique {
                    out.insert("unique".into(), json!(true));
                }
                if *sparse {
                    out.insert("sparse".into(), json!(true));
                }
                if let Some(v) = expire_after_seconds {
                    out.insert("expireAfterSeconds".into(), json!(v));
                }
                "createIndex"
            }
            MongoOp::DropIndex { name } => {
                out.insert("name".into(), json!(name));
                "dropIndex"
            }
            MongoOp::GetIndexes => "getIndexes",
            MongoOp::CreateCollection { name } => {
                out.insert("name".into(), json!(name));
                "createCollection"
            }
            MongoOp::DropDatabase => "dropDatabase",
        };
        out.insert("op".into(), json!(op));
        serde_json::Value::Object(out)
    }

    /// ⚠️ **共享夹具**：同一批例子，浏览器版那个假解析器（`fakeSql.ts`，Playwright
    /// 唯一能驱动的那条路）也拿它跑一遍。语法被实现了两遍，**两遍就会漂移** ——
    /// 而漂移的症状是「e2e 绿的、真机上打不开」。
    #[test]
    fn 契约用例和共享夹具一致() {
        let raw = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tests/fixtures/mongo-queries.json"
        ))
        .expect("读不到共享夹具 tests/fixtures/mongo-queries.json");
        let fixture: serde_json::Value = serde_json::from_str(&raw).expect("夹具不是合法 JSON");
        let cases = fixture["cases"].as_array().expect("夹具里要有 cases");

        for case in cases {
            let query = case["query"].as_str().expect("用例要有 query");
            let command = parse_command(query, Some("默认库"))
                .unwrap_or_else(|e| panic!("`{query}` 解析失败：{e}"));

            let mut expected = case.clone();
            if let Some(object) = expected.as_object_mut() {
                object.remove("query");
            }
            assert_eq!(
                summary(&command),
                expected,
                "`{query}` 的解析结果和夹具对不上"
            );
        }
    }
}
