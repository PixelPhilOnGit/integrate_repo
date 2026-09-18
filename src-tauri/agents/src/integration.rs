//! 「应用自动写入配置」：把状态钩子装进 Claude Code / Codex 的配置文件。
//!
//! # ⚠️ 安全模型：这是唯一改**工作区之外**文件的地方
//!
//! 这个仓库里别的路径操作全在工作区沙箱里（见 README 的「安全模型」）。
//! 这里要写的是**用户主目录**里的文件，套不上沙箱 —— 所以换个做法：
//!
//! **路径完全由 Rust 侧自己算出来，前端只能传一个枚举值。**
//! [`IntegrationTarget`] 只有 `claude` / `codex` 两个变体，`match` 之后各自
//! 拼到 `home` 上（[`AgentPaths`] 由 Tauri 那层用系统 API 求出来）。
//! 前端**没有任何办法**让我们去写第三个路径 —— 这不是靠约定，
//! 是这个类型里没有第三个值。
//!
//! # 三个必须做到的动作
//!
//! * **备份**：改之前把原文件原样留一份带时间戳的（[`apply`] 返回它的路径）
//! * **预览**：给出「改了什么」的可读文本，让用户在点「启用」之前能看见
//! * **撤销**：把我们加进去的那几条**精确**摘掉，不碰用户的其它配置
//!
//! # 幂等
//!
//! 重复启用是**更新**我们那几条，不是追加第二份。「我们那几条」的判据是
//! 命令里含有 [`HOOK_SCRIPT_STEM`]（`devtoolkit-hook`）—— 用脚本名而不是
//! 完整路径，是因为应用数据目录本身可能会变（换机器、改用户名），
//! 而用户手改过的条目也要认得出来（那是「改动过」而不是「没有」）。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::error::AgentError;

/// 包装脚本的名字前缀。**同时是「这条钩子是不是我们装的」的判据**。
pub const HOOK_SCRIPT_STEM: &str = "devtoolkit-hook";

/// 前端能选的目标。
///
/// 只有这两个值，所以路径不可能被前端带偏。多一个变体就多一条能写的路径 ——
/// 加之前请先想清楚为什么。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum IntegrationTarget {
    Claude,
    Codex,
}

impl IntegrationTarget {
    pub fn as_str(self) -> &'static str {
        match self {
            IntegrationTarget::Claude => "claude",
            IntegrationTarget::Codex => "codex",
        }
    }
}

/// 集成当前的状态。**这个枚举就是 IPC 契约**（见 `contract` 测试）。
///
/// 五个值里 `missing` 和 `absent` **刻意分开**：用户看到的文案完全不同
/// （「还没建过配置」vs「配置在，但状态检测没开」），合并了就没法说清楚。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum IntegrationState {
    /// 配置文件还不存在（启用 = 新建它）
    Missing,
    /// 文件在，但没有我们的条目（启用 = 新增）
    Absent,
    /// 已经装好了，而且和我们此刻会写的一模一样（启用是空操作）
    Installed,
    /// 有我们的痕迹，但和此刻会写的不一样：应用数据目录搬过、包装脚本被删了、
    /// 或者**用户自己手改过**。启用会把它更新成当前这份（原文件先备份）
    Modified,
    /// **不是我们能安全改的形状**（不是合法 JSON / hooks 不是对象 / notify 是多行的）
    /// —— 拒绝写入，`preview` 里说的是原因。
    ///
    /// 单独一个状态而不是 `Err`：这是**用户能看到并自己修好**的情况
    /// （打开文件改一处就行），弹一条外壳错误条反而帮不上忙。
    Unusable,
}

/// [`status`] 的返回。**IPC 契约**。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationStatus {
    /// 原样回显调用方传进来的那个目标。**前端拿同一个对象去路由**，
    /// 不用自己在外面记「这次问的是哪个」
    pub target: IntegrationTarget,
    /// 目标配置文件的绝对路径（前端只拿来显示和展示给用户，不参与决策）
    pub path: String,
    pub state: IntegrationState,
    /// 「改了什么」的可读文本。**状态和预览是一起给的**：只有状态的话，
    /// 用户看到「改动过」也不知道到底哪里不一样。
    /// `unusable` 时这里是**原因**
    pub preview: String,
}

/// [`apply`] / [`revert`] 的返回。**IPC 契约**。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationOutcome {
    /// 同 [`IntegrationStatus::target`]
    pub target: IntegrationTarget,
    pub path: String,
    /// 备份文件的路径。**`null` 表示没有备份**，两种情况：原文件本来就不存在
    /// （没什么可备份的）、或者这是 `revert`（撤销本身就是「回到没有我们之前」，
    /// 而原文件在 `apply` 时已经备过一份了）。
    /// **不是「备份失败了」** —— 那种情况是 `Err`
    pub backup_path: Option<String>,
    pub preview: String,
}

/// 这个模块要用到的两个目录。
///
/// 由 Tauri 那层求出来（`app_data_dir` + 用户主目录），**不从前端来** ——
/// 见模块头那段安全模型。
#[derive(Debug, Clone)]
pub struct AgentPaths {
    /// 用户主目录：`~` / `%USERPROFILE%`
    pub home: PathBuf,
    /// 应用数据目录：包装脚本写在这里
    pub data_dir: PathBuf,
}

impl AgentPaths {
    /// ⚠️ **两个目录都必须是绝对路径。**
    ///
    /// 这不是洁癖：这套代码会 `create_dir_all` 加写文件，而**相对路径是相对
    /// 进程的工作目录**解析的。测试里写一个 `C:\Users\me\...` 这种「装作 Windows」
    /// 的相对路径，在 Linux 上就会在当前目录下建出一个**叫这个名字的目录**
    /// —— 真发生过一次（crate 目录里躺着一个
    /// `C:\Users\me\AppData\Roaming\com.devtoolkit.desktop\`），而且它不报错。
    /// 在 Windows 上更糟：那会**写进用户真实的 AppData**。
    ///
    /// 命令层传进来的一定是绝对的（`home_dir()` / `app_data_dir()`），
    /// 所以这条只会拦住测试和将来的调用方写错。
    pub fn ensure_absolute(&self) -> Result<(), AgentError> {
        for dir in [&self.home, &self.data_dir] {
            if !dir.is_absolute() {
                return Err(AgentError::Integration {
                    path: dir.display().to_string(),
                    reason: "内部错误：主目录/数据目录必须是绝对路径（相对路径会写到\
                             进程当前目录里去）"
                        .to_string(),
                });
            }
        }
        Ok(())
    }

