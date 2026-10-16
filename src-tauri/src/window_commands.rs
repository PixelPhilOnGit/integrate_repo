//! 多窗口：新建窗口的命令，以及 `main` 和新窗口**共用**的窗口构造器。
//!
//! # 为什么窗口在 Rust 侧建，不让前端 `new WebviewWindow`
//!
//! 主窗口从第一天起就是 builder 建的（`setup` 里，见 `lib.rs` 的长注释）——
//! 因为 `enable_clipboard_access()` **只有 builder 上有**，配置里没有对应项，
//! 而它就是 Windows/Linux 上「Ctrl+V 不被识别为粘贴」的修法。新窗口必须
//! **一模一样地带全这些每窗口的 flag**（clipboard、drag-drop），所以两边走
//! 同一个构造器，而不是让前端用 JS API 再造一个「差不多」的窗口。
//! （Edit 菜单是**应用级**的：新窗口自动继承，它的加速键不用额外做。）
//!
//! # 三件在这里处理掉、别处不用管的事
//!
//! * **label 唯一**：`main` 是 1 号，新窗口从 `win-2` 起原子递增；建之前还查
//!   一次有没有人占着（防双击竞态），占了就下一个。
//! * **`module` 参数的字符白名单**：它会被拼进 `index.html#<module>` 再去
//!   `Url::join` —— `/`、`//`、`..` 这类输入会改变解析结果，所以在进 URL 之前
//!   就要拦掉（前端也按自己的模块表校验一遍，两边都做，六行的事）。
//! * **级联偏移**：从**调用窗口**的位置 +30px 摆新窗口，别叠死在一起；
//!   取不到位置（窗口刚没、平台不给）就退回居中。
//!
//! # 谁能开新窗口
//!
//! 每个窗口都能（`caller` 就是发命令的那个窗口，Tauri 注入）。「在新窗口
//! 打开」的产品语义是**多开各干各的**：新窗口是一份完整的独立实例，
//! 模块级 store、终端 hub、会话映射都各一份 —— 这一层的注释在 HANDOFF 的
//! 「多窗口」一节，和这里的代码是配套的。

use std::sync::atomic::{AtomicU64, Ordering};

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// 级联偏移的步长（逻辑像素）。
const CASCADE_STEP: f64 = 30.0;

/// 下一个窗口 label 的计数器。`main` 在 setup 里独占 1 号，所以从 2 起。
static NEXT_WINDOW: AtomicU64 = AtomicU64::new(2);

fn next_label() -> String {
    format!("win-{}", NEXT_WINDOW.fetch_add(1, Ordering::SeqCst))
}

/// 模块 id 的字符白名单：`^[a-z0-9_-]{1,32}$`。
///
/// 只放小写字母、数字、`-`、`_` —— 现行模块 id（`diagram` / `agents` /
/// `devplaceholder`…）全在这个集合里，而 URL 里有特殊含义的字符
/// （`/`、`:`、`#`、`.`、空格…）全被挡在外面。见模块头。
fn valid_module_param(module: &str) -> bool {
    !module.is_empty()
        && module.len() <= 32
        && module
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
}

/// 开一个新窗口，落在调用者当前的模块上。
#[tauri::command]
pub async fn open_window(
    app: AppHandle,
    caller: WebviewWindow,
    module: String,
) -> Result<(), String> {
    if !valid_module_param(&module) {
        return Err(format!("模块名不合法：{module}"));
    }

    // 计数器不会撞，但 label 可能已经被人占了（快速多次点击的竞态、
    // 或者将来有别的代码也建窗口）—— 占了就让位，不要拿已存在的 label 去建
    //（Tauri 会报 WindowLabelAlreadyExists，那会原样弹给用户，很没必要）
    let label = loop {
        let candidate = next_label();
        if app.get_webview_window(&candidate).is_none() {
            break candidate;
        }
    };

    build_workspace_window(&app, &label, Some(&module), Some(&caller))
        .map(|_| ())
        .map_err(|e| format!("开不了新窗口：{e}"))
}

