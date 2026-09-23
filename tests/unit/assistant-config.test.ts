/**
 * 助手配置的纯逻辑。
 *
 * 这一层要挡住的是「配错了要等到发请求才发现」那一类问题 —— 所以每条校验
 * 都有一个用例盯着它到底拦没拦住，以及**拦下来时说的话能不能照着改**。
 *
 * ⚠️ 这里的规则和 Rust 侧的 `provider_config.rs` 是同一套，两边各测各的。
 * 改了一边记得看另一边有没有对应的用例。
 */
import { describe, expect, it } from 'vitest';
import {
  LEGACY_PROFILE_ID,
  apiKeyId,
  coerceConfig,
  coerceProfiles,
  configOf,
  defaultConfig,
  defaultProfile,
  endpointOf,
  isLegacyProfile,
  legacyApiKeyId,
  profileFromLegacy,
  selectedProfile,
  validateConfig,
} from '../../src/modules/assistant/core/config';
import type { ProviderProfile } from '../../src/modules/assistant/core/config';

describe('默认值', () => {
  it('两家各有各的默认模型', () => {
    expect(defaultConfig('anthropic').model).toBe('claude-opus-5');
    expect(defaultConfig('openai').model).not.toBe('');
  });

  it('⚠️ 只有 Anthropic 预填地址', () => {
    // OpenAI 兼容那一路没有"官方地址"可言（DeepSeek / vLLM / 内网网关各不相同）。
    // 给它预填一个只会让人以为请求该往那儿发。
    expect(defaultConfig('anthropic').baseUrl).toBe('https://api.anthropic.com');
    expect(defaultConfig('openai').baseUrl).toBe('');
  });
});

