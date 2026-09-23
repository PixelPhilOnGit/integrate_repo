//! 传输层的**兼容壳**：实现已经搬到 `devtoolkit-request`。
//!
//! 保留这个模块（而不是让各处直接 `use devtoolkit_request::...`）是为了
//! **`devtoolkit_assistant::transport::*` 这条路径不变** ——
//! `tests/provider_stream.rs`、`src-tauri/src/assistant_commands.rs`、
//! `session.rs` 里的文档链接，一个字都不用改。
//!
//! 搬迁的验收标准就是这一条：**那些文件零改动，而测试全绿**。
//!
//! 为什么搬走（以及为什么不是复制一份）写在 `devtoolkit-request` 的 `lib.rs` 头部 ——
//! 一句话：助手的传输层是给「POST 一段 JSON 拿 SSE 流」定制的，而「接口调试」
//! 模块要的是任意方法、完整响应头、任意字节 body、以及能关掉的证书校验。
//! 复制两份的话，TLS 的 provider 钉死和 Host 头怎么算迟早漂移。
//!
//! ⚠️ 下一步会把它换成**改名映射**（`HttpRequest as TransportRequest` 之类）。
//! 现在先原样转发，让「搬移」和「泛化」分成两个能各自回滚的提交。

pub use devtoolkit_request::http::*;
