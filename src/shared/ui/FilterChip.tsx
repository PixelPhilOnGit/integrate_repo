/**
 * 侧栏顶部那排「筛选小按钮」：标签 + 计数，选中态高亮。
 *
 * 从任务模块抽出来的 —— 那边先有了这套（`.rd-task-chip`），智能体会话的侧栏
 * 要按状态筛会话时又需要一模一样的东西。
 *
 * ⚠️ **CSS 类给的是 `rd-chip`**：`.rd-task-chip` 在样式表里和它**共用同一组
 * 选择器**（那个名字留着不动 —— 改它只会白白制造 diff，而且它确实还挂在任务
 * 那几个 chip 上）。新代码一律用 `rd-chip`。
 *
 * 选中态用的是 `aria-pressed` 而不是自己造一个状态 —— 读屏能念出来，
 * `is-active` 只管长得不一样。
 */

import type { ReactNode } from 'react';

export interface FilterChipProps {
  label: string;
  count: number;
  active: boolean;
  testId: string;
  onClick: () => void;
}

export function FilterChip({ label, count, active, testId, onClick }: FilterChipProps): ReactNode {
  return (
    <button
      type="button"
      className={`rd-chip${active ? ' is-active' : ''}`}
      data-testid={testId}
      aria-pressed={active}
      onClick={onClick}
    >
      {label}
      <span className="rd-muted"> {count}</span>
    </button>
  );
}