/// 窗口没了没有？**给「登记归属」用的竞态闸门**（见 `ownership.rs`）。
///
/// ⚠️ 语义要卡准：`None` 意味着它已经从 manager 里摘掉了 —— 窗口正在销毁
/// （或已销毁）。调用方的正确顺序是**先登记、后检查**：检查说没了就
/// close + forget 立刻收掉会话。两种交错都是安全的：
///
/// * 收割（Destroyed）先跑、登记后跑 → 检查必为 false → 我们收掉；
/// * 登记先跑、收割后跑 → 收割的 `take_all` 会拿走这个 id → 收掉。
///
/// 反过来的顺序（先检查后登记）会漏掉第二种交错，别改。
pub(crate) fn window_alive(win: &WebviewWindow) -> bool {
    win.app_handle().get_webview_window(win.label()).is_some()
}

/// `main` 和新窗口共用的构造器。
///
/// 泛型收 `Manager` 而不是具体类型：`setup` 拿到的是 `&mut App`、命令里是
/// `&AppHandle` —— 两者都实现 `Manager<Wry>`，写死任何一个都要在另一处改。
pub(crate) fn build_workspace_window<M: Manager<tauri::Wry>>(
    manager: &M,
    label: &str,
    module: Option<&str>,
    caller: Option<&WebviewWindow>,
) -> tauri::Result<WebviewWindow> {
    let url = match module {
        // `WebviewUrl::App` 内部是 `url.join(path)` —— fragment 会被保留
        // （只有恰好等于 "index.html" 时才会被简化掉），前端从
        // `location.hash` 里读初始模块。
        Some(m) => WebviewUrl::App(format!("index.html#{m}").into()),
        None => WebviewUrl::default(),
    };

    let mut builder = WebviewWindowBuilder::new(manager, label, url)
        .title("Devtoolkit")
        .inner_size(1280.0, 800.0)
        .min_inner_size(900.0, 600.0)
        .resizable(true)
        // ⚠️ 下面这两个是**每窗口**的，新窗口必须重复带（见模块头）
        .disable_drag_drop_handler()
        .enable_clipboard_access();

    builder = match caller {
        // `outer_position` 是**物理**像素，builder 的 position 收**逻辑**坐标 ——
        // 按调用窗口的缩放比换算，否则高 DPI 屏上偏移会缩水
        Some(w) => match (w.outer_position(), w.scale_factor()) {
            (Ok(pos), Ok(scale)) if scale > 0.0 => builder.position(
                pos.x as f64 / scale + CASCADE_STEP,
                pos.y as f64 / scale + CASCADE_STEP,
            ),
            _ => builder.center(),
        },
        None => builder.center(),
    };

    builder.build()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 白名单的守门测试：现行模块 id 全都要过，而 URL 里有含义的字符全要被挡。
    #[test]
    fn 模块白名单_该过的过该挡的挡() {
        for ok in ["diagram", "redis", "sql", "ssh", "agents", "tasks", "assistant", "request", "devplaceholder", "kb-2", "a_b"] {
            assert!(valid_module_param(ok), "{ok} 不该被挡");
        }
        for bad in ["", "A", "agents/../x", "a b", "a.b", "a#b", "a?b", "agents\n", "../", "很长的中文模块名"] {
            assert!(!valid_module_param(bad), "{bad:?} 不该放行");
        }
        assert!(!valid_module_param(&"a".repeat(33)), "超长要挡");
        assert!(valid_module_param(&"a".repeat(32)), "32 恰好可以");
    }

    /// label 递增且不重复（真开窗口要 Tauri 运行时，这里只钉生成规则）。
    #[test]
    fn 窗口_label_从_win_2_起递增() {
        // 进程里可能已经有别的测试动过计数器，所以只断言形状与相对关系
        let a = next_label();
        let b = next_label();
        let num = |s: &str| -> u64 { s.trim_start_matches("win-").parse().expect("win-N 形状") };
        assert!(num(&a) >= 2);
        assert_eq!(num(&b), num(&a) + 1);
    }
}
