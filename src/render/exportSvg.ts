/**
 * 导出独立 SVG 与 PNG。
 *
 * 做法是**直接序列化屏幕上那棵 SVG DOM**，而不是另写一套生成器。
 * 这样导出结果和屏幕所见永远一致，不会出现"导出后字体/配色/箭头变了"的问题。
 *
 * 序列化前要做三件事：
 *   1. 剔除选中高亮（那是编辑态的东西，不该出现在成品里）
 *   2. 把 viewBox 收紧到内容包围盒，并补上显式的 width/height，
 *      否则别的软件打开时按默认尺寸显示，可能一片空白
 *   3. 移除编辑用的辅助属性（data-*），保持文件干净
 */

import type { Theme } from '../core/model';
import type { Layout } from '../core/layout';
import { themeToCss } from '../core/theme';

export interface ExportOptions {
  /** 是否包含背景色。透明背景贴到深色文档里更好看，但多数人要白底 */
  background?: boolean;
  /** 四周留白 */
  padding?: number;
  /** 文件名里用的标题（仅用于 <title>） */
  title?: string;
  theme: Theme;
}

/**
 * 把画布上的 SVG 元素序列化成可独立打开的字符串。
 * 传入的 svg 必须是屏幕上那个真实的节点。
 */
export function serializeSvg(
  svg: SVGSVGElement,
  layout: Layout,
  opts: ExportOptions,
): string {
  const padding = opts.padding ?? 12;
  const clone = svg.cloneNode(true) as SVGSVGElement;

  // 1. 去掉选中高亮、透明命中区和编辑态残留 —— 都是编辑期的东西，不该进成品
  for (const el of Array.from(
    clone.querySelectorAll('.rd-selection, .rd-hit, [data-inline-editor]'),
  )) {
    el.remove();
  }

  // 2. 样式必须**在剥离 data-* 之前**处理。
  //    否则 data-rd-theme 标记会被一起剥掉，导致下面的查找落空、又插入一份新样式，
  //    最终文件里出现两份内容相同的 <style>。
  const styles = Array.from(clone.querySelectorAll('style'));
  const primary = styles.find((s) => s.hasAttribute('data-rd-theme')) ?? styles[0];
  for (const s of styles) {
    if (s !== primary) s.remove();
  }
  const css = themeToCss(opts.theme);
  if (primary) {
    primary.textContent = css;
  } else {
    const style = clone.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'style');
    style.textContent = css;
    clone.insertBefore(style, clone.firstChild);
  }

  // 3. 收紧视口到内容包围盒，并补上显式尺寸
  const b = layout.bounds;
  const x = Math.round(b.x - padding);
  const y = Math.round(b.y - padding);
  const width = Math.ceil(b.width + padding * 2);
  const height = Math.ceil(b.height + padding * 2);
  clone.setAttribute('viewBox', `${x} ${y} ${width} ${height}`);
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');

  // 背景：SVG 里没有背景色这个概念，用一个大矩形代替
  if (opts.background !== false) {
    const rect = clone.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', String(x));
    rect.setAttribute('y', String(y));
    rect.setAttribute('width', String(width));
    rect.setAttribute('height', String(height));
    rect.setAttribute('fill', opts.theme.background);
    clone.insertBefore(rect, clone.firstChild);
  }

  if (opts.title) {
    const t = clone.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'title');
    t.textContent = opts.title;
    clone.insertBefore(t, clone.firstChild);
  }

  // 4. 最后才剥掉交互用的辅助属性（data-testid、data-participant-id 等）
  for (const el of Array.from(clone.querySelectorAll('*'))) {
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.startsWith('data-')) el.removeAttribute(attr.name);
    }
  }

  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    new XMLSerializer().serializeToString(clone) +
    '\n'
  );
}

/**
 * 把 SVG 字符串光栅化成 PNG 字节。
 *
 * 两个容易踩的坑：
 *   - 必须先等 document.fonts.ready，否则中文字体还没加载完就画，
 *     出来的图里中文会是空白或者 fallback 字形
 *   - 用 data URL 而不是 blob URL 喂给 Image：blob URL 在部分 WebKit 版本里
 *     加载 SVG 会失败（macOS 上 Tauri 跑的正是 WKWebView）。因为 SVG 里没有任何
 *     外部引用，data URL 也不会污染 canvas。
 */
export async function svgToPng(
  svgText: string,
  width: number,
  height: number,
  scale = 2,
): Promise<Uint8Array> {
  if (typeof document !== 'undefined' && 'fonts' in document) {
    try {
      await document.fonts.ready;
    } catch {
      // 字体接口不可用就继续，不值得为此中断导出
    }
  }

  const img = await loadImage(svgToDataUrl(svgText));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建画布上下文，导出 PNG 失败');
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  const out = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/png'),
  );
  if (!out) throw new Error('PNG 编码失败');
  return new Uint8Array(await out.arrayBuffer());
}

/** UTF-8 安全的 base64 data URL（btoa 只认 latin1，必须先转字节） */
function svgToDataUrl(svgText: string): string {
  const bytes = new TextEncoder().encode(svgText);
  let binary = '';
  const CHUNK = 0x8000; // 分块避免超出参数个数上限
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('SVG 光栅化失败（图片无法加载）'));
    img.src = url;
  });
}

/** 从布局包围盒算出导出尺寸 */
export function exportSize(layout: Layout, padding = 12): { width: number; height: number } {
  return {
    width: Math.ceil(layout.bounds.width + padding * 2),
    height: Math.ceil(layout.bounds.height + padding * 2),
  };
}

export function textToBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
