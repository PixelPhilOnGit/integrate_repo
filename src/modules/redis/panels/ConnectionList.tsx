/**
 * 左侧栏：连接列表。
 *
 * 一行 = 状态点 + 名字 + `host:port/db` + 连接/断开按钮。
 * 点整行是「选中」（选中项同时是 Inspector 的编辑对象和命令台的目标）。
 */

import type { ReactNode } from 'react';
import type { ConnStatus, ConnectionProfile } from '../core/types';
import type { RedisState, RedisStore } from '../state/store';

interface Props {
  state: RedisState;
  store: RedisStore;
}

export function ConnectionList({ state, store }: Props): ReactNode {
  return (
    <div className="rd-panel rd-conn-list" data-testid="conn-list">
      <div className="rd-panel-head">
        <span>连接</span>
        <button
          type="button"
          data-testid="btn-new-connection"
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
            <ConnectionRow
              key={profile.id}
              profile={profile}
              status={state.runtime[profile.id]?.status ?? 'idle'}
              selected={state.selectedId === profile.id}
              store={store}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface RowProps {
  profile: ConnectionProfile;
  status: ConnStatus;
  selected: boolean;
  store: RedisStore;
}

function ConnectionRow({ profile, status, selected, store }: RowProps): ReactNode {
  const connected = status === 'connected';

  return (
    <div
      className={`rd-conn-row${selected ? ' is-selected' : ''}`}
      data-testid={`conn-${profile.id}`}
      data-conn-name={profile.name}
      data-status={status}
      onClick={() => store.select(profile.id)}
    >
      <span
        className={`rd-conn-dot is-${status}`}
        data-testid={`conn-dot-${profile.id}`}
        title={statusLabel(status)}
      />

      <span className="rd-conn-text">
        <span className="rd-conn-name">{profile.name}</span>
        <span className="rd-conn-addr">
          {profile.host}:{profile.port}
          {profile.db !== 0 ? `/${profile.db}` : ''}
        </span>
      </span>

      <button
        type="button"
        className="rd-conn-toggle"
        data-testid={`conn-toggle-${profile.id}`}
        disabled={status === 'connecting'}
        title={connected ? '断开' : '连接'}
        onClick={(e) => {
          // 别让点按钮顺带把选中也切了 —— 用户可能只是想连一下另一个连接
          e.stopPropagation();
          void (connected ? store.disconnect(profile.id) : store.connect(profile.id));
        }}
      >
        {status === 'connecting' ? '…' : connected ? '断开' : '连接'}
      </button>
    </div>
  );
}

function statusLabel(status: ConnStatus): string {
  switch (status) {
    case 'connected':
      return '已连接';
    case 'connecting':
      return '连接中';
    case 'error':
      return '连接出错';
    default:
      return '未连接';
  }
}
