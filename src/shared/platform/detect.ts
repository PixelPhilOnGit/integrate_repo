/**
 * 判断当前是不是跑在 Tauri 里。
 *
 * 注意用的是 `__TAURI_INTERNALS__` 而不是 `__TAURI__` —— 后者只有在
 * tauri.conf.json 里开启 `withGlobalTauri: true` 时才存在，
 * 而 `__TAURI_INTERNALS__` 是 Tauri 2 始终注入的，无需任何配置。
 */
export function isTauri(): boolean {
  return (
    typeof window !== 'undefined' &&
    Object.prototype.hasOwnProperty.call(window, '__TAURI_INTERNALS__')
  );
}

/**
 * 这台机器是不是 macOS。
 *
 * 按键语义要用：macOS 上 `Ctrl+C` 是中断（复制是 `Cmd+C`），Windows / Linux 上
 * 「有选中时的 `Ctrl+C`」是复制。见 `shared/terminal/clipboard.ts`。
 *
 * 刻意**不问 Tauri 要平台**：这个判断在浏览器里跑 e2e 时也得是对的
 * （那边没有 Tauri），而 UA 里 `Macintosh` 两边都有。
 * 顺带一提 iPadOS 的桌面模式也报 `Macintosh` —— 这个桌面应用跑不到那儿去。
 */
export function isMacLike(): boolean {
  return typeof navigator !== 'undefined' && /mac/i.test(navigator.userAgent);
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}
