//! 浏览式界面需要的类型，以及它们的解析。
//!
//! 解析全部写成**纯函数**（`parse_keyspace` / `merge_keyspace`），
//! 这样不用起 Redis 就能把各种边界穷举测一遍 —— 真服务器不方便造出的形状
//! （`CONFIG` 被禁用、空库、库号不连续……）在这里都能直接构造。
//!
//! # 关于二进制的 key 名
//!
//! Redis 的 key 是**二进制安全**的，可以是任意字节。JSON 装不下任意字节，
//! 所以 `KeyMeta` 里给两份：
//!
//! * `key` —— lossy 解码后的可读形式，只用来**显示**
//! * `key_bytes` —— 原始字节，**只在不是合法 UTF-8 时才带**（省得每个 key 都带一份）
//!
//! 前端拿 `key_bytes ?? TextEncoder().encode(key)` 去查详情，这样多怪的字节
//! 都能精确地查回来。只传 lossy 字符串的话，二进制 key 点开就会「不存在」。

use serde::Serialize;

use crate::reply::Reply;

/// 一个库的概况
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DbInfo {
    pub db: i64,
    /// 这个库里的 key 数
    pub keys: u64,
}

/// key 列表里的一项
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct KeyMeta {
    /// 展示用的名字（二进制 key 是 lossy 解码的结果）
    pub key: String,
    /// 原始字节。**只在 `key` 不是合法 UTF-8 时才出现**
    #[serde(rename = "keyBytes", skip_serializing_if = "Option::is_none")]
    pub key_bytes: Option<Vec<u8>>,
    /// string / list / hash / set / zset / stream / none
    #[serde(rename = "keyType")]
    pub key_type: String,
}

/// 一页 SCAN 的结果
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ScanPage {
    /// 下一页的游标；0 表示翻完了
    pub cursor: u64,
    pub keys: Vec<KeyMeta>,
}

/// 一个 key 的详情
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct KeyDetail {
    pub key: String,
    #[serde(rename = "keyBytes", skip_serializing_if = "Option::is_none")]
    pub key_bytes: Option<Vec<u8>>,
    #[serde(rename = "keyType")]
    pub key_type: String,
    /// TTL 秒数：`-1` 永不过期，`-2` 键不存在
    pub ttl: i64,
    /// 容器里的元素总数；string 是 None，键不存在也是 None
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    /// 值本身。大容器只取了前若干项
    pub value: Reply,
    /// 值是否被截断（容器元素超过上限时为真）
    pub truncated: bool,
}

/// 解析 `INFO keyspace` 的正文，返回 `(库号, key 数)`，按库号升序。
///
/// 正文长这样：
///
/// ```text
/// # Keyspace
/// db0:keys=12,expires=3,avg_ttl=0
/// db3:keys=1,expires=0,avg_ttl=0
/// ```
///
/// **只有有 key 的库会出现** —— 空库在这里是查不到的，得靠 `CONFIG GET databases`
/// 补上（见 `merge_keyspace`）。
pub fn parse_keyspace(info: &str) -> Vec<(i64, u64)> {
    let mut found = Vec::new();

    for line in info.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix("db") else {
            continue;
        };
        let Some((number, fields)) = rest.split_once(':') else {
            continue;
        };
        let Ok(db) = number.trim().parse::<i64>() else {
            continue;
        };

        let keys = fields
            .split(',')
            .find_map(|field| field.trim().strip_prefix("keys="))
            .and_then(|value| value.trim().parse::<u64>().ok())
            .unwrap_or(0);

        found.push((db, keys));
    }

    found.sort_by_key(|(db, _)| *db);
    found
}

/// 把「配置里声明了几个库」和「INFO 里各库的 key 数」合成一份完整列表。
///
/// `total` 来自 `CONFIG GET databases`，**可能拿不到**（`CONFIG` 被禁用或改名）。
/// 那种情况下退化成「INFO 里出现过的库 + 至少一个」—— 宁可少列几个空库，
/// 也不能因为一个可选命令失败就什么都显示不出来。
pub fn merge_keyspace(total: Option<i64>, found: &[(i64, u64)]) -> Vec<DbInfo> {
    let highest_seen = found.iter().map(|(db, _)| db + 1).max().unwrap_or(0);
    let count = total.unwrap_or(0).max(highest_seen).max(1);

    (0..count)
        .map(|db| DbInfo {
            db,
            keys: found
                .iter()
                .find(|(found_db, _)| *found_db == db)
                .map(|(_, keys)| *keys)
                .unwrap_or(0),
        })
        .collect()
}

