//! 提示词里的 `S1..Sn` / `I1..Im` 编号 ↔ 库里的真实 rel 的映射。
//!
//! 模型只该看见编号（文件名可能重名、带时间戳、太长），写卡片时再换回 rel。
//! 这一层是**纯逻辑**：编号怎么排、认不出怎么办、图片引用怎么改写 —— 全部
//! 可以毫秒级穷举。
//!
//! # 宽容策略（不静默，也不因为小错整轮失败）
//!
//! * 卡片的 `sources` 省略 / 全都认不出 → **回落本次全部资料**，并给一条警告；
//! * `sources` 里认不出的 token → 忽略该 token + 警告；
//! * 图片引用认不出 → **替换成一句文字说明**（保证卡片不会因为删掉块而变空），
//!   并给警告；
//! * 同名图片（original_name 重复）**不猜**：要求写 `I<n>` 或完整 rel。
//!
//! 所有警告最终走 `GenEvent.note`，用户看得见。

use crate::blocks::{Block, CardsDocument};
use crate::index::SourceRow;

/// 提示词里一份资料的编号。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceBinding {
    pub id: String,
    pub rel: String,
    pub name: String,
}

/// 提示词里一张图片的编号。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageBinding {
    pub id: String,
    /// vault 相对路径 —— 也是卡片里最终写的 target
    pub rel: String,
    pub original_name: String,
    /// 在 PDF 里的页码（提示词里给模型一个位置线索）
    pub page: Option<u32>,
    /// 归属的资料（图片被引用时自动并进卡片的 sources）
    pub source_rel: String,
}

/// 按「资料顺序 + 每份资料内图片顺序」排编号。
///
/// `S1..Sn` 跟着资料；`I1..Im` 是**全局连续**的（不按资料重新开始）——
/// 模型引用 `I3` 时不用先想它是第几份资料的。
pub fn build_bindings(sources: &[SourceRow]) -> (Vec<SourceBinding>, Vec<ImageBinding>) {
    let mut source_bindings = Vec::with_capacity(sources.len());
    let mut image_bindings = Vec::new();
    let mut image_number = 0usize;

    for (index, source) in sources.iter().enumerate() {
        source_bindings.push(SourceBinding {
            id: format!("S{}", index + 1),
            rel: source.rel.clone(),
            name: source.name.clone(),
        });
        for image in &source.images {
            image_number += 1;
            image_bindings.push(ImageBinding {
                id: format!("I{image_number}"),
                rel: image.rel.clone(),
                original_name: image.original_name.clone(),
                page: image.page,
                source_rel: source.rel.clone(),
            });
        }
    }
    (source_bindings, image_bindings)
}

/// 解析一张卡片的 `sources`。
///
/// 返回 `(rels, warnings)`。空/全认不出 → 本次全部资料（这是刻意的缺省，
/// 单资料时和旧行为完全一致）。
pub fn resolve_card_sources(
    raw: &[String],
    sources: &[SourceBinding],
    extra_rels: &[String],
) -> (Vec<String>, Vec<String>) {
    let mut warnings = Vec::new();
    let mut resolved: Vec<String> = Vec::new();

    for token in raw {
        let token = token.trim();
        if token.is_empty() {
            continue;
        }
        match resolve_source_token(token, sources) {
            Some(rel) => push_unique(&mut resolved, rel),
            None => warnings.push(format!("卡片标了一个认不出的来源「{token}」，已忽略")),
        }
    }

    if resolved.is_empty() {
        for source in sources {
            push_unique(&mut resolved, source.rel.clone());
        }
        // 一条提示就够：token 级的警告已经说明了哪个认不出，不再重复。
        if warnings.is_empty() && !raw.is_empty() {
            warnings.push("卡片的 sources 全都认不出，已按「本次全部资料」处理".to_string());
        }
    }

    // 引用图片但没写所属资料 → 自动并入（否则删来源时卡片引用悬空）。
    for rel in extra_rels {
        if !resolved.contains(rel) {
            resolved.push(rel.clone());
        }
    }

    (resolved, warnings)
}

fn resolve_source_token(token: &str, sources: &[SourceBinding]) -> Option<String> {
    let lower = token.to_ascii_lowercase();
    if let Some(rest) = lower.strip_prefix('s') {
        if let Ok(n) = rest.parse::<usize>() {
            return sources.get(n.checked_sub(1)?).map(|s| s.rel.clone());
        }
    }
    if let Some(rest) = token.strip_prefix("资料") {
        if let Ok(n) = rest.parse::<usize>() {
            return sources.get(n.checked_sub(1)?).map(|s| s.rel.clone());
        }
    }
    sources
        .iter()
        .find(|s| s.name == token || s.rel == token)
        .map(|s| s.rel.clone())
}

