import type { ReactNode } from 'react';

/**
 * Redis 的图标：几层叠起来的方块。
 *
 * 刻意不用官方那个红色 Logo —— 一是版权，二是它和 `devplaceholder` 里那个
 * 数据库柱体在 20px 下几乎分不出来。
 */
export function RedisIcon(): ReactNode {
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
      {/* 三层堆叠（等距视角的方块），下面两层被上面挡住的部分不画 */}
      <path d="M10 2.6 17 6l-7 3.4L3 6z" />
      <path d="M3 10l7 3.4L17 10" />
      <path d="M3 14l7 3.4L17 14" />
    </svg>
  );
}
