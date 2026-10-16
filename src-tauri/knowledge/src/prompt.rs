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
//! ⚠️ 改这里的输出契约 = 同时改 `blocks.rs` 的校验和前端渲染器的围栏约定。
//! 测试里有一份**完整示例输出**和它对应的解析结果，先改测试再改这里。

use crate::extract::ExtractOutcome;

/// 相关旧卡片（「查知识库」的命中，最多带几条进提示词）。
pub const RELATED_LIMIT: usize = 8;

/// 一份相关的旧卡片：标题 + 摘要 + 它在库里的相对路径（给 `[[链接]]` 用）。
#[derive(Debug, Clone)]
pub struct RelatedCard {
    pub title: String,
    pub excerpt: String,
    pub rel: String,
}

/// 组装整个提示词。
///
/// `extract` 是原件提取的结果：`Text` 直接进提示词；`None`（图片）把
/// **绝对路径**写进提示词，并留下 `read_files` 给命令层传给 CLI
/// （claude 加 `--add-dir` + Read 工具、codex 加 `-i`）。
pub struct PromptInput<'a> {
    pub source_name: &'a str,
    pub extract: &'a ExtractOutcome,
    /// 图片直读时要递给 CLI 的绝对路径（`ExtractOutcome::None` 时才有）
    pub source_abs: &'a str,
    pub related: &'a [RelatedCard],
    /// 用户在界面上填的补充指示（可为空）
    pub note: &'a str,
}

/// 返回值：提示词本体 + 需要让 CLI 直接读的绝对路径清单（现在最多一个）。
#[derive(Debug, Clone)]
pub struct PromptBundle {
    pub prompt: String,
    pub read_files: Vec<String>,
}

pub fn build(input: &PromptInput<'_>) -> PromptBundle {
    let mut p = String::new();

    p.push_str(
        "你是知识库的整理者。把下面这份资料整理成若干张**知识卡片**。\n\
         \n\
         硬性要求：\n\
         - 只输出一个 JSON 对象，不要任何解释文字、不要 markdown 代码围栏包外层。\n\
         - 中文回答。卡片 1~8 张，按主题拆分（一张卡一件事，别把整份资料塞一张）。\n\
         - 每张卡片的 text 块里写**自包含**的 markdown 正文（读者没看过原文也能懂）。\n\
         - 如果资料来源和「已有知识」相关，在正文里用 [[已有卡片的标题]] 链接过去，\
           不要重复造已经有的内容。\n\
         \n\
         输出 JSON 的形状（严格遵守）：\n\
         {\n\
         \x20 \"cards\": [\n\
         \x20   {\n\
         \x20     \"title\": \"卡片标题（短，一行）\",\n\
         \x20     \"tags\": [\"标签1\", \"标签2\"],\n\
         \x20     \"blocks\": [\n\
         \x20       { \"type\": \"text\", \"text\": \"markdown 正文……\" },\n\
         \x20       { \"type\": \"seq\", \"seq\": { …本仓 .seq.json 的对象… } },\n\
         \x20       { \"type\": \"image\", \"source\": \"图片原件的文件名\" }\n\
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
         - image：引用资料里的图片（source 写文件名）。\n\
         \n",
    );

    if !input.related.is_empty() {
        p.push_str("以下是与这份资料**相关的已有知识卡片**（用 [[标题]] 链接它们）：\n");
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

    p.push_str(&format!("资料名称：{}\n", input.source_name));
    match input.extract {
        ExtractOutcome::Text(text) => {
            p.push_str("资料正文（已提取为文本）：\n<<<资料开始>>>\n");
            p.push_str(text);
            p.push_str("\n<<<资料结束>>>\n");
        }
        ExtractOutcome::None { reason } => {
            p.push_str(&format!(
                "这份资料是图片（{reason}）：请用你的 Read/看图能力直接读取它，\
                 然后按上面的要求整理。\n图片的绝对路径：{}\n",
                input.source_abs
            ));
        }
    }

    let read_files = match input.extract {
        ExtractOutcome::None { .. } => vec![input.source_abs.to_string()],
        ExtractOutcome::Text(_) => Vec::new(),
    };

    PromptBundle {
        prompt: p,
        read_files,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 文本资料_提示词带正文且不需要直读文件() {
        let extract = ExtractOutcome::Text("正文内容 XYZ".into());
        let bundle = build(&PromptInput {
            source_name: "报告.pdf",
            extract: &extract,
            source_abs: "/abs/报告.pdf",
            related: &[],
            note: "",
        });
        assert!(bundle.prompt.contains("资料名称：报告.pdf"));
        assert!(bundle.prompt.contains("正文内容 XYZ"));
        assert!(bundle.prompt.contains("\"cards\""));
        assert!(bundle.prompt.contains("seq"));
        assert!(bundle.read_files.is_empty());
    }

    #[test]
    fn 图片资料_给绝对路径并列入直读清单() {
        let extract = ExtractOutcome::None { reason: "图片没有文本".into() };
        let bundle = build(&PromptInput {
            source_name: "架构图.png",
            extract: &extract,
            source_abs: "/abs/架构图.png",
            related: &[],
            note: "",
        });
        assert!(bundle.prompt.contains("/abs/架构图.png"));
        assert_eq!(bundle.read_files, vec!["/abs/架构图.png"]);
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
        let extract = ExtractOutcome::Text("x".into());
        let bundle = build(&PromptInput {
            source_name: "s.md",
            extract: &extract,
            source_abs: "",
            related: &related,
            note: "重点提取接口约定",
        });
        assert!(bundle.prompt.contains("卡片0"));
        assert!(bundle.prompt.contains("卡片7"));
        assert!(!bundle.prompt.contains("卡片8"), "只带前 8 条");
        assert!(bundle.prompt.contains("重点提取接口约定"));
    }
}
