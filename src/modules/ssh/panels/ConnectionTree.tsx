/**
 * 左侧栏：连接 → 会话 的树。
 *
 * 和 Redis/SQL 那个「连接 → 库 → 表」的树是同一个形状，但**子节点是会话而不是
 * 服务端的结构** —— SSH 连上之后没有「库」这种东西可列，能列的就是你自己开的
 * 那几个终端。所以展开一个连接看到的是它的标签，点一下就切过去。
 *
 * 标签栏在主区顶部还有一份。两处都保留是有意的：侧栏那份回答「我有哪几个会话」，
 * 主区那份回答「这些会话谁是谁」。终端用户习惯了两种都在。
 */

import { useState, type ReactNode } from 'react';
import { ConnectionRow } from '../../../shared/connections/ConnectionRow';
import { ContextMenu, type MenuItem } from '../../../shared/ui/ContextMenu';
import { addressOf } from '../core/profile';
import type { SshProfile, SshSession } from '../core/types';
import type { SshState, SshStore } from '../state/store';

interface Props {
  state: SshState;
  store: SshStore;
}

interface OpenMenu {
  x: number;
  y: number;
  items: MenuItem[];
}

export function ConnectionTree({ state, store }: Props): ReactNode {
  const [menu, setMenu] = useState<OpenMenu | null>(null);

  return (
    <div className="rd-panel rd-conn-list" data-testid="ssh-conn-list">
      <div className="rd-panel-head">
        <span>连接</span>
        <button
          type="button"
          data-testid="ssh-btn-new"
          onClick={() => void store.createProfile()}
        >
          新建
        </button>
      </div>

      {state.profiles.length === 0 ? (
        <div className="rd-empty">还没有连接，点「新建」加一个</div>
      ) : (
        <div className="rd-panel-body">
          {state.profiles.map((profile) => (
            <ConnectionBranch
              key={profile.id}
              profile={profile}
              state={state}
              store={store}
              onMenu={setMenu}
            />
          ))}
        </div>
      )}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      )}
    </div>
  );
}

function ConnectionBranch({
  profile,
  state,
  store,
  onMenu,
}: {
  profile: SshProfile;
  state: SshState;
  store: SshStore;
  onMenu: (menu: OpenMenu) => void;
}): ReactNode {
  // ⚠️ 状态是**从会话列表推出来的**，不另存一份 —— 见 store 里 `statusOf` 的注释
  const status = store.statusOf(profile.id);
  const expanded = state.expanded[profile.id] === true;
  const sessions = store.sessionsOf(profile.id);
  const known = store.hostKeyFor(profile);

  const openMenu = (x: number, y: number): void => {
    const items: MenuItem[] = [
      {
        label: '新建标签页',
        disabled: !store.canConnect(profile),
        onSelect: () => {
          store.select(profile.id);
          void store.connect(profile.id);
        },
      },
    ];

    if (sessions.length > 0) {
      items.push({
        label: `关闭全部会话（${sessions.length}）`,
        onSelect: () => {
          for (const session of sessions) {
            void store.closeSession(session.id);
          }
        },
      });
    }

    if (known) {
      items.push({
        label: '忘记主机密钥',
        separatorBefore: true,
        onSelect: () => void store.forgetHost(profile.host, profile.port),
      });
    }

    items.push({
      label: '删除连接',
      danger: true,
      separatorBefore: true,
      onSelect: () => void store.deleteProfile(profile.id),
    });

    onMenu({ x, y, items });
  };

  return (
    <>
      <ConnectionRow
        id={profile.id}
        name={profile.name}
        address={addressOf(profile)}
        status={status}
        selected={state.selectedId === profile.id}
        expanded={expanded}
        onToggleExpand={() => store.toggleExpanded(profile.id)}
        onSelect={() => store.select(profile.id)}
        // 行右侧那个按钮是「新开一个终端」而不是「连接/断开」——
        // 多标签下「断开」是个说不清的操作（断哪一个？），
        // 而「再开一个」永远是明确的。要关就去标签上关
        onToggle={() => {
          store.select(profile.id);
          void store.connect(profile.id);
        }}
        onContextMenu={openMenu}
      />

      {expanded && (
        <div className="rd-db-list" data-testid={`ssh-sessions-${profile.id}`}>
          {sessions.length === 0 && <div className="rd-db-hint">还没有打开的终端</div>}
          {sessions.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              active={state.activeSessionId === session.id}
              store={store}
            />
          ))}
        </div>
      )}
    </>
  );
}

function SessionRow({
  session,
  active,
  store,
}: {
  session: SshSession;
  active: boolean;
  store: SshStore;
}): ReactNode {
  return (
    <button
      type="button"
      className={`rd-db-row rd-ssh-session${active ? ' is-active' : ''}`}
      data-testid={`ssh-session-${session.id}`}
      // 会话 id 是随机生成的，测试没法稳定地写选择器，
      // 所以另外挂两个可预期的属性（和 Redis 给库行挂 data-db 是同一个理由）
      data-session-title={session.title}
      data-session-status={session.status}
      onClick={() => {
        store.select(session.profileId);
        store.setActiveSession(session.id);
      }}
      title={sessionEndLabel(session) ?? session.title}
    >
      <span className={`rd-conn-dot is-${dotStatus(session)}`} aria-hidden="true" />
      <span className="rd-db-name">{session.title}</span>
      <span className="rd-db-count">{sessionEndLabel(session) ?? ''}</span>
    </button>
  );
}

/** 侧栏那个小圆点：会话的三种状态映射到共享组件认识的四种 */
function dotStatus(session: SshSession): string {
  switch (session.status) {
    case 'open':
      return 'connected';
    case 'starting':
      return 'connecting';
    default:
      return 'idle';
  }
}

/** 已经结束的会话在名字右边显示结局；还活着的不占位置 */
function sessionEndLabel(session: SshSession): string | null {
  if (session.status !== 'closed') return null;
  return session.exitCode === null ? '已结束' : `退出码 ${session.exitCode}`;
}