    /// `~/.claude/settings.json`（Windows 是 `%USERPROFILE%\.claude\settings.json`，
    /// 同一个表达式 —— `join` 会按平台用对分隔符）
    pub fn claude_settings(&self) -> PathBuf {
        self.home.join(".claude").join("settings.json")
    }

    /// `~/.codex/config.toml`
    pub fn codex_config(&self) -> PathBuf {
        self.home.join(".codex").join("config.toml")
    }

    pub fn target_path(&self, target: IntegrationTarget) -> PathBuf {
        match target {
            IntegrationTarget::Claude => self.claude_settings(),
            IntegrationTarget::Codex => self.codex_config(),
        }
    }

    /// 包装脚本的绝对路径。
    pub fn hook_script(&self) -> PathBuf {
        self.data_dir.join(hook_script_name())
    }

    /// 把包装脚本写出来（应用数据目录不存在就建）。返回它的路径。
    ///
    /// **每次 apply 都重写一遍**：脚本是我们生成的、跟着版本走的东西，
    /// 升级之后得跟着更新。用户改它没有意义（下次 apply 就没了），
    /// 这一点脚本自己的注释里也写了。
    pub fn write_hook_script(&self) -> Result<PathBuf, AgentError> {
        let path = self.hook_script();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| AgentError::Integration {
                path: parent.display().to_string(),
                reason: format!("建目录失败：{e}"),
            })?;
        }
        write_atomic(&path, hook_script_contents()).map_err(|e| AgentError::Integration {
            path: path.display().to_string(),
            reason: format!("写包装脚本失败：{e}"),
        })?;

        // ⚠️ Unix 上**必须**给它可执行位：配置里那条命令是
        // `"<脚本路径>" working`，shell 会直接 exec 这个路径，
        // 没有 +x 的话每次钩子都是「Permission denied」
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755));
        }

        Ok(path)
    }
}

/// 包装脚本的文件名。**平台不同**：Windows 上必须是 `.cmd`
/// （`cmd.exe` 只认批处理；`.sh` 在那儿得先有 bash）。
pub fn hook_script_name() -> &'static str {
    if cfg!(windows) {
        "devtoolkit-hook.cmd"
    } else {
        "devtoolkit-hook.sh"
    }
}

/// 包装脚本的内容。
///
/// 它的职责只有一件：**在 Devtoolkit 起的 pane 里**，把状态写成一个文件。
/// 所以第一件事是判断自己是不是在那个环境里 —— 用户在自己的终端里跑
/// `claude` 的时候这两个环境变量是不存在的，那时候**必须安静地退出**：
/// 报错会打在用户的终端上，而他根本没在做和 Devtoolkit 有关的事。
///
/// 状态名从第一个参数取（Claude 的钩子配置里写死，Codex 的 `notify`
/// 数组里第二个元素就是它）。
pub fn hook_script_contents() -> &'static str {
    if cfg!(windows) {
        // ⚠️ 这个字符串里**每一行都必须是 CRLF**。批处理文件用 LF 换行时
        // `goto`/标号的行为会变得不可预测（有的版本直接跑飞）。
        concat!(
            "@echo off\r\n",
            "rem Devtoolkit 生成的状态钩子 —— 别手改，重新启用会被覆盖。\r\n",
            "rem 用法：devtoolkit-hook.cmd <working|waiting|done>\r\n",
            "rem 这两个变量由 Devtoolkit 起的窗格注入；在别的终端里跑 claude 时\r\n",
            "rem 它们不存在，那时必须安静退出（不能往用户终端里打错误）。\r\n",
            "if \"%DEVTOOLKIT_PANE_ID%\"==\"\" exit /b 0\r\n",
            "if \"%DEVTOOLKIT_EVENT_DIR%\"==\"\" exit /b 0\r\n",
            "set \"dtk_state=%~1\"\r\n",
            "if \"%dtk_state%\"==\"working\" goto dtk_write\r\n",
            "if \"%dtk_state%\"==\"waiting\" goto dtk_write\r\n",
            "if \"%dtk_state%\"==\"done\" goto dtk_write\r\n",
            "exit /b 0\r\n",
            ":dtk_write\r\n",
            "rem 目录正常情况下应用已经建好了；这里兜底，免得它被清掉之后\r\n",
            "rem 每一次钩子都往用户终端里打一句「系统找不到指定的路径」。\r\n",
            "if not exist \"%DEVTOOLKIT_EVENT_DIR%\" mkdir \"%DEVTOOLKIT_EVENT_DIR%\" 2>nul\r\n",
            "type nul > \"%DEVTOOLKIT_EVENT_DIR%\\%dtk_state%.%DEVTOOLKIT_PANE_ID%\" 2>nul\r\n",
            "exit /b 0\r\n",
        )
    } else {
        concat!(
            "#!/bin/sh\n",
            "# Devtoolkit 生成的状态钩子 —— 别手改，重新启用会被覆盖。\n",
            "# 用法：devtoolkit-hook.sh <working|waiting|done>\n",
            "#\n",
            "# 这两个变量由 Devtoolkit 起的窗格注入；在别的终端里跑 claude 时\n",
            "# 它们不存在，那时必须安静退出（不能往用户终端里打错误）。\n",
            "if [ -z \"$DEVTOOLKIT_PANE_ID\" ] || [ -z \"$DEVTOOLKIT_EVENT_DIR\" ]; then\n",
            "  exit 0\n",
            "fi\n",
            "\n",
            "state=\"$1\"\n",
            "case \"$state\" in\n",
            "  working|waiting|done) ;;\n",
            "  *) exit 0 ;;\n",
            "esac\n",
            "\n",
            "# 目录正常情况下应用已经建好了；这里兜底，免得它被清掉之后每一次钩子\n",
            "# 都往用户终端里打一句「cannot create ...: Directory nonexistent」。\n",
            "mkdir -p \"$DEVTOOLKIT_EVENT_DIR\" 2>/dev/null\n",
            "\n",
            "# 状态在文件名里，时间戳靠文件自己的 mtime —— 脚本一个字都不用生成。\n",
            "# `: >` 的作用是「创建或清空」，所以同一个状态报第二次也是一条新事件。\n",
            "#\n",
            "# ⚠️ 外面那层括号是必要的：重定向失败时说话的是 **shell 自己**，\n",
            "# 写在命令后面的 `2>/dev/null` 拦不住它（实测过：dash 会把那句\n",
            "# 「Directory nonexistent」直接打到用户的终端上）。放进子 shell 里、\n",
            "# 由子 shell 带着重定向去执行，那句话才真的被吞掉。\n",
            "( : > \"$DEVTOOLKIT_EVENT_DIR/$state.$DEVTOOLKIT_PANE_ID\" ) 2>/dev/null\n",
            "exit 0\n",
        )
    }
}

