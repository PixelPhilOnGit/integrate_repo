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
  apiKeyId,
  coerceConfig,
  defaultConfig,
  endpointOf,
  validateConfig,
} from '../../src/modules/assistant/core/config';

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
  it('⚠️ 两家分开存', () => {
    // 共用一条的话，来回切会互相覆盖，症状是「我明明填过，怎么又要填」——
    // 而且要等到下次发请求才发现。
    expect(apiKeyId('anthropic')).not.toBe(apiKeyId('openai'));
    expect(apiKeyId('anthropic')).toBe('api_key:anthropic');
  });
});
