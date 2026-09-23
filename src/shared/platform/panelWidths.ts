/**
 * 左右两个侧栏的宽度：默认值、夹取范围、从磁盘读回来时的校验。
 *
 * # 为什么放在平台层
 *
 * 三个地方都要用它：**两边的平台实现**（tauri / web 读盘时得把坏数据挡掉）、
 * **外壳**（拖动时夹取、没拖过的模块给默认值）。而平台层在上面 ——
 * 它不该反过来认识外壳（这条是 `Prefs` 里 `theme` 刻意是 `string` 的同一个理由）。
 *
 * # 为什么要夹取
 *
 * 宽度是**用户手拖出来的数**，它会进到 CSS 里。不夹的话：拖到 0 会让侧栏
 * 看不见但还在（用户以为它没了，其实是被挤成了一条），拖到几千像素会把
 * 主区挤到屏幕外面 —— 而这两种状态**都会存进偏好里**，下次打开还是坏的。
 */

/** 没拖过时的宽度（和 `.rd-panel` 的 CSS 默认值一致）。 */
export const DEFAULT_PANEL_WIDTH = 240;

/** 再窄就只剩下一列图标了，反而不好点。 */
export const MIN_PANEL_WIDTH = 180;

/** 再宽就是在抢主区的地方 —— 侧栏是「找东西」，主区才是「看东西」。 */
export const MAX_PANEL_WIDTH = 640;

/** 夹到合法范围里（非数字/NaN 一律回默认值）。 */
export function clampPanelWidth(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_PANEL_WIDTH;
  return Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, Math.round(width)));
}

/**
 * 从磁盘读回来的那张「模块 id → 宽度」表。
 *
 * ⚠️ 逐项校验：库里可能有手改过的、或者某个版本写坏的值。一条坏的
 *（`"sql": "宽一点"`）不该让整张表作废 —— 丢掉那一条，别的照样用。
 */
export function readWidths(raw: unknown): Record<string, number> {
  if (typeof raw !== 'object' || raw === null) return {};
  const out: Record<string, number> = {};
  for (const [moduleId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    out[moduleId] = clampPanelWidth(value);
  }
  return out;
}
