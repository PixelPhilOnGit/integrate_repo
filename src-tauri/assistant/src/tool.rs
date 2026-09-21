//! 工具的注册表契约、参数校验、以及**审批判定**。
//!
//! 这个文件里**只有纯逻辑** —— 不碰文件系统、不起进程、不认识 Tauri。
//! 真正干活的那一半在 `tools/` 下面。这样切开的好处是
//! 「该不该问用户」「参数合不合法」这两件事可以在毫秒级的单测里覆盖全部分支，
//! 而它们恰恰是最容易写错、又最不该出错的两件事。
//!
//! # 三层职责
//!
//! ```text
//! ToolSpec        静态描述：名字、说明、JSON Schema、有没有副作用
//!      ↓  provider 说「调用 read_file，参数是 {...}」
//! validate_input  严格解析 + 按 schema 校验   ← 纯
//!      ↓  再经 Workspace 解析路径（唯一闸门），得到
//! PreparedCall    参数 + **给人看的那个字符串** + 记住授权用的 key
//!      ↓
//! needs_approval  要不要问用户                ← 纯
//!      ↓
//! （IO 层执行）
//! ```
//!
//! ⚠️ **`PreparedCall` 是「展示的」和「执行的」同一个东西**，这是刻意的：
//! 如果先渲染给用户看、执行时再重新解析一遍参数，就等于给「用户批准的」和
//! 「实际执行的」不是一个东西留了门。

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 一个工具对世界的改变有多大。**决定要不要审批**。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SideEffect {
    /// 只读（读文件、列目录、搜索）。自动放行。
    Read,
    /// 会改文件。
    Write,
    /// 会起进程。
    ///
    /// ⚠️ 这一类和 [`SideEffect::Write`] 有本质区别：路径闸门**挡得住写文件**
    /// （所有路径都过 `Workspace::resolve`），但**挡不住 shell** ——
    /// 命令一旦跑起来，`cd ..`、绝对路径、`curl` 全都出得去。
    /// 所以执行类永远要人工确认，不能进任何自动放行名单。
    Execute,
}

impl SideEffect {
    /// 这个副作用是不是必须每次问用户。
    pub fn needs_approval(self) -> bool {
        matches!(self, SideEffect::Write | SideEffect::Execute)
    }
}

/// 一个工具的静态描述。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolSpec {
    /// 工具名。给模型看的，用动词开头、下划线分隔（`read_file`）。
    pub name: String,
    /// 说明。⚠️ 要写清「**什么时候**用它」，不只是「它做什么」——
    /// 新一代模型在描述里给了触发条件时，该调的没调的比率明显下降。
    pub description: String,
    /// 参数的 JSON Schema。
    ///
    /// 我们自己的 schema 只用得到很小的一个子集（见 [`validate_input`]），
    /// 但**顺序必须稳定**（见 [`ToolSet`]）。
    pub schema: Value,
    /// 副作用。
    pub side_effect: SideEffect,
}

/// 一组工具。
///
/// ⚠️ **顺序必须确定**：工具定义是请求前缀的第一段，顺序一变**整个 prompt 缓存就废了**。
/// 所以这里收进来就按名字排序，并且**不用 `HashMap` 迭代**（那是无序的）。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ToolSet {
    specs: Vec<ToolSpec>,
}

impl ToolSet {
    /// 建一组工具（自动按名字排序，保证序列化顺序稳定）。
    pub fn new(mut specs: Vec<ToolSpec>) -> Self {
        specs.sort_by(|a, b| a.name.cmp(&b.name));
        ToolSet { specs }
    }

    /// 按顺序取出所有工具。
    pub fn specs(&self) -> &[ToolSpec] {
        &self.specs
    }

    /// 按名字找。
    pub fn get(&self, name: &str) -> Option<&ToolSpec> {
        self.specs.iter().find(|s| s.name == name)
    }

    /// 这一组工具是不是空的。
    pub fn is_empty(&self) -> bool {
        self.specs.is_empty()
    }
}

/// 参数校验失败。
///
/// ⚠️ 这个错误**不是**「执行失败」，而是「模型给的东西我们不敢执行」。
/// 它会被原样包成 `is_error: true` 的 `tool_result` 回给模型，
/// 让它自己重试 —— 所以文案是**给模型看的**，要说清哪里不对。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvalidInput {
    /// 给模型看的一句话。
    pub reason: String,
}

impl InvalidInput {
    fn new(reason: impl Into<String>) -> Self {
        InvalidInput {
            reason: reason.into(),
        }
    }
}

impl std::fmt::Display for InvalidInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.reason)
    }
}