/// 把卡片里的 image 块改写成确定的 `_files/<名字>`；认不出的换成文字说明。
pub fn rewrite_images(doc: &mut CardsDocument, images: &[ImageBinding]) -> Vec<String> {
    let mut warnings = Vec::new();
    for card in &mut doc.cards {
        let mut rewritten = Vec::with_capacity(card.blocks.len());
        for block in card.blocks.drain(..) {
            match block {
                Block::Image { source } => match resolve_image_token(&source, images) {
                    Ok(rel) => rewritten.push(Block::Image { source: rel }),
                    Err(reason) => {
                        warnings.push(format!(
                            "卡片「{}」的图片「{}」{reason}，已换成文字说明",
                            card.title,
                            source.trim()
                        ));
                        rewritten.push(Block::Text {
                            text: format!("（图片「{}」没有找到，已略去）", source.trim()),
                        });
                    }
                },
                other => rewritten.push(other),
            }
        }
        card.blocks = rewritten;
    }
    warnings
}

/// 卡片里引用的图片属于哪些资料（并入 sources 用）。
pub fn image_sources_in_card(card: &crate::blocks::CardDoc, images: &[ImageBinding]) -> Vec<String> {
    let mut out = Vec::new();
    for block in &card.blocks {
        if let Block::Image { source } = block {
            let target = source.trim();
            if let Some(binding) = images.iter().find(|i| i.rel == target) {
                if !out.contains(&binding.source_rel) {
                    out.push(binding.source_rel.clone());
                }
            }
        }
    }
    out
}

fn resolve_image_token(token: &str, images: &[ImageBinding]) -> Result<String, String> {
    let token = token.trim();
    if token.is_empty() {
        return Err("没有给图片编号".to_string());
    }

    // I1 / i1 / 图片1
    let lower = token.to_ascii_lowercase();
    if let Some(rest) = lower.strip_prefix('i') {
        if let Ok(n) = rest.parse::<usize>() {
            return match n.checked_sub(1).and_then(|i| images.get(i)) {
                Some(binding) => Ok(binding.rel.clone()),
                None => Err(format!("没有编号 {}", token)),
            };
        }
    }
    if let Some(rest) = token.strip_prefix("图片") {
        if let Ok(n) = rest.parse::<usize>() {
            return match n.checked_sub(1).and_then(|i| images.get(i)) {
                Some(binding) => Ok(binding.rel.clone()),
                None => Err(format!("没有编号 {}", token)),
            };
        }
    }

    // 已经是完整 rel（模型照抄了清单里的路径）
    if let Some(binding) = images.iter().find(|i| i.rel == token) {
        return Ok(binding.rel.clone());
    }

    // 原始文件名：**只有唯一命中才认**，同名不猜。
    let hits: Vec<&ImageBinding> = images
        .iter()
        .filter(|i| i.original_name == token)
        .collect();
    match hits.as_slice() {
        [only] => Ok(only.rel.clone()),
        [] => Err("找不到".to_string()),
        _ => Err("重名了（有多张同名图片，请写 I 编号）".to_string()),
    }
}

