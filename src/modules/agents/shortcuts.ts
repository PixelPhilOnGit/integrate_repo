/**
 * 模块内的快捷键。
 *
 * # 为什么是「按键 → 动作」的纯映射
 *
 * 这个函数只回答一个问题：**这一下按的是什么**。执行留给组件。
 * 这样它不需要 store、不需要 DOM，可以拿几个字面量对象测干净 ——
 * 而快捷键最容易出的错（组合判断漏了一个修饰键、code 写成了 key）恰恰
 * 全在这一层，不需要真按一遍键盘才发现。
 *
 * # 为什么全用 `Ctrl+Shift`
 *
 * 外壳已经占了 `Ctrl+1..9`（切模块）。再往下抢 `Ctrl+单键` 迟早撞车，
 * 而且终端里的程序对 `Ctrl+字母` 有自己的含义（`Ctrl+W` 是删词、
 * `Ctrl+D` 是 EOF）—— 用 `Ctrl+Shift` 这一层，终端里的程序基本不碰。
 *
 * # 为什么按 `code` 而不是 `key`
 *
 * 按住 Shift 的时候 `event.key` 是大写（`'D'`），而 `code` 永远是物理键位
 * （`'KeyD'`）。跟着 `key` 写就得同时判断大小写，而且换个键盘布局就散架。
 */

import type { Direction, SplitDir } from './core/layout';

/** 只要这几个字段就能判断，不需要真的 KeyboardEvent —— 测试里给字面量就行 */
export interface KeyEventLike {
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export type ShortcutAction =
  /** 分屏，并在新的一格里开一个同类型的新会话 */
  | { kind: 'split'; dir: SplitDir }
  /** 把当前这一格从屏幕上收掉（**会话不杀**） */
  | { kind: 'close-pane' }
  /** 焦点移到几何方向上的邻居 */
  | { kind: 'focus'; dir: Direction }
  /** 跳到等得最久的那个「需要你」 */
  | { kind: 'jump-attention' }
  /** 在同一个工作目录里新开一个会话 */
  | { kind: 'new-session' };

/** 界面上要显示的快捷键表。提示文案和实现从同一份数据来，免得对不上 */
export const AGENTS_SHORTCUTS: ReadonlyArray<{ combo: string; label: string }> = [
  { combo: 'Ctrl+Shift+D', label: '向右分屏（新开一个）' },
  { combo: 'Ctrl+Shift+E', label: '向下分屏（新开一个）' },
  { combo: 'Ctrl+Shift+W', label: '收掉当前这一格' },
  { combo: 'Ctrl+Shift+方向键', label: '在窗格之间移动' },
  { combo: 'Ctrl+Shift+U', label: '跳到需要你的会话' },
  { combo: 'Ctrl+Shift+N', label: '在同一个目录里再开一个' },
];

export function shortcutFor(e: KeyEventLike): ShortcutAction | null {
  // macOS 上是 Cmd（和外壳的模块切换键同一套判断）
  const mod = e.ctrlKey || e.metaKey;
  if (!mod || !e.shiftKey || e.altKey) return null;

  switch (e.code) {
    case 'KeyD':
      return { kind: 'split', dir: 'row' };
    case 'KeyE':
      return { kind: 'split', dir: 'col' };
    case 'KeyW':
      return { kind: 'close-pane' };
    case 'KeyN':
      return { kind: 'new-session' };
    case 'KeyU':
      return { kind: 'jump-attention' };
    case 'ArrowLeft':
      return { kind: 'focus', dir: 'left' };
    case 'ArrowRight':
      return { kind: 'focus', dir: 'right' };
    case 'ArrowUp':
      return { kind: 'focus', dir: 'up' };
    case 'ArrowDown':
      return { kind: 'focus', dir: 'down' };
    default:
      return null;
  }
}
