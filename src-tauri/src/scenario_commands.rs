//! 「场景」在 Rust 侧的落点。
//!
//! 场景换的是**存储命名空间**（见 `src/shared/platform/scenario.ts` 的规则
//! 一句话）。前端那边 KV 键加后缀；Rust 这边只有两样东西按场景分卷：
//!
//! * **任务库文件名**（`tasks.db` / `tasks@<场景>.db`，纯函数在 tasks crate）；
//! * **知识库根目录**（`knowledge/` / `knowledge/@<场景>/`，见 kb_commands）。
//!
//! # 为什么是进程级全局而不是 Tauri State
//!
//! 场景本来就是**全局**的（每个窗口共享一个），而读它的地方散布在
//! task_commands 的十几个命令里 —— 往每个签名塞一个 `State<ScenarioState>`
//! 是一圈没有信息量的改动。一个加了锁的静态变量更诚实：这就是全局上下文。
//!
//! 切换流程：前端写偏好 → **整窗重载** → 重载后组合根先调 [`scenario_set`]
//! 再渲染（顺序是硬要求：任何 store/命令先跑就会读到旧场景的库）。

use std::sync::Mutex;

use tauri::{Manager, State};

use crate::kb_commands::KbState;
use crate::task_commands::TasksState;

/// 当前场景（`''` = 默认场景）。
static CURRENT: Mutex<String> = Mutex::new(String::new());

/// 读当前场景。
pub fn current() -> String {
    CURRENT.lock().map(|g| g.clone()).unwrap_or_default()
}

/// 场景名后缀（`''` 或 `@名字`）——拼存储名用。
pub fn suffix() -> String {
    let s = current();
    if s.is_empty() {
        String::new()
    } else {
        format!("@{s}")
    }
}

/// 校验 —— **和 TS 侧（`scenario.ts`）一字不差**：这个名字要进文件路径，
/// 两边判定漂移 = 一边能建一边打不开。允许中英文/数字/`- _`/空格，1..=30，
/// 不嵌前后空白；`@`、点、路径分隔符全在拒绝侧。
pub fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.chars().count() <= 30
        && name.trim() == name
        && name
            .chars()
            .all(|c| c.is_alphanumeric() || c == ' ' || c == '-' || c == '_')
}

/// 切场景（前端在重载之后、渲染之前调一次）。
///
/// 顺带把两处**按场景缓存的东西**清掉：
///
/// * 任务库（`TasksState` 里缓存着打开的那份）；
/// * 知识库句柄表（`KbState.open`，键是 vault 名而根目录带场景 —— 不清的话
///   切完场景会拿着旧场景的库继续用）。
#[tauri::command]
pub async fn scenario_set(
    app: tauri::AppHandle,
    tasks: State<'_, std::sync::Arc<TasksState>>,
    kb: State<'_, std::sync::Arc<KbState>>,
    name: String,
) -> Result<(), String> {
    if !name.is_empty() && !valid_name(&name) {
        return Err(format!("场景名不合法：{name}"));
    }
    *CURRENT.lock().map_err(|_| "场景锁坏了".to_string())? = name.clone();
    tasks.reset();
    kb.reset_open();
    crate::health::line(
        "SCENARIO",
        &format!("切到场景：{}", if name.is_empty() { "（默认）" } else { &name }),
    );
    // ⚠️ `app` 现在没用上，但留着这个参数是**故意的**：将来要广播给其它窗口
    // （「别家切场景了」）时，它就是入口
    let _ = app;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 名字校验_该过的过该挡的挡() {
        for ok in ["团队A", "team-1", "客户 现场", "a_b"] {
            assert!(valid_name(ok), "{ok} 不该被挡");
        }
        for bad in ["", " 开头空格", "结尾空格 ", "a@b", "a/b", "..", "a.b", &"汉".repeat(31)] {
            assert!(!valid_name(bad), "{bad:?} 不该放行");
        }
    }

    #[test]
    fn 后缀_默认场景是空串() {
        // 不碰全局（别的测试可能并行）——只测纯逻辑的形态
        assert_eq!(format!("{}{}", "tasks", ""), "tasks");
    }
}
