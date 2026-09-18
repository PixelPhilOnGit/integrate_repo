/**
 * 主区：标签栏 + 终端。
 *
 * # 这个组件**不创建终端**
 *
 * 终端实例归 `core/terminalHub.ts` 管，这里只做两件事：给 hub 一个宿主节点
 * （`<div ref>`），以及在切换标签时告诉 hub「挂这个 / 收起上一个」。
 *
 * 之所以不在这里 `new Terminal()`：切模块时 React 会把这个组件整个卸载，
 * 而终端**不能跟着销毁** —— 会话还在跑，画面也得留着。所以实例必须活在一个
 * 比 React 树更长的作用域里。见 hub 头部那段关于「藏起来而不是销毁」的说明。
 */

import { useEffect, useRef, type ReactNode } from 'react';
import { terminalHub } from '../core/terminalHub';
import type { SshSession } from '../core/types';
import type { SshState, SshStore } from '../state/store';

interface Props {
  state: SshState;
  store: SshStore;
}

export function TerminalPane({ state, store }: Props): ReactNode {
  const hostRef = useRef<HTMLDivElement>(null);
  const active = state.sessions.find((s) => s.id === state.activeSessionId) ?? null;
  const sessionId = active?.id ?? null;

  useEffect(() => {
    const host = hostRef.current;
    if (sessionId === null || host === null) return;

    terminalHub.attach(sessionId, host);
    // 切走（切标签、切模块）时挪到屏幕外，**不销毁** —— 会话还活着，
    // 回来时要看到原来的画面（vim 的备用屏幕、滚动位置都在）
    return () => {
      terminalHub.detach(sessionId);
    };
  }, [sessionId]);

  return (
    <div className="rd-ssh-main" data-testid="ssh-main">
      {/*
        ⚠️ **不要复用 `rd-tabs`。** 那个类是给 Redis/SQL 的「浏览 / 命令台」
        两格切换器用的，它有一条 `.rd-tabs button { flex: 1 }` —— 套到这里会让
        标签和那个 × 各占一半宽度，**点标签正中间会把标签关掉**。
        （实测：标签 157px 宽，label 78px、close 78px，正中心正好落在 × 上。）
      */}
      <div className="rd-ssh-tabs" role="tablist" data-testid="ssh-tabs">
        {state.sessions.map((session) => (
          <SessionTab
            key={session.id}
            session={session}
            active={session.id === sessionId}
            store={store}
          />
        ))}
      </div>

      {/*
        宿主节点**始终存在**，不用条件渲染。终端容器是 hub 直接 appendChild
        进来的，宿主一旦被 React 摘掉，容器就跟着离开 DOM —— 虽然随后会被
        挪到存放点，但中间那一小段它没有布局，xterm 量出来的尺寸是垃圾
      */}
      <div className="rd-ssh-term-host" ref={hostRef} data-testid="ssh-term-host" />

      {active === null && (
        <div className="rd-ssh-empty rd-empty">
          {state.profiles.length === 0
            ? '先在左边新建一个连接'
            : '点左边连接右边的「连接」按钮，或者右键选「新建标签页」'}
        </div>
      )}
    </div>
  );
}

function SessionTab({
  session,
  active,
  store,
}: {
  session: SshSession;
  active: boolean;
  store: SshStore;
}): ReactNode {
  const activate = (): void => store.setActiveSession(session.id);

  return (
    <div
      className={`rd-ssh-tab${active ? ' is-active' : ''}`}
      data-testid={`ssh-tab-${session.id}`}
      // 和侧栏一样：会话 id 是随机的，测试按标题选更稳
      data-session-title={session.title}
      data-session-status={session.status}
      // 点击处理挂在**外层**：标签左右有 padding，只挂在内层按钮上的话，
      // 点那几像素的空白就没反应 —— 用户会觉得「这个标签点不动」
      onClick={activate}
    >
      <button
        type="button"
        className="rd-ssh-tab-label"
        role="tab"
        aria-selected={active}
        onClick={(e) => {
          // 冒泡到外层会再调一次。两次调用是幂等的，但没必要
          e.stopPropagation();
          activate();
        }}
        title={session.title}
      >
        <span className={`rd-conn-dot is-${tabDotStatus(session)}`} aria-hidden="true" />
        <span className="rd-ssh-tab-text">{session.title}</span>
        {session.status === 'closed' && (
          <span className="rd-ssh-tab-end">
            {session.exitCode === null ? '已结束' : `退出码 ${session.exitCode}`}
          </span>
        )}
      </button>

      <button
        type="button"
        className="rd-ssh-tab-close"
        data-testid={`ssh-tab-close-${session.id}`}
        title={session.status === 'closed' ? '关掉这个标签' : '关闭终端（远端会话会结束）'}
        aria-label={`关闭 ${session.title}`}
        onClick={(e) => {
          // 别让关标签顺带把会话切成当前那个 —— 用户点的是 ×
          e.stopPropagation();
          void store.closeSession(session.id);
        }}
      >
        ×
      </button>
    </div>
  );
}

function tabDotStatus(session: SshSession): string {
  switch (session.status) {
    case 'open':
      return 'connected';
    case 'starting':
      return 'connecting';
    default:
      return 'idle';
  }
}
