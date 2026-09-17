//! 查询结果的形状。
//!
//! # 一条刻意的取舍：值一律按文本传
//!
//! **所有单元格都转成文本再给前端**，而不是保留原始类型做完整映射。
//!
//! 原因是完整类型映射是个无底洞：两种引擎加起来几百个类型，日期/时间/时区/
//! 数值精度/数组/枚举/JSON 各有各的规矩，而它们**只在展示上有区别**。
//! 查询台要的是「看得见、能复制」，文本就是这个需求的正解。
//!
//! 代价说清楚，将来要改的话从这里改起：
//!
//! * 数值不再能按数值排序（现在按字符串排）
//! * 二进制列会显示成乱码（用 `binary` 标出来，前端至少可以提示）
//! * 精度可能被服务端的文本形式决定（比如 `numeric` 的小数位数）
//!
//! 真要做得更好，做法是在 Rust 侧留一份类型信息、前端按类型做格式化 ——
//! 那是另一个量级的工程，等真有人在查询台里看大数值再说不迟。

use serde::Serialize;

/// 一列的名字和类型。类型名直接给引擎自己的写法（`int4` / `BIGINT`），不翻译
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ColumnInfo {
    pub name: String,
    #[serde(rename = "typeName")]
    pub type_name: String,
}

/// 一个单元格。`text` 为 `None` 表示 SQL 的 NULL —— 和空字符串是两回事
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Cell {
    pub text: Option<String>,
    /// 内容不是合法 UTF-8（真二进制列）。`text` 是 lossy 的结果
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub binary: bool,
}

impl Cell {
    pub fn null() -> Cell {
        Cell { text: None, binary: false }
    }

    /// 从字节造一个单元格：能按 UTF-8 解码就正常给文本，否则标记成二进制
    pub fn from_bytes(bytes: Vec<u8>) -> Cell {
        match String::from_utf8(bytes) {
            Ok(text) => Cell { text: Some(text), binary: false },
            Err(e) => {
                let bytes = e.into_bytes();
                Cell {
                    text: Some(String::from_utf8_lossy(&bytes).into_owned()),
                    binary: true,
                }
            }
        }
    }
}

/// 一次执行的结果。
///
/// `error` 有值时表示**引擎拒绝了这条 SQL**（表不存在、语法错、权限不够）——
/// 那是一次成功的往返，只是没成功执行。前端把它当结果展示，不是当连接故障。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct QueryResult {
    pub columns: Vec<ColumnInfo>,
    pub rows: Vec<Vec<Cell>>,
    /// 非 SELECT 语句的影响行数（`UPDATE`/`DELETE`/`INSERT`）
    pub affected: Option<u64>,
    /// 行数超过上限被截断了
    pub truncated: bool,
    /// 往返耗时（毫秒）
    #[serde(rename = "elapsedMs")]
    pub elapsed_ms: u64,
    /// 引擎报的错。有它的时候前面几项都是空的
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl QueryResult {
    pub fn failure(message: String, elapsed_ms: u64) -> QueryResult {
        QueryResult {
            columns: Vec::new(),
            rows: Vec::new(),
            affected: None,
            truncated: false,
            elapsed_ms,
            error: Some(message),
        }
    }
}

/// 一次最多取多少行。
///
/// 一个 `SELECT * FROM 大表` 能把内存和界面一起打爆。超出的部分不取，
/// 并在结果里标出来 —— 用户知道被截断了，可以自己加 `LIMIT`。
pub const MAX_ROWS: usize = 1000;

/// 判断一条引擎错误是不是「连接坏了」而不是「这条 SQL 不对」。
///
/// 两种驱动的错误分类完全不同，所以判定要各写各的 —— 但**形状**是一样的：
/// 坏了的连接要从注册表里摘掉，否则界面会一直显示「已连接」而每条查询都失败。
pub fn looks_like_transport(reason: &str) -> bool {
    let lower = reason.to_lowercase();
    const MARKERS: &[&str] = &[
        "connection closed",
        "connection reset",
        "broken pipe",
        "server closed the connection",
        "unexpected eof",
        "connection refused",
        "timed out",
        "timeout",
        "no route to host",
        "network is unreachable",
        "gone away",
        "lost connection",
    ];
    MARKERS.iter().any(|marker| lower.contains(marker))
}

/// 把一个驱动的错误转成给用户看的文案。
///
/// 驱动自己的 `Display` 通常是英文 + 一长串内部细节，直接甩给用户不合适；
/// 但**引擎的原话要保留**（表名、列名、出错位置都在里面），所以不翻译，只裁剪。
pub fn describe(reason: &str) -> String {
    let trimmed = reason.trim();
    if trimmed.len() <= 400 {
        return trimmed.to_string();
    }
    // 超长的错误（tokio-postgres 有时会附一整段源码片段）只留开头
    format!("{}…", &trimmed[..trimmed.char_indices().take(400).last().map(|(i, c)| i + c.len_utf8()).unwrap_or(400)])
}

/// 把「行数超上限」的判断收在一处，方便测
pub fn is_truncated(row_count: usize) -> bool {
    row_count >= MAX_ROWS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn null_and_empty_string_are_different_cells() {
        assert_eq!(Cell::null().text, None);
        assert_eq!(Cell::from_bytes(Vec::new()).text, Some(String::new()));
    }

    #[test]
    fn non_utf8_bytes_are_flagged_but_still_shown() {
        let cell = Cell::from_bytes(vec![0xff, 0xfe, b'a']);
        assert!(cell.binary);
        assert!(cell.text.unwrap().contains('a'), "能认出来的部分还是要给出");
    }

    #[test]
    fn utf8_bytes_are_not_flagged() {
        let cell = Cell::from_bytes("张三".as_bytes().to_vec());
        assert!(!cell.binary);
        assert_eq!(cell.text.as_deref(), Some("张三"));
    }

    /// 这条盯着最容易做错的地方：**引擎报错不是连接故障**。
    /// 判反了的话，写错一个表名就会把连接显示成断开。
    #[test]
    fn sql_errors_are_not_mistaken_for_transport_failures() {
        for message in [
            "relation \"nope\" does not exist",
            "syntax error at or near \"SELEC\"",
            "Table 'test.nope' doesn't exist",
            "permission denied for table users",
            "duplicate key value violates unique constraint",
        ] {
            assert!(
                !looks_like_transport(message),
                "这条 SQL 错误被误判成了连接故障：{message}"
            );
        }
    }

    #[test]
    fn real_transport_failures_are_recognised() {
        for message in [
            "connection closed",
            "server closed the connection unexpectedly",
            "Broken pipe (os error 32)",
            "connection refused",
            "connection timed out",
            "MySQL server has gone away",
            "Lost connection to MySQL server during query",
        ] {
            assert!(
                looks_like_transport(message),
                "这条连接故障没被认出来：{message}"
            );
        }
    }

    #[test]
    fn long_messages_are_trimmed_but_short_ones_kept_whole() {
        assert_eq!(describe("语法错"), "语法错");
        let long = "x".repeat(1000);
        let trimmed = describe(&long);
        assert!(trimmed.ends_with('…'));
        assert!(trimmed.len() < 1000);
    }

    #[test]
    fn failure_carries_the_message_and_nothing_else() {
        let result = QueryResult::failure("表不存在".to_string(), 12);
        assert_eq!(result.error.as_deref(), Some("表不存在"));
        assert!(result.columns.is_empty());
        assert!(result.rows.is_empty());
        assert_eq!(result.affected, None);
        assert_eq!(result.elapsed_ms, 12);
    }
}