/// 从 Redis 的回复里取一份文本（bulk 或 status 都认）。
pub fn as_text(value: &redis::Value) -> Option<String> {
    match value {
        redis::Value::BulkString(bytes) => Some(String::from_utf8_lossy(bytes).into_owned()),
        redis::Value::SimpleString(text) | redis::Value::VerbatimString { text, .. } => {
            Some(text.clone())
        }
        _ => None,
    }
}

/// 从 Redis 的回复里取一份原始字节（只看 bulk）。
pub fn as_bytes(value: &redis::Value) -> Option<Vec<u8>> {
    match value {
        redis::Value::BulkString(bytes) => Some(bytes.clone()),
        _ => None,
    }
}

/// 打包一个 key 名：合法 UTF-8 就只给字符串，否则连原始字节一起给。
pub fn make_key_meta(bytes: Vec<u8>, key_type: String) -> KeyMeta {
    match String::from_utf8(bytes) {
        Ok(key) => KeyMeta { key, key_bytes: None, key_type },
        Err(e) => {
            let bytes = e.into_bytes();
            KeyMeta {
                key: String::from_utf8_lossy(&bytes).into_owned(),
                key_bytes: Some(bytes),
                key_type,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_keyspace_lines() {
        let info = "# Keyspace\r\ndb0:keys=12,expires=3,avg_ttl=0\r\ndb3:keys=1,expires=0,avg_ttl=0\r\n";
        assert_eq!(parse_keyspace(info), vec![(0, 12), (3, 1)]);
    }

    #[test]
    fn keyspace_ignores_junk() {
        // 只认 `dbN:` 开头的行；别的字段、别的段落一律跳过
        let info = "# Server\r\nredis_version:7.0.15\r\n# Keyspace\r\ndb1:keys=5\r\n";
        assert_eq!(parse_keyspace(info), vec![(1, 5)]);

        // 没有 keys= 字段时算 0，而不是整行丢掉
        assert_eq!(parse_keyspace("db2:expires=9\r\n"), vec![(2, 0)]);

        // 库号不是数字、行里没有冒号 —— 都跳过
        assert_eq!(parse_keyspace("dbsomething:keys=1\r\n"), vec![]);
        assert_eq!(parse_keyspace("db5\r\n"), vec![]);
        assert_eq!(parse_keyspace(""), vec![]);
    }

    #[test]
    fn merges_empty_databases_in() {
        // CONFIG 说有 4 个库，INFO 里只有 db0 和 db2 有 key
        let merged = merge_keyspace(Some(4), &[(0, 12), (2, 7)]);
        assert_eq!(
            merged,
            vec![
                DbInfo { db: 0, keys: 12 },
                DbInfo { db: 1, keys: 0 },
                DbInfo { db: 2, keys: 7 },
                DbInfo { db: 3, keys: 0 },
            ]
        );
    }

    #[test]
    fn falls_back_when_config_is_unavailable() {
        // CONFIG 被禁用时 total 是 None —— 至少要列出 INFO 里出现过的库
        let merged = merge_keyspace(None, &[(0, 3), (5, 1)]);
        assert_eq!(merged.len(), 6, "应该列到见过的最大库号");
        assert_eq!(merged[5], DbInfo { db: 5, keys: 1 });

        // 什么都没有的时候也要有一个 db0，界面不能是空的
        assert_eq!(merge_keyspace(None, &[]), vec![DbInfo { db: 0, keys: 0 }]);
    }

    #[test]
    fn config_saying_more_than_info_seen() {
        // 一个全新的空实例：CONFIG 说 16 个库，INFO 什么都没有
        let merged = merge_keyspace(Some(16), &[]);
        assert_eq!(merged.len(), 16);
        assert!(merged.iter().all(|d| d.keys == 0));
    }

    #[test]
    fn utf8_keys_carry_no_raw_bytes() {
        let meta = make_key_meta("user:1".as_bytes().to_vec(), "string".to_string());
        assert_eq!(meta.key, "user:1");
        assert_eq!(meta.key_bytes, None, "合法 UTF-8 不该额外带一份字节");
        assert_eq!(meta.key_type, "string");
    }

    #[test]
    fn binary_keys_carry_raw_bytes_and_still_display() {
        let meta = make_key_meta(vec![0xff, 0xfe, 0x41], "hash".to_string());
        // 展示形式是 lossy 的（会有替换字符），但原始字节完好
        assert_eq!(meta.key_bytes, Some(vec![0xff, 0xfe, 0x41]));
        assert!(meta.key.contains('A'), "能识别的部分还是要显示出来：{}", meta.key);
    }
}
