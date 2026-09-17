/**
 * 主题。
 *
 * 主题以**完整对象**存进 .seq.json，而不是只存一个 id。
 * 代价是文件略大，换来的是：图发给别人、或者一年后自己打开，配色都不会变样。
 *
 * themeToCss() 是屏幕上渲染和导出 SVG 的**唯一**样式来源 ——
 * 渲染时把结果放进 SVG 内部的 <style> 元素，导出时序列化 DOM 就自动带上，
 * 两边不可能不一致。
 *
 * 注意：SVG 里的 <style> 会作用于整个文档（CSS 不被 SVG 作用域限制），
 * 所以这里的每条选择器都必须带 .rd- 前缀的类名，禁止裸元素选择器。
 */

import type { Theme } from './model';

/** 含中文回退的字体栈。导出 SVG 后依赖打开者本机字体，故用通用族名兜底。 */
export const SANS_STACK =
  '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", "Source Han Sans SC", "Heiti SC", system-ui, sans-serif';

export const MONO_STACK =
  '"JetBrains Mono", "SF Mono", Menlo, Consolas, "Courier New", "Noto Sans Mono CJK SC", monospace';

export const LIGHT_THEME: Theme = {
  id: 'light',
  name: '经典浅色',
  mode: 'light',
  background: '#ffffff',
  fontFamily: SANS_STACK,
  fontSize: 14,
  messageFontSize: 13,
  textColor: '#1f2933',
  lineColor: '#9aa5b1',
  participantFill: '#f0f4f8',
  participantStroke: '#52606d',
  activationFill: '#e4e7eb',
  activationStroke: '#52606d',
  noteFill: '#fffbea',
  noteStroke: '#d9b44a',
  noteTextColor: '#5c4813',
  syncMessageColor: '#1f2933',
  asyncMessageColor: '#0b7285',
  returnMessageColor: '#7b8794',
  lineWidth: 1.25,
  messageSpacing: 44,
  participantGap: 170,
  showSequenceNumbers: true,
};

export const DARK_THEME: Theme = {
  id: 'dark',
  name: '暗色',
  mode: 'dark',
  background: '#1a2029',
  fontFamily: SANS_STACK,
  fontSize: 14,
  messageFontSize: 13,
  textColor: '#e4e7eb',
  lineColor: '#52606d',
  participantFill: '#2b3542',
  participantStroke: '#7b8794',
  activationFill: '#3e4c59',
  activationStroke: '#9aa5b1',
  noteFill: '#4a3f1d',
  noteStroke: '#d9b44a',
  noteTextColor: '#f5e6b3',
  syncMessageColor: '#e4e7eb',
  asyncMessageColor: '#4dd4c4',
  returnMessageColor: '#8d99a6',
  lineWidth: 1.25,
  messageSpacing: 44,
  participantGap: 170,
  showSequenceNumbers: true,
};

export const BLUEPRINT_THEME: Theme = {
  id: 'blueprint',
  name: '蓝图',
  mode: 'dark',
  background: '#0b2545',
  fontFamily: MONO_STACK,
  fontSize: 14,
  messageFontSize: 13,
  textColor: '#dbe9ff',
  lineColor: '#4a7fbf',
  participantFill: '#123a63',
  participantStroke: '#7fb2e5',
  activationFill: '#1d5185',
  activationStroke: '#9ecbff',
  noteFill: '#123a63',
  noteStroke: '#7fb2e5',
  noteTextColor: '#dbe9ff',
  syncMessageColor: '#dbe9ff',
  asyncMessageColor: '#6fe3c8',
  returnMessageColor: '#7fb2e5',
  lineWidth: 1.4,
  messageSpacing: 46,
  participantGap: 175,
  showSequenceNumbers: true,
};

export const MONO_THEME: Theme = {
  id: 'mono',
  name: '黑白打印',
  mode: 'light',
  background: '#ffffff',
  fontFamily: SANS_STACK,
  fontSize: 14,
  messageFontSize: 13,
  textColor: '#000000',
  lineColor: '#000000',
  participantFill: '#ffffff',
  participantStroke: '#000000',
  activationFill: '#d0d0d0',
  activationStroke: '#000000',
  noteFill: '#ffffff',
  noteStroke: '#000000',
  noteTextColor: '#000000',
  // 打印主题刻意三色同为黑：纸面上只靠箭头形状区分，不引入灰度
  syncMessageColor: '#000000',
  asyncMessageColor: '#000000',
  returnMessageColor: '#000000',
  lineWidth: 1.5,
  messageSpacing: 44,
  participantGap: 170,
  showSequenceNumbers: true,
};

