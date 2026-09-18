/**
 * 智能体会话模块的图标：分屏的窗格加一个「在等你」的点。
 *
 * 几何参数和另外几个图标一致（`viewBox="0 0 20 20"`、`strokeWidth={1.4}`、
 * 颜色走 `currentColor`），排在一起不会显得大小不一。
 *
 * 造型上用的是「四宫格里右上角亮着一个点」—— 这是这个模块唯一想表达的事：
 * 一屏开着好几个，其中一个在等你。
 */

import type { ReactNode } from 'react';

export function AgentsIcon(): ReactNode {
  return (
    <svg
      viewBox="0 0 20 20"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {/* 左边一整块（主窗格） */}
      <rect x="2" y="3.5" width="7.2" height="13" rx="1.4" />
      {/* 右边上下两块 */}
      <rect x="11.2" y="3.5" width="6.8" height="6" rx="1.4" />
      <rect x="11.2" y="10.5" width="6.8" height="6" rx="1.4" />
      {/* 右上角那个「有人在等你」的点 */}
      <circle cx="17.2" cy="4.2" r="1.9" fill="currentColor" stroke="none" />
    </svg>
  );
}
