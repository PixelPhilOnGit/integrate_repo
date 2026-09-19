/**
 * 侧栏：窗口（工作目录）→ 会话。
 *
 * # 一个工作目录 = 一个窗口
 *
 * 上面那一层是**窗口**：一个本地文件夹，配一套自己的分屏布局。点它就切过去
 * （右边换它那一套子窗口），点另一条就换回去 —— 两个项目的分屏互不影响。
 * 下面那一层是窗口里的**会话**（右边那些格子），**默认收起**：侧栏一眼看到
 * 的该是「我有几个窗口」，而不是「我有几个会话」。要看会话、要跳到某一格，
 * 点开那个箭头。
 *
 * # 关掉父窗口 = 关掉里面全部会话，目录留着
 *
 * 在窗口那一行右键（`关闭全部会话（N）`，有会话在跑会先问一句）。
 * 「删除这个工作目录」是另一件事：那个连目录一起删。
 *
 * # 点一个会话 = 让它上屏
 *
 * 侧栏是导航，主区是舞台。点一下，那个会话所在的窗口切到前面，它自己在
 * 窗口里聚焦（已经在屏幕上的话就直接把焦点给它）。
 * 想并排看两个，用右键里的「在右边/下边分屏显示」，或者窗格标题上的分屏按钮。
 */

