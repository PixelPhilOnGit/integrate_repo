//! 「应用自动写入配置」：Claude 的 settings.json 和 Codex 的 config.toml。
//!
//! 这一层动的是**用户的配置文件**（在工作区之外），所以每条用例都在问
//! 同一组问题：改对了没有、**用户别的东西还在不在**、能不能原样撤回去。

mod common;

use common::TempDir;
use devtoolkit_agents::integration::{
    apply, hook_script_contents, revert, status, AgentPaths, IntegrationState, IntegrationTarget,
    HOOK_SCRIPT_STEM,
};
use serde_json::Value;

/// 一套「用户主目录 + 应用数据目录」。
struct Home {
    _base: TempDir,
    pub paths: AgentPaths,
}

impl Home {
    fn new(tag: &str) -> Home {
        let base = TempDir::new(tag);
        let home = base.path().join("home");
        let data = base.path().join("data");
        std::fs::create_dir_all(&home).expect("建主目录");
        std::fs::create_dir_all(&data).expect("建数据目录");
        Home {
            _base: base,
            paths: AgentPaths {
                home,
                data_dir: data,
            },
        }
    }

    fn claude_path(&self) -> std::path::PathBuf {
        self.paths.claude_settings()
    }

    fn codex_path(&self) -> std::path::PathBuf {
        self.paths.codex_config()
    }

    /// 预置一份用户的 settings.json（父目录一起建出来）。
    fn write_claude(&self, text: &str) {
        let p = self.claude_path();
        std::fs::create_dir_all(p.parent().unwrap()).expect("建 .claude");
        std::fs::write(&p, text).expect("写 settings.json");
    }

    fn write_codex(&self, text: &str) {
        let p = self.codex_path();
        std::fs::create_dir_all(p.parent().unwrap()).expect("建 .codex");
        std::fs::write(&p, text).expect("写 config.toml");
    }

    fn claude_json(&self) -> Value {
        let text = std::fs::read_to_string(self.claude_path()).expect("读 settings.json");
        serde_json::from_str(&text).expect("settings.json 必须还是合法 JSON")
    }

    fn codex_text(&self) -> String {
        std::fs::read_to_string(self.codex_path()).expect("读 config.toml")
    }
}