/// 一个要装的钩子事件。
struct HookSpec {
    /// Claude Code 的事件名（写进 `hooks` 对象当键）
    event: &'static str,
    /// 写文件时用的状态名（脚本的第一个参数）
    state: &'static str,
    /// 事件的 matcher。`None` = 不加这个字段（`Stop` / `UserPromptSubmit`
    /// 本来就不看 matcher，加了只是噪音）
    matcher: Option<&'static str>,
}

/// 四个事件各管一件事，合起来正好覆盖状态机要的全部信号：
///
/// * `UserPromptSubmit` —— 用户提交了提示 → `working`
/// * `PermissionRequest` —— **它在等你拍板**（权限弹窗一出现就触发）→ `waiting`。
///   这是**主力**：它是即时的。
/// * `Notification` —— 兜底那一路：matcher 只认 `idle_prompt`（干完了你 60 秒没动）。
///   ⚠️ 官方对 `permission_prompt` 类型的说明是「要等约 6 秒，而且只在你看起来
///   离开了终端时才发」—— 所以等授权这件事**不能**靠它，靠 `PermissionRequest`。
/// * `Stop` —— 这一回合干完了 → `done`
///
/// ⚠️ **`UserPromptSubmit` 和 `Stop` 不支持 matcher**（官方表格里明确写着
/// no matcher support），给它们写 matcher 是**死配置**：不报错，也不生效。
/// 只有 `Notification` 这类要写。
///
/// ⚠️ **Codex 那边 `notify` 只有「回合结束」这一路**（它只有一个枚举变体
/// `agent-turn-complete`），所以 Codex 的 `working` / `waiting` 目前只能靠终端
/// 通知序列兜底。这是官方能力的边界，不是我们没接 —— 要三态齐全得改用
/// Codex 的 hooks 体系（它会走信任审阅，见 HANDOFF）。
const CLAUDE_HOOKS: [HookSpec; 4] = [
    HookSpec {
        event: "UserPromptSubmit",
        state: "working",
        matcher: None,
    },
    HookSpec {
        event: "PermissionRequest",
        state: "waiting",
        matcher: None,
    },
    HookSpec {
        event: "Notification",
        state: "waiting",
        matcher: Some("idle_prompt"),
    },
    HookSpec {
        event: "Stop",
        state: "done",
        matcher: None,
    },
];

/// Codex 的 `notify` 只有一个事件：回合结束。
///
/// # ⚠️ 下一轮要切到 Codex 的 hooks 体系，切之前先确认两件事
///
/// Codex **有**一套和 Claude 对齐的 hooks（0.149.0 的二进制里能抠出来：
/// `user_prompt_submit` / `permission_request` / `stop` / `pre_tool_use` / …，
/// 引擎文件叫 `hooks/src/engine/command_runner.rs`），也就是说三态能齐全，
/// 而现在这条 `notify` 只给得了 `done`（它只有一个枚举变体
/// `agent-turn-complete`，payload 是**追加在 argv 最后一个元素**上的 JSON）。
///
/// **这一轮刻意还用 `notify`**：它不需要用户做任何额外动作就生效，而 hooks
/// 要用户先去 `/hooks` 里审阅并信任一次，而且**信任按 hook 定义的哈希记账** ——
/// 我们以后每改一次配置他都得重审一次。
///
/// 切之前必须先确认（这两件都只有 Windows 真机能答）：
/// 1. 配置写哪儿：`~/.codex/hooks.json`，还是 config.toml 里的 `[hooks]` 表？
/// 2. 信任怎么落盘（那份哈希记在哪个文件里），以及我们改了配置之后
///    界面上要提示什么。
///
/// 切的时候上面的 `CLAUDE_HOOKS` 那张表可以基本照搬（事件名是一样的），
/// 但**别把 `notify` 删掉**：老版本 Codex 没有 hooks，`notify` 是它们的唯一一条路。
const CODEX_STATE: &str = "done";

/// Claude 那边一条钩子长什么样。
///
/// # 一律用 **exec 形式**（`command` + `args`），两个平台都是
///
/// 两条路摆在这儿：
///
/// * **shell 形式**（不写 `args`）＝ 把整条命令串交给 shell 解析。
///   `"C:\路径\hook.cmd" waiting` 这种写法**只在 cmd 里成立**：PowerShell 里
///   带引号的路径必须加 `&` 调用运算符，Git Bash 里根本跑不了 `.cmd`。
///   而 Claude Code 用哪个 shell 取决于**机器上有没有装 Git Bash**
///   （官方说明：默认 bash，Windows 上没装 Git Bash 时用 PowerShell）
///   —— 也就是同一份配置在不同机器上行为不同。
/// * **exec 形式**（写了 `args`）＝ 直接 spawn 可执行文件，**不过任何 shell、
///   不做分词**（官方对 `args` 的描述原话），这时 `shell` 字段被忽略。
///   路径里的空格、引号、`$`、反引号都不再经过 shell 解析器。
///
/// 我们选后者：它把「用户装没装 Git Bash」这个变量整个消掉。
/// 代价是路径必须是**可执行文件**（Unix 上的 `.sh` 要有 +x 和 shebang ——
/// `AgentPaths::write_hook_script` 会补上可执行位）。
fn claude_entry(paths: &AgentPaths, state: &str) -> Value {
    let script = paths.hook_script().display().to_string();
    let mut entry = Map::new();
    entry.insert("type".to_string(), json!("command"));
    entry.insert("command".to_string(), json!(script));
    entry.insert("args".to_string(), json!([state]));
    Value::Object(entry)
}

