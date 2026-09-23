//! # devtoolkit-request
//!
//! 请求内核：**HTTP/HTTPS 与 WebSocket 客户端**。不依赖 Tauri。
//!
//! # 它从哪儿来
//!
//! 这一层原来长在 `devtoolkit-assistant` 里（`assistant/src/transport.rs`），
//! 是**全仓库唯一碰 socket 的产物代码**。抽出来不是因为「两个模块都要用」，
//! 而是因为**形状不对**：
//!
//! | | 助手要的 | 「接口调试」要的 |
//! |---|---|---|
//! | 方法 | POST 写死 | 任意 |
//! | 响应头 | 丢掉 | **必须要** |
//! | 请求体 | UTF-8 字符串 | 任意字节 |
//! | TLS | 强制校验 | **要能关**（自签证书是天天遇到的） |
//!
//! 复制一份的话，TLS 的 provider 钉死、Host 头怎么算这些**会漂移** ——
//! 而漂移的后果是「偶发地连不上某个内网地址」那种最难查的问题。
//! 抽出来泛化，两份都不要复制，知识只有一处。
//!
//! # 隔离边界
//!
//! 「把可能替换的第三方实现隔离在单文件里」（`portable-pty` 只出现在 `pty.rs`
//! 就是为这个）在这里被拆得更细：
//!
//! * `tls.rs` —— rustls。⚠️ **HTTP 和 WS 共用同一份 `client_config`**，
//!   这是这个 crate 最要紧的一处设计：加密后端必须**显式钉死**（树里 `ring` 和
//!   `aws-lc-rs` 都在，自动挑会返回 `None` 然后在首个 HTTPS 请求 panic），
//!   而「WS 那边自己建一份 config」会是同一个坑的第二个入口。
//! * [`http`] —— hyper + socket。
//! * `ws.rs` —— tokio-tungstenite（还没搬进来）。
//!
//! # 不做什么
//!
//! * **不碰磁盘、不认识 Tauri** —— 和另外几个内核 crate 一样，能脱离 WebKit/GTK 跑测试。
//! * **不管运行时** —— 由调用方提供（Tauri 那边已经有 `tauri::async_runtime`，
//!   自己再起一个是在运行时里套运行时的坑，`ssh` 那一轮记过）。
//! * **不认识任何业务语义** —— 「429 要不要重试」「非 2xx 算不算失败」
//!   都是调用方的判断（助手和调试器在这两件事上答案不同）。

#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod http;
pub mod sse;
pub mod tls;

#[cfg(test)]
mod wiring {
    /// 接线自检：这个 crate 进了 workspace、也进了 `default-members`。
    ///
    /// 这条测试**故意写得没有意义** —— 它存在的唯一理由是让
    /// `cargo test -p devtoolkit-request` 在「刚建好目录」时就能跑起来，
    /// 从而证明 `src-tauri/Cargo.toml` 的 `members` / `default-members` 两处都加对了。
    /// 漏了 `default-members` 的话，这个 crate 的测试会**静默不跑**（README 点过名），
    /// 而那是最难发现的一类错。
    #[test]
    fn crate_is_wired_into_the_workspace() {
        assert_eq!(env!("CARGO_PKG_NAME"), "devtoolkit-request");
        assert!(!env!("CARGO_PKG_VERSION").is_empty());
    }
}
