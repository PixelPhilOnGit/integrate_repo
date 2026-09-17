/**
 * 右侧栏：选中连接的编辑表单。
 *
 * 和 Redis 那份结构一样，多了一个「引擎」选择 —— 它是 MySQL 和 PostgreSQL
 * 合在一个模块里之后唯一需要用户显式告诉我们的东西。
 */

import type { ReactNode } from 'react';
import { hasErrors, validateProfile } from '../core/profile';
import { KIND_LABEL, type SqlKind, type SqlProfile } from '../core/types';
import type { SqlState, SqlStore } from '../state/store';

interface Props {
  state: SqlState;
  store: SqlStore;
}

export function ConnectionForm({ state, store }: Props): ReactNode {
  const profile = store.selectedProfile();

  return (
    <div className="rd-panel rd-inspector" data-testid="sql-inspector">
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
  profile: SqlProfile;
  state: SqlState;
  store: SqlStore;
}): ReactNode {
  const runtime = state.runtime[profile.id];
  const errors = validateProfile(profile);
  const connected = runtime?.status === 'connected';

  const patch = (fields: Partial<SqlProfile>): void => {
    void store.updateProfile(profile.id, fields);
  };

  return (
    <div className="rd-form">
      <label className="rd-field">
        <span>引擎</span>
        <select
          data-testid="sql-kind"
          value={profile.kind}
          // 切引擎时默认端口/用户名跟着换（用户改过的字段不动）
          onChange={(e) => void store.switchKind(profile.id, e.target.value as SqlKind)}
        >
          {(Object.keys(KIND_LABEL) as SqlKind[]).map((kind) => (
            <option key={kind} value={kind}>
              {KIND_LABEL[kind]}
            </option>
          ))}
        </select>
      </label>

      <label className="rd-field">
        <span>名字</span>
        <input
          type="text"
          data-testid="sql-name"
          value={profile.name}
          onChange={(e) => patch({ name: e.target.value })}
        />
      </label>
      {errors.name && <p className="rd-hint is-error">{errors.name}</p>}

      <label className="rd-field">
        <span>主机</span>
        <input
          type="text"
          data-testid="sql-host"
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
          data-testid="sql-port"
          value={Number.isFinite(profile.port) ? profile.port : ''}
          onChange={(e) => patch({ port: Number(e.target.value) })}
        />
      </label>
      {errors.port && <p className="rd-hint is-error">{errors.port}</p>}

      <label className="rd-field">
        <span>库名{profile.kind === 'postgres' ? '' : '（可选）'}</span>
        <input
          type="text"
          data-testid="sql-database"
          spellCheck={false}
          value={profile.database}
          onChange={(e) => patch({ database: e.target.value })}
        />
      </label>
      {errors.database && <p className="rd-hint is-error">{errors.database}</p>}

      <label className="rd-field">
        <span>用户名</span>
        <input
          type="text"
          data-testid="sql-username"
          autoComplete="off"
          value={profile.username}
          onChange={(e) => patch({ username: e.target.value })}
        />
      </label>
      {errors.username && <p className="rd-hint is-error">{errors.username}</p>}

      <label className="rd-field">
        <span>密码（可选）</span>
        <input
          type="password"
          data-testid="sql-password"
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
          data-testid="btn-sql-conn-toggle"
          disabled={runtime?.status === 'connecting' || (!connected && hasErrors(errors))}
          onClick={() => void (connected ? store.disconnect(profile.id) : store.connect(profile.id))}
        >
          {runtime?.status === 'connecting' ? '连接中…' : connected ? '断开' : '连接'}
        </button>
        <button
          type="button"
          data-testid="btn-sql-conn-delete"
          onClick={() => void store.deleteProfile(profile.id)}
        >
          删除
        </button>
      </div>

      {runtime?.stale === true && (
        <p className="rd-hint" data-testid="sql-stale">
          连接参数改过了，要重新连接才生效。
        </p>
      )}

      {runtime?.error != null && (
        <p className="rd-hint is-error" data-testid="sql-conn-error">
          {runtime.error}
        </p>
      )}

      {connected && runtime?.server != null && (
        <p className="rd-hint" data-testid="sql-conn-info">
          已连接 {runtime.server.address} · {runtime.server.kind} {runtime.server.version}
        </p>
      )}
    </div>
  );
}