/// 一个 matcher 组（事件的数组元素）。
fn claude_group(paths: &AgentPaths, spec: &HookSpec) -> Value {
    let mut group = Map::new();
    if let Some(matcher) = spec.matcher {
        group.insert("matcher".to_string(), json!(matcher));
    }
    group.insert("hooks".to_string(), json!([claude_entry(paths, spec.state)]));
    Value::Object(group)
}

/// 这条钩子条目是不是我们装的。判据是命令里有没有 [`HOOK_SCRIPT_STEM`]。
fn is_ours(entry: &Value) -> bool {
    entry
        .get("command")
        .and_then(Value::as_str)
        .is_some_and(|c| c.contains(HOOK_SCRIPT_STEM))
}

/// 在一个事件的数组里找我们那条钩子，返回 `(组下标, 组内下标)`。
fn find_ours(arr: &[Value]) -> Option<(usize, usize)> {
    for (gi, group) in arr.iter().enumerate() {
        let Some(hooks) = group.get("hooks").and_then(Value::as_array) else {
            continue;
        };
        for (hi, entry) in hooks.iter().enumerate() {
            if is_ours(entry) {
                return Some((gi, hi));
            }
        }
    }
    None
}

/// 某个事件现在的样子：有没有我们的痕迹、那一组是不是**完全**符合预期。
fn event_state(hooks: Option<&Value>, paths: &AgentPaths, spec: &HookSpec) -> (bool, bool) {
    let Some(arr) = hooks.and_then(Value::as_array) else {
        return (false, false);
    };
    let Some((gi, hi)) = find_ours(arr) else {
        return (false, false);
    };
    let group = &arr[gi];
    // ⚠️ 两边都要摊平成 `Option<&str>` 再比。写成
    // `group.get("matcher").map(as_str) == Some(spec.matcher)` 的话，
    // 「本来就没有 matcher」的事件会变成 `None == Some(None)` = false ——
    // 于是刚装好的配置立刻被判成「改动过」（这个坑真踩了一次）
    let matcher_ok = group.get("matcher").and_then(|m| m.as_str()) == spec.matcher;
    // 组内的 matcher 也要对：用户把 `Notification` 的 matcher 改宽了，
    // 那是「改过」，不是「装好了」—— 预览里要能说出来
    let entry_ok = group
        .get("hooks")
        .and_then(Value::as_array)
        .and_then(|hs| hs.get(hi))
        .is_some_and(|e| *e == claude_entry(paths, spec.state));
    (true, matcher_ok && entry_ok)
}

/// 读一个文本文件。不存在返回 `None`（这是**正常**情况：用户还没配过）。
fn read_if_exists(path: &Path) -> Result<Option<String>, AgentError> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(AgentError::Integration {
            path: path.display().to_string(),
            reason: format!("读不出来：{e}"),
        }),
    }
}

/// 原子写：先写同目录的临时文件再 rename。
///
/// 同目录是为了保证 rename 不出跨卷（跨卷的 rename 会失败）。
/// 直接往目标文件上写的话，写到一半崩了用户就得到一个**半截的配置文件** ——
/// 那是能把人的编辑器配置弄丢的那种坏法。
///
/// 父目录不存在就先建出来：`~/.claude/` 和 `~/.codex/` 在「用户还没配过」的
/// 机器上是不存在的，而「第一次启用」恰恰是最常见的路径。
fn write_atomic(path: &Path, contents: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_file_name(format!(
        ".{}.devtoolkit-tmp-{}",
        path.file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "config".to_string()),
        std::process::id()
    ));
    std::fs::write(&tmp, contents)?;
    std::fs::rename(&tmp, path)
}

/// 备份原文件，返回备份的路径。原文件不存在时返回 `None`。
///
/// 备份放在**原文件旁边**（不是应用数据目录）：用户哪天要手工恢复，
/// 会先去看那个配置文件所在的地方，而不是去翻我们的数据目录。
fn backup(path: &Path, contents: &str) -> Result<PathBuf, AgentError> {
    let stamp = utc_stamp();
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "config".to_string());
    let backup = path.with_file_name(format!("{name}.devtoolkit-{stamp}.bak"));
    std::fs::write(&backup, contents).map_err(|e| AgentError::Integration {
        path: backup.display().to_string(),
        reason: format!("写备份失败：{e}"),
    })?;
    Ok(backup)
}

/// `20260918-112233Z`（**UTC**）。
///
/// 用 UTC 是因为不想为了本地时区拖一个时间库进来；文件名里的 `Z` 明说了这件事。
/// 定宽所以按名字排序 == 按时间排序。
fn utc_stamp() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let (y, mo, d, h, mi, s) = civil_from_unix(secs);
    format!("{y:04}{mo:02}{d:02}-{h:02}{mi:02}{s:02}Z")
}

/// Unix 秒 → 年月日时分秒（UTC）。
///
/// 手算而不是拉时间库：这是唯一用到日期的地方，为它多一个依赖不划算。
/// 算法是 Howard Hinnant 的 `civil_from_days`（把 1970-01-01 换成 0000-03-01
/// 起点，闰年规则就变成一条直线）。
fn civil_from_unix(secs: u64) -> (i64, u32, u32, u32, u32, u32) {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (h, mi, s) = ((rem / 3600) as u32, ((rem % 3600) / 60) as u32, (rem % 60) as u32);

    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d, h, mi, s)
}

// ---------------------------------------------------------------------------
// Claude Code：settings.json
// ---------------------------------------------------------------------------

/// 解析 Claude 的 settings.json。
///
/// 顶层不是对象、或者 JSON 语法坏了 → **不猜、不硬改**：用户手写坏了的
/// 配置文件，我们拿字符串拼一拼是能把那条命令塞进去，但结果是他的文件更坏了。
/// 这种情况返回「读不懂」而不是 `Err`（`status` 要能把它显示出来，
/// 见 [`IntegrationState::Unusable`]）。
enum ParsedSettings {
    /// 可以安全改
    Ok(Value),
    /// 读不懂 —— 原因是给用户看的那句话
    Unusable(String),
}

