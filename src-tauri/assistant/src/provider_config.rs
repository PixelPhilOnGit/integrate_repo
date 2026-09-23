//! 「用哪家的模型、打哪个地址、用哪个模型」—— 以及 key 存哪。
//!
//! # 这里不碰钥匙串
//!
//! 这个模块只说清「key 叫什么名字」（[`api_key_id`]），**不自己去读**。
//! 读钥匙串是命令层的事（`assistant_commands.rs` 里组装 provider 的时候），
//! 理由和连接密码一样：**密钥不该绕一圈经过 webview**。
//! 前端只需要知道「配没配」，不需要拿到 key 本身。
//!
//! 这样切还有个好处：这个 crate 不用依赖 `devtoolkit-store`，
//! 测试里给 `ProviderConfig` 塞一个假 key 就行，不需要钥匙串。

use serde::{Deserialize, Serialize};

/// 走哪套协议。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderKind {
    /// Anthropic 的 Messages API（`tool_use` 那套）。
    Anthropic,
    /// OpenAI 兼容的 Chat Completions（`function_call` 那套）。
    ///
    /// 「兼容」这三个字要当回事：DeepSeek / Qwen / vLLM / ollama / 公司内网网关
    /// 都往这个口子里接，而它们对 `tool_calls` 和 `stream_options` 的实现忠实度参差。
    /// 所以解析失败要给**能看懂的错误**，不能静默当成「模型没调工具」。
    OpenAi,
}

impl ProviderKind {
    /// 稳定的小写标识。**存进 KV 和钥匙串条目名里的就是它，不要改。**
    pub fn as_str(self) -> &'static str {
        match self {
            ProviderKind::Anthropic => "anthropic",
            ProviderKind::OpenAi => "openai",
        }
    }

    /// 默认的接口地址。
    ///
    /// ⚠️ **只有 Anthropic 有默认值。** OpenAI 兼容那一路**必须让用户填** ——
    /// 它没有"官方地址"可言（DeepSeek / vLLM / 内网网关各不相同）。
    /// 给一个默认值（比如 api.openai.com）只会让人以为要往那儿发。
    pub fn default_base_url(self) -> Option<&'static str> {
        match self {
            ProviderKind::Anthropic => Some("https://api.anthropic.com"),
            ProviderKind::OpenAi => None,
        }
    }

    /// 两家的默认模型。
    ///
    /// 只是**新建配置时的初始值**，用户随时能改 —— 所以这里的取舍是
    /// 「当下能力最强的那一档」而不是「最便宜的」：模型选择是用户的事，
    /// 我们不该替他把上限压低。
    pub fn default_model(self) -> &'static str {
        match self {
            ProviderKind::Anthropic => "claude-opus-5",
            ProviderKind::OpenAi => "gpt-4o",
        }
    }
}

/// 一个 provider 的配置。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    /// 走哪套协议。
    pub kind: ProviderKind,
    /// 接口地址。**不带结尾斜杠**（拼路径时统一处理）。
    pub base_url: String,
    /// 模型 id。
    pub model: String,
}

impl ProviderConfig {
    /// 按某个 provider 的默认值新建（地址用 [`ProviderKind::default_base_url`]）。
    pub fn new(kind: ProviderKind) -> Self {
        ProviderConfig {
            kind,
            base_url: kind.default_base_url().unwrap_or_default().to_string(),
            model: kind.default_model().to_string(),
        }
    }

    /// 拼一个路径到 base_url 后面（处理掉结尾斜杠，避免 `//v1/messages`）。
    pub fn endpoint(&self, path: &str) -> String {
        let base = self.base_url.trim_end_matches('/');
        let path = path.trim_start_matches('/');
        format!("{base}/{path}")
    }

    /// 缺什么？
    ///
    /// ⚠️ `base_url` 是**必填**的（对 OpenAI 兼容那一路尤其要紧）：
    /// 空着的话请求会打到一个拼出来的怪地址上，报错还看不出是配置的问题。
    /// 所以这里在**发请求之前**就拦下来，文案能直接显示给用户。
    pub fn validate(&self) -> Result<(), String> {
        if self.base_url.trim().is_empty() {
            return Err(match self.kind {
                ProviderKind::Anthropic => "还没填接口地址".to_string(),
                ProviderKind::OpenAi => {
                    "OpenAI 兼容这一路必须填接口地址（DeepSeek / vLLM / 内网网关各不相同，没有默认值）"
                        .to_string()
                }
            });
        }
        if !self.base_url.starts_with("https://") && !self.base_url.starts_with("http://") {
            return Err(format!(
                "接口地址要以 http:// 或 https:// 开头，现在是「{}」",
                self.base_url
            ));
        }
        if self.model.trim().is_empty() {
            return Err("还没填模型 id".to_string());
        }
        Ok(())
    }
}

