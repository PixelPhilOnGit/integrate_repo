/**
 * 配色 token 的对比度护栏（2026-10-15 体验评审）。
 *
 * 背景：浅色主题的 `--muted` 是 11–12px 灰字的唯一来源（状态栏、连接地址、
 * 全部 hint），实测对白底只有 3.66:1 —— 低于 WCAG AA 的 4.5:1；`--danger`
 * 用在 12px 报错文字上，也只有 4.38:1。这两个数字**肉眼看不出来**，
 * 靠评审的探针算出来的。修完把门槛钉在测试里：以后调色板时，这两个 token
 * 只要再被调浅到不达标，这条就红。
 *
 * ⚠️ 直接从 `src/styles.css` 的文本里抠 token —— 这是有意的：
 * 测试要盯的就是**文件里真正生效的那几个值**，不是某个 JS 常量。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(__dirname, '../../src/styles.css'), 'utf8');

/** 从指定的选择器块里抠一个变量值。只认 `--名字: #rrggbb;` 这一种写法 */
function token(block: string, name: string): string {
  const m = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(block);
  const value = m?.[1];
  if (value === undefined) throw new Error(`styles.css 里找不到 --${name}（色值得是 6 位 hex）`);
  return value;
}

function block(selector: string): string {
  const m = new RegExp(`${selector}\\s*\\{([^}]*)\\}`, 's').exec(css);
  const body = m?.[1];
  if (body === undefined) throw new Error(`styles.css 里找不到 ${selector} 块`);
  return body;
}

/** WCAG 2.1 相对亮度 */
function luminance(hex: string): number {
  const [r = 0, g = 0, b = 0] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(fg: string, bg: string): number {
  const [a, b] = [luminance(fg), luminance(bg)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

describe('浅色主题的次要文字 / 报错文字对比度（AA 4.5:1）', () => {
  const light = () => block(':root');

  it('--muted 对 panel 和页面底都不低于 4.5', () => {
    const muted = token(light(), 'muted');
    expect(contrast(muted, token(light(), 'panel'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(muted, token(light(), 'bg'))).toBeGreaterThanOrEqual(4.5);
  });

  it('--danger 对 panel 和页面底都不低于 4.5', () => {
    const danger = token(light(), 'danger');
    expect(contrast(danger, token(light(), 'panel'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(danger, token(light(), 'bg'))).toBeGreaterThanOrEqual(4.5);
  });
});

describe('深色主题同一组 token 不比浅色差', () => {
  const dark = () => block(":root\\[data-theme='dark'\\]");

  it('--muted / --danger 都不低于 4.5（深色这套本来就在 5.5 以上）', () => {
    const d = dark();
    expect(contrast(token(d, 'muted'), token(d, 'panel'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token(d, 'danger'), token(d, 'bg'))).toBeGreaterThanOrEqual(4.5);
  });
});
