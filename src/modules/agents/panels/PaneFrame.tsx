/**
 * 主区里的一格：**标签条 + 终端**（2026-10-16 起一格可以放多个终端）。
 *
 * 用户拍板的形态：「单个终端不能作为叶子，叶子属于窗口，一个窗口可能多个
 * 终端」—— 分屏的每一格是个标签容器：同格子里开 N 个会话、标签切换，
 * 分屏依然能用（左一格跑 agent、右一格放五个终端各干各的）。
 *
 * 标签条上每一个的（状态点、标题、×）是**每一格都必须有**的 —— 四个窗格
 * 并排时，用户得一眼看出哪一个在等他，而不是逐个去读终端里的字。
 * 格子级的琥珀边框看的是「**任意一个标签**在等」：提醒是这个模块的立身之本，
 * 藏在不活跃的标签后面等于没有。
 */

import type { ReactNode } from 'react';
import type { PaneLayout } from '../core/layout';
import { statusLine } from '../core/status';
import type { AgentSession } from '../core/types';
import type { AgentsStore } from '../state/store';
import { PaneTerminal } from './PaneTerminal';
import { StatusDot } from './StatusDot';

interface Props {
  /** 这一格（tabs + active） */
  leaf: Extract<PaneLayout, { kind: 'leaf' }>;
  /** 当前显示的会话（`leaf.active` 对应的那条） */
  active: AgentSession;
  /** 这一格里全部还活着的会话（按标签顺序） */
  tabs: readonly AgentSession[];
  workspaceName: string;
  /** 键盘焦点在这一格上（边框会亮起来） */
  focused: boolean;
  store: AgentsStore;
}

export function PaneFrame({ leaf, active, tabs, workspaceName, focused, store }: Props): ReactNode {
  const anyWaiting = tabs.some((s) => s.status === 'waiting');

  return (
    <div
      className={`rd-agent-pane${focused ? ' is-focused' : ''}${anyWaiting ? ' is-waiting' : ''}`}
      data-testid={`agent-pane-${active.id}`}
      data-session-id={active.id}
      data-session-title={active.title}
      data-session-status={active.status}
      // 点这一格的任何地方都算把焦点给它 —— 和真实的终端窗口一致。
      // 用 mousedown 而不是 click：拖选文字的时候也该切过来
      onMouseDown={() => store.focusSession(active.id)}
    >
      <div className="rd-agent-pane-head">
        <StatusDot status={active.status} testId={`agent-dot-${active.id}`} />
        {/*
          标签条：横向可滚（标签开多了不许把右边的分屏/关闭按钮挤出去），
          每个标签 = 状态点 + 标题 + ×（× = 把这个终端从格子里收起来，
          会话不杀、回侧栏，和「关一格 ≠ 关会话」同一条语义）。
        */}
        <div className="rd-agent-tabs" role="tablist" aria-label="这一格里的终端" data-testid={`agent-tabs-${active.id}`}>
          {tabs.map((s) => {
            const isActive = s.id === active.id;
            return (
              <div
                key={s.id}
                className={`rd-agent-tab${isActive ? ' is-active' : ''}`}
                role="tab"
                aria-selected={isActive}
                data-testid={`agent-tab-${s.id}`}
              >
                <button
                  type="button"
                  className="rd-agent-tab-main"
                  title={`${s.title} · ${statusLine(s)}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    store.focusTab(s.id);
                  }}
                >
                  <StatusDot status={s.status} testId={`agent-tab-dot-${s.id}`} />
                  <span className="rd-agent-tab-title">{s.title}</span>
                </button>
                <button
                  type="button"
                  className="rd-agent-tab-close"
                  title="把这个终端从格子里收起来（会话不杀，侧栏里还在）"
                  aria-label={`收起 ${s.title}`}
                  data-testid={`agent-tab-close-${s.id}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    store.closeTabFor(s.id);
                  }}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
        <span className="rd-agent-pane-dir rd-muted" title={workspaceName}>
          {workspaceName}
        </span>
        <span className="rd-spacer" />
        <span className="rd-agent-pane-status rd-muted" data-testid={`agent-line-${active.id}`}>
          {statusLine(active)}
        </span>
        <button
          type="button"
          className="rd-agent-pane-btn"
          title="向右分屏（新开一个同类型的会话，放进新格子）"
          aria-label="向右分屏"
          data-testid={`agent-split-right-${active.id}`}
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
          title="向下分屏（新开一个同类型的会话，放进新格子）"
          aria-label="向下分屏"
          data-testid={`agent-split-down-${active.id}`}
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
            leaf.tabs.length > 1
              ? '关掉这一格（这一格的终端全部回侧栏，进程还在跑）'
              : active.status === 'exited'
                ? '关掉这一格（进程已经退出了）'
                : '关掉这一格（进程还在跑，只是不在屏幕上）'
          }
          aria-label="关掉这一格"
          data-testid={`agent-close-pane-${active.id}`}
          onClick={(e) => {
            e.stopPropagation();
            store.closePaneFor(active.id);
          }}
        >
          ×
        </button>
      </div>

      <PaneTerminal sessionId={active.id} focused={focused} />
    </div>
  );
}
