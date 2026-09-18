/**
 * 图标栏上的角标：有几个会话在等你。
 *
 * 这是**唯一的跨模块提醒**。用户在顺序图那边画着图、或者在看 Redis 的 key，
 * 屏幕上没有一格终端 —— 这时候 agent 停下来等他了，能告诉他的只有这里。
 *
 * 只数「需要你」，不数「已完成」：已完成是结果，需要你才是**现在有事**。
 * 两者混在一个数字里，这个角标就会一直亮着，然后被无视。
 */

import { useSyncExternalStore, type ReactNode } from 'react';
import { attentionQueue } from './core/status';
import { agentsStore } from './state/store';

export function AgentsBadge(): ReactNode {
  const state = useSyncExternalStore(agentsStore.subscribe, agentsStore.getSnapshot);
  const waiting = attentionQueue(state.sessions).length;
  if (waiting === 0) return null;

  return (
    <span className="rd-module-badge" data-testid="agents-badge" aria-label={`${waiting} 个会话在等你`}>
      {waiting > 9 ? '9+' : waiting}
    </span>
  );
}
