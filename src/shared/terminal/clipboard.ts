/**
 * 「这一下按键是复制，还是该原样发给远端」。
 *
 * # 为什么单独一个纯函数
 *
 * 和 `agents/shortcuts.ts` 同一个理由：这层最容易出的错是**修饰键漏判了一个**
 * 或者 **`code` 写成了 `key`**，而这两类都不需要真按一遍键盘就能测干净
 * （见 `tests/unit/terminal-clipboard.test.ts`）。
 *
 * # 规则从哪来
 *
 * * **`Ctrl+Shift+C` 两个平台都复制。** 这是终端的通用手势（GNOME Terminal、
 *   Windows Terminal 都认），不跟着平台的复制键走。
 * * **macOS 上 `Ctrl+C` 永远是中断**，有选中也一样 —— 那边复制是 `Cmd+C`，
 *   而 `Ctrl+C` 是唯一的中断手势，抢了它就没法停一个正在刷屏的程序。
 * * **Windows / Linux 上，「有选中时的裸 `Ctrl+C`」就是复制。** 这是
 *   Windows Terminal 和 VS Code 终端的手感，用户按下去期待的就是复制；
 *   没选中时才落回中断。
 *
 * ⚠️ **带 `Alt` 一律不认。** Windows 上 AltGr 的键事件就是 `Ctrl+Alt`
 * （某些键盘布局打 `c` 要走 AltGr），认了它就会变成「`c` 打不出来，反而复制了」。
 */

/** 只要这几个字段就能判断，不需要真的 KeyboardEvent —— 测试里给字面量就行 */
export interface KeyEventLike {
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export interface CopyIntentOptions {
  /** 终端里当前有选中内容吗 */
  hasSelection: boolean;
  /** 是不是 macOS。判定见 `shared/platform/detect.ts` 的 `isMacLike` */
  isMac: boolean;
}

/**
 * `copy` = **这一下归剪贴板管**：拦下来，别发到远端去（有没有真的复制到东西
 * 是调用方的事 —— 没选中时拦下来什么都不写，而不是把空串塞进剪贴板）。
 * `pass` = 原样交给终端。
 */
export type CopyIntent = 'copy' | 'pass';

export function copyIntent(e: KeyEventLike, options: CopyIntentOptions): CopyIntent {
  if (e.altKey) return 'pass';

  // 通用手势，两个平台都拦（不要求有选中：拦不拦和复不复制是两回事）
  if (e.ctrlKey && e.shiftKey && e.code === 'KeyC') return 'copy';

  if (options.isMac) {
    // Ctrl+C 留给中断，只有 Cmd+C 是复制
    return e.metaKey && !e.ctrlKey && e.code === 'KeyC' ? 'copy' : 'pass';
  }

  // 裸 Ctrl+C：有选中时是复制（Windows Terminal 的手感），没选中才落回 SIGINT
  const bareCtrlC =
    e.ctrlKey && !e.shiftKey && !e.metaKey && e.code === 'KeyC' && options.hasSelection;
  return bareCtrlC ? 'copy' : 'pass';
}