/// 严格解析 + 按 schema 校验一段工具参数。
///
/// # 为什么必须校验（而不是信任 provider）
///
/// 流式请求里我们给每个自定义工具开了 `eager_input_streaming`，代价是
/// **服务端不再校验、也不再纠正**参数，片段直接流过来。于是有三种坏输入：
///
/// 1. 撞上 `max_tokens` 被截断的；2. 模型自己吐的非法 JSON；3. 缺必填字段的。
///
/// 而且**前两种经常仍然能解析成一个"看着合法"的部分对象** ——
/// 所以「解析成功」不等于「可以用」，必须再按 schema 过一遍。
/// 这是那条「截断的输入不要执行、回 INVALID_JSON 让模型重试」的落点。
pub fn validate_input(schema: &Value, raw: &str) -> Result<Value, InvalidInput> {
    let parsed: Value =
        serde_json::from_str(raw).map_err(|e| InvalidInput::new(format!("参数不是合法 JSON：{e}")))?;

    check(schema, &parsed, "")?;
    Ok(parsed)
}

/// 我们支持的 JSON Schema 子集：`type` / `properties` / `required` / `additionalProperties`。
///
/// **不引 schema 校验库**是刻意的：schema 是我们自己写的、结构简单，
/// 为它引一个通用校验器（连同一棵依赖树）不划算。等真需要 `anyOf` 之类再说。
fn check(schema: &Value, value: &Value, path: &str) -> Result<(), InvalidInput> {
    let where_ = if path.is_empty() { "参数".to_string() } else { format!("参数 {path}") };

    // type
    if let Some(t) = schema.get("type").and_then(Value::as_str) {
        let ok = match t {
            "string" => value.is_string(),
            "integer" => value.is_i64() || value.is_u64(),
            "number" => value.is_number(),
            "boolean" => value.is_boolean(),
            "array" => value.is_array(),
            "object" => value.is_object(),
            "null" => value.is_null(),
            _ => true, // 不认识的类型约束：不拦（我们自己的 schema 不会写出来）
        };
        if !ok {
            return Err(InvalidInput::new(format!(
                "{where_} 应该是 {t}，实际是 {}",
                kind_of(value)
            )));
        }
    }

    let Some(obj) = value.as_object() else {
        return Ok(());
    };

    // required
    if let Some(required) = schema.get("required").and_then(Value::as_array) {
        for r in required.iter().filter_map(Value::as_str) {
            if !obj.contains_key(r) {
                return Err(InvalidInput::new(format!(
                    "{where_} 缺少必填字段 `{r}`（可能是输出被截断了，请重新给出完整参数）"
                )));
            }
        }
    }

    // properties：逐个子字段递归
    let props = schema.get("properties").and_then(Value::as_object);
    if let Some(props) = props {
        for (key, sub) in props {
            if let Some(v) = obj.get(key) {
                let child = if path.is_empty() {
                    key.clone()
                } else {
                    format!("{path}.{key}")
                };
                check(sub, v, &child)?;
            }
        }
    }

    // additionalProperties: false —— 多给了字段就是错。
    // 这条要严：模型多塞字段往往意味着它理解错了这个工具的用法。
    if schema.get("additionalProperties") == Some(&Value::Bool(false)) {
        if let Some(props) = props {
            for key in obj.keys() {
                if !props.contains_key(key) {
                    return Err(InvalidInput::new(format!(
                        "{where_} 里有工具不认识的字段 `{key}`"
                    )));
                }
            }
        }
    }

    Ok(())
}

