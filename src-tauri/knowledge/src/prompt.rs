//! 生成提示词的组装：**这是「知识长什么样」唯一的出口**。
//!
//! 三条设计约束（都是用户拍板或实跑验证过的）：
//!
//! 1. **输出是 JSON 卡片数组**（严格契约见下），后端正则切出第一个 `{` 到
//!    最后一个 `}` 再解析 —— 模型爱在外面裹解释文字，别为这个判失败。
//! 2. **时序图用本仓的 `.seq.json` 格式**（`seq` 围栏）：mermaid 在这个仓库里
//!    只有导出方向、没有导入渲染，让模型产出 mermaid 我们画不出来。所以
//!    schema 和例子直接钉进提示词。
//! 3. **「查知识库」的结果带进来**（相关旧卡片的标题+摘要）：提示词要求链接
//!    已有知识、别重复造。
//!
//! # 多份资料（v0.18.0）
//!
//! 资料编号 `S1..Sn`、图片编号 `I1..Im`（全局连续）。用户拍板的语义是
//! 「多个文件的内容可能相互组合成一个卡片」，所以提示词明确允许**跨资料合成**，
//! 每张卡用 `sources: ["S1","S2"]` 标注来源；省略 = 本次全部资料。
//!
//! ⚠️ 改这里的输出契约 = 同时改 `mapping.rs` 的解析、`blocks.rs` 的校验和
//! 前端渲染器的围栏约定。测试里有一份**完整示例输出**和它对应的解析结果，
//! 先改测试再改这里。
//!
//! # 预算
//!
//! 单份资料最多 [`crate::extract::MAX_CHARS`]（120k 字符）；多份资料按
//! [`MAX_TOTAL_CHARS`] 公平分配，每份不低于 [`MIN_PER_SOURCE_CHARS`]。
//! 不能 120k × n 相加 —— 那会把模型上下文撑爆。

use crate::extract::{clamp_chars, ExtractOutcome};
use crate::mapping::{ImageBinding, SourceBinding};

/// 一次最多整理这么多份资料（再多不如分批）。
pub const MAX_SOURCES: usize = 12;

/// 相关旧卡片（「查知识库」的命中，最多带几条进提示词）。
pub const RELATED_LIMIT: usize = 8;

/// 多份资料拼起来的总字符预算。
pub const MAX_TOTAL_CHARS: usize = 240_000;

/// 多份时每份资料的最低配额（预算再紧也要让它说几句）。
pub const MIN_PER_SOURCE_CHARS: usize = 20_000;

/// 一份相关的旧卡片：标题 + 摘要 + 它在库里的相对路径（给 `[[链接]]` 用）。
#[derive(Debug, Clone)]
pub struct RelatedCard {
    pub title: String,
    pub excerpt: String,
    pub rel: String,
}

/// 提示词里的一份资料。
pub struct PromptSource<'a> {
    pub binding: &'a SourceBinding,
    /// 文本或「没有文本（图片）」——后者把绝对路径交给 CLI 直读
    pub extract: &'a ExtractOutcome,
    pub source_abs: &'a str,
    /// 属于这份资料的图片（编号已经全局排好）
    pub images: &'a [ImageBinding],
    /// 抽图时的一句人话说明（空串 = 没什么要说的）
    pub image_note: &'a str,
}

pub struct PromptInput<'a> {
    pub sources: &'a [PromptSource<'a>],
    pub related: &'a [RelatedCard],
    /// 用户在界面上填的补充指示（可为空）
    pub note: &'a str,
}

/// 返回值：提示词本体 + 需要让 CLI 直接读的绝对路径清单。
#[derive(Debug, Clone)]
pub struct PromptBundle {
    pub prompt: String,
    pub read_files: Vec<String>,
}

/// 每份资料的字符配额（公平分配，见模块头）。
fn per_source_budget(count: usize) -> usize {
    if count == 0 {
        return crate::extract::MAX_CHARS;
    }
    (MAX_TOTAL_CHARS / count).clamp(MIN_PER_SOURCE_CHARS, crate::extract::MAX_CHARS)
}