fn read_claude(text: &str) -> ParsedSettings {
    if text.trim().is_empty() {
        // 空文件按「还没有配置」处理：Claude Code 自己也接受空文件
        return ParsedSettings::Ok(json!({}));
    }
    match serde_json::from_str::<Value>(text) {
        Ok(v) if v.is_object() => ParsedSettings::Ok(v),
        Ok(_) => ParsedSettings::Unusable("顶层不是一个 JSON 对象".to_string()),
        Err(e) => ParsedSettings::Unusable(format!("它不是合法的 JSON：{e}")),
    }
}

/// 三个事件各自「有没有痕迹 / 是不是完全符合预期」。
///
/// 顺带把「形状对不对」也判了：`hooks` 不是对象、某个事件不是数组，
/// 都属于「我们不该动它」。
fn claude_scan(settings: &Value, paths: &AgentPaths) -> Result<(usize, bool), String> {
    let hooks = match settings.get("hooks") {
        None => return Ok((0, false)),
        Some(h) => h,
    };
    let Some(hooks) = hooks.as_object() else {
        return Err("里面的 hooks 不是一个对象".to_string());
    };

    let mut traces = 0usize;
    let mut exact = true;
    for spec in &CLAUDE_HOOKS {
        if let Some(slot) = hooks.get(spec.event) {
            if slot.as_array().is_none() {
                return Err(format!("hooks.{} 不是一个数组", spec.event));
            }
        }
        let (has_trace, is_exact) = event_state(hooks.get(spec.event), paths, spec);
        if has_trace {
            traces += 1;
        }
        if !is_exact {
            exact = false;
        }
    }
    Ok((traces, exact))
}

/// 包装脚本还在不在、内容对不对。装好的配置 + 丢了的脚本 = **不能用**，
/// 所以它参与 [`IntegrationState::Installed`] 的判定。
fn script_is_current(paths: &AgentPaths) -> bool {
    std::fs::read_to_string(paths.hook_script()).is_ok_and(|c| c == hook_script_contents())
}

fn claude_preview(
    paths: &AgentPaths,
    path: &Path,
    state: IntegrationState,
    unusable_reason: &str,
) -> String {
    let script = paths.hook_script().display().to_string();
    let what = CLAUDE_HOOKS
        .iter()
        .map(|s| format!("  {} → {}（{}）", s.event, s.state, state_label(s.state)))
        .collect::<Vec<_>>()
        .join("\n");

    match state {
        IntegrationState::Installed => format!(
            "已经装好了，不需要改动。\n文件：{}\n包装脚本：{}\n三个事件都指着它：\n{}",
            path.display(),
            script,
            what
        ),
        IntegrationState::Missing => format!(
            "{} 还不存在，启用时会新建它。\n会写入三个事件钩子（其余配置不受影响）：\n{}\n\
             每个钩子就是一条命令：\"{}\" <状态>",
            path.display(),
            what,
            script
        ),
        IntegrationState::Absent => format!(
            "会往 {} 里增加三个事件钩子：\n{}\n\
             你原有的 hooks 和其它设置原样保留。\n命令：\"{}\" <状态>",
            path.display(),
            what,
            script
        ),
        IntegrationState::Modified => {
            let mut text = format!(
                "⚠️ {} 里已经有一份 Devtoolkit 的钩子，但和当前这份不一样\
                 （应用数据目录变过、包装脚本被删了、或者你手改过）。\n\
                 启用会把它更新成：\n{}\n命令：\"{}\" <状态>\n\
                 改动之前会先把原文件备份一份。",
                path.display(),
                what,
                script
            );
            if !script_is_current(paths) {
                text.push_str("\n（包装脚本也不在了或者内容变过，会一起重写。）");
            }
            text
        }
        // ⚠️ 这里**不报错**：这是用户自己能修好的情况（打开文件改一处），
        // 弹一条外壳错误条他也不知道该改什么。把原因说出来，让他自己动手
        IntegrationState::Unusable => format!(
            "{} 我们不敢改：{}\n\
             （Devtoolkit 只认识「一个 JSON 对象里有一个 hooks 对象」这种形状；\
             别的形状下我们没法保证不弄坏你的其它配置。）\n\
             想用的话请先手工把它改成那个形状，或者按下面这样自己加一行：\n\
             命令：\"{}\" <状态>",
            path.display(),
            unusable_reason,
            script
        ),
    }
}

fn state_label(state: &str) -> &'static str {
    match state {
        "working" => "正在干活，别打扰",
        "waiting" => "需要你介入",
        "done" => "这一回合干完了",
        _ => "",
    }
}

// ---------------------------------------------------------------------------
// Codex：config.toml
// ---------------------------------------------------------------------------

/// 我们在 `config.toml` 里那一行长什么样。
fn codex_line(paths: &AgentPaths) -> String {
    format!(
        "notify = [{}, {}]",
        toml_basic_string(&paths.hook_script().display().to_string()),
        toml_basic_string(CODEX_STATE)
    )
}

/// 把一个字符串写成 TOML 的 basic string（双引号）。
///
/// ⚠️ **Windows 上非做不可**：路径里的 `\` 在 TOML 里是转义符，
/// `"C:\Users\x"` 会直接解析失败（`\U` 不是合法转义）。写成 `\\` 才对。
fn toml_basic_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}

/// 从 `notify = [...]` 这一行里把字符串值抠出来（basic 和 literal 两种写法都认）。
///
/// 自己写而不是上 TOML 解析器，是因为**这一层只做行级编辑**：
/// 上解析器就得整篇重排用户的文件（注释、格式全没了），那比不编辑还糟。
fn parse_toml_string_array(value: &str) -> Option<Vec<String>> {
    let mut out = Vec::new();
    let mut chars = value.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' => {
                let mut s = String::new();
                loop {
                    match chars.next()? {
                        '"' => break,
                        '\\' => {
                            // 只处理最常见的那几个转义。剩下的按「原样」留下 ——
                            // 我们的目的是**比对**，不是完整实现 TOML
                            match chars.next()? {
                                '\\' => s.push('\\'),
                                '"' => s.push('"'),
                                'n' => s.push('\n'),
                                't' => s.push('\t'),
                                'r' => s.push('\r'),
                                other => {
                                    s.push('\\');
                                    s.push(other);
                                }
                            }
                        }
                        other => s.push(other),
                    }
                }
                out.push(s);
            }
            '\'' => {
                let mut s = String::new();
                loop {
                    match chars.next()? {
                        '\'' => break,
                        other => s.push(other),
                    }
                }
                out.push(s);
            }
            '#' => break, // 行尾注释
            _ => {}
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

