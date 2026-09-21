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

/// 这个 provider 的 API key 在钥匙串里的条目名。
///
/// 条目名的完整形式是 `"{模块}/{id}"`（见 `store/src/secrets.rs`），
/// 所以实际存的是 `assistant/api_key:anthropic`。
///
/// ⚠️ **按 provider 分开存**：`anthropic` 和 `openai` 各一把 key，
/// 用户来回切的时候不会互相覆盖（覆盖了的话，症状是"我明明填过，怎么又要填"，
/// 而且要等到下次发请求才发现）。
pub fn api_key_id(kind: ProviderKind) -> String {
    format!("api_key:{}", kind.as_str())
}

/// 这个模块在钥匙串里的名字（配合 [`api_key_id`] 用）。
pub const KEYCHAIN_MODULE: &str = "assistant";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_two_providers_get_separate_key_entries() {
        // 覆盖了的话症状是「我明明填过，怎么又要填」——而且要到下次发请求才发现。
        assert_ne!(
            api_key_id(ProviderKind::Anthropic),
            api_key_id(ProviderKind::OpenAi)
        );
        assert_eq!(api_key_id(ProviderKind::Anthropic), "api_key:anthropic");
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
