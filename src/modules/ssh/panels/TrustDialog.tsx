/**
 * 首次连接一台没见过的机器时，让用户拍板。
 *
 * # 这个弹窗是整个模块安全模型的落点
 *
 * SSH 的信任全建立在「这台机器的公钥是它本人」上，而第一次连接时我们**没有任何
 * 依据**判断这一点 —— 只能把指纹摆出来，让用户去和服务器管理员给的值比对。
 * 所以这个弹窗的文案刻意不写「是否继续？」，而是写清楚「你在确认什么、
 * 怎么确认」。一个让人直接点「确定」的弹窗等于没有这道防线。
 *
 * 它和「指纹变了」走的是**完全不同的两条路**（那个是硬停，见 ConnectionForm）。
 * 这里是信任的**起点**，那里是信任的**破裂** —— 混成一个弹窗会让用户在
 * 真正危险的时候以为自己只是又在连一台新机器。
 */

import { useEffect, type ReactNode } from 'react';
import type { SshState, SshStore } from '../state/store';

interface Props {
  state: SshState;
  store: SshStore;
}

export function TrustDialog({ state, store }: Props): ReactNode {
  const prompt = state.trustPrompt;

  // Escape 关掉。放在 effect 里而不是直接挂 onKeyDown：弹窗是条件渲染的，
  // 挂在 div 上要求它先拿到焦点，而焦点这会儿还在终端那个 textarea 里
  useEffect(() => {
    if (prompt === null) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        store.dismissTrustPrompt();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [prompt, store]);

  if (prompt === null) return null;

  const profile = store.profileById(prompt.profileId);

  return (
    <div className="rd-modal-backdrop" data-testid="ssh-trust-dialog">
      <div className="rd-modal" role="dialog" aria-modal="true" aria-labelledby="ssh-trust-title">
        <h2 className="rd-modal-title" id="ssh-trust-title">
          第一次连接 {prompt.host}:{prompt.port}
        </h2>

        <p className="rd-hint">
          这台机器的身份还没被确认过。它的主机密钥指纹是：
        </p>

        <p className="rd-ssh-fp-value rd-mono" data-testid="ssh-trust-fingerprint">
          {prompt.fingerprint}
        </p>

        <p className="rd-hint">
          密钥类型 <span className="rd-mono">{prompt.algorithm}</span>
        </p>

        <p className="rd-hint">
          请向服务器管理员核对上面这串字符（`ssh-keyscan` 也能印出来）。
          <strong>只有对得上才能继续。</strong>
          对不上的话，你连上的可能是别人的机器。
        </p>

        <p className="rd-hint">
          确认之后，我们会把这个指纹记下来；以后再连这台机器时如果对不上，
          就会直接停下并告警。
        </p>

        <div className="rd-modal-actions">
          <button
            type="button"
            data-testid="ssh-trust-cancel"
            onClick={() => store.dismissTrustPrompt()}
          >
            取消
          </button>
          <button
            type="button"
            className="rd-danger"
            data-testid="ssh-trust-accept"
            onClick={() => void store.trustAndReconnect()}
          >
            指纹对得上，信任并连接
          </button>
        </div>

        {profile && (
          <p className="rd-hint rd-muted">
            登录身份：{profile.username.trim()}@{profile.host.trim()}
          </p>
        )}
      </div>
    </div>
  );
}
