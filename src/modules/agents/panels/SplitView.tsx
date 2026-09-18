/**
 * 主区：把分屏树画出来。
 *
 * 递归渲染，一层 split 就是一个 flex 容器加一条分隔条。
 * 布局本身（谁占多大、上下左右怎么排）全在 `core/layout.ts` 里算好了，
 * 这里只负责摆 —— **这个文件里不该有任何几何计算**。
 *
 * # 分隔条
 *
 * 拖动时把「鼠标在这个容器里的相对位置」报给 store，由 `core/layout.ts`
 * 夹到 [0.15, 0.85]。夹那一头是有理由的：拖到 0 的话那一格**变成零像素**，
 * 但它在树里还活着 —— 用户点不着也关不掉。
 */

import { useRef, useState, type ReactNode } from 'react';
import type { PaneLayout, SplitDir, SplitPath } from '../core/layout';
import type { AgentsState } from '../state/store';
import type { AgentsStore } from '../state/store';
import { PaneFrame } from './PaneFrame';

interface Props {
  state: AgentsState;
  store: AgentsStore;
}

export function SplitView({ state, store }: Props): ReactNode {
  if (state.layout === null) return <EmptyState state={state} store={store} />;

  return (
    <div className="rd-agent-split-root" data-testid="agent-split-root">
      {renderNode(state.layout, [], state, store)}
    </div>
  );
}

function renderNode(
  node: PaneLayout,
  path: SplitPath,
  state: AgentsState,
  store: AgentsStore,
): ReactNode {
  if (node.kind === 'leaf') {
    const session = state.sessions.find((s) => s.id === node.sessionId);
    // 会话没了但布局里还留着它 —— 正常流程下状态机和布局是同步改的，
    // 这里只是兜底：宁可显示一句「这个会话不在了」，也不要整片主区白屏
    if (session === undefined) return <MissingPane sessionId={node.sessionId} store={store} />;

    const workspace = state.workspaces.find((w) => w.id === session.workspaceId);
    return (
      <PaneFrame
        key={session.id}
        session={session}
        workspaceName={workspace?.name ?? ''}
        focused={session.id === state.focusedId}
        store={store}
      />
    );
  }

  return (
    <div
      className={`rd-agent-split is-${node.dir}`}
      data-testid={`agent-split-${node.dir}`}
      key={path.join('-')}
    >
      <div className="rd-agent-cell" style={{ flexGrow: node.ratio, flexBasis: 0 }}>
        {renderNode(node.a, [...path, 0], state, store)}
      </div>
      <Divider path={path} dir={node.dir} store={store} />
      <div className="rd-agent-cell" style={{ flexGrow: 1 - node.ratio, flexBasis: 0 }}>
        {renderNode(node.b, [...path, 1], state, store)}
      </div>
    </div>
  );
}

function Divider({
  path,
  dir,
  store,
}: {
  path: SplitPath;
  dir: SplitDir;
  store: AgentsStore;
}): ReactNode {
  const [dragging, setDragging] = useState(false);
  // 用 ref 而不是 state 判断「在不在拖」：pointermove 里读 state 会读到
  // 闭包捕获的旧值（这个组件在拖动过程中会被重渲染很多次）
  const active = useRef(false);

  const ratioFrom = (el: HTMLElement, clientX: number, clientY: number): number => {
    const parent = el.parentElement;
    if (parent === null) return 0.5;
    const rect = parent.getBoundingClientRect();
    if (dir === 'row') {
      return rect.width === 0 ? 0.5 : (clientX - rect.left) / rect.width;
    }
    return rect.height === 0 ? 0.5 : (clientY - rect.top) / rect.height;
  };

  return (
    <div
      className={`rd-agent-divider is-${dir}${dragging ? ' is-dragging' : ''}`}
      role="separator"
      aria-orientation={dir === 'row' ? 'vertical' : 'horizontal'}
      data-testid={`agent-divider-${path.join('-') || 'root'}`}
      onPointerDown={(e) => {
        // 抓住指针：拖出去（甚至拖出窗口）也要继续收到事件，
        // 否则鼠标一快就会「甩掉」分隔条
        e.currentTarget.setPointerCapture(e.pointerId);
        active.current = true;
        setDragging(true);
        e.preventDefault();
      }}
      onPointerMove={(e) => {
        if (!active.current) return;
        store.resize(path, ratioFrom(e.currentTarget, e.clientX, e.clientY));
      }}
      onPointerUp={(e) => {
        active.current = false;
        setDragging(false);
        e.currentTarget.releasePointerCapture(e.pointerId);
      }}
    />
  );
}

/** 布局里指着一个已经不存在的会话 */
function MissingPane({ sessionId, store }: { sessionId: string; store: AgentsStore }): ReactNode {
  return (
    <div className="rd-agent-pane rd-agent-pane-missing" data-testid={`agent-pane-missing-${sessionId}`}>
      <div className="rd-empty">这一格的会话已经关掉了</div>
      <button type="button" className="rd-btn" onClick={() => store.closePaneFor(sessionId)}>
        收掉这一格
      </button>
    </div>
  );
}

/** 主区空态。这里也是新用户看到的第一个界面，所以直接把「下一步做什么」写出来 */
function EmptyState({ state, store }: { state: AgentsState; store: AgentsStore }): ReactNode {
  if (state.workspaces.length === 0) {
    return (
      <div className="rd-agent-empty rd-empty" data-testid="agent-empty">
        <h2>还没有工作目录</h2>
        <p>先加一个本地文件夹，比如你的项目目录。</p>
        <p className="rd-muted">一个工作目录下面可以开好几个会话，比如一个 Claude Code、一个 Codex。</p>
        <button
          type="button"
          className="rd-btn rd-btn-primary"
          data-testid="agent-add-workspace-empty"
          onClick={() => void store.addWorkspace()}
        >
          选择文件夹
        </button>
      </div>
    );
  }

  const workspace = state.workspaces[0];
  if (workspace === undefined) return null;

  return (
    <div className="rd-agent-empty rd-empty" data-testid="agent-empty">
      <h2>屏幕上还没有会话</h2>
      <p>
        从左边「{workspace.name}」下面开一个，或者点下面这个按钮直接开一个 Claude Code。
      </p>
      <button
        type="button"
        className="rd-btn rd-btn-primary"
        data-testid="agent-new-session-empty"
        onClick={() => void store.createSession(workspace.id, 'claude')}
      >
        新建会话
      </button>
    </div>
  );
}
