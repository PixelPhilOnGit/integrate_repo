/** 顺序图在模块图标栏上的图标：两条生命线 + 一条消息箭头 */

import type { ReactNode } from 'react';

export function DiagramIcon(): ReactNode {
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
      {/* 两条生命线 */}
      <line x1="5" y1="4" x2="5" y2="17" strokeDasharray="2 2" />
      <line x1="15" y1="4" x2="15" y2="17" strokeDasharray="2 2" />
      {/* 两个参与者 */}
      <rect x="2" y="2" width="6" height="3" rx="0.6" />
      <rect x="12" y="2" width="6" height="3" rx="0.6" />
      {/* 一条消息 */}
      <line x1="5" y1="10" x2="15" y2="10" />
      <path d="M12.5 8.6 15 10l-2.5 1.4" />
    </svg>
  );
}
