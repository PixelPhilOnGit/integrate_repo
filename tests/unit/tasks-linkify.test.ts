/**
 * 资料文字里的链接识别（`core/linkify.ts`）。
 *
 * 这里钉的是两类事：
 * 1. **正常链接要认出来**，而且结尾的标点不算链接的一部分
 *    （「见 https://x.com/a。」点开的不该带上那个句号）；
 * 2. **不该变成链接的东西一个都不能变成链接** —— 尤其是 `javascript:`、
 *    `file:` 这类 scheme：正文里混进来的东西不该被做成「可点」的样子
 *    （真发出去的后端也会再拦一道，见 `open.rs`，两边是同一套口径）。
 */
import { describe, expect, it } from 'vitest';
import { linkify, type Linkified } from '../../src/modules/tasks/core/linkify';

/** 把结果压成 "文字|链接" 的紧凑样子，断言好读 */
function compact(parts: Linkified[]): string {
  return parts.map((p) => (p.kind === 'url' ? `[${p.value}]` : p.value)).join('');
}

describe('linkify', () => {
  it('一句话里的链接会被单独切出来', () => {
    expect(compact(linkify('先看 https://example.com/a 再动手'))).toBe(
      '先看 [https://example.com/a] 再动手',
    );
  });

  it('http 和 https 都认', () => {
    expect(compact(linkify('http://a.dev'))).toBe('[http://a.dev]');
    expect(compact(linkify('https://a.dev'))).toBe('[https://a.dev]');
  });

  it('结尾的中英文标点不算链接的一部分', () => {
    expect(compact(linkify('见 https://x.com/a。'))).toBe('见 [https://x.com/a]。');
    expect(compact(linkify('see https://x.com/a.'))).toBe('see [https://x.com/a].');
    expect(compact(linkify('（https://x.com/a）'))).toBe('（[https://x.com/a]）');
  });

  it('链接里的查询参数（& 和 %）原样保留', () => {
    expect(compact(linkify('https://x.com/s?q=a%20b&n=1'))).toBe('[https://x.com/s?q=a%20b&n=1]');
  });

  it('没有链接时整段就是文字', () => {
    expect(linkify('就是一段话')).toEqual([{ kind: 'text', value: '就是一段话' }]);
  });

  it('空串给空结果（界面上就是什么都不画）', () => {
    expect(linkify('')).toEqual([]);
  });

  it('⚠️ javascript: 和 file: 不会被当成链接', () => {
    const parts = linkify('点这个 javascript:alert(1) 或者 file:///etc/passwd');
    expect(parts.every((p) => p.kind === 'text')).toBe(true);
  });

  it('一段里两个链接都切出来', () => {
    expect(compact(linkify('https://a.dev 和 https://b.dev'))).toBe('[https://a.dev] 和 [https://b.dev]');
  });

  it('拆分不丢字符：拼回去等于原文', () => {
    const text = '第一段 https://a.dev/x?y=1，然后 https://b.dev。结尾';
    expect(linkify(text).map((p) => p.value).join('')).toBe(text);
  });
});