/// 数一数 settings.json 里有多少条我们的钩子。
fn our_hooks(settings: &Value) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let Some(hooks) = settings.get("hooks").and_then(Value::as_object) else {
        return out;
    };
    for (event, groups) in hooks {
        let Some(groups) = groups.as_array() else { continue };
        for group in groups {
            let Some(list) = group.get("hooks").and_then(Value::as_array) else {
                continue;
            };
            for entry in list {
                if let Some(cmd) = entry.get("command").and_then(Value::as_str) {
                    if cmd.contains(HOOK_SCRIPT_STEM) {
                        out.push((event.clone(), cmd.to_string()));
                    }
                }
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

/// 从零开始：状态是「还没有」，装上之后是「装好了」，四个事件都在。
#[test]
fn 从零装上四个事件钩子() {
    let home = Home::new("claude-fresh");
    assert_eq!(
        status(&home.paths, IntegrationTarget::Claude).unwrap().state,
        IntegrationState::Missing
    );

    let applied = apply(&home.paths, IntegrationTarget::Claude).expect("装上");
    assert!(applied.backup_path.is_none(), "原文件本来就不存在，不该有备份");

    assert_eq!(
        status(&home.paths, IntegrationTarget::Claude).unwrap().state,
        IntegrationState::Installed
    );

    let settings = home.claude_json();
    let hooks = our_hooks(&settings);
    assert_eq!(hooks.len(), 4, "四个事件各一条：{hooks:?}");
    let events: Vec<&str> = hooks.iter().map(|(e, _)| e.as_str()).collect();
    for want in ["UserPromptSubmit", "PermissionRequest", "Notification", "Stop"] {
        assert!(events.contains(&want), "缺了 {want}：{events:?}");
    }

    // ⚠️ **`UserPromptSubmit` 和 `Stop` 不能有 matcher**：官方表格里写得明白
    // （no matcher support），给它们写上一是死配置 —— 不报错，也不生效
    for event in ["UserPromptSubmit", "Stop"] {
        assert!(
            settings["hooks"][event][0].get("matcher").is_none(),
            "{event} 不该有 matcher（它不支持）"
        );
    }

    // `Notification` 只认 `idle_prompt`：等授权那件事交给 `PermissionRequest`
    // 了（Notification 的 permission_prompt 要等约 6 秒、而且只在你看起来
    // 离开了终端时才发）
    let notification = settings["hooks"]["Notification"][0]["matcher"]
        .as_str()
        .expect("Notification 该有 matcher");
    assert_eq!(notification, "idle_prompt", "matcher 要精确，不能写成一大串");

    // exec 形式：command + args，不过 shell
    let entry = &settings["hooks"]["PermissionRequest"][0]["hooks"][0];
    assert_eq!(entry["type"], "command");
    assert_eq!(entry["args"][0], "waiting");
    let command = entry["command"].as_str().expect("command 是脚本路径");
    assert!(
        command.contains(HOOK_SCRIPT_STEM) && !command.contains(' '),
        "exec 形式的 command 应该就是脚本路径本身（不带参数、不带引号）：{command}"
    );
}

/// ⚠️ 重复启用是**幂等**的：更新我们那几条，不是追加第二份。
///
/// 不幂等的话，用户点两次「启用」就会有两套钩子 —— 每回合往目录里写两次
/// 事件文件（一条状态变化变成两条），而且撤销还得摘两遍。
#[test]
fn 重复启用不会装出两份() {
    let home = Home::new("claude-idempotent");
    apply(&home.paths, IntegrationTarget::Claude).expect("第一次");
    apply(&home.paths, IntegrationTarget::Claude).expect("第二次");
    apply(&home.paths, IntegrationTarget::Claude).expect("第三次");

    let settings = home.claude_json();
    assert_eq!(our_hooks(&settings).len(), 4, "装出多份了");
    for event in ["UserPromptSubmit", "PermissionRequest", "Notification", "Stop"] {
        assert_eq!(
            settings["hooks"][event].as_array().map(Vec::len),
            Some(1),
            "{event} 底下多出了新的组"
        );
    }
}

/// **用户自己的配置一个字节都不能丢。**
///
/// 用真 JSON 合并（不是字符串拼）就是为了这条：用户的 `permissions`、
/// `env`、他自己装的钩子，全都得原样在。
#[test]
fn 用户原有的配置原样保留() {
    let home = Home::new("claude-merge");
    let original = serde_json::json!({
        "model": "opus",
        "env": { "FOO": "bar" },
        "permissions": { "allow": ["Bash(ls:*)"] },
        "hooks": {
            "Stop": [
                { "hooks": [ { "type": "command", "command": "/usr/local/bin/my-own-hook.sh" } ] }
            ],
            "SessionStart": [
                { "hooks": [ { "type": "command", "command": "/usr/local/bin/hello.sh" } ] }
            ]
        }
    });
    home.write_claude(&serde_json::to_string_pretty(&original).unwrap());

    apply(&home.paths, IntegrationTarget::Claude).expect("装上");
    let after = home.claude_json();

    assert_eq!(after["model"], "opus");
    assert_eq!(after["env"]["FOO"], "bar");
    assert_eq!(after["permissions"]["allow"][0], "Bash(ls:*)");
    // 用户自己那条 Stop 钩子还在（我们**追到一个新的组**里，不是替换它）
    let stop = after["hooks"]["Stop"].as_array().unwrap();
    let all: Vec<String> = stop
        .iter()
        .flat_map(|g| g["hooks"].as_array().unwrap().iter())
        .map(|h| h["command"].as_str().unwrap().to_string())
        .collect();
    assert!(
        all.iter().any(|c| c.contains("my-own-hook")),
        "用户自己的钩子被弄丢了：{all:?}"
    );
    assert!(all.iter().any(|c| c.contains(HOOK_SCRIPT_STEM)));
    // 没碰过的事件原样在
    assert!(after["hooks"]["SessionStart"][0]["hooks"][0]["command"]
        .as_str()
        .unwrap()
        .contains("hello.sh"));
}

/// 用户手改过我们的条目 → **认出来**（「改动过」而不是「装好了」）。
///
/// 不认的后果是：界面上显示「已启用」，而实际生效的是他改过的那份 ——
/// 用户以为自己关掉的东西还在起作用。
#[test]
fn 用户改过我们的条目时认得出是改动过() {
    let home = Home::new("claude-modified");
    apply(&home.paths, IntegrationTarget::Claude).expect("先装上");

    // 用户把状态参数改了（比如他想要别的语义）
    let mut settings = home.claude_json();
    settings["hooks"]["Stop"][0]["hooks"][0]["command"] =
        serde_json::json!("/somewhere/else/devtoolkit-hook.sh something-else");
    home.write_claude(&serde_json::to_string_pretty(&settings).unwrap());

    let s = status(&home.paths, IntegrationTarget::Claude).unwrap();
    assert_eq!(s.state, IntegrationState::Modified, "{}", s.preview);
    assert!(
        s.preview.contains("不一样") || s.preview.contains("改过"),
        "预览要说清楚哪里不一样：{}",
        s.preview
    );

    // 再启用一次会把它改回当前这份（并且先备份）
    let applied = apply(&home.paths, IntegrationTarget::Claude).expect("重新装上");
    assert!(applied.backup_path.is_some(), "改动之前必须备份");
    assert_eq!(
        status(&home.paths, IntegrationTarget::Claude).unwrap().state,
        IntegrationState::Installed
    );
}

/// 别人装的钩子**不会被误认成我们的**（判据是命令里含有 `devtoolkit-hook`）。
#[test]
fn 别人的钩子不会被误认成我们的() {
    let home = Home::new("claude-foreign");
    home.write_claude(
        r#"{
  "hooks": {
    "Stop": [ { "hooks": [ { "type": "command", "command": "/opt/other-tool/hook.sh done" } ] } ]
  }
}"#,
    );

    let s = status(&home.paths, IntegrationTarget::Claude).unwrap();
    assert_eq!(s.state, IntegrationState::Absent, "{}", s.preview);

    apply(&home.paths, IntegrationTarget::Claude).expect("装上");
    let all: Vec<String> = our_hooks(&home.claude_json())
        .into_iter()
        .map(|(_, c)| c)
        .collect();
    assert_eq!(all.len(), 4);
    // 别人的那条原样还在
    assert!(home.claude_json()["hooks"]["Stop"]
        .as_array()
        .unwrap()
        .iter()
        .any(|g| g["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .contains("other-tool")));
}

/// 备份就是**改动前的原文**，一个字节不差 —— 它是用户最后那道保险。
#[test]
fn 备份是改动前的原文() {
    let home = Home::new("claude-backup");
    let original = "{\n  \"model\": \"opus\"\n}\n";
    home.write_claude(original);

    let applied = apply(&home.paths, IntegrationTarget::Claude).expect("装上");
    let backup = applied.backup_path.expect("有原文件就该有备份");

    assert_eq!(
        std::fs::read_to_string(&backup).expect("读备份"),
        original,
        "备份必须是改动前的原文"
    );
    assert!(
        backup.contains(".devtoolkit-") && backup.ends_with(".bak"),
        "备份文件名要能看出是谁留的、什么时候留的：{backup}"
    );
    // 备份躺在原文件**旁边**（用户要找的时候会先看那儿）
    assert_eq!(
        std::path::Path::new(&backup).parent(),
        home.claude_path().parent()
    );
}

/// 撤销只摘我们那几条，**用户自己的钩子（哪怕是同一个事件里的）一根汗毛都不动**。
#[test]
fn 撤销只摘掉我们自己装的那几条() {
    let home = Home::new("claude-revert");
    let original = serde_json::json!({
        "model": "opus",
        "hooks": {
            "Stop": [ { "hooks": [ { "type": "command", "command": "/opt/mine.sh done" } ] } ]
        }
    });
    home.write_claude(&serde_json::to_string_pretty(&original).unwrap());

    apply(&home.paths, IntegrationTarget::Claude).expect("装上");
    let outcome = revert(&home.paths, IntegrationTarget::Claude).expect("撤销");
    assert!(outcome.preview.contains("已撤掉"), "{}", outcome.preview);
    assert!(outcome.backup_path.is_none(), "撤销不产生备份");

    let after = home.claude_json();
    assert!(our_hooks(&after).is_empty(), "撤销之后还有我们的钩子");
    assert_eq!(after["model"], "opus");
    assert_eq!(
        after["hooks"]["Stop"][0]["hooks"][0]["command"], "/opt/mine.sh done",
        "用户自己的钩子被动了"
    );
    // 只被我们加过、里面没别的东西的事件键要整个清掉（不留 `"Notification": []`）
    assert!(
        after["hooks"].get("Notification").is_none(),
        "空的钩子事件该被清掉：{}",
        after["hooks"]
    );

    // 撤销之后状态回到「没有我们的痕迹」
    assert_eq!(
        status(&home.paths, IntegrationTarget::Claude).unwrap().state,
        IntegrationState::Absent
    );
}

/// 撤销是**幂等**的：撤两次、撤一个本来就没装过的，都不出错。
#[test]
fn 撤销是幂等的() {
    let home = Home::new("claude-revert-idempotent");
    apply(&home.paths, IntegrationTarget::Claude).expect("装上");
    revert(&home.paths, IntegrationTarget::Claude).expect("第一次撤销");
    revert(&home.paths, IntegrationTarget::Claude).expect("第二次撤销");

    // 文件都不存在的时候也不该出错
    let empty = Home::new("claude-revert-missing");
    revert(&empty.paths, IntegrationTarget::Claude).expect("没装过也能撤");
}

/// 配置文件是坏的 JSON → **明确报错，一个字节都不动**。
///
/// 我们拿字符串拼一拼是能把命令塞进去，但结果是用户的文件更坏了 —— 而那是
/// 他的编辑器/主题/权限设置，可能已经攒了一年。
#[test]
fn 坏掉的_json_不碰并明确报错() {
    let home = Home::new("claude-broken");
    home.write_claude("{ 这不是 JSON");

    // 状态是 **unusable 而不是 Err** —— 这是用户能看到也能自己修好的情况，
    // 原因写在 preview 里给他看（弹一条外壳错误条他也不知道该改什么）
    let s = status(&home.paths, IntegrationTarget::Claude).expect("坏 JSON 不该让 status 失败");
    assert_eq!(s.state, IntegrationState::Unusable, "{}", s.preview);
    assert!(s.preview.contains("JSON"), "预览要说出原因：{}", s.preview);

    // 但**写**是要拒绝的
    let err = apply(&home.paths, IntegrationTarget::Claude).expect_err("坏 JSON 不该动它");
    assert!(err.to_string().contains("JSON"), "{err}");
    assert_eq!(
        std::fs::read_to_string(home.claude_path()).unwrap(),
        "{ 这不是 JSON",
        "报错的时候文件不该被改"
    );
}

/// 包装脚本被删掉（或者内容变了）→ 状态是「改动过」，不是「装好了」。
///
/// 配置指着的是一个不存在的文件时，「已启用」是句假话 —— 钩子永远不生效。
#[test]
fn 包装脚本丢了的配置不算装好() {
    let home = Home::new("claude-script-gone");
    apply(&home.paths, IntegrationTarget::Claude).expect("装上");
    std::fs::remove_file(home.paths.hook_script()).expect("删掉脚本");

    assert_eq!(
        status(&home.paths, IntegrationTarget::Claude).unwrap().state,
        IntegrationState::Modified
    );

    apply(&home.paths, IntegrationTarget::Claude).expect("再装上");
    assert!(home.paths.hook_script().exists(), "apply 要重新写出脚本");
    assert_eq!(
        status(&home.paths, IntegrationTarget::Claude).unwrap().state,
        IntegrationState::Installed
    );
}

/// 包装脚本本身：**环境变量没有就静默退出**（用户在自己的终端里跑 claude
/// 的时候不能报错），有就按第一个参数写一个状态文件。
#[test]
fn 包装脚本有守卫也有状态白名单() {
    let script = hook_script_contents();
    assert!(script.contains("Devtoolkit"), "脚本要写明是谁生成的");
    assert!(
        script.contains("DEVTOOLKIT_PANE_ID") && script.contains("DEVTOOLKIT_EVENT_DIR"),
        "脚本要检查那两个环境变量"
    );
    assert!(script.contains("DEVTOOLKIT_EVENT_DIR") && script.contains("$state"), "写文件的形状");
    for state in ["working", "waiting", "done"] {
        assert!(script.contains(state), "少了状态 {state}");
    }
    // 「没有环境变量就安静退出」在两边都是**先**发生的（在任何写操作之前）
    let guard = script.find("DEVTOOLKIT_PANE_ID").unwrap();
    let write = script.find("$state.").unwrap();
    assert!(guard < write, "守卫必须在写文件之前");
}

/// Unix 上给脚本可执行位 —— 配置里那条命令是 `"<脚本路径>" <状态>`，
/// shell 会直接 exec 它，没有 +x 就是每次钩子都「Permission denied」。
#[cfg(unix)]
#[test]
fn unix_上包装脚本是可执行的() {
    use std::os::unix::fs::PermissionsExt;
    let home = Home::new("claude-script-exec");
    apply(&home.paths, IntegrationTarget::Claude).expect("装上");

    let mode = std::fs::metadata(home.paths.hook_script())
        .expect("脚本要在")
        .permissions()
        .mode();
    assert_eq!(mode & 0o111, 0o111, "缺可执行位：{mode:o}");
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

/// ⚠️ **TOML 的根键必须写在任何 `[表]` 之前。**
///
/// 这条是这个文件里最重要的回归：往文件尾追加一行 `notify = [...]` 会被
/// 当成**最后那张表里的键**，Codex 读的是根上的 `notify` —— 于是那行
/// 「写进去了」但永远不生效，而且从文件上看不出来。
///
/// 这里的判据不是「行号靠前」这种自己跟自己玩的东西，而是**拿一个真的
/// TOML 解析器读一遍**：解析出来是根键才算数。
#[test]
fn notify_必须在任何表之前() {
    let home = Home::new("codex-root-key");
    home.write_codex(
        "# 我的 Codex 配置\n\
         model = \"gpt-5\"\n\
         \n\
         [tui]\n\
         notifications = true\n",
    );

    apply(&home.paths, IntegrationTarget::Codex).expect("装上");
    let text = home.codex_text();

    let parsed: toml::Value = toml::from_str(&text).expect("结果必须还是合法 TOML");
    let notify = parsed
        .get("notify")
        .expect("notify 必须是**根键**（在 [tui] 里就白写了）");
    let arr = notify.as_array().expect("notify 是数组");
    assert_eq!(arr[0].as_str().unwrap(), home.paths.hook_script().display().to_string());
    assert_eq!(arr[1].as_str().unwrap(), "done");

    // 用户的表原样在
    assert_eq!(parsed["tui"]["notifications"].as_bool(), Some(true));
    assert_eq!(parsed["model"].as_str(), Some("gpt-5"));
}

/// 已经有一行根级的 `notify` → **替换那一行**，不是新增第二行。
#[test]
fn 已有的_notify_是替换不是追加() {
    let home = Home::new("codex-replace");
    home.write_codex("notify = [\"/usr/bin/old-hook\", \"done\"]\nmodel = \"gpt-5\"\n");

    apply(&home.paths, IntegrationTarget::Codex).expect("装上");
    let text = home.codex_text();

    assert_eq!(text.matches("notify =").count(), 1, "多出一行 notify：\n{text}");
    assert!(!text.contains("old-hook"), "旧值没被换掉：\n{text}");
    let parsed: toml::Value = toml::from_str(&text).expect("合法 TOML");
    assert_eq!(parsed["model"].as_str(), Some("gpt-5"));
}

/// 表里的 `notify` **不是** Codex 读的那个 —— 我们不碰它，
/// 而是在根区另加一行（这才是对的：把表里那行改掉没有任何效果）。
#[test]
fn 表里的同名键不会被误当成根键() {
    let home = Home::new("codex-in-table");
    home.write_codex("[some_tool]\nnotify = [\"leave-me-alone\"]\n");

    let s = status(&home.paths, IntegrationTarget::Codex).unwrap();
    assert_eq!(s.state, IntegrationState::Absent, "{}", s.preview);

    apply(&home.paths, IntegrationTarget::Codex).expect("装上");
    let text = home.codex_text();
    assert!(text.contains("leave-me-alone"), "表里那个键被动了：\n{text}");

    let parsed: toml::Value = toml::from_str(&text).expect("合法 TOML");
    assert!(parsed.get("notify").is_some(), "根上要有 notify");
    assert_eq!(
        parsed["some_tool"]["notify"][0].as_str(),
        Some("leave-me-alone"),
        "表里那个键要原样"
    );
}

/// 幂等：装三次，根上还是只有一行 notify。
#[test]
fn codex_重复启用也是幂等的() {
    let home = Home::new("codex-idempotent");
    home.write_codex("model = \"gpt-5\"\n");
    apply(&home.paths, IntegrationTarget::Codex).expect("装上");
    apply(&home.paths, IntegrationTarget::Codex).expect("再来一次");
    apply(&home.paths, IntegrationTarget::Codex).expect("再来一次");

    assert_eq!(home.codex_text().matches("notify =").count(), 1);
    assert_eq!(
        status(&home.paths, IntegrationTarget::Codex).unwrap().state,
        IntegrationState::Installed
    );
}

/// 用户改过 notify → 认出来是「改动过」；再启用会替换它**并先备份**。
#[test]
fn codex_用户改过_notify_时认得出() {
    let home = Home::new("codex-modified");
    apply(&home.paths, IntegrationTarget::Codex).expect("装上");
    home.write_codex("notify = [\"/somewhere/else/devtoolkit-hook.sh\", \"done\"]\n");

    let s = status(&home.paths, IntegrationTarget::Codex).unwrap();
    assert_eq!(s.state, IntegrationState::Modified);

    let applied = apply(&home.paths, IntegrationTarget::Codex).expect("重新装上");
    assert!(applied.backup_path.is_some());
    assert!(home.codex_text().contains(
        home.paths.hook_script().display().to_string().as_str()
    ));
}

/// 撤销：摘掉那一行，用户的其它配置原样。
#[test]
fn codex_撤销只摘掉_notify_那一行() {
    let home = Home::new("codex-revert");
    home.write_codex("model = \"gpt-5\"\n\n[tui]\nnotifications = true\n");
    apply(&home.paths, IntegrationTarget::Codex).expect("装上");

    revert(&home.paths, IntegrationTarget::Codex).expect("撤销");
    let text = home.codex_text();
    assert!(!text.contains("notify"), "notify 还在：\n{text}");
    assert!(text.contains("gpt-5") && text.contains("[tui]"), "别的配置被动了：\n{text}");
    assert_eq!(
        status(&home.paths, IntegrationTarget::Codex).unwrap().state,
        IntegrationState::Absent
    );
}

/// 多行写的 `notify`：**我们不猜它的边界**，明确报错让用户自己去改。
///
/// 猜错的后果是把用户配置的其它部分一起吃掉 —— 那比「装不上」严重得多。
#[test]
fn 多行的_notify_明确拒绝而不是猜() {
    let home = Home::new("codex-multiline");
    home.write_codex("model = \"gpt-5\"\nnotify = [\n  \"/usr/bin/old\",\n  \"done\",\n]\n");

    let s = status(&home.paths, IntegrationTarget::Codex).unwrap();
    assert_eq!(s.state, IntegrationState::Unusable, "{}", s.preview);
    assert!(s.preview.contains("多行"), "预览要说清楚原因：{}", s.preview);

    let err = apply(&home.paths, IntegrationTarget::Codex).expect_err("多行不该猜");
    assert!(err.to_string().contains("多行"), "{err}");
    assert!(home.codex_text().contains("/usr/bin/old"), "拒绝的时候文件不该被改");
}

/// 文件全是注释/空行时，插到**最后**（没有「根键区」，但也绝不能跑到注释中间去）。
#[test]
fn 全是注释的文件也能插() {
    let home = Home::new("codex-comments-only");
    home.write_codex("# 只有注释\n# 还是注释\n");

    apply(&home.paths, IntegrationTarget::Codex).expect("装上");
    let parsed: toml::Value = toml::from_str(&home.codex_text()).expect("合法 TOML");
    assert!(parsed.get("notify").is_some());
}

/// 文件末尾原本**没有换行**时，我们也不加一个 —— 那会把「只改了一行」的 diff
/// 变成两行。
#[test]
fn 不擅自改文件末尾的换行() {
    let home = Home::new("codex-newline");
    home.write_codex("model = \"gpt-5\""); // 没有结尾换行
    apply(&home.paths, IntegrationTarget::Codex).expect("装上");
    assert!(
        !home.codex_text().ends_with('\n'),
        "我们给它加了个结尾换行：{:?}",
        home.codex_text()
    );

    let home = Home::new("codex-newline-2");
    home.write_codex("model = \"gpt-5\"\n");
    apply(&home.paths, IntegrationTarget::Codex).expect("装上");
    assert!(home.codex_text().ends_with('\n'), "原来的结尾换行没了");
}

/// ⚠️ **Windows 路径里的反斜杠在 TOML 里是转义符**。
///
/// `notify = ["C:\Users\me\hook.cmd", "done"]` 是**非法 TOML**（`\U` 不是转义），
/// 整个配置文件会读不出来 —— 用户得到的是一句语法错误，而原因在他看不见的地方。
/// 所以写进去的必须是 `\\`。
#[test]
fn windows_路径的反斜杠会被转义() {
    let base = TempDir::new("codex-backslash");
    // ⚠️ **路径必须是绝对的**（用临时目录拼），不能直接写一个 `C:\Users\me\...`
    // 当 data_dir —— 那在 Linux 上是个**相对路径**，`create_dir_all` 会在进程的
    // 当前目录（也就是 crate 目录）里建出一个叫这个名字的目录。
    // 真发生过一次：`src-tauri/agents/C:\Users\me\AppData\Roaming\...`。
    // 库那边现在有 `ensure_absolute` 拦着（这个测试也顺带钉住了它）。
    //
    // 但目录名里**要有反斜杠**，否则测不到转义：`win\dir` 这种段落在 Linux 上
    // 就是一个普通目录名（合法字符），在 Windows 上会变成两级目录 ——
    // 两边都能跑到同一个代码路径。
    let paths = AgentPaths {
        home: base.path().join("home"),
        data_dir: base.path().join(r"AppData\Roaming\com.devtoolkit.desktop"),
    };
    std::fs::create_dir_all(&paths.home).expect("建主目录");

    apply(&paths, IntegrationTarget::Codex).expect("装上");
    let text = std::fs::read_to_string(paths.codex_config()).expect("读");

    assert!(text.contains(r"\\"), "反斜杠没转义：\n{text}");
    let parsed: toml::Value = toml::from_str(&text).expect("转义不对的话这里就炸了");
    let script = parsed["notify"][0].as_str().expect("第一个元素是脚本路径");
    assert!(
        script.contains(r"Roaming\com.devtoolkit.desktop"),
        "解析回来的路径应该和写进去的一样：{script}"
    );
    assert!(script.contains("devtoolkit-hook"), "{script}");
}

/// 回归：**相对路径要当场拒绝。**
///
/// 真出过一次：测试里把 `C:\Users\me\AppData\...` 当 data_dir（在 Linux 上
/// 那是个相对路径），于是 `create_dir_all` 在 crate 目录里建出了一个
/// **叫这个名字的目录**，不报错、没人发现；在 Windows 上它会写进**用户真实的
/// AppData**。所以库自己拦一道。
#[test]
fn 相对路径当场拒绝而不是写到当前目录() {
    let paths = AgentPaths {
        home: std::path::PathBuf::from("relative-home"),
        data_dir: std::path::PathBuf::from(r"C:\Users\me\AppData\Roaming\x"),
    };

    let err = status(&paths, IntegrationTarget::Claude).expect_err("相对路径要报错");
    assert!(err.to_string().contains("绝对路径"), "{err}");
    assert!(apply(&paths, IntegrationTarget::Claude).is_err());
    assert!(revert(&paths, IntegrationTarget::Claude).is_err());
    assert!(
        !std::path::Path::new(r"C:\Users\me").exists(),
        "拒绝的时候不该建出任何目录"
    );
}

/// 目标枚举只有两个值 —— 它是**唯一**能影响去写哪个文件的东西（安全模型见
/// `integration` 模块头）。多一个能写的路径必须是有意为之。
#[test]
fn 只有两种目标() {
    assert_eq!(IntegrationTarget::Claude.as_str(), "claude");
    assert_eq!(IntegrationTarget::Codex.as_str(), "codex");
    assert_ne!(
        AgentPaths::claude_settings(&AgentPaths {
            home: "/home/me".into(),
            data_dir: "/data".into(),
        }),
        AgentPaths::codex_config(&AgentPaths {
            home: "/home/me".into(),
            data_dir: "/data".into(),
        })
    );
}

// ---------------------------------------------------------------------------
// 整条信号链路：配置里那条命令 → 包装脚本 → 事件文件 → scan
// ---------------------------------------------------------------------------

/// 按配置里写的那样把钩子跑一遍。
///
/// 两个平台都是 **exec 形式**（`command` + `args`，不经过 shell），所以这里没有
/// 平台分岔 —— 验的就是**真的会被执行的那条路**：路径能不能被直接 exec
/// （Unix 上要有 +x 和 shebang，Windows 上要是能被 CreateProcess 认下的形状）。
fn run_hook(entry: &Value, env: &[(&str, &str)]) -> std::process::Output {
    let mut cmd = std::process::Command::new(entry["command"].as_str().expect("钩子命令"));
    for arg in entry["args"].as_array().expect("exec 形式的参数表") {
        cmd.arg(arg.as_str().expect("参数是字符串"));
    }
    cmd.envs(env.iter().copied()).output().expect("跑钩子脚本")
}

/// 从装好的配置里取某个事件的钩子条目。
fn hook_entry(home: &Home, event: &str) -> Value {
    let settings = home.claude_json();
    settings["hooks"][event][0]["hooks"][0].clone()
}

/// **整条链路走一遍**：配置里那条命令 → 包装脚本 → 事件文件 → `scan` 读出来。
///
/// 单独测脚本内容、或者单独测 `scan`，中间那条缝（命令字符串到底能不能跑起来、
/// 脚本到底写没写对文件名）是盖不到的 —— 而它恰恰是最容易错的地方：
/// 命令形状错了脚本根本不会被调用，钩子静默失效，界面上什么都看不出来。
#[test]
fn 配置里那条命令真能把状态写成事件文件() {
    let home = Home::new("hook-e2e");
    let events_dir = home._base.path().join("agent-events");
    apply(&home.paths, IntegrationTarget::Claude).expect("装上");

    let entry = hook_entry(&home, "Notification");
    let out = run_hook(
        &entry,
        &[
            ("DEVTOOLKIT_PANE_ID", "pane_k3f9x2a1"),
            (
                "DEVTOOLKIT_EVENT_DIR",
                events_dir.to_str().expect("临时目录路径是 UTF-8"),
            ),
        ],
    );

    assert!(out.status.success(), "钩子脚本没跑成功：{out:?}");
    let written = events_dir.join("waiting.pane_k3f9x2a1");
    assert!(
        written.exists(),
        "脚本没有写出事件文件（目录里：{:?}）",
        std::fs::read_dir(&events_dir)
            .map(|d| d.filter_map(|e| e.ok()).map(|e| e.file_name()).collect::<Vec<_>>())
    );

    // 我们真的能读到它，而且是按约定的名字
    let events = devtoolkit_agents::events::scan(&events_dir).expect("扫描");
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].name, "waiting.pane_k3f9x2a1");
    assert!(events[0].at > 0, "mtime 要是真的时间戳");
}

/// ⚠️ **在别的终端里跑 claude 时，钩子必须安静地什么都不做。**
///
/// 用户在自己的终端里用 Claude Code 是完全正常的事，而那时候这两个环境变量
/// 是不存在的。钩子这时候要是报错，用户看到的就是一句莫名其妙的
/// 「找不到 DEVTOOLKIT_EVENT_DIR」—— 而他根本没在做和 Devtoolkit 有关的事。
///
/// 三个都要满足：**退出码 0、没有输出、没有写出任何文件**。
#[test]
fn 没有环境变量时钩子安静地什么都不做() {
    let home = Home::new("hook-quiet");
    let events_dir = home._base.path().join("agent-events");
    std::fs::create_dir_all(&events_dir).expect("建事件目录");
    apply(&home.paths, IntegrationTarget::Claude).expect("装上");

    let entry = hook_entry(&home, "Stop");
    // 注意是**空的**环境：连 DEVTOOLKIT_* 都不给
    let out = run_hook(&entry, &[]);

    assert!(out.status.success(), "钩子在没有环境变量时报错了：{out:?}");
    assert!(
        out.stdout.is_empty() && out.stderr.is_empty(),
        "钩子往用户的终端里打了东西：stdout={:?} stderr={:?}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    let leftovers: Vec<_> = std::fs::read_dir(&events_dir)
        .expect("读事件目录")
        .filter_map(|e| e.ok())
        .map(|e| e.file_name())
        .collect();
    assert!(leftovers.is_empty(), "不该写出任何东西：{leftovers:?}");
}

/// 状态名不在白名单时也不写（脚本的第一个参数是外部输入，
/// 拼进路径之前必须先过白名单 —— 这是那道防目录穿越的边界）。
#[test]
fn 钩子的状态参数不在白名单时不写文件() {
    let home = Home::new("hook-bad-state");
    let events_dir = home._base.path().join("agent-events");
    std::fs::create_dir_all(&events_dir).expect("建事件目录");
    apply(&home.paths, IntegrationTarget::Claude).expect("装上");

    let script = home.paths.hook_script().display().to_string();
    let out = run_hook(
        // 故意给一个「看起来能穿目录」的状态名：脚本必须只认白名单里那三个
        // （exec 形式下它是**第一个参数**，脚本里是 `$1` / `%1`）
        &serde_json::json!({
            "type": "command",
            "command": script,
            "args": ["../../etc/passwd"],
        }),
        &[
            ("DEVTOOLKIT_PANE_ID", "pane1"),
            (
                "DEVTOOLKIT_EVENT_DIR",
                events_dir.to_str().expect("临时目录路径是 UTF-8"),
            ),
        ],
    );

    assert!(out.status.success(), "{out:?}");
    let leftovers: Vec<_> = std::fs::read_dir(&events_dir)
        .expect("读事件目录")
        .filter_map(|e| e.ok())
        .map(|e| e.file_name())
        .collect();
    assert!(leftovers.is_empty(), "拿一个奇怪的状态名写出了文件：{leftovers:?}");
    assert!(
        !home._base.path().join("etc").exists(),
        "状态名被当成路径用了 —— 逃到事件目录外面去了"
    );
}

/// 形状不对（`hooks` 不是对象、某个事件不是数组）也算 `unusable`，
/// 而且**理由要说出来** —— 用户打开文件看一眼就知道该改哪儿。
///
/// 这几种在 Claude Code 那边是「条目被忽略」（不报错、不生效），
/// 所以最容易变成「界面说装好了、实际什么都没发生」。我们至少要说清楚。
#[test]
fn 形状不对的文件我们不碰也不装作改好了() {
    for (text, needle) in [
        (r#"{"hooks": "我不是对象"}"#, "hooks"),
        (r#"{"hooks": {"Stop": {"不是": "数组"}}}"#, "Stop"),
        ("[1, 2, 3]", "顶层"),
    ] {
        let home = Home::new("claude-shape");
        home.write_claude(text);

        let s = status(&home.paths, IntegrationTarget::Claude).unwrap();
        assert_eq!(s.state, IntegrationState::Unusable, "{text} → {}", s.preview);
        assert!(
            s.preview.contains(needle),
            "预览要指出是哪里不对（expected {needle}）：{}",
            s.preview
        );

        let err = apply(&home.paths, IntegrationTarget::Claude).expect_err("不该动这个文件");
        assert!(err.to_string().contains(needle), "{err}");
        assert_eq!(
            std::fs::read_to_string(home.claude_path()).unwrap(),
            text,
            "拒绝写入的时候文件不该被改"
        );
    }
}

/// `status` / `apply` / `revert` 的返回里都带着 `target` ——
/// 前端拿同一个对象去路由，不用自己在外面记「这次问的是哪个」。
#[test]
fn 返回里带着问的是哪个目标() {
    let home = Home::new("target-echo");

    let s = status(&home.paths, IntegrationTarget::Codex).unwrap();
    assert_eq!(s.target, IntegrationTarget::Codex);
    assert!(s.path.ends_with("config.toml"), "{}", s.path);

    let applied = apply(&home.paths, IntegrationTarget::Codex).unwrap();
    assert_eq!(applied.target, IntegrationTarget::Codex);

    let reverted = revert(&home.paths, IntegrationTarget::Codex).unwrap();
    assert_eq!(reverted.target, IntegrationTarget::Codex);

    // 两个目标指向的**确实**是两个不同的文件
    assert_ne!(
        status(&home.paths, IntegrationTarget::Claude).unwrap().path,
        s.path
    );
}
