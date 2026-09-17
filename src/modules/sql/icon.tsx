import type { ReactNode } from 'react';

/**
 * SQL 模块的图标：一张带表头的表格。
 *
 * 刻意和 `devplaceholder` 那个数据库柱体、以及 Redis 那个堆叠方块都区分得开 ——
 * 三个图标在 20px 下要能一眼分辨。
 */
export function SqlIcon(): ReactNode {
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
      {/* 表格外框 */}
      <rect x="3" y="4" width="14" height="12" rx="1.6" />
      {/* 表头分隔线 */}
      <path d="M3 8h14" />
      {/* 两列 */}
      <path d="M8.5 8v8" />
      <path d="M13 8v8" />
    </svg>
  );
}
