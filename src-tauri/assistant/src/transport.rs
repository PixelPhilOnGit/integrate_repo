//! HTTP 传输层在 [`devtoolkit_request`] 里，这里只是**一条稳定的路径**。
//!
//! # 为什么留着这个模块
//!
//! 实现已经整体搬到 `devtoolkit-request`（那是「接口调试」模块和助手**共用**的
//! 一份传输层，理由写在它的 `lib.rs` 头部）。留着这一层转发是为了：
//!
//! * 助手内部（`provider/`）和外部（`src/assistant_commands.rs`、
//!   `tests/provider_stream.rs`）都有一条不依赖 crate 名字的路径 ——
//!   将来传输层再搬一次，改成一行 `pub use` 就行，调用点不动；
//! * 「可能替换的第三方实现隔离在单文件里」这条惯例在助手这边**依然成立**：
//!   `lib.rs` 的文档说的那个「一个文件」，现在指向这一行。
//!
//! ⚠️ **名字用 request crate 那一套**（`HttpRequest` / `HttpTransport` /
//! `HttpError`），这里**不做改名映射**。曾经打算过
//! `HttpRequest as TransportRequest` 这种别名，放弃的理由是：
//! 构造请求的那几个调用点必须改（新形状多了 `method` / `options`，
//! body 从 `String` 变成字节），改了之后构造处写 `HttpRequest::post(...)`、
//! 类型处写 `TransportRequest`，**一个类型两个名字** —— 那比多改几行贵得多。
//!
//! ⚠️ 别在这里加东西。要用传输层就 `use devtoolkit_request::http::...`；
//! 这一层存在的唯一理由是路径稳定，多一行逻辑就多一处漂移点。

pub use devtoolkit_request::http::*;
