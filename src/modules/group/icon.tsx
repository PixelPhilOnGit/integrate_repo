import type { ReactNode } from 'react';

/**
 * 群组协作的图标：三个围成一圈的节点，中间连起来。
 *
 * 意象是「多个 agent 在一个群里」，而不是单个对话气泡 —— 后者是助手模块的。
 */
export function GroupIcon(): ReactNode {
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
      {/* 三个成员 */}
      <circle cx="10" cy="4.6" r="2.1" />
      <circle cx="4.6" cy="14" r="2.1" />
      <circle cx="15.4" cy="14" r="2.1" />
      {/* 彼此之间的连线 */}
      <path d="M8.4 6.3 6 12.2M11.6 6.3 14 12.2M6.7 14h6.6" />
    </svg>
  );
}
