/**
 * 右侧栏：编辑**当前选中的那份**模型配置。
 *
 * 配置名单在左侧（`AssistantProfileList`），这里编辑其中的一份 ——
 * 和连接类模块（侧栏列表 + 检查器编辑选中项）是同一个分工。
 *
 * ⚠️ **没有「保存」按钮**：改一个字段就落盘。理由见 `state/store.ts` 的头注释
 * —— 有了列表之后，「编辑中」和「已保存」两份状态会在切换配置时丢掉用户的半截
 * 改动。连接表单也是这个做法。
 */

import { useState, type ReactNode } from 'react';
import { PROVIDER_HINT, PROVIDER_LABEL, apiKeyId } from '../core/config';
import type { ProviderKind, ProviderProfile } from '../core/config';
import type { AssistantState, AssistantStore } from '../state/store';

interface Props {
  state: AssistantState;
  store: AssistantStore;
}

const KINDS: ProviderKind[] = ['anthropic', 'openai'];

export function AssistantInspector({ state, store }: Props): ReactNode {
  const [keyInput, setKeyInput] = useState('');
  const [replacing, setReplacing] = useState(false);

  const profile = store.selected();
  // 一份都没有：这个表单编辑的是「某一份」，没有就没得画。
  // 正常走不到（`load` 会兜一份），删光最后一份之后会到这儿。
  if (profile === null) {
    return (
      <div className="rd-panel rd-inspector" data-testid="assistant-inspector">
        <div className="rd-panel-head">
          <span>模型</span>
        </div>
        <div className="rd-panel-body">
          <p className="rd-hint" data-testid="assistant-no-profile">
            还没有模型配置 —— 在左边点「新建」加一份。
          </p>
        </div>
      </div>
    );
  }

  const problem = store.configProblem();
  const status = state.keyStatus;
  const configured = status?.configured ?? false;
  // 钥匙串不可用 ≠ 没配。前者要明说（key 存不住），后者只是还没填。
  const noKeychain = status !== null && !status.available;
  /** 改一个字段就落盘。 */
  const patch = (fields: Partial<Omit<ProviderProfile, 'id'>>): void => {
    void store.updateProfile(profile.id, fields);
  };

  return (
    <div className="rd-panel rd-inspector" data-testid="assistant-inspector">
      <div className="rd-panel-head">
        <span>模型</span>
      </div>
      <div className="rd-panel-body">
        <div className="rd-form">
          <label className="rd-field">
            <span>名字</span>
            <input
              data-testid="assistant-profile-name"
              type="text"
              value={profile.name}
              placeholder="比如「公司的 Anthropic」"
              onChange={(e) => patch({ name: e.target.value })}
            />
          </label>

          <label className="rd-field">
            <span>提供方</span>
            <select
              data-testid="assistant-kind"
              value={profile.kind}
              // ⚠️ 只传 `kind` —— `updateProfile` 会把地址和模型跟着换成
              // 那一家的默认值（「Anthropic 的地址 + openai 的模型名」
              // 不是一个有意义的组合）。
              onChange={(e) => patch({ kind: e.target.value as ProviderKind })}
            >
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {PROVIDER_LABEL[k]}
                </option>
              ))}
            </select>
          </label>

          <p className="rd-hint" data-testid="assistant-kind-hint">
            {PROVIDER_HINT[profile.kind]}
          </p>

          <label className="rd-field">
            <span>接口地址</span>
            <input
              data-testid="assistant-base-url"
              type="text"
              value={profile.baseUrl}
              placeholder="https://…"
              spellCheck={false}
              onChange={(e) => patch({ baseUrl: e.target.value })}
            />
          </label>

          <label className="rd-field">
            <span>模型</span>
            <input
              data-testid="assistant-model"
              type="text"
              value={profile.model}
              spellCheck={false}
              onChange={(e) => patch({ model: e.target.value })}
            />
          </label>

          {problem !== null && (
            <p className="rd-hint is-error" data-testid="assistant-config-error">
              {problem}
            </p>
          )}

          {state.notice !== null && (
            <p className="rd-hint" data-testid="assistant-notice">
              {state.notice}
            </p>
          )}

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
                  placeholder="sk-…"
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
            key 挂在<strong>这一份配置</strong>上（钥匙串条目{' '}
            <code>{apiKeyId(profile.id)}</code>），换一份配置就是各用各的
            —— 同一家要两把 key 就新建一份配置。key 只在系统钥匙串里，
            <strong>读不回来</strong> —— 只能换。
          </p>

          <hr className="rd-assistant-sep" />

          {/* ---------------------------------------------------- 测试连接 */}

          {/*
            ⚠️ 这个按钮存在的理由只有一个：**把「卡住」变成一句能读的话**。

            用户配好之后发消息、界面一直转圈、一个字都不报 —— 那是我们能给出的
            最糟的失败方式（他连「是网络还是 key」都无从判断）。这个按钮一次往返
            就能回答，而且**刻意不走对话那条通道**：走同一条路的话，
            「界面收不到事件」和「网络不通」会表现成同一个样子。

            它只要 30 秒（对话那条路的超时宽容得多），因为用户点它是为了立刻知道结果。
          */}
          <div className="rd-assistant-row">
            <button
              type="button"
              className="rd-btn"
              data-testid="assistant-test"
              disabled={state.testing}
              onClick={() => void store.testConnection()}
            >
              {state.testing ? '测试中…' : '测试连接'}
            </button>
            <span className="rd-hint">不问它问题，只握一次手</span>
          </div>

          {state.test !== null && (
            <p
              className={`rd-hint${state.test.ok ? '' : ' is-error'}`}
              data-testid="assistant-test-result"
              data-ok={state.test.ok ? 'yes' : 'no'}
            >
              {state.test.message}
              {state.test.reply !== '' && (
                <>
                  <br />
                  它回的是：<code>{state.test.reply}</code>
                </>
              )}
            </p>
          )}

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
