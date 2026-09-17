/**
 * 把 `KeyDetail` 整形成界面好渲染的形状。
 *
 * 纯函数，不碰 DOM —— 所以「一个 hash 该怎么显示」这类判断能在 node 下穷举测。
 *
 * 为什么不直接在组件里 `switch (detail.keyType)`：那样每种类型的形状判断会和
 * JSX 缠在一起，测试要挂 jsdom、断言要查 DOM。分开之后两边都简单。
 */

import type { KeyDetail, RedisReply } from './types';

/** 值的展示形状 */
export type ValueView =
  /** 单段文本（string）。二进制值只给长度，不给内容 */
  | { kind: 'text'; text: string; binary: boolean; bytes: number }
  /** 有序列表（list / set） */
  | { kind: 'list'; items: string[] }
  /** 键值对（hash = 字段/值，zset = 成员/分数） */
  | { kind: 'pairs'; leftLabel: string; rightLabel: string; pairs: [string, string][] }
  /** 键不存在 */
  | { kind: 'nil' }
  /** 认不出的类型 —— 兜底把它按 redis-cli 的样子打成几行，至少信息不丢 */
  | { kind: 'raw'; lines: string[] };

export function toValueView(detail: KeyDetail): ValueView {
  if (detail.keyType === 'none') return { kind: 'nil' };

  switch (detail.keyType) {
    case 'string':
      return stringView(detail.value);

    case 'list':
    case 'set':
      return { kind: 'list', items: texts(detail.value) };

    case 'hash':
      // HGETALL 形状：[字段, 值, 字段, 值, ...]
      return { kind: 'pairs', leftLabel: '字段', rightLabel: '值', pairs: toPairs(detail.value, 2) };

    case 'zset':
      // ZRANGE ... WITHSCORES 形状：[成员, 分数, 成员, 分数, ...]
      return { kind: 'pairs', leftLabel: '成员', rightLabel: '分数', pairs: toPairs(detail.value, 2) };

    case 'stream':
      return { kind: 'raw', lines: streamLines(detail.value) };

    default:
      return { kind: 'raw', lines: [] };
  }
}

function stringView(value: RedisReply): ValueView {
  if (value.type === 'bulk') {
    return { kind: 'text', text: value.binary ? '' : value.text, binary: value.binary, bytes: value.bytes };
  }
  // string 类型拿到 nil 基本只可能是「查询和读取之间被删了」
  if (value.type === 'nil') return { kind: 'nil' };

  return { kind: 'raw', lines: [] };
}

/** 取数组里的每一项当文本 */
function texts(value: RedisReply): string[] {
  if (value.type !== 'array') return [];
  return value.items.map(asText);
}

/** 把扁平数组两两配成键值对 */
function toPairs(value: RedisReply, size: number): [string, string][] {
  if (value.type !== 'array') return [];

  const flat = value.items.map(asText);
  const pairs: [string, string][] = [];
  for (let i = 0; i + size - 1 < flat.length; i += size) {
    pairs.push([flat[i] ?? '', flat[i + 1] ?? '']);
  }
  return pairs;
}

/** stream 的每一项是一个「id → 字段值列表」的嵌套结构，按 redis-cli 的样子铺平 */
function streamLines(value: RedisReply): string[] {
  if (value.type !== 'array') return [];

  const lines: string[] = [];
  for (const item of value.items) {
    const id = item.type === 'array' ? item.items[0] : undefined;
    const fieldsReply = item.type === 'array' ? item.items[1] : undefined;

    // 形状不对（不是 [id, 字段列表]）就原样打出来，至少信息不丢
    if (id === undefined || fieldsReply === undefined) {
      lines.push(asText(item));
      continue;
    }

    lines.push(asText(id));
    for (const [field, fieldValue] of toPairs(fieldsReply, 2)) {
      lines.push(`  ${field} = ${fieldValue}`);
    }
  }
  return lines;
}

/** 任意回复取一个可读的文本形式 */
function asText(value: RedisReply): string {
  switch (value.type) {
    case 'nil':
      return '(nil)';
    case 'status':
      return value.text;
    case 'error':
      return `(error) ${value.message}`;
    case 'integer':
      return String(value.value);
    case 'double':
      return String(value.value);
    case 'boolean':
      return value.value ? 'true' : 'false';
    case 'bigNumber':
      return value.text;
    case 'verbatim':
      return value.text;
    case 'bulk':
      return value.binary ? `(二进制, ${value.bytes} 字节)` : value.text;
    default:
      return '(嵌套结构)';
  }
}

/**
 * TTL 的展示文本。
 *
 * `-1` 和 `-2` 是 Redis 的两个特殊值（永不过期 / 键不存在），
 * 直接显示数字没人看得懂。
 */
export function formatTtl(ttl: number): string {
  if (ttl === -1) return '永不过期';
  if (ttl === -2) return '键不存在';
  if (ttl < 60) return `${ttl} 秒`;
  if (ttl < 3600) return `${Math.floor(ttl / 60)} 分 ${ttl % 60} 秒`;
  return `${Math.floor(ttl / 3600)} 小时 ${Math.floor((ttl % 3600) / 60)} 分`;
}

/** 元素总数的展示文本 */
export function formatSize(detail: KeyDetail): string | null {
  if (detail.size === undefined) return null;
  if (detail.keyType === 'string') return `${detail.size} 字节`;
  return `${detail.size} 项`;
}
