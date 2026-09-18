/**
 * 会话的状态点。
 *
 * 它是这个模块**唯一一个到处都在用的东西**（侧栏、窗格标题、队列），
 * 所以形状和颜色必须只有这一处定义 —— 三处各写一遍的话，
 * 迟早会出现「侧栏是蓝的、标题上是黄的」这种对不上的情况。
 *
 * 颜色的分工：
 * - **琥珀 + 脉冲** = 需要你（唯一一个会动的东西，眼睛会先看到它）
 * - 蓝 = 正在工作
 * - 绿 = 已完成
 * - 灰 = 空闲 / 已退出
 */

import type { ReactNode } from 'react';
import type { SessionStatus } from '../core/types';

interface Props {
  status: SessionStatus;
  /** 界面上要不要带上状态名。窗格标题那种窄的地方就不带 */
  label?: string;
  testId?: string;
}

export function StatusDot({ status, label, testId }: Props): ReactNode {
  const cls = `rd-agent-dot is-${dotClass(status)}`;
  return (
    <span className="rd-agent-dot-wrap">
      <span
        className={cls}
        data-testid={testId}
        data-status={status}
        title={label}
        aria-hidden={label === undefined ? 'true' : undefined}
      />
      {label !== undefined && <span className="rd-agent-dot-label">{label}</span>}
    </span>
  );
}

/** 状态 → CSS 类。`working` 和 `starting` 在视觉上是一回事（都在忙） */
function dotClass(status: SessionStatus): string {
  switch (status) {
    case 'starting':
    case 'working':
      return 'working';
    case 'waiting':
      return 'waiting';
    case 'done':
      return 'done';
    case 'exited':
      return 'exited';
    default:
      return 'idle';
  }
}
