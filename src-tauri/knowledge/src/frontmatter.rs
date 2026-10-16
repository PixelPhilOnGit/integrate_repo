//! 卡片 frontmatter 的编解码：**扁平 YAML 子集**。
//!
//! # 为什么手写而不是引 YAML 全家桶
//!
//! 我们只写这几样：`title/status/archived/created/tags/sources` —— 全是一行的
//! 标量或行内列表。引一个 YAML crate 是为了「读别人的文件」，而**读别人的
//! 文件恰恰要什么都容忍**（用户在 Obsidian 里手编过、加了嵌套、加了多行块）——
//! 一个严格解析器在那时候给的是报错，而这里给的是「认不出的原样留着」。
//!
//! # ⚠️ 用户会手编这些文件 —— 未知键必须**原样保命**
//!
//! 库的承诺是「文件是真相」：用户可以在 Obsidian（或任何一个编辑器）里加
//! 自己的字段（`aliases:`、`cssclass:`…）。我们改状态/归档时要重写 frontmatter，
//! **重写绝不能把不认识的键洗掉** —— 认不出的行按原始文本收进 `extra`，
//! 序列化时一字不差地放回去（顺序按出现顺序）。这是这个模块最重要的规矩。
//!
//! # 宽容的读
//!
//! * 没有 `---` 头 = 没有 frontmatter（给默认值），**不是错误**；
//! * 认得出键的形状就认，认不出就进 `extra`；
//! * 值两头的引号剥掉，`"` 与 `\` 支持转义。

/// 卡片状态。白名单之外的值按 `Unreviewed` 处理（手编错的文件不该炸整个库）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CardStatus {
    Unreviewed,
    Reviewed,
}

impl CardStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            CardStatus::Unreviewed => "unreviewed",
            CardStatus::Reviewed => "reviewed",
        }
    }

    pub fn parse(s: &str) -> CardStatus {
        match s.trim().to_ascii_lowercase().as_str() {
            "reviewed" | "已评审" => CardStatus::Reviewed,
            // 认不出的（含手编错、历史值）一律回未评审 —— **宁可多审一遍，
            // 不能假装审过**
            _ => CardStatus::Unreviewed,
        }
    }
}

/// 一张卡片的 frontmatter。`extra` 里是**原样文本**的未知行。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frontmatter {
    pub title: String,
    pub status: CardStatus,
    pub archived: bool,
    /// ISO-8601 字符串（我们自己写的）；手编的任意串原样留着
    pub created: String,
    pub tags: Vec<String>,
    /// 来源文件的相对路径（`_sources/…`）
    pub sources: Vec<String>,
    /// ⚠️ 认不出的键：`(原始行)`，序列化时按顺序放回（见模块头）
    pub extra: Vec<String>,
}

impl Frontmatter {
    pub fn new(title: &str, created: &str) -> Self {
        Frontmatter {
            title: title.to_string(),
            status: CardStatus::Unreviewed,
            archived: false,
            created: created.to_string(),
            tags: Vec::new(),
            sources: Vec::new(),
            extra: Vec::new(),
        }
    }
}

/// 解析一篇 md：返回 `(frontmatter, 正文)`。
///
/// 不行就**当作没有 frontmatter**（整篇都是正文，给默认值）—— 卡片内容
/// 一个字不丢，比任何报错都强。
pub fn parse(text: &str) -> (Frontmatter, String) {
    let Some((head, body)) = split(text) else {
        return (Frontmatter::new("", ""), text.to_string());
    };

    let mut fm = Frontmatter::new("", "");
    for raw_line in head.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            // 注释/空行：不进 extra（我们序列化时本来就不写它们；留着'#'行会
            // 让用户在别处加的注释随我们的重写无限增殖）
            continue;
        }
        let Some((key, value)) = line.split_once(':') else {
            fm.extra.push(raw_line.to_string());
            continue;
        };
        let key = key.trim();
        let value = value.trim();
        match key {
            "title" => fm.title = scalar(value),
            "status" => fm.status = CardStatus::parse(&scalar(value)),
            "archived" => fm.archived = matches!(scalar(value).as_str(), "true" | "yes" | "1"),
            "created" => fm.created = scalar(value),
            "tags" => fm.tags = list(value),
            "sources" => fm.sources = list(value),
            _ => fm.extra.push(raw_line.to_string()),
        }
    }

    if fm.title.is_empty() {
        // title 缺失（手编删掉了）：调用方多半拿文件名兜底；这里给空串保真
        fm.title = String::new();
    }
    (fm, body.to_string())
}