/// 一行是不是**根键** `notify` 的赋值（不是 `[表]` 里的，也不是 `notify_x =`）。
fn is_notify_key(line: &str) -> bool {
    let t = line.trim_start();
    let Some(rest) = t.strip_prefix("notify") else {
        return false;
    };
    matches!(rest.trim_start().strip_prefix('='), Some(_))
}

/// 在文件里找根级 `notify`。
///
/// ⚠️ **TOML 的根键必须写在任何 `[表]` 之前** —— 往文件尾追加一行
/// `notify = [...]` 的话，它会被当成**最后那张表里的键**，Codex 读的是根上的
/// `notify`，于是那行"写进去了但永远不生效"。这也是为什么找不到就插到最前面。
///
/// 返回 `(起始行, 结束行(含), 是不是多行)`。
fn find_notify(text: &str) -> Option<(usize, usize, bool)> {
    let lines: Vec<&str> = text.lines().collect();
    let mut in_table = false;
    for (i, line) in lines.iter().enumerate() {
        let t = line.trim_start();
        if t.starts_with('[') {
            in_table = true;
            continue;
        }
        // 只看根区（第一张表之前）。表里同名的键和我们无关
        if in_table || !is_notify_key(line) {
            continue;
        }
        // 数组跨行的话（用户手写的）一直找到收尾的 `]` 为止，
        // 但**只在根区里找**、而且有上界 —— 找不到就当它是个我们读不懂的写法
        if line.contains(']') {
            return Some((i, i, false));
        }
        for (j, next) in lines.iter().enumerate().skip(i + 1).take(20) {
            if next.trim_start().starts_with('[') {
                break;
            }
            if next.contains(']') {
                return Some((i, j, true));
            }
        }
        return None;
    }
    None
}

/// 插入位置：**第一行不是注释也不是空行的地方**。
///
/// 也就是「根键区的最前面」。放文件头（哪怕在注释之前）也满足 TOML 的规则，
/// 但用户的文件开头往往有一句「这是我的配置，别乱改」之类的话，
/// 把我们的行塞到它前面显得很没礼貌 —— 而且那也是他会先看到的位置。
fn insert_at(lines: &[&str]) -> usize {
    lines
        .iter()
        .position(|l| {
            let t = l.trim_start();
            !t.is_empty() && !t.starts_with('#')
        })
        .unwrap_or(lines.len())
}

/// 当前 config.toml 的状态。
fn codex_state(text: &str, paths: &AgentPaths) -> IntegrationState {
    match find_notify(text) {
        None => IntegrationState::Absent,
        // 多行的那种**我们不猜它的边界**（猜错会把用户配置的其它部分一起吃掉）
        // —— 那是「不敢改」，不是「改过」
        Some((_, _, true)) => IntegrationState::Unusable,
        Some((start, end, false)) => {
            let lines: Vec<&str> = text.lines().collect();
            let value = lines[start..=end].join("\n");
            let ours = parse_toml_string_array(&value);
            let want = vec![
                paths.hook_script().display().to_string(),
                CODEX_STATE.to_string(),
            ];
            if ours.as_deref() == Some(want.as_slice()) {
                IntegrationState::Installed
            } else {
                IntegrationState::Modified
            }
        }
    }
}

fn codex_preview(paths: &AgentPaths, path: &Path, state: IntegrationState) -> String {
    let line = codex_line(paths);
    match state {
        IntegrationState::Installed => format!(
            "已经装好了，不需要改动。\n文件：{}\n这一行：{line}",
            path.display()
        ),
        IntegrationState::Missing => format!(
            "{} 还不存在，启用时会新建它，只写这一行：\n{line}\n\
             （Codex 只有「回合结束」这一个钩子事件，所以状态里只有「已完成」是它报的。）",
            path.display()
        ),
        IntegrationState::Absent => format!(
            "会往 {} 的最前面加一行：\n{line}\n\
             ⚠️ TOML 的根键必须写在任何 [表] 之前 —— 追加到文件尾的话它会变成\
             最后那张表里的键，Codex 读不到，看起来「配好了」却永远不生效。\n\
             你原有的配置一行不动。",
            path.display()
        ),
        IntegrationState::Modified => format!(
            "⚠️ {} 里已经有一行 notify，但值不是我们写的那份\
             （应用数据目录变过，或者你手改过）。\n启用会把它换成：\n{line}\n\
             改动之前会先把原文件备份一份。",
            path.display()
        ),
        IntegrationState::Unusable => format!(
            "{} 里的 notify 是**多行**写的，Devtoolkit 不会去猜它的边界\
             （猜错会把你配置里别的部分一起吃掉）。\n\
             请先手工把它改成一行（或者删掉），再点启用。想要的值是：\n{line}",
            path.display()
        ),
    }
}

// ---------------------------------------------------------------------------
// 对外三个动作
// ---------------------------------------------------------------------------

