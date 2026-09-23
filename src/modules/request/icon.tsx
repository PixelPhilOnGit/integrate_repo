import type { ReactNode } from 'react';

/**
 * 「接口调试」的图标：一个方框 + 一支**射出去的箭头**。
 *
 * 选这个形状的理由：这个模块做的事就是「把一份请求发出去、看它回来什么」——
 * 箭头的方向是**出去的**（不是下载、不是云）。方框是那个外面的服务端。
 */
export function RequestIcon(): ReactNode {
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
      {/* 目标（服务端） */}
      <path d="M11.5 4.5h4a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5h-4" />
      {/* 射出去的箭头 */}
      <path d="M3 10h8.5" />
      <path d="M8.5 6.5 12 10l-3.5 3.5" />
    </svg>
  );
}
