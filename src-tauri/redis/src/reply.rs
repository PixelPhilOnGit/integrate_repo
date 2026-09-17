//! Redis 回复 → 可序列化的树。
//!
//! [`Reply`] 是**前后端之间的 IPC 契约**：它的 JSON 字段名被下面的单元测试钉死，
//! 前端的 TS 判别联合是照着那些断言写的（跟 `FileNode` 的做法一样）。
//!
//! # 为什么不用 `query_async`
//!
//! `query_async::<Value>` 内部会调 `val.extract_error()?`，**递归**把嵌套在数组或
//! Map 里的 `ServerError` 也提成 `Err`。那样 `CONFIG GET` 之类返回嵌套结构的命令
//! 一旦有一项是错误，整条命令就变成传输层失败了 —— 而它其实只是「一条回复」。
//!
//! 所以走 `send_packed_command`，拿**原始**的 `Value` 树，在这里自己把它翻译成
//! [`Reply`]。这也是 [`Reply::Error`] 能作为「一种正常回复」存在的前提。

use redis::Value;

/// Redis 的一条回复。
///
/// 变体覆盖 RESP2 的全部类型，外加 RESP3 特有的 Map/Set/Double/Boolean/
/// VerbatimString/BigNumber —— 后者在 RESP2 连接下不会出现，但**多写几个分支
/// 的成本几乎为零，而不写的代价是用户看到「不支持」而不是看到值**。
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Reply {
    /// nil / 不存在的 key
    Nil,
    /// 简单状态回复（`+OK`、`+PONG`）
    Status { text: String },
    /// 服务器报错。**这是一条正常回复**，不是执行失败（见模块文档）
    Error { message: String },
    /// `:123`
    Integer { value: i64 },
    Bulk {
        /// 能按 UTF-8 解码时是原文；否则是 lossy 解码的结果（配合 `binary` 判断）
        text: String,
        /// 无法按 UTF-8 解码。前端据此显示成 `"\xac\xed…"` 而不是糊一屏乱码
        binary: bool,
        /// 原始字节数。`binary` 为真时它是唯一的长度真相（`text` 已经失真）
        bytes: usize,
    },
    Array { items: Vec<Reply> },
    Map { entries: Vec<(Reply, Reply)> },
    Set { items: Vec<Reply> },
    Double { value: f64 },
    Boolean { value: bool },
    Verbatim { format: String, text: String },
    /// 超出 i64 的大整数，按字符串传（前端不参与运算，只显示）
    BigNumber { text: String },
}

impl Reply {
    /// 把驱动给的原始回复树翻译过来。
    pub fn from_value(value: Value) -> Reply {
        match value {
            Value::Nil => Reply::Nil,
            Value::Int(value) => Reply::Integer { value },
            Value::BulkString(bytes) => Reply::bulk(bytes),
            Value::Array(items) => Reply::array(items),
            Value::SimpleString(text) => Reply::Status { text },
            Value::Okay => Reply::Status { text: "OK".to_string() },
            Value::Map(entries) => Reply::Map {
                entries: entries
                    .into_iter()
                    .map(|(k, v)| (Reply::from_value(k), Reply::from_value(v)))
                    .collect(),
            },
            // 属性是给客户端看的元数据，命令台里没有展示价值，只显示它挂着的那个值。
            Value::Attribute { data, .. } => Reply::from_value(*data),
            Value::Set(items) => Reply::Set {
                items: items.into_iter().map(Reply::from_value).collect(),
            },
            Value::Double(value) => Reply::Double { value },
            Value::Boolean(value) => Reply::Boolean { value },
            Value::VerbatimString { format, text } => Reply::Verbatim {
                format: verbatim_format(format),
                text,
            },
            Value::BigNumber(n) => Reply::BigNumber { text: n.to_string() },
            // 推送消息（RESP3）。没订阅的连接基本见不到；真见到时把内容当数组显示，
            // 至少信息不丢。
            Value::Push { data, .. } => Reply::array(data),
            Value::ServerError(e) => Reply::Error {
                message: server_error_text(e.code(), e.details()),
            },
        }
    }

    fn bulk(bytes: Vec<u8>) -> Reply {
        let len = bytes.len();
        match String::from_utf8(bytes) {
            Ok(text) => Reply::Bulk { text, binary: false, bytes: len },
            Err(e) => Reply::Bulk {
                text: String::from_utf8_lossy(e.as_bytes()).into_owned(),
                binary: true,
                bytes: len,
            },
        }
    }

    fn array(items: Vec<Value>) -> Reply {
        Reply::Array {
            items: items.into_iter().map(Reply::from_value).collect(),
        }
    }
}

/// 拼出 `redis-cli` 那种 `ERR unknown command 'FOO'` 的文案。
///
/// `ServerError` 在 redis 0.32 里**没有从 crate 根导出**（`types` 模块是私有的），
/// 所以这里收的是它的两个字符串参数而不是 `&ServerError` —— 顺带也让这个函数
/// 能脱离 Redis 单测。
pub(crate) fn server_error_text(code: &str, details: Option<&str>) -> String {
    match details {
        Some(d) if !d.is_empty() => format!("{code} {d}"),
        _ => code.to_string(),
    }
}