pub fn build(input: &PromptInput<'_>) -> PromptBundle {
    let mut p = String::new();
    let budget = per_source_budget(input.sources.len());

    p.push_str(
        "你是知识库的整理者。把下面的资料整理成若干张**知识卡片**。\n\
         \n\
         硬性要求：\n\
         - 只输出一个 JSON 对象，不要任何解释文字、不要 markdown 代码围栏包外层。\n\
         - 中文回答。卡片 1~8 张，按主题拆分（一张卡一件事，别把整份资料塞一张）。\n\
         - 每张卡片的 text 块里写**自包含**的 markdown 正文（读者没看过原文也能懂）。\n\
         - **多份资料可以综合**：同一个主题跨资料时合成一张卡，并在 sources 里\n\
           列出用到的资料编号（例如 [\"S1\", \"S2\"]）；省略 sources = 本次全部资料。\n\
         - 如果资料和「已有知识」相关，在正文里用 [[已有卡片的标题]] 链接过去，\n\
           不要重复造已经有的内容。\n\
         \n\
         输出 JSON 的形状（严格遵守）：\n\
         {\n\
         \x20 \"cards\": [\n\
         \x20   {\n\
         \x20     \"title\": \"卡片标题（短，一行）\",\n\
         \x20     \"tags\": [\"标签1\", \"标签2\"],\n\
         \x20     \"sources\": [\"S1\"],\n\
         \x20     \"blocks\": [\n\
         \x20       { \"type\": \"text\", \"text\": \"markdown 正文……\" },\n\
         \x20       { \"type\": \"seq\", \"seq\": { …本仓 .seq.json 的对象… } },\n\
         \x20       { \"type\": \"image\", \"source\": \"I1\" }\n\
         \x20     ]\n\
         \x20   }\n\
         \x20 ]\n\
         }\n\
         \n\
         blocks 说明：\n\
         - text：最常用。markdown（标题/列表/代码块都行）。\n\
         - seq：**只有当资料描述了一个清晰的流程/交互时序**时才用。格式是本仓的\n\
           顺序图 JSON，例子（照这个形状来，participants 与 messages 必给）：\n\
         {\"title\":\"登录流程\",\"participants\":[{\"id\":\"p1\",\"name\":\"用户\"},{\"id\":\"p2\",\"name\":\"服务端\"}],\"messages\":[{\"from\":\"p1\",\"to\":\"p2\",\"text\":\"POST /login\"},{\"from\":\"p2\",\"to\":\"p1\",\"text\":\"200 + token\"}]}\n\
         - image：引用下面列出的图片编号（source 写 `I1` 这种编号，或完整文件名）。\n\
         \n",
    );

    if !input.related.is_empty() {
        p.push_str("以下是与这些资料**相关的已有知识卡片**（用 [[标题]] 链接它们）：\n");
        for card in input.related.iter().take(RELATED_LIMIT) {
            p.push_str(&format!(
                "- 《{}》（{}）：{}\n",
                card.title,
                card.rel,
                card.excerpt.chars().take(120).collect::<String>()
            ));
        }
        p.push('\n');
    }

    if !input.note.trim().is_empty() {
        p.push_str("用户对这次整理的补充要求（优先满足）：\n");
        p.push_str(input.note.trim());
        p.push_str("\n\n");
    }

    let mut read_files: Vec<String> = Vec::new();
    for source in input.sources {
        p.push_str(&format!(
            "===== {}：{} =====\n",
            source.binding.id, source.binding.name
        ));
        match source.extract {
            ExtractOutcome::Text(text) => {
                p.push_str("资料正文（已提取为文本）：\n");
                p.push_str(&format!("<<<{} 正文开始>>>\n", source.binding.id));
                p.push_str(&clamp_chars(text.clone(), budget));
                p.push_str(&format!("\n<<<{} 正文结束>>>\n", source.binding.id));
            }
            ExtractOutcome::None { reason } => {
                p.push_str(&format!(
                    "这份资料是图片（{reason}）：请用你的 Read/看图能力直接读取它。\n\
                     图片的绝对路径：{}\n",
                    source.source_abs
                ));
                if !read_files.iter().any(|f| f == source.source_abs) {
                    read_files.push(source.source_abs.to_string());
                }
            }
        }

        if !source.images.is_empty() {
            p.push_str("可引用图片：\n");
            for image in source.images {
                let where_ = match image.page {
                    Some(page) => format!("第{page}页，"),
                    None => String::new(),
                };
                p.push_str(&format!(
                    "- {}（{}{}）\n",
                    image.id, where_, image.original_name
                ));
            }
        }
        if !source.image_note.trim().is_empty() {
            p.push_str(&format!(
                "注意：{}；这些图不可引用。\n",
                source.image_note.trim()
            ));
        }
        p.push('\n');
    }

    p.push_str(&format!(
        "本次共 {} 份资料（S1..S{}）。\n",
        input.sources.len(),
        input.sources.len()
    ));

    PromptBundle {
        prompt: p,
        read_files,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::extract::MAX_CHARS;

    fn binding(id: &str, rel: &str, name: &str) -> SourceBinding {
        SourceBinding {
            id: id.into(),
            rel: rel.into(),
            name: name.into(),
        }
    }

    fn image(id: &str, rel: &str, original: &str, source_rel: &str) -> ImageBinding {
        ImageBinding {
            id: id.into(),
            rel: rel.into(),
            original_name: original.into(),
            page: None,
            source_rel: source_rel.into(),
        }
    }

    #[test]
    fn 单份文本资料_提示词带编号正文且不需要直读() {
        let b = binding("S1", "_sources/a.pdf", "报告.pdf");
        let extract = ExtractOutcome::Text("正文内容 XYZ".into());
        let bundle = build(&PromptInput {
            sources: &[PromptSource {
                binding: &b,
                extract: &extract,
                source_abs: "/abs/报告.pdf",
                images: &[],
                image_note: "",
            }],
            related: &[],
            note: "",
        });
        assert!(bundle.prompt.contains("===== S1：报告.pdf ====="));
        assert!(bundle.prompt.contains("正文内容 XYZ"));
        assert!(bundle.prompt.contains("\"cards\""));
        assert!(bundle.prompt.contains("\"sources\""));
        assert!(bundle.prompt.contains("seq"));
        assert!(bundle.read_files.is_empty());
    }

    #[test]
    fn 图片资料_给绝对路径并列入直读清单() {
        let b = binding("S1", "_sources/a.png", "架构图.png");
        let extract = ExtractOutcome::None {
            reason: "图片没有文本".into(),
        };
        let bundle = build(&PromptInput {
            sources: &[PromptSource {
                binding: &b,
                extract: &extract,
                source_abs: "/abs/架构图.png",
                images: &[],
                image_note: "",
            }],
            related: &[],
            note: "",
        });
        assert!(bundle.prompt.contains("/abs/架构图.png"));
        assert_eq!(bundle.read_files, vec!["/abs/架构图.png"]);
    }

    #[test]
    fn 多份资料_各自编号_图片编号全局连续() {
        let s1 = binding("S1", "_sources/a.pdf", "A.pdf");
        let s2 = binding("S2", "_sources/b.pdf", "B.pdf");
        let e1 = ExtractOutcome::Text("甲的内容".into());
        let e2 = ExtractOutcome::Text("乙的内容".into());
        let i1 = image("I1", "_files/a-img-1.png", "image1.png", "_sources/a.pdf");
        let i2 = image("I2", "_files/b-img-1.jpg", "page.jpg", "_sources/b.pdf");

        let bundle = build(&PromptInput {
            sources: &[
                PromptSource {
                    binding: &s1,
                    extract: &e1,
                    source_abs: "",
                    images: std::slice::from_ref(&i1),
                    image_note: "",
                },
                PromptSource {
                    binding: &s2,
                    extract: &e2,
                    source_abs: "",
                    images: std::slice::from_ref(&i2),
                    image_note: "",
                },
            ],
            related: &[],
            note: "",
        });
        assert!(bundle.prompt.contains("===== S1：A.pdf ====="));
        assert!(bundle.prompt.contains("===== S2：B.pdf ====="));
        assert!(bundle.prompt.contains("可引用图片：\n- I1"));
        assert!(bundle.prompt.contains("- I2"));
        assert!(bundle.prompt.contains("本次共 2 份资料"));
    }

    #[test]
    fn 图片跳过的说明会进提示词() {
        let b = binding("S1", "_sources/a.pdf", "A.pdf");
        let e = ExtractOutcome::Text("x".into());
        let bundle = build(&PromptInput {
            sources: &[PromptSource {
                binding: &b,
                extract: &e,
                source_abs: "",
                images: &[],
                image_note: "另有 2 张图片未能提取（JPX（扫描件））",
            }],
            related: &[],
            note: "",
        });
        assert!(bundle.prompt.contains("不可引用"));
        assert!(bundle.prompt.contains("JPX"));
    }

    #[test]
    fn 多份资料按总预算公平截断_不会_120k_乘以_n() {
        let s1 = binding("S1", "_sources/a.md", "a.md");
        let s2 = binding("S2", "_sources/b.md", "b.md");
        let long1 = "甲".repeat(MAX_CHARS + 1000);
        let long2 = "乙".repeat(MAX_CHARS + 1000);
        let e1 = ExtractOutcome::Text(long1);
        let e2 = ExtractOutcome::Text(long2);
        let bundle = build(&PromptInput {
            sources: &[
                PromptSource { binding: &s1, extract: &e1, source_abs: "", images: &[], image_note: "" },
                PromptSource { binding: &s2, extract: &e2, source_abs: "", images: &[], image_note: "" },
            ],
            related: &[],
            note: "",
        });
        let budget = per_source_budget(2);
        assert_eq!(budget, MAX_TOTAL_CHARS / 2);
        // 每份都截到 budget（内容 + 省略标记，不能按 120k 全给）
        let jia = bundle.prompt.matches('甲').count();
        assert!(jia <= budget, "甲有 {jia} 个，预算 {budget}");
        assert!(bundle.prompt.contains("已截断") || bundle.prompt.contains("省略"));
    }

    #[test]
    fn 相关卡片和用户指示都进提示词_且截到上限() {
        let related: Vec<RelatedCard> = (0..20)
            .map(|i| RelatedCard {
                title: format!("卡片{i}"),
                excerpt: "摘要".into(),
                rel: format!("目录/卡片{i}.md"),
            })
            .collect();
        let b = binding("S1", "_sources/s.md", "s.md");
        let extract = ExtractOutcome::Text("x".into());
        let bundle = build(&PromptInput {
            sources: &[PromptSource {
                binding: &b,
                extract: &extract,
                source_abs: "",
                images: &[],
                image_note: "",
            }],
            related: &related,
            note: "重点提取接口约定",
        });
        assert!(bundle.prompt.contains("卡片0"));
        assert!(bundle.prompt.contains("卡片7"));
        assert!(!bundle.prompt.contains("卡片8"), "只带前 8 条");
        assert!(bundle.prompt.contains("重点提取接口约定"));
    }
}
