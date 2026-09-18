/**
 * 全局外观的选择逻辑。
 *
 * 这一层只有几行，但它是「用户存的选择」和「屏幕上的颜色」之间唯一的转换点 ——
 * 写错了的表现是「我选了深色，重启又变回浅色」这种让人以为设置没保存的问题。
 */
import { describe, expect, it } from 'vitest';
import {
  parseThemeChoice,
  resolveTheme,
  THEME_OPTIONS,
  type ThemeChoice,
} from '../../src/shell/theme';

describe('resolveTheme', () => {
  it('明确选了哪档就是哪档，和系统偏好无关', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('light', false)).toBe('light');
    expect(resolveTheme('dark', true)).toBe('dark');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('跟随系统时看系统', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });
});

describe('parseThemeChoice', () => {
  it('三档都认', () => {
    for (const { choice } of THEME_OPTIONS) {
      expect(parseThemeChoice(choice)).toBe(choice);
    }
  });

  it('⚠️ 认不出来的一律退回「跟随系统」，不是「浅色」', () => {
    // 退回一个**具体**的档位，等于替用户做了一个他可能不想要的永久决定；
    // 退回「跟随系统」则至少不会和系统主题打架
    for (const bad of [undefined, null, '', 'DARK', '深色', 42, {}, []]) {
      expect(parseThemeChoice(bad), String(bad)).toBe('system');
    }
  });
});

describe('选项表', () => {
  it('每档都有中文名，否则菜单上会显示空白', () => {
    for (const { choice, label } of THEME_OPTIONS) {
      expect(label.trim(), choice).not.toBe('');
    }
  });

  it('覆盖了全部三档，不多不少', () => {
    const all: ThemeChoice[] = ['system', 'light', 'dark'];
    expect(THEME_OPTIONS.map((o) => o.choice).sort()).toEqual([...all].sort());
  });
});