/// 序列化：`---` 头 + 已知键（固定顺序）+ extra 原样 + `---` + 正文。
pub fn serialize(fm: &Frontmatter, body: &str) -> String {
    let mut out = String::from("---\n");
    out.push_str(&format!("title: {}\n", quote(&fm.title)));
    out.push_str(&format!("status: {}\n", fm.status.as_str()));
    out.push_str(&format!("archived: {}\n", fm.archived));
    if !fm.created.is_empty() {
        out.push_str(&format!("created: {}\n", quote(&fm.created)));
    }
    if !fm.tags.is_empty() {
        out.push_str(&format!("tags: {}\n", inline_list(&fm.tags)));
    }
    if !fm.sources.is_empty() {
        out.push_str(&format!("sources: {}\n", inline_list(&fm.sources)));
    }
    for line in &fm.extra {
        out.push_str(line);
        out.push('\n');
    }
    out.push_str("---\n");
    out.push_str(body);
    out
}

/// 切出 `---` 头和正文。没有合法的头返回 None。
fn split(text: &str) -> Option<(&str, &str)> {
    let rest = text.strip_prefix("---")?;
    // 第一行必须**只有** `---`（`--- abc` 是别的语法，我们不碰）
    let rest = rest.strip_prefix('\n').or_else(|| rest.strip_prefix("\r\n"))?;
    // 从头到下一个恰为 `---` 的行
    let mut offset = 0usize;
    for line in rest.split_inclusive('\n') {
        let trimmed = line.trim_end_matches(['\n', '\r']).trim();
        if trimmed == "---" {
            let head = &rest[..offset];
            let body = &rest[offset + line.len()..];
            return Some((head, body));
        }
        offset += line.len();
    }
    None
}

/// 剥标量两头的引号并解转义；没引号就 trim 后原样。
fn scalar(value: &str) -> String {
    let v = value.trim();
    if v.len() >= 2 && v.starts_with('"') && v.ends_with('"') {
        let inner = &v[1..v.len() - 1];
        let mut out = String::with_capacity(inner.len());
        let mut chars = inner.chars();
        while let Some(c) = chars.next() {
            if c == '\\' {
                match chars.next() {
                    Some('n') => out.push('\n'),
                    Some(other) => out.push(other),
                    None => out.push('\\'),
                }
            } else {
                out.push(c);
            }
        }
        out
    } else {
        v.to_string()
    }
}

/// 行内列表：`[a, b, "c, 带逗号"]`。认不出括号就当单元素。
fn list(value: &str) -> Vec<String> {
    let v = value.trim();
    let Some(inner) = v.strip_prefix('[').and_then(|s| s.strip_suffix(']')) else {
        let one = scalar(v);
        return if one.is_empty() { Vec::new() } else { vec![one] };
    };
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_quotes = false;
    for c in inner.chars() {
        match c {
            '"' => {
                in_quotes = !in_quotes;
                cur.push(c);
            }
            ',' if !in_quotes => {
                let item = scalar(cur.trim());
                if !item.is_empty() {
                    out.push(item);
                }
                cur.clear();
            }
            _ => cur.push(c),
        }
    }
    let item = scalar(cur.trim());
    if !item.is_empty() {
        out.push(item);
    }
    out
}

/// 需要引号的标量就加引号（含 `:`、`#`、头尾空白、空串、或以 `[` 开头）。
fn quote(s: &str) -> String {
    let needs = s.is_empty()
        || s.contains([':', '#', '"', '\n'])
        || s.starts_with(['[', ' '])
        || s.ends_with(' ')
        || s.starts_with("---");
    if !needs {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            other => out.push(other),
        }
    }
    out.push('"');
    out
}

fn inline_list(items: &[String]) -> String {
    let parts: Vec<String> = items.iter().map(|s| quote(s)).collect();
    format!("[{}]", parts.join(", "))
}

