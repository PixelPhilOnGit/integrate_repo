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

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}