/// 看一眼现在是装好的 / 没装 / 装过但变了。**不改任何东西**。
///
/// 「文件读不懂」**不是** `Err` —— 那是个用户能看到、也能自己修好的状态
/// （[`IntegrationState::Unusable`]），原因写在 `preview` 里。
/// `Err` 留给「连文件都读不了」（权限、IO）。
pub fn status(paths: &AgentPaths, target: IntegrationTarget) -> Result<IntegrationStatus, AgentError> {
    paths.ensure_absolute()?;
    let path = paths.target_path(target);
    let Some(text) = read_if_exists(&path)? else {
        return Ok(IntegrationStatus {
            target,
            path: path.display().to_string(),
            state: IntegrationState::Missing,
            preview: match target {
                IntegrationTarget::Claude => {
                    claude_preview(paths, &path, IntegrationState::Missing, "")
                }
                IntegrationTarget::Codex => codex_preview(paths, &path, IntegrationState::Missing),
            },
        });
    };

    let (state, unusable_reason) = match target {
        IntegrationTarget::Claude => match read_claude(&text) {
            ParsedSettings::Unusable(reason) => (IntegrationState::Unusable, Some(reason)),
            ParsedSettings::Ok(settings) => match claude_scan(&settings, paths) {
                Err(reason) => (IntegrationState::Unusable, Some(reason)),
                Ok((traces, exact)) => {
                    let state = if traces == 0 {
                        IntegrationState::Absent
                    } else if exact && script_is_current(paths) {
                        IntegrationState::Installed
                    } else {
                        IntegrationState::Modified
                    };
                    (state, None)
                }
            },
        },
        IntegrationTarget::Codex => {
            let mut state = codex_state(&text, paths);
            // 包装脚本也在判定里：脚本丢了的话「装好了」是假的
            // （配置指着的是一个不存在的文件，钩子永远不生效）
            if state == IntegrationState::Installed && !script_is_current(paths) {
                state = IntegrationState::Modified;
            }
            (state, None)
        }
    };

    let preview = match target {
        IntegrationTarget::Claude => {
            claude_preview(paths, &path, state, unusable_reason.as_deref().unwrap_or(""))
        }
        IntegrationTarget::Codex => codex_preview(paths, &path, state),
    };

    Ok(IntegrationStatus {
        target,
        path: path.display().to_string(),
        state,
        preview,
    })
}

/// 装上（或者更新）。**幂等**：重复调用得到同样的结果，不会追加第二份。
///
/// 顺序是「**先算、再备份、再写脚本、最后写配置**」：
/// 算不出来（文件读不懂）就一个字节都不动；备份失败的话后面一步都不做
/// （宁可没装上，也不能改坏了还没备份）；脚本先写好，配置里那条命令
/// 指向的就是一个已经存在的文件。
pub fn apply(
    paths: &AgentPaths,
    target: IntegrationTarget,
) -> Result<IntegrationOutcome, AgentError> {
    paths.ensure_absolute()?;
    let path = paths.target_path(target);
    let original = read_if_exists(&path)?;

    let (new_text, preview) = match target {
        IntegrationTarget::Claude => {
            let mut settings = match original.as_deref().map(read_claude) {
                Some(ParsedSettings::Ok(v)) => v,
                Some(ParsedSettings::Unusable(reason)) => {
                    return Err(AgentError::Integration {
                        path: path.display().to_string(),
                        reason: format!(
                            "{reason}。Devtoolkit 不会去改一个读不懂的文件 —— \
                             请先修好它，或者手工加上钩子。"
                        ),
                    })
                }
                None => json!({}),
            };
            let (added, updated) = merge_claude(paths, &mut settings)?;
            let text = serde_json::to_string_pretty(&settings).map_err(|e| {
                AgentError::Integration {
                    path: path.display().to_string(),
                    reason: format!("序列化失败：{e}"),
                }
            })?;
            let text = format!("{text}\n");
            let what = match (added, updated) {
                (0, n) => format!("已更新 {n} 个事件钩子"),
                (n, 0) => format!("已新增 {n} 个事件钩子"),
                (a, u) => format!("已新增 {a} 个、更新 {u} 个事件钩子"),
            };
            let preview = format!(
                "{what}。\n文件：{}\n命令：\"{}\" <状态>",
                path.display(),
                paths.hook_script().display()
            );
            (text, preview)
        }
        IntegrationTarget::Codex => {
            let text = original.clone().unwrap_or_default();
            let (new_text, replaced) = merge_codex(paths, &text)?;
            let preview = format!(
                "已{} config.toml 里的 notify（{}）。\n文件：{}",
                if replaced { "更新" } else { "新增" },
                codex_line(paths),
                path.display()
            );
            (new_text, preview)
        }
    };

    // 备份（原文件不存在就没什么可备的）
    let backup_path = match &original {
        Some(text) => Some(backup(&path, text)?),
        None => None,
    };

    // 包装脚本（配置里那条命令指着它）
    paths.write_hook_script()?;

    write_atomic(&path, &new_text).map_err(|e| AgentError::Integration {
        path: path.display().to_string(),
        reason: format!("写失败：{e}"),
    })?;

    Ok(IntegrationOutcome {
        target,
        path: path.display().to_string(),
        backup_path: backup_path.map(|p| p.display().to_string()),
        preview,
    })
}

/// 把我们加的那几条**精确摘掉**，不碰用户的其它配置。
///
/// 刻意**不从备份恢复**：用户很可能在启用之后又改了自己的配置，
/// 拿一份旧备份整个盖回去会把他后来的改动一起抹掉。所以只摘我们认得的那些条目
/// （判据还是命令里有没有 [`HOOK_SCRIPT_STEM`]）。被我们替换掉的原值还能从
/// 备份里找回来 —— `apply` 的返回值里有它的路径。
///
/// 包装脚本**留着不删**：它不占地方，而且在环境变量缺失时就是一句 exit，
/// 万一别处还引用着它（用户自己配的钩子），删掉反而会弄坏东西。
pub fn revert(paths: &AgentPaths, target: IntegrationTarget) -> Result<IntegrationOutcome, AgentError> {
    paths.ensure_absolute()?;
    let path = paths.target_path(target);
    let done = |preview: String| IntegrationOutcome {
        target,
        path: path.display().to_string(),
        // 撤销**不备份**：它自己就是「回到没有我们之前」的动作，
        // 而原文件在 apply 的时候已经备过一份了
        backup_path: None,
        preview,
    };

    let Some(original) = read_if_exists(&path)? else {
        // 文件都没了，那本来也没什么可撤的。**幂等**
        return Ok(done(format!(
            "{} 不存在，没有需要撤销的东西。",
            path.display()
        )));
    };

    let (new_text, removed) = match target {
        IntegrationTarget::Claude => {
            if original.trim().is_empty() {
                return Ok(done(format!("{} 是空的，没有需要撤销的东西。", path.display())));
            }
            let mut settings = match read_claude(&original) {
                ParsedSettings::Ok(v) => v,
                ParsedSettings::Unusable(reason) => {
                    return Err(AgentError::Integration {
                        path: path.display().to_string(),
                        reason: format!("{reason}，没法精确撤销。"),
                    })
                }
            };
            let removed = remove_claude(&mut settings);
            let text = format!(
                "{}\n",
                serde_json::to_string_pretty(&settings).map_err(|e| AgentError::Integration {
                    path: path.display().to_string(),
                    reason: format!("序列化失败：{e}"),
                })?
            );
            (text, removed)
        }
        IntegrationTarget::Codex => match find_notify(&original) {
            None => {
                return Ok(done(format!(
                    "{} 里没有 Devtoolkit 装的 notify，没有需要撤销的东西。",
                    path.display()
                )))
            }
            Some((start, end, _)) => {
                let lines: Vec<&str> = original.lines().collect();
                let mut kept: Vec<&str> = Vec::with_capacity(lines.len());
                kept.extend_from_slice(&lines[..start]);
                kept.extend_from_slice(&lines[end + 1..]);
                let mut text = kept.join("\n");
                if original.ends_with('\n') || !text.is_empty() {
                    text.push('\n');
                }
                (text, 1)
            }
        },
    };

    write_atomic(&path, &new_text).map_err(|e| AgentError::Integration {
        path: path.display().to_string(),
        reason: format!("写失败：{e}"),
    })?;

    Ok(done(format!(
        "已撤掉 {removed} 条 Devtoolkit 加的配置。你原有的设置一行没动。\n文件：{}",
        path.display()
    )))
}

