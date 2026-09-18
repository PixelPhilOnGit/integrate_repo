/**
 * 侧栏顶部那条「需要你」队列。
 *
 * # 它是这个模块的答案
 *
 * 用户开这个模块就是为了这一个问题：**现在该看哪个？** 四个 agent 同时跑着的时候，
 * 靠逐个窗格扫一眼来判断「谁在等我」是在浪费时间，而且会漏。
 * 队列把这件事变成一句「等得最久的在最上面」，点一下就跳过去。
 *
 * # 没有等待的会话时它整个不出现
 *
 * 不是折叠起来或者显示「0 个」—— 那样会在侧栏顶部永久占一块地方，
 * 而它是**有事才该出现**的东西。空着的时候侧栏应该干干净净地是工作目录列表。
 */

import type { ReactNode } from 'react';
import { elapsed } from '../core/elapsed';
import { attentionQueue, statusLine } from '../core/status';
import type { AgentsState, AgentsStore } from '../state/store';
import { StatusDot } from './StatusDot';

interface Props {
  state: AgentsState;
  store: AgentsStore;
  /** 当前时间。由外面传进来，让它和侧栏其它地方共用一个时钟 */
  now: number;
}

export function AttentionQueue({ state, store, now }: Props): ReactNode {
  const queue = attentionQueue(state.sessions);
  if (queue.length === 0) return null;

  return (
    <div className="rd-agent-queue" data-testid="agent-queue">
      <div className="rd-agent-queue-head">
        <span>需要你（{queue.length}）</span>
        <span className="rd-spacer" />
        <span className="rd-muted">Ctrl+Shift+U</span>
      </div>
      {queue.map((session) => {
        const workspace = state.workspaces.find((w) => w.id === session.workspaceId);
        return (
          <button
            key={session.id}
            type="button"
            className="rd-agent-queue-item"
            data-testid={`agent-queue-${session.id}`}
            title={`${workspace?.name ?? ''} · ${statusLine(session)}`}
            onClick={() => store.jumpTo(session.id)}
          >
            <StatusDot status={session.status} />
            <span className="rd-agent-queue-title">{session.title}</span>
            <span className="rd-muted rd-agent-queue-where">{workspace?.name ?? ''}</span>
            <span className="rd-agent-queue-age">{elapsed(session.statusAt, now)}</span>
          </button>
        );
      })}
    </div>
  );
}