/// 便捷入口：解析完的 frontmatter 直接带出「哪些未知键」的调试视图（测试用）。
#[cfg(test)]
fn extra_map(fm: &Frontmatter) -> std::collections::BTreeMap<String, String> {
    fm.extra
        .iter()
        .filter_map(|l| l.split_once(':').map(|(k, v)| (k.trim().to_string(), v.trim().to_string())))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 没有_frontmatter_就当没有_整篇是正文() {
        let (fm, body) = parse("# 标题\n正文");
        assert_eq!(body, "# 标题\n正文");
        assert_eq!(fm.title, "");
        assert_eq!(fm.status, CardStatus::Unreviewed);
        assert!(!fm.archived);
    }

    #[test]
    fn 往返_我们写的东西读回来一模一样() {
        let mut fm = Frontmatter::new("登录: 流程 \"v2\"", "2026-10-16T00:00:00Z");
        fm.status = CardStatus::Reviewed;
        fm.archived = true;
        fm.tags = vec!["团队/一号".into(), "auth".into()];
        fm.sources = vec!["_sources/a_report.pdf".into()];
        let body = "# 内容\n\n- 一\n- 二\n";

        let text = serialize(&fm, body);
        let (parsed, parsed_body) = parse(&text);
        assert_eq!(parsed, fm, "往返丢了东西：\n{text}");
        assert_eq!(parsed_body, body, "正文一个字都不许动");
    }

    #[test]
    fn 未知键原样保命_顺序不变() {
        let text = concat!(
            "---\n",
            "title: 卡片\n",
            "status: reviewed\n",
            "aliases: [甲, 乙]\n",
            "cssclass: my-vault\n",
            "tags: [a]\n",
            "---\n",
            "正文",
        );
        let (fm, _) = parse(text);
        assert_eq!(fm.title, "卡片");
        assert_eq!(fm.status, CardStatus::Reviewed);
        let map = extra_map(&fm);
        assert_eq!(map.get("aliases").map(String::as_str), Some("[甲, 乙]"));
        assert_eq!(map.get("cssclass").map(String::as_str), Some("my-vault"));

        // 重写（比如标已评审）之后未知键还在、顺序没动
        let out = serialize(&fm, "正文");
        let aliases_at = out.find("aliases:").expect("aliases 丢了");
        let cssclass_at = out.find("cssclass:").expect("cssclass 丢了");
        assert!(aliases_at < cssclass_at, "extra 的顺序该按出现顺序");
        assert!(out.contains("aliases: [甲, 乙]"), "extra 要一字不差：\n{out}");
    }

    #[test]
    fn 认不出的_status_回未评审_宁可多审一遍() {
        let (fm, _) = parse("---\nstatus: 状态不明\n---\n");
        assert_eq!(fm.status, CardStatus::Unreviewed);
        let (fm, _) = parse("---\nstatus: Reviewed\n---\n");
        assert_eq!(fm.status, CardStatus::Reviewed, "大小写不敏感");
    }

    #[test]
    fn 只认恰好三个横线的头() {
        // 正文里三个横线开头的行（分隔线）不当 frontmatter 头
        let (fm, body) = parse("--- abc\n不是头\n");
        assert_eq!(fm.title, "");
        assert_eq!(body, "--- abc\n不是头\n");

        // 没闭合的头 = 没有 frontmatter（内容全留）
        let text = "---\ntitle: 半截\n没有闭合";
        let (fm, body) = parse(text);
        assert_eq!(fm.title, "");
        assert_eq!(body, text);
    }

    #[test]
    fn 值里的冒号井号引号都稳() {
        let fm_text = "---\ntitle: \"a: b #c \\\"引号\\\"\"\nurl: http://x/y\n---\n";
        let (fm, _) = parse(fm_text);
        assert_eq!(fm.title, "a: b #c \"引号\"");
        // 认不出的键（url）原样进 extra
        assert!(fm.extra.iter().any(|l| l.contains("http://x/y")));
    }

    #[test]
    fn 列表解析_带逗号的引号项不拆开() {
        let items = list("[\"a, b\", c, d]");
        assert_eq!(items, vec!["a, b", "c", "d"]);
        let items = list("单个");
        assert_eq!(items, vec!["单个"]);
        let items = list("[]");
        assert!(items.is_empty());
    }

    #[test]
    fn 空行的头_也能解析() {
        let (fm, body) = parse("---\n\n# 注释行\n---\nbody");
        assert_eq!(body, "body");
        assert_eq!(fm.title, "");
        assert!(fm.extra.is_empty(), "注释/空行不进 extra");
    }
}
