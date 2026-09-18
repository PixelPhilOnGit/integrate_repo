/**
 * 尾部合并。
 *
 * 它守着一条真问题：拖动分屏分隔条时每一帧都可能给 PTY 发一次 resize，
 * 而 **ConPTY 在连续 resize 下会损坏输出**（wezterm 作者的描述 + Windows
 * Terminal #15935）。所以「只发最后一个」不是优化，是正确性。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCoalescer } from '../../src/shared/terminal/coalesce';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('尾部合并', () => {
  it('连续推多个值，只送出最后一个', () => {
    const sent: number[] = [];
    const c = createCoalescer(100, (v: number) => sent.push(v));

    for (let i = 0; i < 20; i += 1) c.push(i);
    expect(sent).toEqual([]);

    vi.advanceTimersByTime(100);
    expect(sent).toEqual([19]);
  });

  it('⚠️ 松手之后一定送得出去 —— 停在中间宽度上是明显的 bug', () => {
    const sent: number[] = [];
    const c = createCoalescer(100, (v: number) => sent.push(v));

    c.push(1);
    vi.advanceTimersByTime(60);
    c.push(2); // 计时器重置
    vi.advanceTimersByTime(60);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(40);
    expect(sent).toEqual([2]);
  });

  it('隔得够久就是两次独立的发送', () => {
    const sent: number[] = [];
    const c = createCoalescer(100, (v: number) => sent.push(v));

    c.push(1);
    vi.advanceTimersByTime(150);
    c.push(2);
    vi.advanceTimersByTime(150);
    expect(sent).toEqual([1, 2]);
  });

  it('cancel 之后不再发送（会话已经关了）', () => {
    const sent: number[] = [];
    const c = createCoalescer(100, (v: number) => sent.push(v));

    c.push(1);
    c.cancel();
    vi.advanceTimersByTime(500);
    expect(sent).toEqual([]);
  });

  it('flush 立刻送出挂着的那个', () => {
    const sent: number[] = [];
    const c = createCoalescer(100, (v: number) => sent.push(v));

    c.push(7);
    c.flush();
    expect(sent).toEqual([7]);

    // flush 之后计时器不该再补发一次
    vi.advanceTimersByTime(500);
    expect(sent).toEqual([7]);
  });

  it('没东西可送时 flush / cancel 是安全的', () => {
    const sent: number[] = [];
    const c = createCoalescer(100, (v: number) => sent.push(v));
    c.flush();
    c.cancel();
    vi.advanceTimersByTime(500);
    expect(sent).toEqual([]);
  });
});
