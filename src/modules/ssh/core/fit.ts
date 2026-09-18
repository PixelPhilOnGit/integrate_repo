/**
 * 终端尺寸的计算与兜底。
 *
 * 抽成纯函数是有原因的：这块的坑**肉眼看不出来**。容器没布局的时候
 * `FitAddon.proposeDimensions()` 会返回 `undefined` 或者一个极小的值
 * （比如 2 列），直接拿去调 `ssh_resize` 的后果是**远端真的按 2 列换行** ——
 * 终端里所有东西都变成竖着的一列字，而且因为尺寸「没变」，
 * 之后再也不会触发重绘。
 *
 * 所以这里的策略是：**拿不准就什么都不做**（返回 null），
 * 宁可终端尺寸停在旧值上，也不要发一个荒唐的值出去。
 */

import { MAX_COLS, MAX_ROWS, MIN_COLS, MIN_ROWS } from './types';

export interface TermSize {
  cols: number;
  rows: number;
}

/**
 * 把一个「建议尺寸」夹到合理范围内。
 *
 * 返回 `null` 表示**别用这个值**，三种情况：
 * - 不是数字（`proposeDimensions()` 在容器没布局时返回 `undefined`）
 * - 不是有限数（NaN / Infinity）
 * - 比下限还小 —— 这几乎总是「容器还没有尺寸」而不是「用户真想要一个 3 列的终端」
 *
 * 上限那一头不返回 null 而是夹住：超大只是不常见，夹一下就好；
 * 而一个 5000 列的 PTY 会让远端程序做很多没意义的排版工作。
 */
export function clampSize(cols: unknown, rows: unknown): TermSize | null {
  if (typeof cols !== 'number' || typeof rows !== 'number') return null;
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) return null;

  const c = Math.floor(cols);
  const r = Math.floor(rows);
  if (c < MIN_COLS || r < MIN_ROWS) return null;

  return {
    cols: Math.min(c, MAX_COLS),
    rows: Math.min(r, MAX_ROWS),
  };
}

/**
 * 容器这会儿有没有真实尺寸。
 *
 * `display: none` 的元素 `clientWidth`/`clientHeight` 都是 0；
 * 隐藏的标签页、还没挂上的节点都是这个状态。这时候 fit 出来的值是垃圾。
 */
export function hasLayout(el: HTMLElement | null | undefined): boolean {
  if (!el) return false;
  return el.clientWidth > 0 && el.clientHeight > 0;
}

/** 两个尺寸是不是一样。用来避免 ResizeObserver 的自激循环 */
export function sameSize(a: TermSize | null, b: TermSize | null): boolean {
  if (a === null || b === null) return a === b;
  return a.cols === b.cols && a.rows === b.rows;
}

/** 只用来给状态栏/标签显示，比如 `80×24` */
export function formatSize(size: TermSize): string {
  return `${size.cols}×${size.rows}`;
}
