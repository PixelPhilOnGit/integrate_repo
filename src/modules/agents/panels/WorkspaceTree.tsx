/**
 * 侧栏：工作目录 → 会话。
 *
 * # 两层的分工
 *
 * 上面是**工作目录**（一个本地文件夹），下面挂着它里面的**会话**。
 * 用户的心智模型是「这个项目我开了三个 agent」，所以分组不是装饰 ——
 * 它决定了「我在哪儿」这件事在界面上有没有答案。
 *
 * # 点一个会话 = 让它上屏
 *
 * 侧栏是导航，主区是舞台。点一下，那个会话就出现在**当前聚焦的那一格**里
 * （不在屏幕上时才这样；已经在屏幕上就直接把焦点给它）。
 * 想并排看两个，用右键里的「在右边/下边分屏显示」，或者窗格标题上的分屏按钮。
 */

import { useState, type ReactNode } from 'react';
import { ContextMenu, type MenuItem } from '../../../shared/ui/ContextMenu';
import { elapsed } from '../core/elapsed';
import { statusLine } from '../core/status';
import type { AgentSession, AgentWorkspace, SessionStatus } from '../core/types';
import type { AgentsState, AgentsStore } from '../state/store';
import { StatusDot } from './StatusDot';

interface Props {
  state: AgentsState;
  store: AgentsStore;
  now: number;
}

interface OpenMenu {
  x: number;
  y: number;
  items: MenuItem[];
}

export function WorkspaceTree({ state, store, now }: Props): ReactNode {
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [renaming, setRenaming] = useState<string | null>(null);

  return (
    <>
      <div className="rd-panel" data-testid="agent-workspaces">
        <div className="rd-panel-head">
          <span>工作目录</span>
          <span className="rd-spacer" />
          <button
            type="button"
            className="rd-btn"
            data-testid="agent-add-workspace"
            onClick={() => void store.addWorkspace()}
          >
            添加
          </button>
        </div>

        <div className="rd-panel-body">
          {state.workspaces.length === 0 ? (
            <div className="rd-empty">还没有工作目录，点「添加」选一个项目文件夹</div>
          ) : (
            state.workspaces.map((workspace) => {
              const sessions = state.sessions.filter((s) => s.workspaceId === workspace.id);
              const expanded = collapsed[workspace.id] !== true;

              return (
                <div className="rd-agent-ws" key={workspace.id} data-testid={`agent-ws-${workspace.id}`}>
                  <WorkspaceHead
                    workspace={workspace}
                    sessions={sessions}
                    expanded={expanded}
                    renaming={renaming === workspace.id}
                    onToggle={() =>
                      setCollapsed((c) => ({ ...c, [workspace.id]: expanded }))
                    }
                    onStartRename={() => setRenaming(workspace.id)}
                    onFinishRename={(name) => {
                      setRenaming(null);
                      if (name !== null) store.renameWorkspace(workspace.id, name);
                    }}
                    onMenu={(x, y) => setMenu({ x, y, items: workspaceMenu(store, workspace) })}
                    onNewSession={(kind) =>
                      void store.createSession(workspace.id, kind)
                    }
                  />

                  {expanded &&
                    sessions.map((session) => (
                      <SessionRow
                        key={session.id}
                        session={session}
                        focused={session.id === state.focusedId}
                        onScreen={isOnScreen(state, session.id)}
                        now={now}
                        onClick={() => store.jumpTo(session.id)}
                        onMenu={(x, y) => setMenu({ x, y, items: sessionMenu(store, state, session) })}
                      />
                    ))}
                </div>
              );
            })
          )}
        </div>
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      )}
    </>
  );
}

function WorkspaceHead({
  workspace,
  sessions,
  expanded,
  renaming,
  onToggle,
  onStartRename,
  onFinishRename,
  onMenu,
  onNewSession,
}: {
  workspace: AgentWorkspace;
  sessions: readonly AgentSession[];
  expanded: boolean;
  renaming: boolean;
  onToggle: () => void;
  onStartRename: () => void;
  onFinishRename: (name: string | null) => void;
  onMenu: (x: number, y: number) => void;
  onNewSession: (kind: 'claude' | 'codex' | 'shell') => void;
}): ReactNode {
  const rollup = rollupStatus(sessions);

  return (
    <div
      className="rd-agent-ws-head"
      data-testid={`agent-ws-head-${workspace.id}`}
      // 路径是这一行真正有用的信息，但显示出来太长 —— 放 title 里
      title={workspace.path}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e.clientX, e.clientY);
      }}
    >
      <button
        type="button"
        className="rd-agent-caret"
        aria-label={expanded ? '收起' : '展开'}
        onClick={onToggle}
      >
        {expanded ? '▾' : '▸'}
      </button>

      {rollup !== null && <StatusDot status={rollup} />}

      {renaming ? (
        <RenameInput value={workspace.name} onDone={onFinishRename} />
      ) : (
        <span
          className="rd-agent-ws-name"
          data-testid={`agent-ws-name-${workspace.id}`}
          onDoubleClick={onStartRename}
        >
          {workspace.name}
        </span>
      )}

      <span className="rd-muted rd-agent-ws-count">{sessions.length}</span>
      <button
        type="button"
        className="rd-agent-add"
        title="在这个目录里新开一个会话"
        aria-label="新开会话"
        data-testid={`agent-new-session-${workspace.id}`}
        onClick={() => onNewSession('claude')}
      >
        ＋
      </button>
    </div>
  );
}

