/**
 * 快捷键的按键 → 动作映射。
 *
 * 快捷键最容易出的两类错都在这一层：组合判断漏了一个修饰键（于是打字时
 * 触发了分屏），以及 code 写成了 key（于是按住 Shift 就不灵了）。
 * 两类都能在这里拿字面量对象测出来，不用真按键盘。
 */
import { describe, expect, it } from 'vitest';
import {
  AGENTS_SHORTCUTS,
  shortcutFor,
  type KeyEventLike,
} from '../../src/modules/agents/shortcuts';

/** 按下 Ctrl+Shift+某个键 */
function combos(code: string, patch: Partial<KeyEventLike> = {}): KeyEventLike {
  return { code, ctrlKey: true, metaKey: false, shiftKey: true, altKey: false, ...patch };
}

describe('shortcutFor', () => {
  it('六个动作各自对应一个键', () => {
    expect(shortcutFor(combos('KeyD'))).toEqual({ kind: 'split', dir: 'row' });
    expect(shortcutFor(combos('KeyE'))).toEqual({ kind: 'split', dir: 'col' });
    expect(shortcutFor(combos('KeyW'))).toEqual({ kind: 'close-pane' });
    expect(shortcutFor(combos('KeyN'))).toEqual({ kind: 'new-session' });
    expect(shortcutFor(combos('KeyU'))).toEqual({ kind: 'jump-attention' });
    expect(shortcutFor(combos('ArrowLeft'))).toEqual({ kind: 'focus', dir: 'left' });
    expect(shortcutFor(combos('ArrowDown'))).toEqual({ kind: 'focus', dir: 'down' });
  });

  it('macOS 上是 Cmd', () => {
    expect(shortcutFor(combos('KeyD', { ctrlKey: false, metaKey: true }))).toEqual({
      kind: 'split',
      dir: 'row',
    });
  });

  it('⚠️ 少了 Shift 就不是我们的键 —— 否则终端里 Ctrl+D 会变成分屏', () => {
    // Ctrl+D 在终端里是 EOF，Ctrl+W 是删一个词。抢这些键会让用户的
    // shell 变得莫名其妙
    expect(shortcutFor(combos('KeyD', { shiftKey: false }))).toBeNull();
    expect(shortcutFor(combos('KeyW', { shiftKey: false }))).toBeNull();
  });

  it('少了 Ctrl/Cmd 也不是我们的键', () => {
    expect(shortcutFor(combos('KeyD', { ctrlKey: false }))).toBeNull();
  });

  it('带上 Alt 就不认（那是另一个组合，别抢）', () => {
    expect(shortcutFor(combos('KeyD', { altKey: true }))).toBeNull();
  });

  it('⚠️ 按 code 判断：按住 Shift 时 key 是大写，code 还是物理键位', () => {
    // 跟着 key 写的话就得同时判断 'd' 和 'D'，而且换个键盘布局就散架
    expect(shortcutFor({ code: 'KeyD', ctrlKey: true, metaKey: false, shiftKey: true, altKey: false }))
      .toEqual({ kind: 'split', dir: 'row' });
  });

  it('不认识的键返回 null，不吞掉任何东西', () => {
    expect(shortcutFor(combos('KeyA'))).toBeNull();
    expect(shortcutFor(combos('Digit1'))).toBeNull();
    expect(shortcutFor(combos('Escape'))).toBeNull();
  });
});

describe('快捷键提示表', () => {
  it('表里写的组合都真的能用 —— 提示和实现不能对不上', () => {
    for (const { combo } of AGENTS_SHORTCUTS) {
      const parts = combo.split('+');
      const code = parts[parts.length - 1]!;
      const key = code === '方向键' ? 'ArrowLeft' : `Key${code}`;
      const e: KeyEventLike = {
        code: key,
        ctrlKey: true,
        metaKey: false,
        shiftKey: true,
        altKey: false,
      };
      if (code === '方向键') {
        // 「Ctrl+Shift+方向键」是一条概括，四个方向都要在
        for (const dir of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
          expect(shortcutFor({ ...e, code: dir }), combo).not.toBeNull();
        }
        continue;
      }
      expect(shortcutFor(e), combo).not.toBeNull();
    }
  });
});
