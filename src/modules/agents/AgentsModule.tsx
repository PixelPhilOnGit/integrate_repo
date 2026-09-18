/**
 * 智能体会话模块的各个槽位。
 *
 * 外壳只认 `Module` 接口，它把这些组件填进去：
 *   Sidebar（左） / Main（中） / Inspector（右） / StatusItems（状态栏右侧）
 *
 * 和 Redis / SQL / SSH 一样**没有 Toolbar** —— 这个模块的工具都在侧栏和
 * 窗格标题上，横跨整个内容区放一条工具栏只会让终端矮一行。
 */

import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { attentionQueue } from './core/status';
import { AttentionQueue } from './panels/AttentionQueue';
import { SessionForm } from './panels/SessionForm';
import { SplitView } from './panels/SplitView';
import { WorkspaceTree } from './panels/WorkspaceTree';
import { shortcutFor, type ShortcutAction } from './shortcuts';
import { agentsStore } from './state/store';

/** 订阅模块自己的 store。外壳不掺和模块的状态 */
function useAgents() {
  return useSyncExternalStore(agentsStore.subscribe, agentsStore.getSnapshot);
}

/**
 * 每秒钟走一次的时钟。
 *
 * 侧栏上那句「正在工作 12 秒」得动起来才有意义 —— 一个不动的数字，
 * 用户没法靠它判断「它是不是卡住了」。一秒一次的重渲染只波及侧栏那一小块，
 * 终端（它在 React 树外面）完全不受影响。
 */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/**
 * 模块级快捷键。
 *
 * ⚠️ **挂在 window 的捕获阶段**，不是冒泡阶段。终端的键盘输入走 xterm 的隐藏
 * textarea，事件会先落到它身上 —— 冒泡阶段收到时，按键已经发给进程了
 * （`Ctrl+Shift+W` 会变成进程收到一个莫名其妙的控制字符，同时窗格被关掉）。
 * 捕获阶段先拿到，处理掉就 `stopPropagation`，事件根本到不了 xterm。
 */
function useShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      // 在输入框里打字时不要抢键。⚠️ **terminal 的隐藏 textarea 不算** ——
      // 焦点在终端里是这个模块最常见的情形，那时的快捷键必须照样能用
      const target = e.target as HTMLElement | null;
      if (target !== null && (target.tagName === 'INPUT' || target.isContentEditable)) return;

      const action = shortcutFor(e);
      if (action === null) return;

      e.preventDefault();
      e.stopPropagation();
      runAction(action);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);
}

function runAction(action: ShortcutAction): void {
  const state = agentsStore.getSnapshot();
  const focused = state.focusedId;

  switch (action.kind) {
    case 'split':
      void agentsStore.splitWithNewSession(action.dir);
      return;
    case 'close-pane':
      if (focused !== null) agentsStore.closePaneFor(focused);
      return;
    case 'focus':
      agentsStore.focusDirection(action.dir);
      return;
    case 'jump-attention':
      agentsStore.jumpToAttention();
      return;
    case 'new-session': {
      // 在**当前会话所在的**目录里再开一个 —— 用户按这个键的意思几乎总是
      // 「这个项目再来一个」，而不是「随便找个目录开一个」
      const session = state.sessions.find((s) => s.id === focused);
      const workspaceId = session?.workspaceId ?? state.workspaces[0]?.id;
      if (workspaceId !== undefined) {
        void agentsStore.createSession(workspaceId, session?.kind ?? 'claude');
      }
      return;
    }
  }
}

export function AgentsSidebar(): ReactNode {
  const state = useAgents();
  const now = useNow();

  return (
    <div className="rd-agent-sidebar" data-testid="agents-sidebar">
      <AttentionQueue state={state} store={agentsStore} now={now} />
      <WorkspaceTree state={state} store={agentsStore} now={now} />
    </div>
  );
}

export function AgentsMain(): ReactNode {
  const state = useAgents();
  useShortcuts();

  return (
    <div className="rd-agent-main" data-testid="agents-main">
      <SplitView state={state} store={agentsStore} />
    </div>
  );
}

export function AgentsInspector(): ReactNode {
  const state = useAgents();
  const now = useNow();
  return <SessionForm state={state} store={agentsStore} now={now} />;
}

/** 状态栏右侧：几个会话、几个在等 */
export function AgentsStatusItems(): ReactNode {
  const state = useAgents();
  const waiting = useMemo(() => attentionQueue(state.sessions).length, [state.sessions]);

  if (state.sessions.length === 0) {
    return (
      <span className="rd-muted" data-testid="agents-status">
        没有会话
      </span>
    );
  }

  return (
    <>
      <span className="rd-muted" data-testid="agents-status">
        {state.sessions.length} 个会话
      </span>
      <span
        className={waiting > 0 ? 'rd-agent-waiting-text' : 'rd-muted'}
        data-testid="agents-status-waiting"
      >
        {waiting > 0 ? `${waiting} 个在等你` : '没有在等你的'}
      </span>
    </>
  );
}
