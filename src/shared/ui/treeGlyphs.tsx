/**
 * 树上的两个小图形：文件夹/文件图标、折叠箭头。
 *
 * 从顺序图的文件树里抽出来的 —— 智能体会话的「文件」标签是同一种树，
 * 两份 SVG 各写一遍迟早长歪（一处换了形状另一处不知道）。
 *
 * 用内联 SVG 而不是 emoji：容器里没装彩色 emoji 字体，emoji 会渲染成豆腐块，
 * 而 SVG 跨平台一致、还能跟随主题色（stroke 用 currentColor）。
 */

import type { ReactNode } from 'react';

/**
 * 文件夹分"打开/关闭"两种形状 —— 只靠折叠箭头区分的话，箭头一小就完全
 * 看不出状态。
 */
export function TreeIcon({ kind, open }: { kind: 'dir' | 'file'; open: boolean }): ReactNode {
  const common = {
    className: 'rd-tree-icon',
    viewBox: '0 0 16 16',
    width: 14,
    height: 14,
    'aria-hidden': true,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.3,
    strokeLinejoin: 'round' as const,
  };
  if (kind === 'file') {
    return (
      <svg {...common}>
        <path d="M3.6 2.6h5.9l3 3v7.8H3.6z" />
        <path d="M9.5 2.6v3h3" />
      </svg>
    );
  }
  return open ? (
    <svg {...common}>
      {/* 打开的文件夹：背板矮一截，前板向右外张 */}
      <path d="M1.7 4.6c0-.6.4-1 1-1h2.6l1.3 1.5h5.7c.6 0 1 .4 1 1v.7H1.7z" />
      <path d="M1.7 6.8h12.6l-1.2 4.7c-.1.5-.5.8-1 .8H2.7c-.6 0-1-.4-1-1z" />
    </svg>
  ) : (
    <svg {...common}>
      <path d="M1.7 4.6c0-.6.4-1 1-1h2.6l1.3 1.5h6.7c.6 0 1 .4 1 1v5.1c0 .6-.4 1-1 1H2.7c-.6 0-1-.4-1-1z" />
    </svg>
  );
}

/** 折叠箭头。用一个会旋转的 V 形，比 ▸/▾ 两个字符更容易看出状态差异 */
export function Caret({ open }: { open: boolean }): ReactNode {
  return (
    <span className={`rd-tree-caret${open ? ' is-open' : ''}`} aria-hidden="true">
      <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M6 4l4 4-4 4" />
      </svg>
    </span>
  );
}