function SessionRow({
  session,
  focused,
  onScreen,
  now,
  onClick,
  onMenu,
}: {
  session: AgentSession;
  focused: boolean;
  onScreen: boolean;
  now: number;
  onClick: () => void;
  onMenu: (x: number, y: number) => void;
}): ReactNode {
  return (
    <div
      className={`rd-agent-row${focused ? ' is-focused' : ''}`}
      data-testid={`agent-session-${session.id}`}
      data-session-title={session.title}
      data-session-status={session.status}
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e.clientX, e.clientY);
      }}
    >
      <StatusDot status={session.status} />
      <span className="rd-agent-row-title" title={session.title}>
        {session.title}
      </span>
      {/* 已经在屏幕上就标一下 —— 点了不会换屏，而是把焦点给它 */}
      {onScreen && (
        <span className="rd-agent-on-screen" title="已经在屏幕上">
          ▣
        </span>
      )}
      <span className="rd-agent-row-line" title={statusLine(session)}>
        {statusLine(session)}
      </span>
      <span className="rd-agent-row-age rd-muted">{elapsed(session.statusAt, now)}</span>
    </div>
  );
}

/** 双击改名。回车提交、Esc 取消、失焦提交（和别的模块的行内编辑一致） */
function RenameInput({
  value,
  onDone,
}: {
  value: string;
  onDone: (name: string | null) => void;
}): ReactNode {
  const [text, setText] = useState(value);

  return (
    <input
      className="rd-input rd-agent-rename"
      value={text}
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setText(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onDone(text);
        if (e.key === 'Escape') onDone(null);
        e.stopPropagation();
      }}
      onBlur={() => onDone(text)}
      onDoubleClick={(e) => e.stopPropagation()}
    />
  );
}

// ------------------------------------------------------------------ 各种小逻辑

/** 这个工作目录下面最「值得注意」的那个状态。谁的优先级更高见下 */
function rollupStatus(sessions: readonly AgentSession[]): SessionStatus | null {
  if (sessions.length === 0) return null;
  const order: SessionStatus[] = ['waiting', 'working', 'done', 'starting', 'idle', 'exited'];
  for (const status of order) {
    if (sessions.some((s) => s.status === status)) return status;
  }
  return null;
}

function isOnScreen(state: AgentsState, sessionId: string): boolean {
  const layout = state.layout;
  if (layout === null) return false;
  const walk = (node: typeof layout): boolean =>
    node.kind === 'leaf' ? node.sessionId === sessionId : walk(node.a) || walk(node.b);
  return walk(layout);
}

function workspaceMenu(store: AgentsStore, workspace: AgentWorkspace): MenuItem[] {
  return [
    { label: '新开 Claude Code', onSelect: () => void store.createSession(workspace.id, 'claude') },
    { label: '新开 Codex', onSelect: () => void store.createSession(workspace.id, 'codex') },
    { label: '新开终端', onSelect: () => void store.createSession(workspace.id, 'shell') },
    {
      label: '删除这个工作目录',
      danger: true,
      separatorBefore: true,
      onSelect: () => void store.removeWorkspace(workspace.id),
    },
  ];
}

function sessionMenu(store: AgentsStore, state: AgentsState, session: AgentSession): MenuItem[] {
  const items: MenuItem[] = [];

  // 已经在屏幕上的会话不该再提供「分屏显示」—— 一个会话不能同时占两格
  if (!isOnScreen(state, session.id)) {
    items.push({
      label: '在右边分屏显示',
      onSelect: () => store.putOnScreen(session.id, 'row'),
    });
    items.push({
      label: '在下边分屏显示',
      onSelect: () => store.putOnScreen(session.id, 'col'),
    });
  }

  if (session.status === 'waiting') {
    items.push({ label: '我知道了', onSelect: () => store.acknowledge(session.id) });
  }

  items.push({
    label: '关掉这个会话',
    danger: true,
    separatorBefore: items.length > 0,
    onSelect: () => void store.closeSession(session.id),
  });

  return items;
}