fn push_unique(list: &mut Vec<String>, value: String) {
    if !list.contains(&value) {
        list.push(value);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::SourceImage;

    fn source(rel: &str, name: &str, images: &[(&str, &str)]) -> SourceRow {
        SourceRow {
            rel: rel.into(),
            name: name.into(),
            byte_size: 0,
            extract_status: "ok".into(),
            created: String::new(),
            images: images
                .iter()
                .map(|(rel, original)| SourceImage {
                    rel: (*rel).into(),
                    original_name: (*original).into(),
                    page: None,
                })
                .collect(),
            image_note: String::new(),
        }
    }

    fn doc(blocks: Vec<Block>) -> CardsDocument {
        CardsDocument {
            cards: vec![crate::blocks::CardDoc {
                title: "卡".into(),
                tags: vec![],
                sources: vec![],
                blocks,
            }],
        }
    }

    #[test]
    fn 编号_资料按顺序_图片全局连续() {
        let sources = vec![
            source("_sources/a.pdf", "A.pdf", &[("_files/a-1.png", "x.png")]),
            source(
                "_sources/b.pdf",
                "B.pdf",
                &[("_files/b-1.png", "y.png"), ("_files/b-2.jpg", "z.jpg")],
            ),
        ];
        let (s, i) = build_bindings(&sources);
        assert_eq!(s.iter().map(|x| x.id.as_str()).collect::<Vec<_>>(), ["S1", "S2"]);
        assert_eq!(
            i.iter().map(|x| x.id.as_str()).collect::<Vec<_>>(),
            ["I1", "I2", "I3"]
        );
        assert_eq!(i[2].rel, "_files/b-2.jpg");
    }

    #[test]
    fn 卡片来源_缺省或全认不出都回落全部() {
        let sources = vec![
            SourceBinding { id: "S1".into(), rel: "_sources/a".into(), name: "A".into() },
            SourceBinding { id: "S2".into(), rel: "_sources/b".into(), name: "B".into() },
        ];
        let (rels, warnings) = resolve_card_sources(&[], &sources, &[]);
        assert_eq!(rels, ["_sources/a", "_sources/b"]);
        assert!(warnings.is_empty());

        let (rels, warnings) = resolve_card_sources(&["??".into()], &sources, &[]);
        assert_eq!(rels, ["_sources/a", "_sources/b"]);
        assert_eq!(warnings.len(), 1);
    }

    #[test]
    fn 卡片来源_认编号_资料名_rel_并去重保序() {
        let sources = vec![
            SourceBinding { id: "S1".into(), rel: "_sources/a".into(), name: "A.pdf".into() },
            SourceBinding { id: "S2".into(), rel: "_sources/b".into(), name: "B.pdf".into() },
        ];
        let (rels, _) = resolve_card_sources(
            &["S2".into(), "资料1".into(), "A.pdf".into(), "_sources/b".into()],
            &sources,
            &[],
        );
        assert_eq!(rels, ["_sources/b", "_sources/a"]);
    }

    #[test]
    fn 图片引用_认编号和完整_rel_同名不猜() {
        let images = vec![
            ImageBinding { id: "I1".into(), rel: "_files/a-1.png".into(), original_name: "x.png".into(), page: None, source_rel: "_sources/a".into() },
            ImageBinding { id: "I2".into(), rel: "_files/b-1.png".into(), original_name: "dup.png".into(), page: None, source_rel: "_sources/b".into() },
            ImageBinding { id: "I3".into(), rel: "_files/c-1.png".into(), original_name: "dup.png".into(), page: None, source_rel: "_sources/c".into() },
        ];
        assert_eq!(resolve_image_token("I1", &images), Ok("_files/a-1.png".into()));
        assert_eq!(resolve_image_token("i2", &images), Ok("_files/b-1.png".into()));
        assert_eq!(
            resolve_image_token("_files/a-1.png", &images),
            Ok("_files/a-1.png".into())
        );
        assert_eq!(resolve_image_token("x.png", &images), Ok("_files/a-1.png".into()));
        assert!(resolve_image_token("dup.png", &images).is_err());
        assert!(resolve_image_token("I9", &images).is_err());
    }

    #[test]
    fn 改写图片_认不出换成文字说明并警告() {
        let images = vec![ImageBinding {
            id: "I1".into(),
            rel: "_files/a-1.png".into(),
            original_name: "x.png".into(),
            page: None,
            source_rel: "_sources/a".into(),
        }];
        let mut d = doc(vec![
            Block::Image { source: "I1".into() },
            Block::Image { source: "不存在.png".into() },
        ]);
        let warnings = rewrite_images(&mut d, &images);
        assert_eq!(
            d.cards[0].blocks[0],
            Block::Image { source: "_files/a-1.png".into() }
        );
        assert!(matches!(&d.cards[0].blocks[1], Block::Text { text } if text.contains("已略去")));
        assert_eq!(warnings.len(), 1);
    }

    #[test]
    fn 引用图片所属资料自动并入_sources() {
        let images = vec![ImageBinding {
            id: "I1".into(),
            rel: "_files/b-1.png".into(),
            original_name: "x.png".into(),
            page: None,
            source_rel: "_sources/b".into(),
        }];
        let d = doc(vec![Block::Image { source: "_files/b-1.png".into() }]);
        let sources = vec![
            SourceBinding { id: "S1".into(), rel: "_sources/a".into(), name: "A".into() },
            SourceBinding { id: "S2".into(), rel: "_sources/b".into(), name: "B".into() },
        ];
        let extra = image_sources_in_card(&d.cards[0], &images);
        let (rels, _) = resolve_card_sources(&["S1".into()], &sources, &extra);
        assert_eq!(rels, ["_sources/a", "_sources/b"]);
    }
}
