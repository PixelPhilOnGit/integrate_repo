/**
 * 右侧栏：选中连接的编辑表单。
 *
 * 用 Inspector 而不是弹模态框：外壳本来就提供了这个槽位，模态框还要自己管
 * 焦点、Esc、点击遮罩这些事，而且会挡住下面的命令台 —— 用户一边看图一边改参数
 * 是很常见的。
 */

import type { ReactNode } from 'react';
import { hasErrors, validateProfile } from '../core/profile';
import type { ConnectionProfile } from '../core/types';
import type { RedisState, RedisStore } from '../state/store';

interface Props {
  state: RedisState;
  store: RedisStore;
}

export function ConnectionForm({ state, store }: Props): ReactNode {
  const profile = store.selectedProfile();

  return (
    <div className="rd-panel rd-inspector" data-testid="conn-inspector">
      <div className="rd-panel-head">
        <span>连接属性</span>
      </div>
      <div className="rd-panel-body">
        {profile === null ? (
          <div className="rd-form">
            <p className="rd-hint">在左边选一个连接来编辑它。</p>
          </div>
        ) : (
          <Form profile={profile} state={state} store={store} />
        )}
      </div>
    </div>
  );
}

function Form({
  profile,
  state,
  store,
}: {
  profile: ConnectionProfile;
  state: RedisState;
  store: RedisStore;
}): ReactNode {
  const runtime = state.runtime[profile.id];
  const errors = validateProfile(profile);
  const connected = runtime?.status === 'connected';

  // 只改名字不算改连接参数；改了 host/port/密码这些才提示要重连
  const patch = (fields: Partial<ConnectionProfile>): void => {
    void store.updateProfile(profile.id, fields);
  };

  return (
    <div className="rd-form">
      <label className="rd-field">
        <span>名字</span>
        <input
          type="text"
          data-testid="conn-name"
          value={profile.name}
          onChange={(e) => patch({ name: e.target.value })}
        />
      </label>
      {errors.name && <p className="rd-hint is-error">{errors.name}</p>}

      <label className="rd-field">
        <span>主机</span>
        <input
          type="text"
          data-testid="conn-host"
          spellCheck={false}
          value={profile.host}
          onChange={(e) => patch({ host: e.target.value })}
        />
      </label>
      {errors.host && <p className="rd-hint is-error">{errors.host}</p>}

      <label className="rd-field">
        <span>端口</span>
        <input
          type="number"
          data-testid="conn-port"
          value={Number.isFinite(profile.port) ? profile.port : ''}
          onChange={(e) => patch({ port: Number(e.target.value) })}
        />
      </label>
      {errors.port && <p className="rd-hint is-error">{errors.port}</p>}

      <label className="rd-field">
        <span>库号</span>
        <input
          type="number"
          data-testid="conn-db"
          value={Number.isFinite(profile.db) ? profile.db : ''}
          onChange={(e) => patch({ db: Number(e.target.value) })}
        />
      </label>
      {errors.db && <p className="rd-hint is-error">{errors.db}</p>}

      <label className="rd-field">
        <span>用户名（可选）</span>
        <input
          type="text"
          data-testid="conn-username"
          autoComplete="off"
          value={profile.username}
          onChange={(e) => patch({ username: e.target.value })}
        />
      </label>

      <label className="rd-field">
        <span>密码（可选）</span>
        <input
          type="password"
          data-testid="conn-password"
          autoComplete="off"
          value={profile.password}
          onChange={(e) => patch({ password: e.target.value })}
        />
      </label>
      {/* 这是明确知情的妥协，直接写在用户看得见的地方，别只藏在代码注释里 */}
      <p className="rd-hint">
        密码以明文保存在本机配置文件里（待接入系统钥匙串）。共用电脑上别填生产库密码。
      </p>

      <div className="rd-conn-actions">
        <button
          type="button"
          data-testid="btn-conn-toggle"
          disabled={runtime?.status === 'connecting' || (!connected && hasErrors(errors))}
          onClick={() => void (connected ? store.disconnect(profile.id) : store.connect(profile.id))}
        >
          {runtime?.status === 'connecting' ? '连接中…' : connected ? '断开' : '连接'}
        </button>
        <button
          type="button"
          data-testid="btn-conn-delete"
          onClick={() => void store.deleteProfile(profile.id)}
        >
          删除
        </button>
      </div>

      {runtime?.stale && (
        <p className="rd-hint" data-testid="conn-stale">
          连接参数改过了，要重新连接才生效。
        </p>
      )}

      {runtime?.error && (
        <p className="rd-hint is-error" data-testid="conn-error">
          {runtime.error}
        </p>
      )}

      {runtime?.status === 'connected' && runtime.server && (
        <p className="rd-hint" data-testid="conn-info">
          已连接 {runtime.server.address}
          {runtime.server.version ? ` · Redis ${runtime.server.version}` : ''}
        </p>
      )}
    </div>
  );
}
