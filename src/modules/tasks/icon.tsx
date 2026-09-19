import type { ReactNode } from 'react';

/**
 * 任务的图标：一块清单板，前两行有勾、第三行空着。
 *
 * 「有一个勾、有一个没勾」是刻意的 —— 一个全是勾的图标看着像「都做完了」，
 * 而这个模块的存在意义是提醒你**还有没做完的**。
 */
export function TasksIcon(): ReactNode {
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
      {/* 板子 */}
      <rect x="3.5" y="3" width="13" height="14" rx="2" />
      {/* 第一条：勾 */}
      <path d="M6.2 7.2l1.3 1.3 2.4-2.4" />
      {/* 第二条：勾 */}
      <path d="M6.2 11.4l1.3 1.3 2.4-2.4" />
      {/* 第三条：空的（还没做） */}
      <path d="M11.6 14.6h4" />
    </svg>
  );
}
