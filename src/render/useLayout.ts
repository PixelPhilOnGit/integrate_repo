import { useMemo } from 'react';
import type { Doc } from '../core/model';
import { computeLayout, type Layout } from '../core/layout';
import { createCanvasMeasurer } from '../core/text';

/**
 * 全局共用一个测量器实例：它在内部缓存当前字体字符串，
 * 每次重建都会丢掉缓存，而拖拽期间布局是每帧都要算的。
 */
const measurer = createCanvasMeasurer();

/** 文档 → 布局。doc 不可变，所以引用没变就不用重算。 */
export function useLayout(doc: Doc): Layout {
  return useMemo(() => computeLayout(doc, measurer), [doc]);
}

export { measurer };
