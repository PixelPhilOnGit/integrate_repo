/**
 * 右侧检查器：编辑当前选中的连接。
 *
 * 和 Redis/SQL 一样，表单**直接改档案本身**，没有「草稿 → 保存」这一步 ——
 * 每一键都写进 store，也写回磁盘。少一个「改了没保存」的状态，
 * 就少一整类「我明明改了啊」的问题。
 *
 * 这里也是**连接失败的落点**：连不上、认证被拒、指纹变了都显示在表单下面，
 * 而不是弹外壳的错误条 —— 它们回答的是「这个连接的参数哪里不对」，
 * 摆在参数旁边才找得到。这条和另外两个连接类模块是一致的。
 */

import type { ReactNode } from 'react';
import { platform } from '../../../shared/platform';
import { AUTH_LABEL, type SshAuthKind } from '../core/types';
import { applyAuthKindSwitch, hasErrors, validateProfile } from '../core/profile';
import type { SshProfile } from '../core/types';
import type { SshState, SshStore } from '../state/store';

interface Props {
  state: SshState;
  store: SshStore;
}

export function ConnectionForm({ state, store }: Props): ReactNode {
  const profile = store.selectedProfile();

  return (
    <div className="rd-panel rd-inspector" data-testid="ssh-inspector">
      <div className="rd-panel-head">
        <span>连接设置</span>
      </div>

      {profile === null ? (
        <div className="rd-empty">在左边选一个连接来编辑它</div>
      ) : (
        <Form profile={profile} state={state} store={store} />
      )}
    </div>
  );
}

