/**
 * 导出动作：把画布上的图导出成文件。
 *
 * 统一从**屏幕上那个真实的 SVG 节点**出发序列化，
 * 所以导出结果和所见一致；PNG 则由同一份 SVG 光栅化而来，两者不会走样。
 */

import type { Doc } from '../core/model';
import type { Layout } from '../core/layout';
import { toMermaid } from '../core/mermaid';
import { platform } from '../platform';
import { basename, stripExt } from '../platform/path';
import { exportSize, serializeSvg, svgToPng, textToBytes } from './exportSvg';

const SVG_SELECTOR = '[data-testid="canvas-svg"]';

export class ExportError extends Error {}

function liveSvg(): SVGSVGElement {
  const el = document.querySelector<SVGSVGElement>(SVG_SELECTOR);
  if (!el) throw new ExportError('找不到画布，导出失败');
  return el;
}

function baseName(doc: Doc, currentPath: string | null): string {
  if (currentPath) return stripExt(basename(currentPath));
  return doc.title || '顺序图';
}

export function buildSvgText(doc: Doc, layout: Layout, svg?: SVGSVGElement): string {
  return serializeSvg(svg ?? liveSvg(), layout, {
    theme: doc.theme,
    background: true,
    title: doc.title,
  });
}

export async function exportSvgFile(
  doc: Doc,
  layout: Layout,
  currentPath: string | null,
): Promise<string | null> {
  return platform.exportFile(
    `${baseName(doc, currentPath)}.svg`,
    textToBytes(buildSvgText(doc, layout)),
    'image/svg+xml',
  );
}

export async function exportPngFile(
  doc: Doc,
  layout: Layout,
  currentPath: string | null,
  scale = 2,
): Promise<string | null> {
  const svgText = buildSvgText(doc, layout);
  const { width, height } = exportSize(layout);
  const png = await svgToPng(svgText, width, height, scale);
  return platform.exportFile(`${baseName(doc, currentPath)}.png`, png, 'image/png');
}

export async function exportMermaidFile(
  doc: Doc,
  currentPath: string | null,
): Promise<string | null> {
  return platform.exportFile(
    `${baseName(doc, currentPath)}.mmd`,
    textToBytes(toMermaid(doc)),
    'text/plain',
  );
}

/** 复制 Mermaid 文本到剪贴板；返回是否成功 */
export async function copyMermaid(doc: Doc): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(toMermaid(doc));
    return true;
  } catch {
    return false;
  }
}
