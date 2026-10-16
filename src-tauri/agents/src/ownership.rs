//! 会话 → 窗口 的归属表：谁起的会话，归谁收。
//!
//! # 为什么需要它
//!
//! 多窗口之前，全局会话表默认「一个 webview 拥有全部会话」足够用 —— 刷新留下的
//! 孤儿会被下一次 `init()` 里的 `close_all` 全收。多窗口之后这个假设塌了：
//!
//! * 新窗口一激活模块就 `close_all` → **会把别的窗口还在跑的 agent 杀掉**；
//! * 关掉一个窗口 → 它名下的进程没人收 → 变成看不见的孤儿
//!   （这个模块的头号大忌，见 crate 文档第 1 条）。
//!
//! 所以每个会话登记时记上「起它的窗口 label」，之后三件事全部按 label 说话：
//! `close_all` 只收自己的、窗口销毁时按 label 收割、事件轮询只取自己的
//! （见 `events::scan_filtered` 和 `agent_commands.rs`）。
//!
//! # 为什么放在这个 crate 而不是 app crate
//!
//! ⚠️ **CI 的 package 列表里没有 app crate**（见 `.github/workflows/release.yml`）。
//! 放这里才测得到 —— 这个文件里的语义（隔离、幂等、取空）全是回归敏感点。
//!
//! # 为什么是纯逻辑、不碰 tauri
//!
//! 和这个 crate 的其它模块同一个理由：脱离 WebKit/GTK 也要能测。
//! 「窗口还在不在」的判断（防「登记晚于销毁」的竞态）在命令层做，
//! 那里本来就有 `AppHandle`。

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

/// `窗口 label -> 它名下的会话 id 集合`。
///
/// 不区分注册表（agents / local / ssh / remote）：id 的前缀本来就是分开的
/// （`pane_*` / `term_*` …），收割时对四个表依次调 `close`，表里没有它是空操作。
#[derive(Debug, Default)]
pub struct WindowOwnership {
    /// 锁只保护这一张表，锁内没有 IO —— 不可能长时间被持有。
    inner: Mutex<HashMap<String, HashSet<String>>>,
}

impl WindowOwnership {
    pub fn new() -> Self {
        Self::default()
    }

    /// 会话起来之后登记。同 id 重复登记是幂等的（重连、代次替换都会走到这里）。
    pub fn register(&self, label: &str, id: &str) {
        let mut map = self.inner.lock().unwrap();
        map.entry(label.to_string()).or_default().insert(id.to_string());
    }

    /// 会话自然结束（转发任务收尾）时注销。
    ///
    /// label 那格空了就删掉 —— 不然开开关关之后表里堆一串空集合。
    /// 窗口销毁时整格已经被 [`Self::take_all`] 摘走了，这里的调用是空操作，
    /// 正好（销毁收割和自然结束会赛跑，两边都必须幂等）。
    pub fn forget(&self, label: &str, id: &str) {
        let mut map = self.inner.lock().unwrap();
        if let Some(set) = map.get_mut(label) {
            set.remove(id);
            if set.is_empty() {
                map.remove(label);
            }
        }
    }

    /// 该窗口名下的会话 id（克隆一份）。事件轮询的过滤集合用的是这个。
    pub fn ids_of(&self, label: &str) -> HashSet<String> {
        let map = self.inner.lock().unwrap();
        map.get(label).cloned().unwrap_or_default()
    }

    /// 摘走整个 label 并返回它的会话 id —— 窗口销毁（`Destroyed`）时用。
    ///
    /// ⚠️ **必须在查到窗口对象之前就用它**：Tauri 把 `Destroyed` 派发给我们之前，
    /// 窗口已经从 manager 里摘掉了，`get_webview_window(label)` 必为 `None`。
    /// 归属表是那个时刻唯一还记得「这个窗口起过什么」的地方。
    pub fn take_all(&self, label: &str) -> Vec<String> {
        let mut map = self.inner.lock().unwrap();
        map.remove(label).map(|set| set.into_iter().collect()).unwrap_or_default()
    }

    /// 表里还剩哪些 label（健康日志/排查用）。
    pub fn labels(&self) -> Vec<String> {
        let map = self.inner.lock().unwrap();
        map.keys().cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn register_and_ids_of() {
        let own = WindowOwnership::new();
        own.register("main", "pane_a");
        own.register("main", "pane_b");
        own.register("win-2", "pane_c");

        let mut main_ids: Vec<_> = own.ids_of("main").into_iter().collect();
        main_ids.sort();
        assert_eq!(main_ids, vec!["pane_a", "pane_b"]);
        assert_eq!(own.ids_of("win-2").len(), 1);
        // 没登记过的窗口是空集，不是错误。
        assert!(own.ids_of("win-9").is_empty());
    }

    #[test]
    fn register_is_idempotent() {
        let own = WindowOwnership::new();
        own.register("main", "pane_a");
        own.register("main", "pane_a");
        assert_eq!(own.ids_of("main").len(), 1);
    }

    #[test]
    fn forget_removes_and_prunes_empty_label() {
        let own = WindowOwnership::new();
        own.register("main", "pane_a");
        own.register("win-2", "pane_b");
        own.forget("main", "pane_a");

        assert!(own.ids_of("main").is_empty());
        assert!(own.labels().is_empty() || !own.labels().contains(&"main".to_string()));
        // 别人的一个都不能动。
        assert_eq!(own.ids_of("win-2").len(), 1);

        // 幂等：再删一次（销毁收割和自然结束赛跑的那条路）。
        own.forget("main", "pane_a");
        own.forget("win-9", "pane_x");
    }

    #[test]
    fn take_all_empties_that_label_only() {
        let own = WindowOwnership::new();
        own.register("main", "pane_a");
        own.register("main", "pane_b");
        own.register("win-2", "pane_c");

        let mut taken = own.take_all("main");
        taken.sort();
        assert_eq!(taken, vec!["pane_a", "pane_b"]);
        // 摘走之后这一格就没了……
        assert!(own.ids_of("main").is_empty());
        assert!(!own.labels().contains(&"main".to_string()));
        // ……但别的窗口一个字没动。
        assert_eq!(own.ids_of("win-2").len(), 1);
        // 再摘一次是空的（Destroyed 只会来一次，但幂等没有坏处）。
        assert!(own.take_all("main").is_empty());
    }

    #[test]
    fn isolation_between_windows() {
        // 这是这个文件存在的理由：两个窗口各干各的，谁都不许动谁的。
        let own = WindowOwnership::new();
        own.register("main", "pane_1");
        own.register("win-2", "pane_2");

        assert!(!own.ids_of("main").contains("pane_2"));
        assert!(!own.ids_of("win-2").contains("pane_1"));
        own.take_all("win-2");
        assert_eq!(own.ids_of("main").len(), 1, "收 win-2 不能碰 main 的会话");
    }
}
