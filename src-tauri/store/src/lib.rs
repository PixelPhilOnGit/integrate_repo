//! Devtoolkit 的键值存储：**一个 SQLite 文件**，替掉原来「每个模块一个 JSON 文件」。
//!
//! # 它是什么、不是什么
//!
//! **是**：`get(key)` / `set(key, value)` 两个动作，加上「第一次打开时把老 JSON
//! 导进来」那一次搬迁。值一律是**原样的 JSON 文本** —— 这一层不认识任何模块的
//! 结构，那是模块自己的事（各模块仍然自己校验、自己容错）。
//!
//! **不是**：把连接档案拆成一张张表的那个重构。那件事的价值（按种类分组、搜索、
//! 和别的表联查）在这一步之后才好做 —— 先换底、接口不动，重构留到下一步。
//!
//! # 为什么换（用户的原话：「这些渐渐转到 sqlite 中去吧」）
//!
//! 「一个 JSON 整体读写」对档案那种东西是够的，但每加一个查询维度
//! （按种类筛、搜索、排序）就得在内存里重写一遍，而且**两个窗口同时写会丢数据**
//! （各自读一份、改一处、整体覆盖）。SQLite 单文件、无服务端、有事务，
//! 桌面应用该用的就是它。
//!
//! # ⚠️ 数据安全：这些 JSON 里装的是用户的真实数据
//!
//! 连接档案、主机指纹、工作目录 —— **一条都不能丢**。所以搬迁的规矩是：
//!
//! 1. **先写库、后动文件**：数据进了库（事务提交）才把老文件改名成 `.bak`；
//! 2. **任何一步失败都不动老文件**，并把错误交出去 —— 调用方据此**退回老的
//!    JSON 实现**，这次会话照常用老数据；
//! 3. **老文件只改名、不删**：用户自己去看得见，出事了也能手动捞回来。
//!
//! 幂等：库里记一个 `__imported__` 标记，导过就不再导。

use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};

mod error;

pub use error::StoreError;

/// 系统钥匙串：连接密码的归宿。
///
/// ⚠️ 它和这个 crate 的键值表**是两套东西**，别混：键值表里存的是**能公开的**
/// 那些字段（主机、端口、用户名……），密码单独走钥匙串。理由和两条边界见模块文档。
pub mod secrets;

/// 结构版本。加表/加列时 +1 并在 [`migrate`] 里补一段。
const SCHEMA_VERSION: i64 = 1;

/// 搬迁标记的后缀。`<模块>:__imported__` 有值就表示这个模块的老文件处理过了。
const IMPORT_MARKER: &str = "__imported__";

pub struct Store {
    conn: Connection,
}

impl Store {
    /// 开库（不存在就建）。
    pub fn open(path: &Path) -> Result<Self, StoreError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| StoreError::Open {
                path: parent.display().to_string(),
                reason: e.to_string(),
            })?;
        }
        let conn = Connection::open(path).map_err(|e| StoreError::Open {
            path: path.display().to_string(),
            reason: e.to_string(),
        })?;

        // 崩溃/断电时不丢已提交的事务
        conn.execute_batch("PRAGMA journal_mode = WAL;")?;
        migrate(&conn)?;
        Ok(Store { conn })
    }

    /// 读一个值（原样的 JSON 文本）。没有就是 `None`。
    pub fn get(&self, module: &str, key: &str) -> Result<Option<String>, StoreError> {
        let full = format!("{module}:{key}");
        let value = self
            .conn
            .query_row("SELECT v FROM kv WHERE k = ?1", params![full], |row| {
                row.get::<_, String>(0)
            })
            .optional()?;
        Ok(value)
    }

    /// 写一个值（覆盖）。
    pub fn set(&self, module: &str, key: &str, value: &str) -> Result<(), StoreError> {
        let full = format!("{module}:{key}");
        self.conn.execute(
            "INSERT INTO kv (k, v, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at",
            params![full, value, now_ms()],
        )?;
        Ok(())
    }

    /// 第一次打开某个模块时，把它的老 JSON 文件搬进库。
    ///
    /// 幂等；已经搬过（或者压根没有老文件）就直接返回。**失败时什么都不动** ——
    /// 见模块头部那段「数据安全」。
    pub fn import_legacy_json(&self, dir: &Path, module: &str) -> Result<(), StoreError> {
        if self.get(module, IMPORT_MARKER)?.is_some() {
            return Ok(());
        }

        let file = dir.join(format!("{module}.json"));
        if !file.is_file() {
            // 没有老文件：记个标记，免得每次启动都 stat 一遍
            return self.set(module, IMPORT_MARKER, "\"none\"");
        }

        // ⚠️ 读/解析失败**原样返回错误**（不动文件）—— 调用方要退回老实现
        let text = std::fs::read_to_string(&file).map_err(|e| StoreError::Import {
            path: file.display().to_string(),
            reason: format!("读不了：{e}"),
        })?;
        // ⚠️ 用 `RawValue` 而不是 `Value`：前者把每个值的**原文**原样留着，
        // 后者会（a）重排对象的键、（b）重排数字的写法 —— 搬迁不该改用户的数据，
        // 哪怕只是写法。
        // 用 std 的 BTreeMap（键会排一下序，无所谓 —— 每个键是库里的**一行**，
        // 行之间没有顺序可言）；值那一边仍然是 RawValue，原样不动
        let map: std::collections::BTreeMap<String, Box<serde_json::value::RawValue>> =
            serde_json::from_str(&text).map_err(|e| StoreError::Import {
                path: file.display().to_string(),
                reason: format!("不是合法的 JSON 对象（老格式应该是一张键值表）：{e}"),
            })?;

        // 一个事务里写：要么全进、要么全不进 —— 半截导入比不导入更难收拾
        let tx = self.conn.unchecked_transaction()?;
        for (key, value) in map {
            tx.execute(
                // 库里已经有这个 key 就不覆盖：可能是新库里先写进去的（用户已经用过新版本）
                "INSERT OR IGNORE INTO kv (k, v, updated_at) VALUES (?1, ?2, ?3)",
                params![format!("{module}:{key}"), value.get(), now_ms()],
            )?;
        }
        // 标记**放在同一个事务里**：崩在中间不会留下「导了一半、下次又不导」的状态
        tx.execute(
            "INSERT OR REPLACE INTO kv (k, v, updated_at) VALUES (?1, ?2, ?3)",
            params![
                format!("{module}:{IMPORT_MARKER}"),
                format!("\"{}:imported\"", file.display()),
                now_ms()
            ],
        )?;
        tx.commit()?;

        // ⚠️ 改名放在**最后**，而且失败也不算错：数据已经在库里了，
        // 老文件留在原地最多是多占一点磁盘（标记已经写了，不会再导一遍）
        let backup = file.with_extension("json.bak");
        let _ = std::fs::rename(&file, &backup);
        Ok(())
    }
}

fn migrate(conn: &Connection) -> Result<(), StoreError> {
    let current: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if current == SCHEMA_VERSION {
        return Ok(());
    }
    if current > SCHEMA_VERSION {
        return Err(StoreError::Migrate {
            reason: format!("这个库是更新的版本建的（结构版本 {current}，本程序只认 {SCHEMA_VERSION}）"),
        });
    }

    let tx = conn.unchecked_transaction()?;
    if current < 1 {
        tx.execute_batch(
            "CREATE TABLE kv (
                 k          TEXT PRIMARY KEY,
                 v          TEXT NOT NULL,
                 updated_at INTEGER NOT NULL
             );",
        )?;
    }
    tx.execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION};"))?;
    tx.commit()?;
    Ok(())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
