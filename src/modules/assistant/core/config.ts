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

// ⚠️ 这两个是从 `shared/connections/` 借来的（`nextAvailableName` 甚至住在
// 「连接」那一层，而助手不是连接类模块）。复用它而不是各写一遍的理由：
// **名字去重的口径必须全仓一致**（「新建配置」→「新建配置 2」这个形状），
// 各写一份迟早会分叉。想把它挪到 `shared/` 顶层是另一件事，会牵动三个模块。
import { newId } from '../../../shared/ids';
import { asArray, asRecord, asString, nextAvailableName } from '../../../shared/connections/profiles';

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

/**
 * 发给 Rust 的那三个字段。**这是 IPC 契约**，别往里加东西 ——
 * `assistant_send` / `assistant_test_connection` 收的就是它。
 */
export interface ProviderConfig {
  kind: ProviderKind;
  /** 接口地址，不带结尾斜杠 */
  baseUrl: string;
  model: string;
}

/**
 * 一份**命名的**模型配置（用户在侧栏能看到、能切换的那种）。
 *
 * ⚠️ 它是 [`ProviderConfig`] 的**超集**，这是刻意的：`validateConfig` /
 * `endpointOf` / `defaultConfig` 一个字都不用改就能吃它。
 *
 * 为什么要多份：用户的机器上常常有不止一套 —— 「公司的 Anthropic」「自己的
 * DeepSeek」。只有一份的话每次换都得重填地址和模型。
 */
export interface ProviderProfile extends ProviderConfig {
  id: string;
  name: string;
}

/** KV：整份名单（一个键整个数组，照连接档案）。 */
export const PROFILES_KEY = 'profiles';
/**
 * KV：现在用的是哪一份。
 *
 * ⚠️ **这个要落盘**，和 redis/sql/ssh「选中项不落盘」是有意的偏差：
 * 「哪一份在用」直接决定发出去的东西，而侧栏只在助手模块里可见 ——
 * 重启之后悄悄换一份，用户看不见，只会觉得「怎么又是不通的那份」。
 */
export const SELECTED_KEY = 'selected';
/** KV：**旧版**那份裸配置（升级时消费掉，见 `profileFromLegacy`）。 */
export const LEGACY_CONFIG_KEY = 'provider';

/**
 * 从旧版迁过来的那一份的 id。
 *
 * ⚠️ **固定值，不是 `newId()`** —— 钥匙串搬迁（`assistant_migrate_api_key`）
 * 要能**反复重试**而不换目标条目名，靠的就是这个 id 每次都一样。
 */
export const LEGACY_PROFILE_ID = 'p_default';
/** 它的名字。⚠️ 不要用提供方名 —— 侧栏副标题已经是提供方了，会出现「Anthropic · Anthropic」。 */
export const LEGACY_PROFILE_NAME = '默认配置';

/** 新建一份配置时用的名字（`nextAvailableName` 会去重成「新建配置 2」）。 */
const NEW_PROFILE_NAME = '新建配置';

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
 * 一份**配置**的 key 在钥匙串里的条目 id。
 *
 * ⚠️ **按配置分开存，不是按提供方** —— 同一家可以有好几份配置
 *（「工作用 Anthropic」「自己的 Anthropic」），按提供方命名会让它们
 * **互相顶掉**：症状是「我明明填过，怎么又要填」，而要等到下次发请求才发现。
 *
 * 这是 Rust 侧 `provider_config::api_key_id` 的同一条规则 —— 改一边要看另一边。
 */
export function apiKeyId(profileId: string): string {
  return `api_key:${profileId}`;
}

/**
 * 老版本按**提供方**命名的条目 id —— **只给搬迁用**。
 *
 * ⚠️ 从旧版本升上来的用户，那把 key 就躺在这个名字底下；搬迁
 * （`migrateApiKey`）全靠它对上老数据。具体怎么搬在 Rust 侧
 *（`plan_key_move`，有穷举测试）。
 */
export function legacyApiKeyId(kind: ProviderKind): string {
  return `api_key:${kind}`;
}

/** 新建一份配置（名字去重、字段用那一家的默认值）。 */
export function defaultProfile(
  existing: readonly ProviderProfile[],
  kind: ProviderKind = 'anthropic',
): ProviderProfile {
  return {
    id: newId('p'),
    name: nextAvailableName(
      existing.map((p) => p.name),
      NEW_PROFILE_NAME,
    ),
    ...defaultConfig(kind),
  };
}

/**
 * 只取 IPC 那三个字段。
 *
 * ⚠️ **`id` / `name` 不能漏进 IPC** —— 那三个字段是 `ProviderConfig` 的契约，
 * 多塞两个进去会让「前端配置的形状」和「Rust 认得的形状」悄悄分叉。
 */
export function configOf(profile: ProviderConfig): ProviderConfig {
  return { kind: profile.kind, baseUrl: profile.baseUrl, model: profile.model };
}

/** 从状态里取「现在用的那一份」。指向一个不存在的 id 就是 `null`。 */
export function selectedProfile(state: {
  profiles: readonly ProviderProfile[];
  selectedId: string | null;
}): ProviderProfile | null {
  if (state.selectedId === null) return null;
  return state.profiles.find((p) => p.id === state.selectedId) ?? null;
}

/** 这是从旧版（单份配置）迁过来的那一份吗。搬迁的重试判据用到它。 */
export function isLegacyProfile(profile: ProviderProfile): boolean {
  return profile.id === LEGACY_PROFILE_ID;
}

/**
 * 一份配置读回来是不是还认得出。
 *
 * ⚠️ **没有 `id` 就 `null`**（不是补一个）：id 是这份记录的唯一身份，
 * 补一个等于每次读盘都给它换一个身份 —— 钥匙串里那条 key 就再也对不上了。
 * 坏记录整条丢掉，不连坐别的（照连接档案的规矩）。
 */
export function coerceProfile(raw: unknown): ProviderProfile | null {
  const o = asRecord(raw);
  if (o === null) return null;

  const id = asString(o.id);
  if (id === '') return null;

  const base = coerceConfig(o);
  return {
    id,
    name: asString(o.name) || LEGACY_PROFILE_NAME,
    ...base,
  };
}

/** 整份名单读回来。坏记录单条丢掉，剩下的照常。 */
export function coerceProfiles(raw: unknown): ProviderProfile[] {
  const out: ProviderProfile[] = [];
  const seen = new Set<string>();
  for (const item of asArray(raw)) {
    const profile = coerceProfile(item);
    // 重复 id 只留第一条：两条同 id 的记录在钥匙串里共用一把 key，
    // 而界面上会出现「改这份、那份也跟着变」—— 不如直接丢掉后来的
    if (profile !== null && !seen.has(profile.id)) {
      seen.add(profile.id);
      out.push(profile);
    }
  }
  return out;
}

/**
 * 旧版那份**裸配置**（KV 键 `provider`）→ 一份命名配置。
 *
 * 认不出来就 `null`（调用方会兜一份全新的默认配置）。
 * 固定 id 和名字的理由见 [`LEGACY_PROFILE_ID`]。
 */
export function profileFromLegacy(raw: unknown): ProviderProfile | null {
  const o = asRecord(raw);
  // 至少要像个 provider 配置：`kind` 认得出、且有个字符串地址或模型
  if (o === null) return null;
  if (o.kind !== 'anthropic' && o.kind !== 'openai') return null;
  if (typeof o.baseUrl !== 'string' && typeof o.model !== 'string') return null;

  return {
    id: LEGACY_PROFILE_ID,
    name: LEGACY_PROFILE_NAME,
    ...coerceConfig(o),
  };
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
