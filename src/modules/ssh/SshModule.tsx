/**
 * SSH 模块的各个槽位。
 *
 * 外壳只认 `Module` 接口，它把这些组件填进去：
 *   Sidebar（左） / Main（中） / Inspector（右） / StatusItems（状态栏右侧）
 *
 * 和 Redis 一样**没有 Toolbar** —— 标签栏是主区的一部分（它在终端上面而不是
 * 横跨整个内容区），所以不需要外壳那个通栏槽位。
 */

import { useSyncExternalStore, type ReactNode } from 'react';
import { ConnectionForm } from './panels/ConnectionForm';
import { ConnectionTree } from './panels/ConnectionTree';
import { TerminalPane } from './panels/TerminalPane';
import { TrustDialog } from './panels/TrustDialog';
import { sshStore } from './state/store';

/** 订阅模块自己的 store。外壳不掺和模块的状态 */
function useSsh() {
  const state = useSyncExternalStore(sshStore.subscribe, sshStore.getSnapshot);
  return { state };
}

export function SshSidebar(): ReactNode {
  const { state } = useSsh();
  return <ConnectionTree state={state} store={sshStore} />;
}

export function SshMain(): ReactNode {
  const { state } = useSsh();
  return (
    <>
      <TerminalPane state={state} store={sshStore} />
      {/*
        TOFU 弹窗挂在主区：它是**一次连接过程的**中间状态，和当前在看哪个标签
        无关，所以不适合塞进某个面板里。渲染成覆盖整屏的层（见 .rd-modal-backdrop）
      */}
      <TrustDialog state={state} store={sshStore} />
    </>
  );
}

export function SshInspector(): ReactNode {
  const { state } = useSsh();
  return <ConnectionForm state={state} store={sshStore} />;
}

/** 状态栏右侧：当前会话、远端身份、终端尺寸 */
export function SshStatusItems(): ReactNode {
  const { state } = useSsh();
  const session = state.sessions.find((s) => s.id === state.activeSessionId) ?? null;
  const profile = session === null ? sshStore.selectedProfile() : sshStore.profileById(session.profileId);

  if (session === null || profile === null) {
    const count = state.sessions.length;
    return (
      <span className="rd-muted" data-testid="ssh-status">
        {count === 0 ? '没有终端' : `${count} 个终端`}
      </span>
    );
  }

  return (
    <>
      <span className="rd-muted" data-testid="ssh-status">
        {profile.username.trim()}@{profile.host.trim()}:{profile.port} · {statusText(session.status)}
      </span>
      {/* 尺寸只在活着的会话上有意义 —— 已经退出的那个数字是历史，显示出来只会误导 */}
      {session.status === 'open' && (
        <span className="rd-muted" data-testid="ssh-status-size">
          {session.cols}×{session.rows}
        </span>
      )}
      {session.status === 'closed' && (
        <span className="rd-muted" data-testid="ssh-status-exit">
          {session.exitCode === null ? '已结束' : `退出码 ${session.exitCode}`}
        </span>
      )}
    </>
  );
}

function statusText(status: string): string {
  switch (status) {
    case 'open':
      return '已连接';
    case 'starting':
      return '连接中';
    default:
      return '已结束';
  }
}
