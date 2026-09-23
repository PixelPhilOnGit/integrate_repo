//! SSE 解析的**兼容壳**：实现已经搬到 `devtoolkit-request`。
//!
//! 和 `transport.rs` 同一个理由：让 `devtoolkit_assistant::sse::*` 这条路径
//! 不变，助手的 provider 和测试一个字都不用改。
//!
//! 那边是**纯字节状态机**（零 I/O、零 tokio），所以搬过去之后「接口调试」模块
//! 也能直接用它把流式响应解成帧 —— 不必在 TS 里再写一遍那个
//! 「切在半个多字节字符中间」的状态机。

pub use devtoolkit_request::sse::*;
