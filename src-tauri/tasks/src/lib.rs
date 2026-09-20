//! Devtoolkit 的任务内核：**一个 SQLite 文件 + 任务的增删改查**。
//!
//! **不依赖 tauri** —— 和另外五个内核一样，能脱离 WebKit/GTK 跑测试
//! （集成测试起一个临时库文件，跑完就删）。
//!
//! # 它是什么、不是什么
//!
//! 是：一条任务从「待办」到「完成」的全部状态，以及一个能放心升级的库文件。
//!
//! 不是：**和 agent 的联动**（把任务派给某个会话、把执行结果回写到任务上）。
//! 那是下一轮的事，用户明确说了「先把任务弄好」。这一轮刻意把它排除在外 ——
//! 先把「事」管起来，数据结构经得起用之后，再往上接执行那条线。
//!
//! # 为什么单独一个 crate
//!
//! 和 `core` / `redis` / `sql` / `ssh` / `agents` 同一个理由：数据库这一层
//! 的测试要跑得快、要能在没有图形环境的机器上跑，而它本身和 Tauri 毫无关系。
//! 路径由命令层算好传进来（`store::TaskStore::open`），这里不认识任何
//! 应用目录的概念。

pub mod error;
pub mod store;

pub use error::TaskError;
pub use store::{Progress, Task, TaskCounts, TaskPatch, TaskStatus, TaskStore};