/// 一份**配置**的 API key 在钥匙串里的条目名。
///
/// 条目名的完整形式是 `"{模块}/{id}"`（见 `store/src/secrets.rs`），
/// 所以实际存的是 `assistant/api_key:p_default`。
///
/// ⚠️ **按配置分开存，不是按 provider。** 同一个 provider 可以有好几份配置
/// （「工作用 Anthropic」「自己的 Anthropic」），按 provider 命名会让它们
/// **互相顶掉** —— 症状是「我明明填过，怎么又要填」，而且要等到下次发请求才发现。
/// 和当年「按 provider 分开存」的理由是同一个，只是粒度又细了一层。
pub fn api_key_id(profile_id: &str) -> String {
    format!("api_key:{profile_id}")
}

/// 老版本按 **provider** 命名的条目名（`api_key:anthropic`）。
///
/// ⚠️ **留着它、并且用测试钉住** —— 从旧版本升上来的用户，那把 key 就躺在
/// 这个名字底下，搬迁（`assistant_migrate_api_key`）全靠这个名字对上老数据。
/// 觉得「反正没人读了」把它删掉 = 所有老用户的 key 静默消失。
pub fn legacy_api_key_id(kind: ProviderKind) -> String {
    format!("api_key:{}", kind.as_str())
}

/// 搬迁一条 key 时该做什么。
///
/// 抽成纯函数是为了能**穷举测试**：这段代码唯一的使命是**别把用户的 key 弄丢**，
/// 而它跑在真实钥匙串上（没法反复试着重调）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyMove {
    /// 老条目本来就是空的（用户没配过）—— 什么都不用做。
    Nothing,
    /// 把老条目搬到新条目上（**写完才删**）。
    CopyThenDelete,
    /// 新条目已经有值了（用户自己填过、或者上次搬了一半）—— 只把老条目删掉。
    JustDelete,
}

/// 决定怎么搬。见 [`KeyMove`]。
///
/// ⚠️ 不变量：**任何分支都不会让「老条目没了、新条目也没有」同时成立** ——
/// 那就是用户的 key 凭空蒸发。有测试钉着（那一条是这段代码存在的全部意义）。
pub fn plan_key_move(source: Option<&str>, target: Option<&str>) -> KeyMove {
    match (source, target) {
        // 老条目空的：没东西可搬；新条目有没有都不关我们的事
        (None, _) => KeyMove::Nothing,
        // 新条目已经有值：**不覆盖** —— 那可能是用户后来自己重新填的一把，
        // 而老那把是旧的。只清掉老条目（清不掉也无所谓，它不会再被读到）
        (Some(_), Some(_)) => KeyMove::JustDelete,
        (Some(_), None) => KeyMove::CopyThenDelete,
    }
}

