/**
 * 全局外观：浅色 / 深色 / 跟随系统。
 *
 * # 「选择」和「结果」是两回事
 *
 * 用户选的是**三档之一**（`ThemeChoice`），而屏幕上真正生效的只有浅或深
 * （`ResolvedTheme`）。这两者分开是有原因的：
 *
 * - 选「跟随系统」的人，系统切换时外观要跟着变 —— 那需要一个监听，
 *   而监听的回调里需要知道「现在该变成什么」；
 * - 存进配置的必须是**原始选择**。把「跟随系统」在存储里就解析成 `dark`，
 *   用户以后换了系统主题，应用还停在深色，而且他再也找不回「跟随系统」这一档。
 *
 * # 为什么由 JS 解析，而不是纯 CSS 的 `@media`
 *
 * 纯 CSS 只能表达「跟随系统」，表达不了「用户明确选了浅色，但系统是深色」。
 * 要同时支持两者，CSS 里就得把深色那一套变量写两遍（媒体查询一份、
 * 属性选择器一份），而它们迟早在某次改配色时对不上。
 *
 * 所以：**JS 把选择解析成一个确定的值，写进 `<html data-theme>`，
 * CSS 只认这一个属性**。代价是启动时有一小段「属性还没写上」的时间 ——
 * 所以默认值（跟随系统）在 store 构造时就同步解析并应用了，
 * 那发生在 React 渲染之前，深色系统的用户看不到闪白。
 */

export type ThemeChoice = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_OPTIONS: ReadonlyArray<{ choice: ThemeChoice; label: string }> = [
  { choice: 'system', label: '跟随系统' },
  { choice: 'light', label: '浅色' },
  { choice: 'dark', label: '深色' },
];

/** 存的可能是旧版本的、手改过的值 —— 不认识的当默认值，别让界面变成没配色 */
export function parseThemeChoice(raw: unknown): ThemeChoice {
  return raw === 'light' || raw === 'dark' ? raw : 'system';
}

/**
 * 选择 + 系统偏好 → 实际显示哪一套。
 *
 * 纯函数：把「系统偏好」当参数传进来，而不是在里面读 `matchMedia` ——
 * 那样这个函数在 node 里就跑不了，而它恰恰是最该被测的一个。
 */
export function resolveTheme(choice: ThemeChoice, systemPrefersDark: boolean): ResolvedTheme {
  if (choice === 'light') return 'light';
  if (choice === 'dark') return 'dark';
  return systemPrefersDark ? 'dark' : 'light';
}

/** 系统现在偏好深色吗。没有 `matchMedia` 的环境（单测、老 webview）当浅色 */
export function systemPrefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/**
 * 把解析结果写到文档元素上。
 *
 * CSS 只认这一个属性 —— 见文件头那段。`color-scheme` 顺带一起设：
 * 它管的是**浏览器自己画的东西**（滚动条、表单控件、默认背景），
 * 不设的话深色界面里会冒出几根刺眼的亮色滚动条。
 */
export function applyTheme(theme: ResolvedTheme): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.dataset['theme'] = theme;
  root.style.colorScheme = theme;
}
