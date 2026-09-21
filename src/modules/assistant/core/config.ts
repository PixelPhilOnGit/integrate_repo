/**
 * 助手的配置：用哪家模型、打哪个地址、用哪个模型。
 *
 * 纯 TS —— 不 import React、不碰 DOM、不碰 Tauri。所以 `npm test`
 * （vitest 跑在 node 环境）能直接测它，不需要浏览器。
 *
 * ⚠️ 这里的规则和 Rust 侧的 `assistant/src/provider_config.rs` 是**同一套**。
 * 两边各写各的是有意的：Rust 那份是发请求前最后一道闸门（改了 config 的
 * 唯一入口就是它），这份负责让用户在**界面上**就看见问题 —— 而不是等到
 * 点了发送才收到一个网络层的怪错误。**改一边的时候记得看另一边。**
 */

/** 走哪套协议。 */
export type ProviderKind = 'anthropic' | 'openai';

/** 给用户看的名字。 */
export const PROVIDER_LABEL: Record<ProviderKind, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI 兼容',
};

/** 选提供方时那一段说明 —— 用户多半不知道这两个有什么区别。 */
export const PROVIDER_HINT: Record<ProviderKind, string> = {
  anthropic: 'Anthropic 官方接口。地址已经填好，只需要填 key。',
  openai:
    'DeepSeek / Qwen / vLLM / ollama / 公司内网网关都走这一路。**地址必须自己填** —— 它们没有统一的官方地址。',
};

export interface ProviderConfig {
  kind: ProviderKind;
  /** 接口地址，不带结尾斜杠 */
  baseUrl: string;
  model: string;
}

/** 只有 Anthropic 有默认地址，理由见 `provider_config.rs`。 */
const DEFAULT_BASE_URL: Record<ProviderKind, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: '',
};

const DEFAULT_MODEL: Record<ProviderKind, string> = {
  anthropic: 'claude-opus-5',
  openai: 'gpt-4o',
};

/** 新建一份默认配置（切换提供方时也用它）。 */
export function defaultConfig(kind: ProviderKind): ProviderConfig {
  return { kind, baseUrl: DEFAULT_BASE_URL[kind], model: DEFAULT_MODEL[kind] };
}

/**
 * 这个提供方的 key 在钥匙串里的条目 id。
 *
 * ⚠️ **按提供方分开存**：两家各一把 key，来回切的时候不会互相覆盖 ——
 * 覆盖了的话症状是「我明明填过，怎么又要填」，而且要等到下次发请求才发现。
 */
export function apiKeyId(kind: ProviderKind): string {
  return `api_key:${kind}`;
}

/**
 * 检查配置。返回 `null` 表示没问题，否则是给用户看的一句话。
 *
 * ⚠️ 地址是**必填**的（对 OpenAI 兼容那一路尤其要紧）：空着的话请求会打到
 * 一个拼出来的怪地址上，报错还看不出是配置的问题。
 */
export function validateConfig(config: ProviderConfig): string | null {
  const url = config.baseUrl.trim();
  if (url === '') {
    return config.kind === 'anthropic'
      ? '还没填接口地址'
      : 'OpenAI 兼容这一路要填接口地址 —— DeepSeek / vLLM / 内网网关各不相同，没有默认值';
  }
  if (!url.startsWith('https://') && !url.startsWith('http://')) {
    return `接口地址要以 http:// 或 https:// 开头，现在是「${config.baseUrl}」`;
  }
  if (config.model.trim() === '') return '还没填模型 id';
  return null;
}

/** 拼一个路径到地址后面（顺手处理掉结尾斜杠，避免拼出 `//v1/...`）。 */
export function endpointOf(config: ProviderConfig, path: string): string {
  const base = config.baseUrl.trim().replace(/\/+$/, '');
  return `${base}/${path.replace(/^\/+/, '')}`;
}

/**
 * 从 KV 里读回来的东西**不一定是这个形状**（用户手改过、或者版本旧了）。
 * 认不出来就退回默认值 —— 配置坏掉不该让整个模块打不开。
 */
export function coerceConfig(raw: unknown): ProviderConfig {
  if (typeof raw !== 'object' || raw === null) return defaultConfig('anthropic');
  const o = raw as Record<string, unknown>;
  const kind: ProviderKind = o.kind === 'openai' ? 'openai' : 'anthropic';
  const fallback = defaultConfig(kind);
  return {
    kind,
    baseUrl: typeof o.baseUrl === 'string' ? o.baseUrl : fallback.baseUrl,
    model: typeof o.model === 'string' ? o.model : fallback.model,
  };
}