fn verbatim_format(format: redis::VerbatimFormat) -> String {
    match format {
        redis::VerbatimFormat::Text => "txt".to_string(),
        redis::VerbatimFormat::Markdown => "mkd".to_string(),
        redis::VerbatimFormat::Unknown(other) => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 这些断言就是**前后端契约**。改 Reply 的字段名 = 改前端类型，两边必须一起动。
    #[test]
    fn json_contract() {
        assert_eq!(serde_json::to_value(Reply::Nil).unwrap(), json!({"type": "nil"}));

        assert_eq!(
            serde_json::to_value(Reply::Status { text: "OK".into() }).unwrap(),
            json!({"type": "status", "text": "OK"})
        );
        assert_eq!(
            serde_json::to_value(Reply::Error { message: "ERR bad".into() }).unwrap(),
            json!({"type": "error", "message": "ERR bad"})
        );
        assert_eq!(
            serde_json::to_value(Reply::Integer { value: -3 }).unwrap(),
            json!({"type": "integer", "value": -3})
        );
        assert_eq!(
            serde_json::to_value(Reply::Bulk { text: "v".into(), binary: false, bytes: 1 }).unwrap(),
            json!({"type": "bulk", "text": "v", "binary": false, "bytes": 1})
        );
        assert_eq!(
            serde_json::to_value(Reply::Array { items: vec![Reply::Integer { value: 1 }] }).unwrap(),
            json!({"type": "array", "items": [{"type": "integer", "value": 1}]})
        );
        assert_eq!(
            serde_json::to_value(Reply::Map {
                entries: vec![(Reply::bulk(b"k".to_vec()), Reply::bulk(b"v".to_vec()))],
            })
            .unwrap(),
            json!({"type": "map", "entries": [[
                {"type": "bulk", "text": "k", "binary": false, "bytes": 1},
                {"type": "bulk", "text": "v", "binary": false, "bytes": 1}
            ]]})
        );
        assert_eq!(
            serde_json::to_value(Reply::Set { items: vec![] }).unwrap(),
            json!({"type": "set", "items": []})
        );
        assert_eq!(
            serde_json::to_value(Reply::Double { value: 1.5 }).unwrap(),
            json!({"type": "double", "value": 1.5})
        );
        assert_eq!(
            serde_json::to_value(Reply::Boolean { value: true }).unwrap(),
            json!({"type": "boolean", "value": true})
        );
        assert_eq!(
            serde_json::to_value(Reply::Verbatim { format: "txt".into(), text: "hi".into() }).unwrap(),
            json!({"type": "verbatim", "format": "txt", "text": "hi"})
        );
        assert_eq!(
            serde_json::to_value(Reply::BigNumber { text: "123456789012345678901".into() }).unwrap(),
            json!({"type": "bigNumber", "text": "123456789012345678901"})
        );
    }

    #[test]
    fn bulk_marks_non_utf8_as_binary() {
        // 合法的 UTF-8：binary = false，bytes 就是字符的字节数
        let Reply::Bulk { text, binary, bytes } = Reply::bulk("中文".as_bytes().to_vec()) else {
            panic!("期望是 Bulk");
        };
        assert_eq!(text, "中文");
        assert!(!binary);
        assert_eq!(bytes, 6); // UTF-8 下一个汉字 3 字节

        // 非法 UTF-8：标记为 binary，bytes 仍是真实的原始长度
        let Reply::Bulk { binary, bytes, .. } = Reply::bulk(vec![0xff, 0xfe, 0x00]) else {
            panic!("期望是 Bulk");
        };
        assert!(binary, "非 UTF-8 必须被标记成 binary");
        assert_eq!(bytes, 3);
    }

    #[test]
    fn server_error_text_matches_redis_cli_shape() {
        // 有细节 → "ERR unknown command 'FOO'"
        assert_eq!(
            server_error_text("ERR", Some("unknown command 'FOO'")),
            "ERR unknown command 'FOO'"
        );
        // 没细节 → 只有错误码
        assert_eq!(server_error_text("ERR", None), "ERR");
        // 细节是空串 → 不要把尾巴上的空格留下
        assert_eq!(server_error_text("ERR", Some("")), "ERR");
    }

    #[test]
    fn nil_and_ok_map_to_the_expected_variants() {
        assert_eq!(Reply::from_value(Value::Nil), Reply::Nil);
        assert_eq!(
            Reply::from_value(Value::Okay),
            Reply::Status { text: "OK".to_string() }
        );
    }

    #[test]
    fn nested_server_error_stays_a_reply() {
        // 这条是语义守门测试：数组里的 ServerError 必须变成 Reply::Error，
        // 而不是让整条命令失败（用 send_packed_command 而不是 query_async 的原因）。
        // 用 parse_redis_value 造这个值，而不是 ServerError::new ——
        // ServerError 在 redis 0.32 里没有从 crate 根导出，命名不了。
        // 这样造反而更真实：走的就是驱动自己解析 RESP 的那条路。
        let server_error =
            redis::parse_redis_value(b"-ERR nope\r\n").expect("应该能解析出 RESP 错误");
        assert!(
            matches!(server_error, Value::ServerError(_)),
            "RESP 错误行应该解析成 ServerError，实际是 {server_error:?}"
        );
        let value = Value::Array(vec![Value::BulkString(b"ok".to_vec()), server_error]);
        let Reply::Array { items } = Reply::from_value(value) else {
            panic!("期望是 Array");
        };
        assert_eq!(items[0], Reply::bulk(b"ok".to_vec()));
        assert!(matches!(items[1], Reply::Error { .. }), "实际是 {:?}", items[1]);
    }
}
