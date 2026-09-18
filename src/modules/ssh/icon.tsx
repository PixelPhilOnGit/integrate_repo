/**
 * SSH 模块的图标：终端提示符（一个方框加 `>` 和 `_`）。
 *
 * 几何参数和另外三个图标一致（`viewBox="0 0 20 20"`、`strokeWidth={1.4}`、
 * 颜色走 `currentColor`），这样在图标栏里排在一起不会显得大小不一。
 *
 * 造型上和 SQL 那个「数据库圆柱」刻意拉得远一点：20 像素下都是小图形，
 * 轮廓接近就会看错，而这两个模块在图标栏里是挨着的。
 */

import type { ReactNode } from 'react';

export function SshIcon(): ReactNode {
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
      {/* 终端窗口 */}
      <rect x="2" y="3.5" width="16" height="13" rx="1.6" />
      {/* 提示符 > */}
      <polyline points="5.4 8.2 7.6 10.3 5.4 12.4" />
      {/* 光标 _ */}
      <line x1="9.6" y1="12.6" x2="13.4" y2="12.6" />
    </svg>
  );
}