export const THEMES: readonly Theme[] = [
  LIGHT_THEME,
  DARK_THEME,
  BLUEPRINT_THEME,
  MONO_THEME,
];

export function getTheme(id: string): Theme {
  return THEMES.find((t) => t.id === id) ?? LIGHT_THEME;
}

export function defaultTheme(): Theme {
  return { ...LIGHT_THEME };
}

/**
 * 把主题编译成一段 CSS。
 * 变量定义在 .rd-root 上，规则全部用 .rd- 类名限定，避免污染宿主文档。
 */
export function themeToCss(t: Theme): string {
  return `
.rd-root {
  --rd-bg: ${t.background};
  --rd-text: ${t.textColor};
  --rd-line: ${t.lineColor};
  --rd-participant-fill: ${t.participantFill};
  --rd-participant-stroke: ${t.participantStroke};
  --rd-activation-fill: ${t.activationFill};
  --rd-activation-stroke: ${t.activationStroke};
  --rd-note-fill: ${t.noteFill};
  --rd-note-stroke: ${t.noteStroke};
  --rd-note-text: ${t.noteTextColor};
  --rd-sync: ${t.syncMessageColor};
  --rd-async: ${t.asyncMessageColor};
  --rd-return: ${t.returnMessageColor};
  --rd-font: ${t.fontFamily};
  --rd-font-size: ${t.fontSize}px;
  --rd-message-font-size: ${t.messageFontSize}px;
  --rd-line-width: ${t.lineWidth};
  background: var(--rd-bg);
  font-family: var(--rd-font);
}
.rd-participant-box {
  fill: var(--rd-participant-fill);
  stroke: var(--rd-participant-stroke);
  stroke-width: var(--rd-line-width);
}
.rd-participant-label {
  fill: var(--rd-text);
  font-family: var(--rd-font);
  font-size: var(--rd-font-size);
}
.rd-participant-icon {
  fill: none;
  stroke: var(--rd-participant-stroke);
  stroke-width: var(--rd-line-width);
}
.rd-lifeline {
  stroke: var(--rd-line);
  stroke-width: var(--rd-line-width);
  stroke-dasharray: 5 4;
}
.rd-message-line {
  stroke: var(--rd-sync);
  stroke-width: var(--rd-line-width);
  fill: none;
}
/* 颜色是叠加在 UML 的箭头形状差异之上的：形状管语义，颜色管一眼可辨 */
.rd-message-line--sync,
.rd-message-line--self {
  stroke: var(--rd-sync);
}
.rd-message-line--async {
  stroke: var(--rd-async);
}
.rd-message-line--return {
  stroke: var(--rd-return);
  stroke-dasharray: 6 4;
}
.rd-message-label {
  fill: var(--rd-text);
  font-family: var(--rd-font);
  font-size: var(--rd-message-font-size);
}
.rd-message-seq {
  fill: var(--rd-text);
  font-family: var(--rd-font);
  font-size: calc(var(--rd-message-font-size) - 1px);
  opacity: 0.75;
}
.rd-activation {
  fill: var(--rd-activation-fill);
  stroke: var(--rd-activation-stroke);
  stroke-width: var(--rd-line-width);
}
.rd-note {
  fill: var(--rd-note-fill);
  stroke: var(--rd-note-stroke);
  stroke-width: var(--rd-line-width);
}
.rd-note-text {
  fill: var(--rd-note-text);
  font-family: var(--rd-font);
  font-size: var(--rd-message-font-size);
}
.rd-arrow-head {
  fill: var(--rd-sync);
  stroke: none;
}
.rd-arrow-head--sync,
.rd-arrow-head--self {
  fill: var(--rd-sync);
}
.rd-arrow-head--async {
  fill: none;
  stroke: var(--rd-async);
  stroke-width: var(--rd-line-width);
}
.rd-arrow-head--return {
  fill: none;
  stroke: var(--rd-return);
  stroke-width: var(--rd-line-width);
}
/**
 * 透明命中区：让整个头部/标签区域都可点选。
 * 火柴人是 fill:none、消息箭头只有 1px 宽，没有这层矩形用户很难点中它们。
 * fill 必须用 transparent 而不是 none —— none 不接收指针事件。
 * 导出时这层矩形不可见，留着也无妨，但为了文件干净会在导出时剔除。
 */
.rd-hit {
  fill: transparent;
  stroke: none;
}
.rd-selection {
  fill: none;
  stroke: #2f80ed;
  stroke-width: 1.5;
  stroke-dasharray: 4 3;
}
`.trim();
}

/** 深色底要配浅色选中框，否则看不清 */
export function selectionColor(t: Theme): string {
  return t.mode === 'dark' ? '#63b3ed' : '#2f80ed';
}