/// 把三个钩子并进 settings.json。返回 `(新增, 更新)` 的条数。
fn merge_claude(paths: &AgentPaths, settings: &mut Value) -> Result<(usize, usize), AgentError> {
    let root = settings.as_object_mut().ok_or_else(|| AgentError::Integration {
        path: "settings.json".to_string(),
        reason: "顶层不是一个 JSON 对象。".to_string(),
    })?;

    let hooks = root
        .entry("hooks".to_string())
        .or_insert_with(|| json!({}));
    let hooks = hooks.as_object_mut().ok_or_else(|| AgentError::Integration {
        path: "settings.json".to_string(),
        reason: "里面的 hooks 不是一个对象，Devtoolkit 不会动它。".to_string(),
    })?;

    let mut added = 0;
    let mut updated = 0;
    for spec in &CLAUDE_HOOKS {
        let slot = hooks
            .entry(spec.event.to_string())
            .or_insert_with(|| json!([]));
        let arr = slot.as_array_mut().ok_or_else(|| AgentError::Integration {
            path: "settings.json".to_string(),
            reason: format!("hooks.{} 不是一个数组。", spec.event),
        })?;

        match find_ours(arr) {
            Some((gi, hi)) => {
                // **就地更新**我们那一组：用户在同一个组里塞的别的钩子
                // （他可能把好几个命令并进一个 matcher 组）不能动
                if let Some(group) = arr.get_mut(gi) {
                    if let Some(matcher) = spec.matcher {
                        group["matcher"] = json!(matcher);
                    }
                    if let Some(entry) = group
                        .get_mut("hooks")
                        .and_then(Value::as_array_mut)
                        .and_then(|h| h.get_mut(hi))
                    {
                        *entry = claude_entry(paths, spec.state);
                    }
                }
                updated += 1;
            }
            None => {
                arr.push(claude_group(paths, spec));
                added += 1;
            }
        }
    }
    Ok((added, updated))
}

/// 把钩子从 settings.json 里摘掉。摘空了的组/事件键一起清掉，
/// 免得留一堆空的 `"Stop": []` 在用户文件里。返回摘掉了几条。
fn remove_claude(settings: &mut Value) -> usize {
    let mut removed = 0;
    let Some(hooks) = settings.get_mut("hooks").and_then(Value::as_object_mut) else {
        return removed;
    };
    for spec in &CLAUDE_HOOKS {
        let Some(arr) = hooks.get_mut(spec.event).and_then(Value::as_array_mut) else {
            continue;
        };
        // 从后往前走，删除时下标不会乱
        for gi in (0..arr.len()).rev() {
            let empty_group = {
                let Some(group) = arr.get_mut(gi) else { continue };
                let Some(entry_list) = group.get_mut("hooks").and_then(Value::as_array_mut) else {
                    continue;
                };
                let before = entry_list.len();
                entry_list.retain(|e| !is_ours(e));
                removed += before - entry_list.len();
                // 组里原本有东西、现在空了 → 这个组是我们加进去的，一起删掉
                before > 0 && entry_list.is_empty()
            };
            if empty_group {
                arr.remove(gi);
            }
        }
        if arr.is_empty() {
            hooks.remove(spec.event);
        }
    }
    if hooks.is_empty() {
        if let Some(root) = settings.as_object_mut() {
            root.remove("hooks");
        }
    }
    removed
}

/// 把 `notify` 插进去或者换掉。返回 `(新内容, 是替换还是新增)`。
fn merge_codex(paths: &AgentPaths, text: &str) -> Result<(String, bool), AgentError> {
    let lines: Vec<&str> = text.lines().collect();
    let wanted = codex_line(paths);

    if let Some((start, end, multi)) = find_notify(text) {
        if multi {
            // 多行的那种我们不猜边界 —— **宁可拒绝，也不能写坏用户的配置**
            return Err(AgentError::Integration {
                path: paths.codex_config().display().to_string(),
                reason: "里面的 notify 是多行写的，Devtoolkit 不会自动改它。\
                         请先把它改成一行（或者删掉）再启用。"
                    .to_string(),
            });
        }
        let mut out: Vec<String> = lines.iter().map(|l| l.to_string()).collect();
        out[start] = wanted;
        let _ = end;
        return Ok((join_lines(&out, text), true));
    }

    let at = insert_at(&lines);
    let mut out: Vec<String> = Vec::with_capacity(lines.len() + 1);
    out.extend(lines[..at].iter().map(|l| l.to_string()));
    out.push(wanted);
    out.extend(lines[at..].iter().map(|l| l.to_string()));
    Ok((join_lines(&out, text), false))
}

/// 拼回一个文本文件，**保留原来有没有结尾换行**。
///
/// 用户的配置文件末尾本来没有换行的话，我们也不该给他加一个 ——
/// 那会让「只改了一行」的 diff 变成两行。
fn join_lines(lines: &[String], original: &str) -> String {
    let mut text = lines.join("\n");
    if original.is_empty() || original.ends_with('\n') {
        text.push('\n');
    }
    text
}