function Form({
  profile,
  state,
  store,
}: {
  profile: SshProfile;
  state: SshState;
  store: SshStore;
}): ReactNode {
  // 每次渲染现算，不缓存 —— 校验规则只有一处，改了这里就跟着变
  const errors = validateProfile(profile);
  const runtime = state.runtime[profile.id];
  const mismatch = state.mismatch[profile.id];
  const known = store.hostKeyFor(profile);
  const sessions = store.sessionsOf(profile.id);
  const busy = sessions.some((s) => s.status === 'starting');

  const patch = (next: Partial<SshProfile>): void => {
    void store.updateProfile(profile.id, next);
  };

  const browse = async (): Promise<void> => {
    const picked = await platform.pickFile('选择私钥文件');
    if (picked !== null) patch({ privateKeyPath: picked });
  };

  return (
    <div className="rd-panel-body">
      <div className="rd-form">
        <label className="rd-field">
          <span>名字</span>
          <input
            value={profile.name}
            data-testid="ssh-field-name"
            onChange={(e) => patch({ name: e.target.value })}
          />
          {errors.name && <p className="rd-hint is-error">{errors.name}</p>}
        </label>

        <label className="rd-field">
          <span>主机</span>
          <input
            value={profile.host}
            data-testid="ssh-field-host"
            placeholder="127.0.0.1"
            onChange={(e) => patch({ host: e.target.value })}
          />
          {errors.host && <p className="rd-hint is-error">{errors.host}</p>}
        </label>

        <label className="rd-field">
          <span>端口</span>
          <input
            value={String(profile.port)}
            data-testid="ssh-field-port"
            inputMode="numeric"
            onChange={(e) => {
              const raw = e.target.value.trim();
              // 空串不能直接 Number() 成 0 —— 那样边删边打字的时候会一路报
              // 「端口要在 1–65535 之间」，很吵。留空就按 0 存，校验会提示
              patch({ port: raw === '' ? 0 : Number(raw) });
            }}
          />
          {errors.port && <p className="rd-hint is-error">{errors.port}</p>}
        </label>

        <label className="rd-field">
          <span>用户名</span>
          <input
            value={profile.username}
            data-testid="ssh-field-username"
            onChange={(e) => patch({ username: e.target.value })}
          />
          {errors.username && <p className="rd-hint is-error">{errors.username}</p>}
        </label>

        <label className="rd-field">
          <span>认证方式</span>
          <select
            value={profile.authKind}
            data-testid="ssh-field-auth"
            onChange={(e) =>
              void store.updateProfile(
                profile.id,
                // 换认证方式会**清掉另一边的凭据**，见 applyAuthKindSwitch 的注释
                applyAuthKindSwitch(profile, e.target.value as SshAuthKind),
              )
            }
          >
            {(Object.keys(AUTH_LABEL) as SshAuthKind[]).map((kind) => (
              <option key={kind} value={kind}>
                {AUTH_LABEL[kind]}
              </option>
            ))}
          </select>
        </label>

        {profile.authKind === 'password' ? (
          <label className="rd-field">
            <span>密码</span>
            <input
              type="password"
              value={profile.password}
              data-testid="ssh-field-password"
              onChange={(e) => patch({ password: e.target.value })}
            />
            {errors.password && <p className="rd-hint is-error">{errors.password}</p>}
          </label>
        ) : (
          <>
            <label className="rd-field">
              <span>私钥文件</span>
              <div className="rd-ssh-pick">
                <input
                  value={profile.privateKeyPath}
                  data-testid="ssh-field-key"
                  placeholder="~/.ssh/id_ed25519"
                  onChange={(e) => patch({ privateKeyPath: e.target.value })}
                />
                <button type="button" data-testid="ssh-btn-browse" onClick={() => void browse()}>
                  浏览…
                </button>
              </div>
              {errors.privateKeyPath && (
                <p className="rd-hint is-error">{errors.privateKeyPath}</p>
              )}
            </label>

            <label className="rd-field">
              <span>私钥口令</span>
              <input
                type="password"
                value={profile.passphrase}
                data-testid="ssh-field-passphrase"
                placeholder="没有口令就留空"
                onChange={(e) => patch({ passphrase: e.target.value })}
              />
            </label>
          </>
        )}

        <button
          type="button"
          className="rd-ssh-connect"
          data-testid="ssh-btn-connect"
          disabled={busy || hasErrors(errors)}
          onClick={() => {
            store.select(profile.id);
            void store.connect(profile.id);
          }}
        >
          {busy ? '连接中…' : '新建标签页'}
        </button>

        {/* ---------------------------------------------------- 状态提示 */}

        {runtime?.stale === true && (
          <p className="rd-hint" data-testid="ssh-stale">
            连接参数改过了。已经开着的终端还是旧参数，新开一个标签页才会生效。
          </p>
        )}

        {runtime?.error != null && (
          <p className="rd-hint is-error" data-testid="ssh-conn-error">
            {runtime.error}
          </p>
        )}

        {mismatch && (
          <div className="rd-ssh-warn" data-testid="ssh-mismatch">
            <strong>主机密钥和上次不一样了</strong>
            <p className="rd-hint">
              这可能意味着服务器重装了系统，也可能意味着有人在中间冒充它。
              协议上这两种情况分不出来 —— 请先向服务器管理员核对指纹。
            </p>
            <dl className="rd-ssh-fp">
              <dt>上次</dt>
              <dd className="rd-mono">{mismatch.expected}</dd>
              <dt>这次</dt>
              <dd className="rd-mono">{mismatch.actual}</dd>
            </dl>
            <p className="rd-hint">
              确认服务器确实换过密钥之后，才能
              <button
                type="button"
                className="rd-ssh-link"
                data-testid="ssh-btn-forget"
                onClick={() => void store.forgetAndReconnect(profile.id)}
              >
                忘记这台主机并重连
              </button>
              。在那之前连不上去，这是故意的。
            </p>
          </div>
        )}

        {runtime?.status === 'connected' && runtime.server !== null && (
          <div className="rd-hint" data-testid="ssh-conn-info">
            <p>
              已连接 {runtime.server.username}@{runtime.server.address}
            </p>
            <p>
              主机密钥 <span className="rd-mono">{runtime.server.algorithm}</span>
            </p>
            <p className="rd-mono rd-ssh-fp-line">{runtime.server.fingerprint}</p>
          </div>
        )}

        {known !== null && runtime?.status !== 'connected' && (
          <p className="rd-hint rd-mono" data-testid="ssh-known-host">
            已信任 {known.fingerprint}
          </p>
        )}
      </div>
    </div>
  );
}