import { useState, type ReactNode } from 'react';
import { NoMatch, SearchBox } from '../../../shared/ui/SearchBox';
import { ContextMenu, type MenuItem } from '../../../shared/ui/ContextMenu';
import { fuzzyBest } from '../../../shared/search';
import { elapsed } from '../core/elapsed';
import { statusLine } from '../core/status';
import { STATUS_LABEL, type AgentSession, type AgentWorkspace, type SessionStatus } from '../core/types';
import type { AgentsState, AgentsStore } from '../state/store';
import { NewSessionDialog } from './NewSessionDialog';
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
  // ⚠️ 展开状态在 store 里（默认收起），不在这儿：切个模块 React 就把它卸载了，
  // 组件内的状态会让用户刚点开的那一行又合上（这条是 e2e 抓出来的）
  const [renaming, setRenaming] = useState<string | null>(null);
  /** 「新建会话」对话框是给哪个工作目录开的。null = 没开着 */
  const [newFor, setNewFor] = useState<AgentWorkspace | null>(null);
  const [query, setQuery] = useState('');

  const q = query.trim();
  const searching = q !== '';

  /**
   * 匹配**窗口自己**（目录名 / 路径）或者它下面的会话（标题）。
   *
   * ⚠️ 保序（`filter` 而不是按分排序）：这儿是一棵树，顺序是用户摆出来的形状；
   * 平铺的连接列表（Redis / SQL）才按相关度排。
   */
  const visible = state.workspaces.filter((workspace) => {
    if (!searching) return true;
    if (fuzzyBest(q, [workspace.name, workspace.path]) !== null) return true;
    return state.sessions.some(
      (s) => s.workspaceId === workspace.id && fuzzyBest(q, [s.title]) !== null,
    );
  });

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

        {state.workspaces.length > 0 && (
          <SearchBox
            value={query}
            onChange={setQuery}
            testId="agents-ws-search"
            placeholder="搜目录或会话"
          />
        )}

        <div className="rd-panel-body">
          {state.workspaces.length === 0 ? (
            <div className="rd-empty">还没有工作目录，点「添加」选一个项目文件夹</div>
          ) : visible.length === 0 ? (
            <NoMatch testId="agents-ws-nomatch" />
          ) : (
            visible.map((workspace) => {
              const allSessions = state.sessions.filter((s) => s.workspaceId === workspace.id);
              // ⚠️ **默认收起**：一个目录就是一个窗口，侧栏一眼看到的该是「有几个
              // 窗口」而不是「有几个会话」—— 后者展开再看。会话级的状态（在等你、
              // 已完成）在收起时由父行那个汇总圆点和顶部的「需要你」队列负责
              //
              // 搜索期间：只显示命中的会话，并**临时撑开**（叠加在点击状态之上，
              // `state.expanded` 一个字不动 —— 否则清空搜索之后树回不到原样）
              const sessions = searching
                ? allSessions.filter((s) => fuzzyBest(q, [s.title]) !== null)
                : allSessions;
              const expanded =
                searching && sessions.length > 0 ? true : state.expanded[workspace.id] === true;
              const active = state.activeWorkspaceId === workspace.id;

              return (
                <div className="rd-agent-ws" key={workspace.id} data-testid={`agent-ws-${workspace.id}`}>
                  <WorkspaceHead
                    workspace={workspace}
                    sessions={allSessions}
                    expanded={expanded}
                    active={active}
                    renaming={renaming === workspace.id}
                    onToggle={() => store.toggleExpanded(workspace.id)}
                    onActivate={() => store.setActiveWorkspace(workspace.id)}
                    onStartRename={() => setRenaming(workspace.id)}
                    onFinishRename={(name) => {
                      setRenaming(null);
                      if (name !== null) store.renameWorkspace(workspace.id, name);
                    }}
                    onMenu={(x, y) =>
                      setMenu({
                        x,
                        y,
                        items: workspaceMenu(store, workspace, allSessions, () => setNewFor(workspace)),
                      })
                    }
                    onNewSession={() => setNewFor(workspace)}
                  />

                  {expanded &&
                    sessions.map((session) => (
                      <SessionRow
                        key={session.id}
                        session={session}
                        focused={active && session.id === state.focusedId}
                        onScreen={isOnScreen(state, session)}
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

      {newFor !== null && (
        <NewSessionDialog
          state={state}
          store={store}
          workspace={newFor}
          onClose={() => setNewFor(null)}
        />
      )}
    </>
  );
}

function WorkspaceHead({
  workspace,
  sessions,
  expanded,
  active,
  renaming,
  onToggle,
  onActivate,
  onStartRename,
  onFinishRename,
  onMenu,
  onNewSession,
}: {
  workspace: AgentWorkspace;
  sessions: readonly AgentSession[];
  expanded: boolean;
  /** 现在右边显示的就是这一个窗口吗 */
  active: boolean;
  renaming: boolean;
  onToggle: () => void;
  onActivate: () => void;
  onStartRename: () => void;
  onFinishRename: (name: string | null) => void;
  onMenu: (x: number, y: number) => void;
  /** 打开「新建会话」对话框。**不再直接建** —— 数量由用户在对话框里定 */
  onNewSession: () => void;
}): ReactNode {
  const rollup = rollupStatus(sessions);

  return (
    <div
      className={`rd-agent-ws-head${active ? ' is-active' : ''}`}
      data-testid={`agent-ws-head-${workspace.id}`}
      data-workspace-active={active ? 'true' : 'false'}
      // 路径是这一行真正有用的信息，但显示出来太长 —— 放 title 里
      title={workspace.path}
      // 点这一行就切到它那个窗口（右边换一整套分屏）。和「点会话切过去」
      // 是同一件事的两个粒度：点目录 = 整个窗口，点会话 = 窗口里的某一格
      onClick={onActivate}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e.clientX, e.clientY);
      }}
    >
      <button
        type="button"
        className="rd-agent-caret"
        aria-label={expanded ? '收起' : '展开'}
        onClick={(e) => {
          // 别让展开顺带把窗口也切了 —— 用户可能只是想看看里面有什么
          e.stopPropagation();
          onToggle();
        }}
      >
        {expanded ? '▾' : '▸'}
      </button>

      {rollup !== null && <StatusDot status={rollup} />}

      {/* 两行：上面是名字，下面是**路径 + 会话数 + 状态汇总**。
          用户要的「胖一点」——一个项目最有用的三件事（在哪儿、开了几个、
          有没有在等你）收起时也该看得见，而不是只能看见一个名字 */}
      <span className="rd-agent-ws-text">
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
        <span className="rd-agent-ws-sub" data-testid={`agent-ws-sub-${workspace.id}`}>
          <span className="rd-agent-ws-path" title={workspace.path}>
            {workspace.path}
          </span>
          {sessions.length > 0 && <> · {sessions.length} 个会话</>}
          {rollup !== null && <> · {STATUS_LABEL[rollup]}</>}
        </span>
      </span>

      <span className="rd-muted rd-agent-ws-count">{sessions.length}</span>
      <button
        type="button"
        className="rd-agent-add"
        title="在这个目录里新开会话"
        aria-label="新开会话"
        data-testid={`agent-new-session-${workspace.id}`}
        onClick={(e) => {
          e.stopPropagation();
          onNewSession();
        }}
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

/**
 * 这个会话是不是正摆在**它那个窗口**里。
 *
 * ⚠️ 按会话自己的窗口算，不是「当前显示的那套」：它在别的窗口里摆着也算
 * 「已经在屏幕上」（那个窗口里不能再摆第二份），但侧栏那一行会诚实地说
 * 它在不在**现在看的**这一屏上 —— 前者管菜单里能不能点「分屏显示」，
 * 后者只是显示。
 */
function isOnScreen(state: AgentsState, session: AgentSession): boolean {
  const layout = state.layouts[session.workspaceId];
  if (layout === undefined) return false;
  const walk = (node: typeof layout): boolean =>
    node.kind === 'leaf' ? node.sessionId === session.id : walk(node.a) || walk(node.b);
  return walk(layout);
}

function workspaceMenu(
  store: AgentsStore,
  workspace: AgentWorkspace,
  sessions: readonly AgentSession[],
  onNewSession: () => void,
): MenuItem[] {
  const items: MenuItem[] = [
    // 「新建会话…」在最上面：一次可以开好几个，是默认的那条路；
    // 下面三条是「就来一个」的快捷方式，熟手用起来还是它们快
    { label: '新建会话…', onSelect: onNewSession },
    {
      label: '新开 Claude Code',
      separatorBefore: true,
      onSelect: () => void store.createSession(workspace.id, 'claude'),
    },
    { label: '新开 Codex', onSelect: () => void store.createSession(workspace.id, 'codex') },
    { label: '新开终端', onSelect: () => void store.createSession(workspace.id, 'shell') },
  ];

  if (sessions.length > 0) {
    // 「关掉父窗口」= 只收子窗口，**目录留着**（下次直接重开一批）。
    // 要连目录一起删是下面那条「删除这个工作目录」
    items.push({
      label: `关闭全部会话（${sessions.length}）`,
      separatorBefore: true,
      onSelect: () => void store.closeWorkspaceSessions(workspace.id),
    });
  }

  items.push({
    label: '删除这个工作目录',
    danger: true,
    separatorBefore: true,
    onSelect: () => void store.removeWorkspace(workspace.id),
  });

  return items;
}

function sessionMenu(store: AgentsStore, state: AgentsState, session: AgentSession): MenuItem[] {
  const items: MenuItem[] = [];

  // 已经在屏幕上的会话不该再提供「分屏显示」—— 一个会话不能同时占两格
  if (!isOnScreen(state, session)) {
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