/// 这个模块在钥匙串里的名字（配合 [`api_key_id`] 用）。
pub const KEYCHAIN_MODULE: &str = "assistant";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_key_entry_is_named_after_the_profile_id() {
        assert_eq!(api_key_id("p_default"), "api_key:p_default");
    }

    #[test]
    fn two_profiles_of_the_same_provider_do_not_share_an_entry() {
        // ⚠️ 这条是「按配置存」的全部理由：同一个 provider 可以有好几份配置
        //（「工作用 Anthropic」「自己的 Anthropic」），按 provider 命名会让它们
        // **互相顶掉** —— 症状是「我明明填过，怎么又要填」，要到下次发请求才发现。
        assert_ne!(api_key_id("p_work"), api_key_id("p_home"));
    }

    #[test]
    fn the_legacy_name_is_still_what_old_versions_wrote() {
        // ⚠️ 搬迁（`assistant_migrate_api_key`）靠这两个名字对上老数据。
        // 改了它们 = 所有老用户升级之后 key 静默消失。
        assert_eq!(legacy_api_key_id(ProviderKind::Anthropic), "api_key:anthropic");
        assert_eq!(legacy_api_key_id(ProviderKind::OpenAi), "api_key:openai");
        // 新旧两种名字不会撞（配置 id 都带前缀）
        assert_ne!(legacy_api_key_id(ProviderKind::Anthropic), api_key_id("p_default"));
    }

    #[test]
    fn the_key_move_never_loses_both_copies() {
        // ⚠️ 这是搬迁**唯一不能破**的不变量：任何分支都不该让「老条目没了、
        // 新条目也没有」同时成立 —— 那就是用户的 key 凭空蒸发了。
        //
        // 穷举四种组合（老条目有/没有 × 新条目有/没有），逐个检查分支的**前提**。
        for source in [None, Some("sk-old")] {
            for target in [None, Some("sk-new")] {
                let plan = plan_key_move(source, target);
                match plan {
                    // 老条目本来就空 —— 搬之前就是「没有」，谈不上丢
                    KeyMove::Nothing => assert!(source.is_none(), "{source:?} {target:?}"),
                    // 先写新的、再删老的：中间态是「两边都有」，不是「两边都没有」
                    KeyMove::CopyThenDelete => {
                        assert!(source.is_some() && target.is_none(), "{source:?} {target:?}")
                    }
                    // 只删老的前提是新条目已经有值
                    KeyMove::JustDelete => {
                        assert!(source.is_some() && target.is_some(), "{source:?} {target:?}")
                    }
                }
            }
        }
    }

    #[test]
    fn an_existing_target_is_never_overwritten() {
        // 用户可能在老条目还在的时候自己重填过一把 —— 那把比老的**新**，
        // 覆盖它等于把用户刚做的事抹掉。所以目标非空时只删来源。
        assert_eq!(plan_key_move(Some("sk-old"), Some("sk-new")), KeyMove::JustDelete);
        assert_eq!(plan_key_move(Some("sk-old"), None), KeyMove::CopyThenDelete);
        assert_eq!(plan_key_move(None, None), KeyMove::Nothing);
    }

    #[test]
    fn only_anthropic_has_a_default_base_url() {
        // OpenAI 兼容那一路没有"官方地址"可言 —— 给个默认值只会让人
        // 以为请求该往那儿发。
        assert!(ProviderKind::Anthropic.default_base_url().is_some());
        assert_eq!(ProviderKind::OpenAi.default_base_url(), None);
    }

    #[test]
    fn a_fresh_openai_config_is_not_valid_until_the_url_is_filled() {
        let c = ProviderConfig::new(ProviderKind::OpenAi);
        assert!(c.validate().is_err(), "地址空着就该拦下来");

        let filled = ProviderConfig {
            base_url: "https://api.deepseek.com".into(),
            ..c
        };
        assert!(filled.validate().is_ok());
    }

    #[test]
    fn endpoint_joining_does_not_double_the_slash() {
        // 拼出 `//v1/messages` 的话，有的网关会 404，有的会当成不同的路径。
        let c = ProviderConfig {
            kind: ProviderKind::Anthropic,
            base_url: "https://api.anthropic.com/".into(),
            model: "claude-opus-5".into(),
        };
        assert_eq!(c.endpoint("/v1/messages"), "https://api.anthropic.com/v1/messages");
        assert_eq!(c.endpoint("v1/messages"), "https://api.anthropic.com/v1/messages");
    }

    #[test]
    fn a_url_without_a_scheme_is_rejected() {
        // 少了 scheme 的地址会在网络层报一个和配置毫无关系的错。
        let c = ProviderConfig {
            kind: ProviderKind::OpenAi,
            base_url: "api.deepseek.com".into(),
            model: "deepseek-chat".into(),
        };
        let err = c.validate().unwrap_err();
        assert!(err.contains("http"), "文案要说清该怎么改：{err}");
    }

    #[test]
    fn an_empty_model_is_rejected() {
        let c = ProviderConfig {
            kind: ProviderKind::Anthropic,
            base_url: "https://api.anthropic.com".into(),
            model: "  ".into(),
        };
        assert!(c.validate().is_err());
    }

    #[test]
    fn config_round_trips_through_json_with_camel_case() {
        // 这份配置会经过 IPC 和 KV，两边的字段名要定死。
        let c = ProviderConfig::new(ProviderKind::Anthropic);
        let s = serde_json::to_string(&c).unwrap();
        assert!(s.contains(r#""baseUrl""#), "字段名没转成 camelCase：{s}");
        assert!(s.contains(r#""kind":"anthropic""#), "{s}");
        let back: ProviderConfig = serde_json::from_str(&s).unwrap();
        assert_eq!(c, back);
    }
}
