/**
 * 右侧栏：模型配置。
 *
 * 用 Inspector 而不是模态框 —— 和别的模块同一个理由：外壳本来就给了这个槽位，
 * 模态框还要自己管焦点、Esc、点遮罩，而且会挡住主区域。
 */

import { useState, type ReactNode } from 'react';
import { PROVIDER_HINT, PROVIDER_LABEL, apiKeyId } from '../core/config';
import type { ProviderKind } from '../core/config';
import type { AssistantState, AssistantStore } from '../state/store';

interface Props {
  state: AssistantState;
  store: AssistantStore;
}

const KINDS: ProviderKind[] = ['anthropic', 'openai'];

export function AssistantInspector({ state, store }: Props): ReactNode {
  const [keyInput, setKeyInput] = useState('');
  const [replacing, setReplacing] = useState(false);

  const problem = store.configProblem();
  const dirty = store.isDirty();
  const status = state.keyStatus;
  const configured = status?.configured ?? false;
  // 钥匙串不可用 ≠ 没配。前者要明说（key 存不住），后者只是还没填。
  const noKeychain = status !== null && !status.available;

  return (
    <div className="rd-panel rd-inspector" data-testid="assistant-inspector">
      <div className="rd-panel-head">
        <span>模型</span>
      </div>
      <div className="rd-panel-body">
        <div className="rd-form">
          <label className="rd-field">
            <span>提供方</span>
            <select
              data-testid="assistant-kind"
              value={state.config.kind}
              onChange={(e) => store.setKind(e.target.value as ProviderKind)}
            >
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {PROVIDER_LABEL[k]}
                </option>
              ))}
            </select>
          </label>

          <p className="rd-hint" data-testid="assistant-kind-hint">
            {PROVIDER_HINT[state.config.kind]}
          </p>

          <label className="rd-field">
            <span>接口地址</span>
            <input
              data-testid="assistant-base-url"
              type="text"
              value={state.config.baseUrl}
              placeholder="https://…"
              spellCheck={false}
              onChange={(e) => store.setBaseUrl(e.target.value)}
            />
          </label>

          <label className="rd-field">
            <span>模型</span>
            <input
              data-testid="assistant-model"
              type="text"
              value={state.config.model}
              spellCheck={false}
              onChange={(e) => store.setModel(e.target.value)}
            />
          </label>

          {problem !== null && (
            <p className="rd-hint is-error" data-testid="assistant-config-error">
              {problem}
            </p>
          )}

          <div className="rd-assistant-row">
            <button
              type="button"
              className="rd-btn"
              data-testid="assistant-save-config"
              disabled={!dirty}
              onClick={() => void store.saveConfig()}
            >
              {dirty ? '保存' : '已保存'}
            </button>
            {state.notice !== null && (
              <span className="rd-hint" data-testid="assistant-notice">
                {state.notice}
              </span>
            )}
          </div>

          <hr className="rd-assistant-sep" />

          {/* ---------------------------------------------------------- key */}

          <div className="rd-field">
            <span>API key</span>
            <span className="rd-hint" data-testid="assistant-key-status">
              {status === null
                ? '…'
                : configured
                  ? '已配置'
                  : noKeychain
                    ? '没配（而且这台机器上没有钥匙串）'
                    : '还没配'}
            </span>
          </div>

          {noKeychain && (
            <p className="rd-hint is-error" data-testid="assistant-no-keychain">
              这台机器上没有可用的钥匙串，key 存不住 ——
              桌面端要有系统凭据服务（Windows 凭据管理器 / macOS 钥匙串 / Linux Secret Service）。
            </p>
          )}

          {(configured && !replacing) ? (
            <div className="rd-assistant-row">
              <button
                type="button"
                className="rd-btn"
                data-testid="assistant-key-replace"
                onClick={() => {
                  setReplacing(true);
                  setKeyInput('');
                }}
              >
                换一把
              </button>
              <button
                type="button"
                className="rd-btn"
                data-testid="assistant-key-clear"
                disabled={state.savingKey}
                onClick={() => void store.clearApiKey()}
              >
                删除
              </button>
            </div>
          ) : (
            <>
              <label className="rd-field">
                <span>key</span>
                <input
                  data-testid="assistant-key-input"
                  type="password"
                  value={keyInput}
                  placeholder={apiKeyId(state.config.kind)}
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(e) => setKeyInput(e.target.value)}
                />
              </label>
              <div className="rd-assistant-row">
                <button
                  type="button"
                  className="rd-btn"
                  data-testid="assistant-key-save"
                  disabled={state.savingKey || keyInput.trim() === ''}
                  onClick={() => {
                    void store.saveApiKey(keyInput).then(() => {
                      setKeyInput('');
                      setReplacing(false);
                    });
                  }}
                >
                  {state.savingKey ? '保存中…' : '保存 key'}
                </button>
                {configured && (
                  <button
                    type="button"
                    className="rd-btn"
                    data-testid="assistant-key-cancel"
                    onClick={() => {
                      setReplacing(false);
                      setKeyInput('');
                    }}
                  >
                    取消
                  </button>
                )}
              </div>
            </>
          )}

          <p className="rd-hint">
            两家各存一把（当前是 <code>{apiKeyId(state.config.kind)}</code>），
            来回切不会互相覆盖。key 只在系统钥匙串里，<strong>读不回来</strong> —— 只能换。
          </p>

          {state.error !== null && (
            <p className="rd-hint is-error" data-testid="assistant-error">
              {state.error}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
