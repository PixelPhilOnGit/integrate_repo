import { describe, expect, it } from 'vitest';
import {
  MAX_ARRAY_ITEMS,
  formatElapsed,
  renderReply,
  summarize,
} from '../../src/modules/redis/core/render';
import type { RedisReply } from '../../src/modules/redis/core/types';

const bulk = (text: string): RedisReply => ({
  type: 'bulk',
  text,
  binary: false,
  bytes: new TextEncoder().encode(text).length,
});

describe('回复渲染', () => {
  it('标量按 redis-cli 的记号渲染', () => {
    expect(renderReply({ type: 'nil' })).toEqual(['(nil)']);
    expect(renderReply({ type: 'status', text: 'OK' })).toEqual(['OK']);
    expect(renderReply({ type: 'status', text: 'PONG' })).toEqual(['PONG']);
    expect(renderReply({ type: 'integer', value: 42 })).toEqual(['(integer) 42']);
    expect(renderReply({ type: 'integer', value: -1 })).toEqual(['(integer) -1']);
    expect(renderReply(bulk('hello'))).toEqual(['"hello"']);
  });

  it('服务器错误带上 (error) 前缀，和 redis-cli 一致', () => {
    expect(renderReply({ type: 'error', message: "ERR unknown command 'X'" })).toEqual([
      "(error) ERR unknown command 'X'",
    ]);
  });

  it('二进制值只报字节数，不显示内容', () => {
    const reply: RedisReply = { type: 'bulk', text: '乱码', binary: true, bytes: 12 };
    expect(renderReply(reply)).toEqual(['(二进制, 12 字节)']);
  });

  it('字符串里的引号、反斜杠、控制字符会被转义', () => {
    // 值里带换行是常事，原样打出来会把一行日志撑成好几行
    expect(renderReply(bulk('a\nb'))).toEqual(['"a\\x0ab"']);
    expect(renderReply(bulk('say "hi"'))).toEqual(['"say \\"hi\\""']);
    expect(renderReply(bulk('a\\b'))).toEqual(['"a\\\\b"']);
    // 中文不需要转义
    expect(renderReply(bulk('张三'))).toEqual(['"张三"']);
  });

  it('数组逐项编号', () => {
    const reply: RedisReply = { type: 'array', items: [bulk('a'), bulk('b'), bulk('c')] };
    expect(renderReply(reply)).toEqual(['1) "a"', '2) "b"', '3) "c"']);
  });

  it('空数组和 nil 是两回事', () => {
    expect(renderReply({ type: 'array', items: [] })).toEqual(['(empty array)']);
    expect(renderReply({ type: 'nil' })).toEqual(['(nil)']);
  });

  it('嵌套数组按层级缩进', () => {
    const reply: RedisReply = {
      type: 'array',
      items: [bulk('a'), { type: 'array', items: [bulk('b'), bulk('c')] }],
    };
    expect(renderReply(reply)).toEqual(['1) "a"', '2) 1) "b"', '2) 2) "c"']);
  });

  it('map 用 => 连接键值', () => {
    const reply: RedisReply = { type: 'map', entries: [[bulk('k'), bulk('v')]] };
    expect(renderReply(reply)).toEqual(['1) "k" => "v"']);
  });

  it('set 和数组一样逐项编号', () => {
    const reply: RedisReply = { type: 'set', items: [bulk('x')] };
    expect(renderReply(reply)).toEqual(['1) "x"']);
  });

  it('特殊的双精度值用 redis 的写法', () => {
    expect(renderReply({ type: 'double', value: 1.5 })).toEqual(['(double) 1.5']);
    // JS 的 String(Infinity) 是 "Infinity"，redis 那边写的是 inf
    expect(renderReply({ type: 'double', value: Infinity })).toEqual(['(double) inf']);
    expect(renderReply({ type: 'double', value: -Infinity })).toEqual(['(double) -inf']);
    expect(renderReply({ type: 'double', value: NaN })).toEqual(['(double) nan']);
  });

  it('布尔和大整数', () => {
    expect(renderReply({ type: 'boolean', value: true })).toEqual(['(true)']);
    expect(renderReply({ type: 'boolean', value: false })).toEqual(['(false)']);
    expect(renderReply({ type: 'bigNumber', text: '123456789012345678901' })).toEqual([
      '(bignumber) 123456789012345678901',
    ]);
  });

  it('verbatim 带上它的格式标记', () => {
    expect(renderReply({ type: 'verbatim', format: 'txt', text: 'hi' })).toEqual(['=txt "hi"']);
  });

  it('超大数组会截断，但会说明还有多少项', () => {
    const items = Array.from({ length: MAX_ARRAY_ITEMS + 37 }, (_, i) => bulk(String(i)));
    const lines = renderReply({ type: 'array', items });

    expect(lines).toHaveLength(MAX_ARRAY_ITEMS + 1);
    expect(lines[MAX_ARRAY_ITEMS]).toContain('还有 37 项');
    // 前 MAX_ARRAY_ITEMS 项都在
    expect(lines[MAX_ARRAY_ITEMS - 1]).toBe(`${MAX_ARRAY_ITEMS}) "${MAX_ARRAY_ITEMS - 1}"`);
  });

  it('summarize 取第一行', () => {
    expect(summarize({ type: 'integer', value: 7 })).toBe('(integer) 7');
    expect(summarize({ type: 'array', items: [bulk('a'), bulk('b')] })).toBe('1) "a"');
  });
});

describe('耗时格式化', () => {
  it('不到 10 毫秒保留一位小数，别四舍五入成 0', () => {
    expect(formatElapsed(0.4)).toBe('0.4ms');
    expect(formatElapsed(3.25)).toBe('3.3ms');
  });

  it('毫秒级取整', () => {
    expect(formatElapsed(42.7)).toBe('43ms');
    expect(formatElapsed(999)).toBe('999ms');
  });

  it('超过一秒换成秒', () => {
    expect(formatElapsed(1500)).toBe('1.50s');
  });
});
