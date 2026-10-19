//! Devtoolkit 的知识库内核。**文件是真相，索引是派生的。**
//!
//! 一个知识库 = 磁盘上一个目录（vault）：卡片是 markdown 文件 + YAML
//! frontmatter，上传的原件拷进 `_sources/`，附件在 `_files/`；隐藏目录
//! `.devtoolkit/index.db` 只是**派生索引**（搜索/筛选用），删掉它不丢任何
//! 知识（下次进模块时重建）。这同时兑现了「AI 要能直接读它」：库就是一堆
//! 普通 md，任何会话/CLI 直接 grep。
//!
//! 分层和其它内核一样：**不依赖 tauri**（脱离 WebKit/GTK 跑测试），
//! 命令层只做搬运。文件解析（pdf/docx/xlsx）和 CLI runner 都在这个 crate 里。

#![forbid(unsafe_code)]

pub mod blocks;
pub mod error;
pub mod extract;
pub mod frontmatter;
pub mod images;
pub mod index;
pub mod mapping;
pub mod prompt;
pub mod runner;
pub mod timefmt;
pub mod vault;

/// 这个文件现在是个**依赖试装的骨架**：先让全新解析依赖在这台 2 核机上
/// 编过一遍（LanceDB/protoc 的教训），再往里长真东西。
pub fn version_marker() -> &'static str {
    "devtoolkit-knowledge"
}

#[cfg(test)]
mod tests {
    #[test]
    fn 接线自检_这个_crate_真的在被测试() {
        // 照 assistant 的接线自检：新 crate 漏加 default-members 时，
        // 这个测试根本不会跑 —— 至少这里能提醒「加过 members 了吗」
        assert_eq!(super::version_marker(), "devtoolkit-knowledge");
    }
}