fn kind_of(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

/// 「本次会话记住」的粒度。
///
/// ⚠️ **这是安全边界上的一行，粒度定错就是个洞。**
///
/// 绝不能是「整条命令」或者「整个工具」：用户点了「记住 `rm`」，
/// 结果 `rm -rf /` 也免审 —— 那是个用户永远发现不了的放宽。
/// 所以是 `(工具名, 归一化目标)`：
///
/// * `write_file` → 目标 = **父目录**（批准「往 src/ 写」不等于批准往 `/etc` 写）
/// * `run_command` → 目标 = **`argv[0]`，程序名**（批准 `git` 不等于批准 `curl`）
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrantKey {
    /// 工具名。
    pub tool: String,
    /// 归一化之后的目标。
    pub target: String,
}

/// 一次**已经准备好、可以执行**的调用。
///
/// ⚠️ 这个结构是「给用户看的」和「拿去执行的」**同一个东西** ——
/// 不要在执行的时候重新解析一遍参数，否则「用户批准的」和「实际跑的」
/// 可能不是一个东西（审批版的 TOCTOU）。
#[derive(Debug, Clone, PartialEq)]
pub struct PreparedCall {
    /// 工具名。
    pub name: String,
    /// 校验过的参数。
    pub args: Value,
    /// 副作用（决定要不要审批）。
    pub side_effect: SideEffect,
    /// **给人看的那一行**。写文件是解析之后的真实路径，跑命令是完整命令行原文。
    pub display: String,
    /// 记住授权用的 key。只读工具是 `None`。
    pub grant: Option<GrantKey>,
}

impl PreparedCall {
    /// 要问用户吗？返回 `Some` 表示要问，值是被记住时的那条 key。
    ///
    /// 纯函数，**判定和等待是分开的**（等待在 `approval.rs`）——
    /// 这样「什么情况下要问」可以在毫秒级单测里穷举。
    pub fn needs_approval(&self, granted: &HashSet<GrantKey>) -> Option<GrantKey> {
        if !self.side_effect.needs_approval() {
            return None;
        }
        let key = self.grant.clone()?;
        if granted.contains(&key) {
            return None; // 本会话已经批准过这一条
        }
        Some(key)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn write_spec() -> ToolSpec {
        ToolSpec {
            name: "write_file".into(),
            description: "写文件".into(),
            schema: json!({
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "contents": {"type": "string"}
                },
                "required": ["path", "contents"],
                "additionalProperties": false
            }),
            side_effect: SideEffect::Write,
        }
    }

    #[test]
    fn tool_set_serializes_in_a_stable_order() {
        // 顺序不稳 = prompt 缓存每轮全废。这条盯着它。
        let set = ToolSet::new(vec![
            ToolSpec {
                name: "z_last".into(),
                ..write_spec()
            },
            ToolSpec {
                name: "a_first".into(),
                ..write_spec()
            },
        ]);
        let names: Vec<_> = set.specs().iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, ["a_first", "z_last"]);
    }

    #[test]
    fn rejects_a_truncated_object() {
        // 这是最要命的一种：JSON 本身**能解析**，但内容是被截断的。
        // 「解析成功」绝不能等于「可以用」。
        let schema = write_spec().schema;
        let truncated = r#"{"path":"a.txt"}"#; // 少了 contents
        let err = validate_input(&schema, truncated).unwrap_err();
        assert!(err.reason.contains("contents"), "报错要指名字段：{err}");
    }

    #[test]
    fn rejects_malformed_json() {
        let schema = write_spec().schema;
        let err = validate_input(&schema, r#"{"path":"a.txt","cont"#).unwrap_err();
        assert!(err.reason.contains("合法 JSON"), "{err}");
    }

    #[test]
    fn rejects_extra_fields() {
        // 模型多给字段通常说明它理解错了这个工具的用法，要拦。
        let schema = write_spec().schema;
        let err = validate_input(
            &schema,
            r#"{"path":"a","contents":"b","mode":"0777"}"#,
        )
        .unwrap_err();
        assert!(err.reason.contains("mode"), "{err}");
    }

    #[test]
    fn rejects_wrong_type() {
        let schema = write_spec().schema;
        let err = validate_input(&schema, r#"{"path":7,"contents":"b"}"#).unwrap_err();
        assert!(err.reason.contains("string"), "{err}");
    }

    #[test]
    fn accepts_a_good_payload() {
        let schema = write_spec().schema;
        let v = validate_input(&schema, r#"{"path":"a.txt","contents":"hi"}"#).unwrap();
        assert_eq!(v["path"], json!("a.txt"));
    }

    fn call(name: &str, effect: SideEffect, target: &str) -> PreparedCall {
        PreparedCall {
            name: name.into(),
            args: json!({}),
            side_effect: effect,
            display: format!("{name} {target}"),
            grant: Some(GrantKey {
                tool: name.into(),
                target: target.into(),
            }),
        }
    }

    #[test]
    fn reads_never_ask() {
        let c = call("read_file", SideEffect::Read, "a.txt");
        assert_eq!(c.needs_approval(&HashSet::new()), None);
    }

    #[test]
    fn writes_and_execs_always_ask() {
        let empty = HashSet::new();
        assert!(call("write_file", SideEffect::Write, "src").needs_approval(&empty).is_some());
        assert!(call("run_command", SideEffect::Execute, "git").needs_approval(&empty).is_some());
    }

    #[test]
    fn remembering_is_per_target_not_per_tool() {
        // 这个测试就是那个安全洞的防线：
        // 批准过 `git` 之后，`curl` **仍然要问**。
        let mut granted = HashSet::new();
        granted.insert(GrantKey {
            tool: "run_command".into(),
            target: "git".into(),
        });

        let git = call("run_command", SideEffect::Execute, "git");
        assert_eq!(git.needs_approval(&granted), None, "git 已经批准过，不该再问");

        let curl = call("run_command", SideEffect::Execute, "curl");
        assert!(
            curl.needs_approval(&granted).is_some(),
            "⚠️ 批准 git 不能顺带批准 curl —— 那是个用户发现不了的洞"
        );
    }

    #[test]
    fn remembering_a_directory_does_not_unlock_its_siblings() {
        let mut granted = HashSet::new();
        granted.insert(GrantKey {
            tool: "write_file".into(),
            target: "src".into(),
        });
        let elsewhere = call("write_file", SideEffect::Write, "config");
        assert!(elsewhere.needs_approval(&granted).is_some());
    }
}
