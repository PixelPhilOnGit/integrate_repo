/**
 * 文件浏览器的纯逻辑：树展开的摊平、预览态的组装、大小文案。
 *
 * 所有异步编排在 `state/explorer.ts`（那个要碰 platform），这里全是纯函数 ——
 * 「摊平一棵树」这种事最容易在边上出错（折叠的子级漏了/多了、深度算错），
 * 得能拿字面量直接测。
 */

import type { DirEntry, Preview } from '../../../shared/platform/types';

/** 渲染用的一行：目录项 + 它的缩进深度 */
export interface ExplorerRow {
  entry: DirEntry;
  depth: number;
}

/** 隐藏项（界面上画得暗一点）。只影响外观 —— 列目录本身不过滤它们 */
export function isHidden(name: string): boolean {
  return name.startsWith('.');
}

/**
 * 把「根列表 + 展开集合 + 按目录的缓存」**按树序**摊平成渲染行。
 *
 * 展开但还没加载出来（加载中/失败了）的目录：它的子级自然缺席，
 * 行本身照常渲染（caret 是开着的）。这一层不做 loading 行 —— 目录项
 * 的展开态本来就是「先开箭头、内容随后到」。
 */
export function flatten(
  rootEntries: readonly DirEntry[],
  expanded: ReadonlySet<string>,
  cache: ReadonlyMap<string, readonly DirEntry[]>,
): ExplorerRow[] {
  const rows: ExplorerRow[] = [];

  const walk = (entries: readonly DirEntry[], depth: number): void => {
    for (const entry of entries) {
      rows.push({ entry, depth });
      if (entry.kind === 'dir' && expanded.has(entry.path)) {
        const children = cache.get(entry.path);
        if (children) walk(children, depth + 1);
      }
    }
  };

  walk(rootEntries, 0);
  return rows;
}

/** 预览区的展示态：Rust 三态 + 加载/空/错误，UI 直接 switch 这个 */
export type PreviewState =
  | { kind: 'empty' }
  | { kind: 'loading' }
  | { kind: 'text'; text: string }
  | { kind: 'binary' }
  | { kind: 'tooLarge'; size: number }
  | { kind: 'error'; message: string };

/** 把 platform.readPreview 的结果翻成展示态 */
export function previewToState(preview: Preview): PreviewState {
  switch (preview.kind) {
    case 'text':
      return { kind: 'text', text: preview.text };
    case 'binary':
      return { kind: 'binary' };
    case 'tooLarge':
      return { kind: 'tooLarge', size: preview.size };
  }
}

/**
 * 体积的人话。⚠️ 1 MB 以下说 KB —— request 模块出过一模一样的教训：
 * 小文件显示成「0.0 MB」看着像坏掉了（那条教训也记在 HANDOFF 里）。
 */
export function formatBytes(size: number): string {
  const mib = size / (1024 * 1024);
  if (mib >= 1) return `${mib.toFixed(1)} MB`;
  const kib = size / 1024;
  return `${kib < 10 ? kib.toFixed(1) : Math.round(kib)} KB`;
}

/** 路径的最后一段（面包屑/预览头用）。空串给空串 */
export function baseName(path: string): string {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return idx >= 0 ? path.slice(idx + 1) : path;
}
