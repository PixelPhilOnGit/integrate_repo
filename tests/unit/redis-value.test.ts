import { describe, expect, it } from 'vitest';
import {
  formatSize,
  formatTtl,
  toValueView,
} from '../../src/modules/redis/core/value';
import type { KeyDetail, RedisReply } from '../../src/modules/redis/core/types';

function detail(patch: Partial<KeyDetail> & { value: RedisReply }): KeyDetail {
  return {
    key: 'k',
    keyType: 'string',
    ttl: -1,
    truncated: false,
    ...patch,
  };
}

const bulk = (text: string): RedisReply => ({
  type: 'bulk',
  text,
  binary: false,
  bytes: new TextEncoder().encode(text).length,
});

describe('值的展示形状', () => {
  it('不存在的键是 nil', () => {
    expect(toValueView(detail({ keyType: 'none', value: { type: 'nil' } }))).toEqual({ kind: 'nil' });
  });

  it('string 显示成一段文本', () => {
    const view = toValueView(detail({ value: bulk('hello') }));
    expect(view).toEqual({ kind: 'text', text: 'hello', binary: false, bytes: 5 });
  });

  it('空字符串和「没有值」要能区分开', () => {
    // 组件那边会把空字符串画成「(空字符串)」而不是什么都不显示
    expect(toValueView(detail({ value: bulk('') }))).toEqual({
      kind: 'text',
      text: '',
      binary: false,
      bytes: 0,
    });
  });

  it('二进制值不给内容，只给长度', () => {
    const view = toValueView(
      detail({ value: { type: 'bulk', text: '乱码', binary: true, bytes: 12 } }),
    );
    expect(view).toEqual({ kind: 'text', text: '', binary: true, bytes: 12 });
  });

  it('list 和 set 都是列表', () => {
    const value: RedisReply = { type: 'array', items: [bulk('a'), bulk('b')] };
    expect(toValueView(detail({ keyType: 'list', value }))).toEqual({
      kind: 'list',
      items: ['a', 'b'],
    });
    expect(toValueView(detail({ keyType: 'set', value }))).toEqual({
      kind: 'list',
      items: ['a', 'b'],
    });
  });

  it('hash 是两列的键值对', () => {
    const value: RedisReply = { type: 'array', items: [bulk('f1'), bulk('v1'), bulk('f2'), bulk('v2')] };
    expect(toValueView(detail({ keyType: 'hash', value }))).toEqual({
      kind: 'pairs',
      leftLabel: '字段',
      rightLabel: '值',
      pairs: [
        ['f1', 'v1'],
        ['f2', 'v2'],
      ],
    });
  });

  it('zset 是成员和分数两列', () => {
    const value: RedisReply = { type: 'array', items: [bulk('a'), bulk('1'), bulk('b'), bulk('2')] };
    expect(toValueView(detail({ keyType: 'zset', value }))).toEqual({
      kind: 'pairs',
      leftLabel: '成员',
      rightLabel: '分数',
      pairs: [
        ['a', '1'],
        ['b', '2'],
      ],
    });
  });

  it('奇数个元素（数据不完整）不会崩', () => {
    const value: RedisReply = { type: 'array', items: [bulk('f1'), bulk('v1'), bulk('f2')] };
    const view = toValueView(detail({ keyType: 'hash', value }));
    expect(view).toEqual({
      kind: 'pairs',
      leftLabel: '字段',
      rightLabel: '值',
      // 最后一个配不上对的忽略掉，而不是补一个空字符串造出一行假数据
      pairs: [['f1', 'v1']],
    });
  });

  it('空容器和 nil 是两回事', () => {
    expect(toValueView(detail({ keyType: 'list', value: { type: 'array', items: [] } }))).toEqual({
      kind: 'list',
      items: [],
    });
  });

  it('stream 铺成带缩进的多行', () => {
    const value: RedisReply = {
      type: 'array',
      items: [
        {
          type: 'array',
          items: [
            bulk('1700000000000-0'),
            { type: 'array', items: [bulk('temp'), bulk('21')] },
          ],
        },
      ],
    };
    expect(toValueView(detail({ keyType: 'stream', value }))).toEqual({
      kind: 'raw',
      lines: ['1700000000000-0', '  temp = 21'],
    });
  });

  it('容器里的 nil 显示成 (nil) 而不是空', () => {
    const value: RedisReply = { type: 'array', items: [{ type: 'nil' }, bulk('b')] };
    expect(toValueView(detail({ keyType: 'list', value }))).toEqual({
      kind: 'list',
      items: ['(nil)', 'b'],
    });
  });

  it('认不出的类型给空的 raw，不抛错', () => {
    expect(toValueView(detail({ keyType: 'hyperloglog', value: bulk('x') }))).toEqual({
      kind: 'raw',
      lines: [],
    });
  });
});

describe('TTL 的文案', () => {
  it('两个特殊值要翻译成人话', () => {
    expect(formatTtl(-1)).toBe('永不过期');
    expect(formatTtl(-2)).toBe('键不存在');
  });

  it('按量级换单位', () => {
    expect(formatTtl(0)).toBe('0 秒');
    expect(formatTtl(59)).toBe('59 秒');
    expect(formatTtl(60)).toBe('1 分 0 秒');
    expect(formatTtl(125)).toBe('2 分 5 秒');
    expect(formatTtl(3600)).toBe('1 小时 0 分');
    expect(formatTtl(7500)).toBe('2 小时 5 分');
  });
});

describe('大小的文案', () => {
  it('string 报字节数', () => {
    expect(formatSize(detail({ keyType: 'string', value: bulk('hello'), size: 5 }))).toBe('5 字节');
  });

  it('容器报元素个数', () => {
    const value: RedisReply = { type: 'array', items: [] };
    expect(formatSize(detail({ keyType: 'hash', value, size: 3 }))).toBe('3 项');
  });

  it('拿不到大小就返回 null（组件据此不显示这一行）', () => {
    expect(formatSize(detail({ keyType: 'string', value: bulk('x') }))).toBeNull();
  });
});