describe('校验', () => {
  it('地址空着要拦下来，而且两家的说法不一样', () => {
    const anthropic = validateConfig({ kind: 'anthropic', baseUrl: '', model: 'x' });
    const openai = validateConfig({ kind: 'openai', baseUrl: '  ', model: 'x' });
    expect(anthropic).not.toBeNull();
    expect(openai).not.toBeNull();
    // OpenAI 那边要额外说清「为什么没有默认值」
    expect(openai).toContain('没有默认值');
  });

  it('少了 scheme 的地址要拦下来，并说清该怎么改', () => {
    const err = validateConfig({
      kind: 'openai',
      baseUrl: 'api.deepseek.com',
      model: 'deepseek-chat',
    });
    expect(err).toContain('http');
  });

  it('模型是空白也要拦', () => {
    expect(
      validateConfig({ kind: 'anthropic', baseUrl: 'https://api.anthropic.com', model: '   ' }),
    ).not.toBeNull();
  });

  it('填齐了就是 null', () => {
    expect(validateConfig(defaultConfig('anthropic'))).toBeNull();
    expect(
      validateConfig({ kind: 'openai', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' }),
    ).toBeNull();
  });
});

describe('地址拼接', () => {
  it('结尾有没有斜杠都拼成同一个结果', () => {
    // 拼出 `//v1/messages` 的话，有的网关 404、有的当成另一条路径。
    const withSlash = { kind: 'anthropic' as const, baseUrl: 'https://a.com/', model: 'm' };
    const without = { kind: 'anthropic' as const, baseUrl: 'https://a.com', model: 'm' };
    expect(endpointOf(withSlash, '/v1/messages')).toBe('https://a.com/v1/messages');
    expect(endpointOf(without, 'v1/messages')).toBe('https://a.com/v1/messages');
  });
});

describe('从 KV 读回来的东西', () => {
  it('认不出来就退回默认值（配置坏掉不该让模块打不开）', () => {
    for (const junk of [null, undefined, 42, 'abc', []]) {
      const c = coerceConfig(junk);
      expect(c.kind).toBe('anthropic');
      expect(c.model).not.toBe('');
    }
  });

  it('缺字段的用默认值补上', () => {
    const c = coerceConfig({ kind: 'openai' });
    expect(c.kind).toBe('openai');
    // OpenAI 的默认地址是空串，补上之后仍然是空串 —— 该让用户填的还是要他填
    expect(c.baseUrl).toBe('');
  });

  it('完整的原样保留', () => {
    const raw = { kind: 'openai', baseUrl: 'https://x.com', model: 'm1' };
    expect(coerceConfig(raw)).toEqual(raw);
  });
});

describe('key 的条目名', () => {
  it('条目名跟着**配置 id** 走', () => {
    expect(apiKeyId('p_default')).toBe('api_key:p_default');
  });

  it('⚠️ 同一家的两份配置不共用条目', () => {
    // 这条是「按配置存」的**全部理由**。按提供方存的年代，两份 Anthropic 配置
    // 会共用一把 key，来回切互相覆盖 —— 症状是「我明明填过，怎么又要填」，
    // 而且要等到下次发请求才发现。
    expect(apiKeyId('p_work')).not.toBe(apiKeyId('p_home'));
  });

  it('⚠️ 老名字还是老名字 —— 搬迁全靠它', () => {
    // 从旧版本升上来的用户，那把 key 躺在 `api_key:<提供方>` 底下。
    // 改了这几个字面量 = 所有老用户升级之后 key 静默消失。
    expect(legacyApiKeyId('anthropic')).toBe('api_key:anthropic');
    expect(legacyApiKeyId('openai')).toBe('api_key:openai');
    // 新旧两种名字不会撞
    expect(legacyApiKeyId('anthropic')).not.toBe(apiKeyId('p_default'));
  });
});

// ------------------------------------------------------------- 多份配置

function profile(patch: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    id: 'p1',
    name: '工作',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-opus-5',
    ...patch,
  };
}

describe('配置名单', () => {
  it('新建的名字自动去重', () => {
    // 侧栏里两条同名的话，用户分不清哪条是哪条
    expect(defaultProfile([]).name).toBe('新建配置');
    expect(defaultProfile([profile({ name: '新建配置' })]).name).toBe('新建配置 2');
  });

  it('⚠️ configOf 只出那三个字段 —— 这是 IPC 契约', () => {
    // id / name 漏进 IPC 的话，「前端配置的形状」和「Rust 认得的形状」会悄悄分叉，
    // 而那种分叉两边的测试都盖不到。
    expect(Object.keys(configOf(profile())).sort()).toEqual(['baseUrl', 'kind', 'model']);
  });

  it('selectedProfile：指向不存在的 id 就是 null', () => {
    expect(selectedProfile({ profiles: [profile()], selectedId: 'p1' })?.id).toBe('p1');
    expect(selectedProfile({ profiles: [profile()], selectedId: 'nope' })).toBeNull();
    expect(selectedProfile({ profiles: [profile()], selectedId: null })).toBeNull();
  });
});

describe('从 KV 读回来的名单', () => {
  it('不是数组就是空名单', () => {
    expect(coerceProfiles(null)).toEqual([]);
    expect(coerceProfiles(42)).toEqual([]);
    expect(coerceProfiles({})).toEqual([]);
  });

  it('⚠️ 没有 id 的记录整条丢掉 —— 不补一个', () => {
    // 补一个等于每次读盘都给它换一个身份，钥匙串里那条 key 就再也对不上了
    expect(coerceProfiles([{ name: 'x', kind: 'anthropic' }])).toEqual([]);
  });

  it('一条坏的不会连坐别的', () => {
    const rows = coerceProfiles([
      { id: 'a', kind: 'anthropic' },
      null,
      { id: 'b', kind: 'openai' },
    ]);
    expect(rows.map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('缺 name 补一个能认出来的', () => {
    expect(coerceProfiles([{ id: 'a', kind: 'anthropic' }])[0]?.name).toBe('默认配置');
  });

  it('⚠️ 重复 id 只留第一条', () => {
    // 两条同 id 在钥匙串里共用一把 key，界面上会「改这份、那份也跟着变」
    const rows = coerceProfiles([
      { id: 'a', name: '一' },
      { id: 'a', name: '二' },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe('一');
  });
});

describe('从旧版那份裸配置迁过来', () => {
  it('认得出旧形状', () => {
    const p = profileFromLegacy({
      kind: 'openai',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
    });
    expect(p?.id).toBe(LEGACY_PROFILE_ID);
    expect(p?.name).toBe('默认配置');
    expect(p?.kind).toBe('openai');
    expect(p?.baseUrl).toBe('https://api.deepseek.com');
  });

  it('⚠️ 名字不用提供方名 —— 侧栏副标题已经是它了', () => {
    // 用提供方名的话侧栏会显示「Anthropic · Anthropic」，读起来像 bug
    const p = profileFromLegacy({
      kind: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-opus-5',
    });
    expect(p?.name).toBe('默认配置');
  });

  it('认不出来就是 null（调用方会兜一份全新的）', () => {
    expect(profileFromLegacy(null)).toBeNull();
    expect(profileFromLegacy(42)).toBeNull();
    expect(profileFromLegacy('abc')).toBeNull();
    // kind 认不出 → 不当旧配置（否则会把一个乱七八糟的东西端上来）
    expect(profileFromLegacy({ kind: 'gemini', baseUrl: 'https://x' })).toBeNull();
    // 连 baseUrl 和 model 都没有 → 不是配置
    expect(profileFromLegacy({ kind: 'anthropic' })).toBeNull();
  });

  it('isLegacyProfile 认的就是那个固定 id', () => {
    expect(isLegacyProfile(profile({ id: LEGACY_PROFILE_ID }))).toBe(true);
    expect(isLegacyProfile(profile({ id: 'p_other' }))).toBe(false);
  });
});
