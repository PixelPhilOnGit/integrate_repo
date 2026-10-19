//! 生成输出的**块结构**：CLI 回给我们的卡片 JSON 的形状和校验。
//!
//! ⚠️ 这是**模型输出**，不是可信输入（它可能少字段、类型错、塞空洞）。所以：
//! 解析走 serde，**校验单独一层**（[`validate`]）——解析过了不代表内容有意义
//!（`{"cards":[]}` 是合法 JSON 但没有任何知识）。校验不过的 run 标失败、
//! 原文留给用户看，**绝不静默写进库里**。
//!
//! 块类型（和 `prompt.rs` 的说明、前端的渲染器三方对齐）：
//!
//! * `text` —— markdown 正文
//! * `seq`  —— 本仓 .seq.json 的对象（**原样字符串化存进 md 的 ````seq` 围栏**）
//! * `image`—— 引用 `_files/` 里的图片（生成时由 `mapping.rs` 换成确定路径）

use serde::{Deserialize, Serialize};

use crate::error::KbError;

/// 一份生成输出的顶层。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CardsDocument {
    pub cards: Vec<CardDoc>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CardDoc {
    pub title: String,
    #[serde(default)]
    pub tags: Vec<String>,
    /// 这张卡用到的**资料编号**（`S1`..）。写回时由 `mapping.rs` 换成 rel；
    /// 缺省 = 本次全部资料（解释在 mapping，**validate 不判错**）。
    #[serde(default)]
    pub sources: Vec<String>,
    pub blocks: Vec<Block>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Block {
    Text {
        text: String,
    },
    Seq {
        /// 顺序图 JSON 的**对象**（校验在渲染端做 —— `parseDoc` 是宽容的，
        /// 这里只保证是对象不是字符串）
        seq: serde_json::Value,
    },
    Image {
        source: String,
    },
}

/// 把模型返回的文本切成 JSON 并解析。
///
/// **宽容切割**：模型爱在 JSON 外面裹解释文字或代码围栏，取第一个 `{`
/// 到最后一个 `}` 那一段 —— 为这点格式噪音判失败不值得。切出来还解析不了
/// 就是真坏了（把原始文本放在错误里，调用方要原样留给用户看）。
pub fn parse_generated(text: &str) -> Result<CardsDocument, KbError> {
    let start = text.find('{');
    let end = text.rfind('}');
    let (Some(start), Some(end)) = (start, end) else {
        return Err(KbError::Extract {
            rel: "（生成输出）".to_string(),
            reason: "输出里连一段 JSON 都找不到".to_string(),
        });
    };
    if end <= start {
        return Err(KbError::Extract {
            rel: "（生成输出）".to_string(),
            reason: "输出的 JSON 是残缺的".to_string(),
        });
    }
    serde_json::from_str(&text[start..=end]).map_err(|e| KbError::Extract {
        rel: "（生成输出）".to_string(),
        reason: format!("输出不是约定的卡片 JSON：{e}"),
    })
}

/// 内容层的校验（解析之后再过一遍，见模块头）。
pub fn validate(doc: &CardsDocument) -> Result<(), KbError> {
    if doc.cards.is_empty() {
        return Err(KbError::Extract {
            rel: "（生成输出）".to_string(),
            reason: "一张卡片都没有".to_string(),
        });
    }
    for (i, card) in doc.cards.iter().enumerate() {
        let what = format!("第 {} 张卡片", i + 1);
        if card.title.trim().is_empty() {
            return Err(KbError::Extract {
                rel: what,
                reason: "卡片没有标题".to_string(),
            });
        }
        if card.title.chars().count() > 80 {
            return Err(KbError::Extract {
                rel: what,
                reason: "标题太长（>80 字）".to_string(),
            });
        }
        if card.blocks.is_empty() {
            return Err(KbError::Extract {
                rel: what,
                reason: "卡片一个内容块都没有".to_string(),
            });
        }
        for block in &card.blocks {
            match block {
                Block::Text { text } if text.trim().is_empty() => {
                    return Err(KbError::Extract {
                        rel: what,
                        reason: "有一个空的文字块".to_string(),
                    });
                }
                Block::Seq { seq } if !seq.is_object() => {
                    return Err(KbError::Extract {
                        rel: what,
                        reason: "seq 块不是对象".to_string(),
                    });
                }
                Block::Image { source } if source.trim().is_empty() => {
                    return Err(KbError::Extract {
                        rel: what,
                        reason: "image 块没有给来源文件名".to_string(),
                    });
                }
                _ => {}
            }
        }
    }
    Ok(())
}

/// 把块拼成卡片的 markdown 正文（frontmatter 之外的部分）。
///
/// * text → 原样
/// * seq  → ````seq` 围栏，内容是**紧凑的 JSON 字符串**（前端围栏解析器
///   直接 `JSON.parse` 那一段）
/// * image→ `![[文件名]]`（Obsidian 的嵌入语法）
pub fn blocks_to_markdown(blocks: &[Block]) -> String {
    let mut out = String::new();
    for (i, block) in blocks.iter().enumerate() {
        if i > 0 {
            out.push('\n');
        }
        match block {
            Block::Text { text } => {
                out.push_str(text.trim_end());
                out.push('\n');
            }
            Block::Seq { seq } => {
                out.push_str("```seq\n");
                out.push_str(&seq.to_string());
                out.push_str("\n```\n");
            }
            Block::Image { source } => {
                out.push_str(&format!("![[{}]]\n", source.trim()));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 外面裹解释文字也能切出_json() {
        let text = "好的，这是整理结果：\n```json\n{\"cards\":[{\"title\":\"甲\",\"blocks\":[{\"type\":\"text\",\"text\":\"正文\"}]}]}\n```\n希望有用！";
        let doc = parse_generated(text).unwrap();
        assert_eq!(doc.cards.len(), 1);
        assert_eq!(doc.cards[0].title, "甲");
    }

    #[test]
    fn 连_json_都没有_报错里带原文位置提示() {
        let err = parse_generated("抱歉，我做不到").unwrap_err();
        assert!(err.to_string().contains("连一段 JSON"));
    }

    #[test]
    fn 校验_空卡空块都拦() {
        assert!(validate(&CardsDocument { cards: vec![] }).is_err());
        let empty_block = CardsDocument {
            cards: vec![CardDoc {
                title: "甲".into(),
                tags: vec![],
                sources: vec![],
                blocks: vec![],
            }],
        };
        assert!(validate(&empty_block).is_err());
        let blank_text = CardsDocument {
            cards: vec![CardDoc {
                title: "甲".into(),
                tags: vec![],
                sources: vec![],
                blocks: vec![Block::Text { text: "  ".into() }],
            }],
        };
        assert!(validate(&blank_text).is_err());
    }

    #[test]
    fn 块拼成_markdown_三种块都对() {
        let blocks = vec![
            Block::Text { text: "# 标题\n正文".into() },
            Block::Seq {
                seq: serde_json::json!({"title": "流程", "participants": [], "messages": []}),
            },
            Block::Image { source: "架构图.png".into() },
        ];
        let md = blocks_to_markdown(&blocks);
        assert!(md.contains("# 标题\n正文"));
        assert!(md.contains("```seq\n{"));
        assert!(md.contains("![[架构图.png]]"));
        // seq 围栏里是合法 JSON（前端要 JSON.parse 它）
        let json_part = md
            .split("```seq\n")
            .nth(1)
            .unwrap()
            .split("\n```")
            .next()
            .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(json_part).unwrap();
        assert_eq!(parsed["title"], "流程");
    }
}
