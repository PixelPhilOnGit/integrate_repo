/**
 * 内联文字编辑。
 *
 * 用绝对定位的 HTML <textarea> 浮在 SVG 上，**不用 <foreignObject>**。
 * 这不是风格偏好，是两个硬性原因：
 *   1. macOS 上 Tauri 用的是 WKWebView（WebKit），foreignObject 里的中文输入法
 *      候选框定位错乱、拼音串字是老问题，对中文用户是硬伤
 *   2. foreignObject 在别的渲染器（Illustrator、Inkscape）和 PNG 光栅化时
 *      经常被整个忽略，导出的图会缺文字
 *
 * 浮层还有个好处：输入法、选区、复制粘贴、撤销都是浏览器原生行为，不用自己实现。
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Doc } from '../core/model';
import type { Layout } from '../core/layout';
import type { EditTarget, Viewport } from '../types';

export interface InlineEditorProps {
  doc: Doc;
  layout: Layout;
  viewport: Viewport;
  target: EditTarget;
  onCommit: (text: string) => void;
  onCancel: () => void;
}

interface Box {
  left: number;
  top: number;
  width: number;
  fontSize: number;
  align: 'center' | 'left';
}

const PAD = 6;

/** 算出浮层该出现在哪：文档坐标 → 屏幕像素 */
function computeBox(doc: Doc, layout: Layout, vp: Viewport, target: EditTarget): Box | null {
  const toScreenX = (x: number) => (x - vp.panX) * vp.zoom;
  const toScreenY = (y: number) => (y - vp.panY) * vp.zoom;

  if (target.type === 'participant') {
    const g = layout.participants.find((p) => p.id === target.id);
    if (!g) return null;
    return {
      left: toScreenX(g.labelAnchorX) - (g.box.width * vp.zoom) / 2,
      top: toScreenY(g.labelY - doc.theme.fontSize * 0.95),
      width: g.box.width * vp.zoom,
      fontSize: doc.theme.fontSize * vp.zoom,
      align: 'center',
    };
  }

  if (target.type === 'message') {
    const g = layout.messages.find((m) => m.id === target.id);
    if (!g) return null;
    const width = Math.max(120, Math.abs(g.x2 - g.x1) + 100) * vp.zoom;
    return {
      left: toScreenX(g.labelX) - width / 2,
      top: toScreenY(g.labelY - doc.theme.messageFontSize * 1.05),
      width,
      fontSize: doc.theme.messageFontSize * vp.zoom,
      align: 'center',
    };
  }

  const g = layout.notes.find((n) => n.id === target.id);
  if (!g) return null;
  return {
    left: toScreenX(g.x),
    top: toScreenY(g.y),
    width: Math.max(g.width, 140) * vp.zoom,
    fontSize: doc.theme.messageFontSize * vp.zoom,
    align: 'left',
  };
}

function initialText(doc: Doc, target: EditTarget): string {
  switch (target.type) {
    case 'participant':
      return doc.participants.find((p) => p.id === target.id)?.name ?? '';
    case 'message':
      return doc.messages.find((m) => m.id === target.id)?.label ?? '';
    case 'note':
      return doc.notes.find((n) => n.id === target.id)?.text ?? '';
  }
}

export function InlineEditor({
  doc,
  layout,
  viewport,
  target,
  onCommit,
  onCancel,
}: InlineEditorProps): ReactNode {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState(() => initialText(doc, target));
  // 记录进入编辑时的初值，用来判断"没改动就别浪费一次撤销记录"
  const initial = useRef(value);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  const box = computeBox(doc, layout, viewport, target);
  if (!box) return null;

  const commit = () => {
    const next = value.trim();
    if (next !== initial.current.trim() && next.length > 0) onCommit(next);
    else onCancel();
  };

  return (
    <textarea
      ref={ref}
      className="rd-inline-editor"
      data-inline-editor="true"
      value={value}
      aria-label="编辑文字"
      style={{
        left: box.left,
        top: box.top,
        width: box.width,
        fontSize: box.fontSize,
        textAlign: box.align,
        height: Math.max(box.fontSize * 1.9, 26),
      }}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        // Esc 放弃修改；Enter 提交（Shift+Enter 换行，供多行标签用）
        if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        } else if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          commit();
        }
        // 编辑文字时不要让快捷键（Delete、方向键等）冒泡到画布
        e.stopPropagation();
      }}
    />
  );
}

export { PAD };
