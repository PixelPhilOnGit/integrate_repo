/**
 * 知识库的图标：三张叠起来的卡片。
 *
 * 线性 SVG、currentColor —— 照全仓的图标规矩（不用 emoji：容器里没装
 * 彩色 emoji 字体，会渲染成豆腐块）。
 */

import type { ReactNode } from 'react';

export function KnowledgeIcon(): ReactNode {
  return (
    <svg
      viewBox="0 0 20 20"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {/* 最上面一张（实线），下面两张只画露出来的边 */}
      <rect x="3.6" y="3.6" width="12.8" height="8.6" rx="1.4" />
      <path d="M5.6 14.6h9" opacity="0.7" />
      <path d="M6.6 16.6h7" opacity="0.45" />
      <path d="M6.4 6.8h4.4" opacity="0.8" />
    </svg>
  );
}
