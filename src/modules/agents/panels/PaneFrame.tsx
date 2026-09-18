/**
 * 主区里的一格：标题条 + 终端。
 *
 * 标题条上那三样东西（状态点、标题、操作按钮）是**每一格都必须有**的 ——
 * 四个窗格并排时，用户得一眼看出哪一格在等他，而不是逐个去读终端里的字。
 */

import type { ReactNode } from 'react';
import { statusLine } from '../core/status';
import type { AgentSession } from '../core/types';
import type { AgentsStore } from '../state/store';
import { PaneTerminal } from './PaneTerminal';
import { StatusDot } from './StatusDot';

interface Props {
  session: AgentSession;
  workspaceName: string;
  /** 键盘焦点在这一格上（边框会亮起来） */
  focused: boolean;
  store: AgentsStore;
}

export function PaneFrame({ session, workspaceName, focused, store }: Props): ReactNode {
  const waiting = session.status === 'waiting';

  return (
    <div
      className={`rd-agent-pane${focused ? ' is-focused' : ''}${waiting ? ' is-waiting' : ''}`}
      data-testid={`agent-pane-${session.id}`}
      data-session-id={session.id}
      data-session-title={session.title}
      data-session-status={session.status}
      // 点这一格的任何地方都算把焦点给它 —— 和真实的终端窗口一致。
      // 用 mousedown 而不是 click：拖选文字的时候也该切过来
      onMouseDown={() => store.focusSession(session.id)}
    >
      <div className="rd-agent-pane-head">
        <StatusDot status={session.status} testId={`agent-dot-${session.id}`} />
        <span className="rd-agent-pane-title" title={`${workspaceName} · ${session.command}`}>
          {session.title}
        </span>
        <span className="rd-agent-pane-dir rd-muted" title={workspaceName}>
          {workspaceName}
        </span>
        <span className="rd-spacer" />
        <span className="rd-agent-pane-status rd-muted" data-testid={`agent-line-${session.id}`}>
          {statusLine(session)}
        </span>
        <button
          type="button"
          className="rd-agent-pane-btn"
          title="向右分屏（新开一个同类型的会话）"
          aria-label="向右分屏"
          data-testid={`agent-split-right-${session.id}`}
          onClick={(e) => {
            e.stopPropagation();
            void store.splitWithNewSession('row');
          }}
        >
          ▥
        </button>
        <button
          type="button"
          className="rd-agent-pane-btn"
          title="向下分屏（新开一个同类型的会话）"
          aria-label="向下分屏"
          data-testid={`agent-split-down-${session.id}`}
          onClick={(e) => {
            e.stopPropagation();
            void store.splitWithNewSession('col');
          }}
        >
          ▤
        </button>
        <button
          type="button"
          className="rd-agent-pane-btn"
          title={
            session.status === 'exited'
              ? '关掉这一格（进程已经退出了）'
              : '关掉这一格（进程还在跑，只是不在屏幕上）'
          }
          aria-label="关掉这一格"
          data-testid={`agent-close-pane-${session.id}`}
          onClick={(e) => {
            e.stopPropagation();
            store.closePaneFor(session.id);
          }}
        >
          ×
        </button>
      </div>

      <PaneTerminal sessionId={session.id} />
    </div>
  );
}
