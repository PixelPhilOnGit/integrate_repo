/**
 * 首次连一台远端机器时核对主机密钥的弹窗（TOFU）。
 *
 * # 为什么必须有它
 *
 * 远端会话的状态检测本来就是这个模块里最弱的一环（远端写不了我们的钩子，
 * 只剩 OSC 和键盘两条路）。**指纹核对是那条路上唯一的安全决策** ——
 * 没有它，用户第一次连自己的机器时，中间人可以任意冒充那台机器，
 * 而我们连提示都没有。
 *
 * # 两条和 SSH 模块一致、但不显然的规矩
 *
 * 1. **指纹变了不给「就这样继续」**。那是中间人最典型的信号，
 *    把「继续」做成一键可达，等于在最危险的时候给了最顺手的按钮。
 *    用户确认服务器真的重装过之后，去右键菜单「忘记这台机器的指纹」再连。
 * 2. **信任是一次性的**（`store.trustHost` 只对**这一次连接**放行）——
 *    它不是「这台机器以后随便连」，而是「这一次我核对过了」。
 */

import type { ReactNode } from 'react';
import type { TrustPrompt } from '../state/store';
import type { AgentsStore } from '../state/store';

interface Props {
  prompt: TrustPrompt;
  store: AgentsStore;
}

export function TrustDialog({ prompt, store }: Props): ReactNode {
  const mismatch = prompt.expected !== null;

  return (
    <div className="rd-modal-backdrop" data-testid="agent-trust">
      <div className="rd-modal" role="dialog" aria-modal="true">
        <h3>{mismatch ? '⚠️ 这台机器的密钥变了' : '第一次连这台机器'}</h3>

        {mismatch ? (
          <p className="rd-danger">
            它现在给的密钥和上次记住的**不一样**。这可能是服务器重装过，
            也可能有人在中间冒充它 —— **在你确认之前不要继续**。
          </p>
        ) : (
          <p>
            没见过这台机器。核对一下指纹是不是它的（可以在那台机器上跑
            <code>ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</code> 看）。
          </p>
        )}

        <dl className="rd-agent-fingerprint">
          {prompt.algorithm !== '' && (
            <>
              <dt>算法</dt>
              <dd>{prompt.algorithm}</dd>
            </>
          )}
          <dt>{mismatch ? '它现在给的' : '指纹'}</dt>
          <dd data-testid="agent-trust-fingerprint">{prompt.fingerprint}</dd>
          {mismatch && prompt.expected !== null && (
            <>
              <dt>上次记住的</dt>
              <dd data-testid="agent-trust-expected">{prompt.expected}</dd>
            </>
          )}
        </dl>

        <div className="rd-modal-actions">
          <button
            type="button"
            className="rd-btn"
            data-testid="agent-trust-cancel"
            onClick={() => store.dismissTrust()}
          >
            取消
          </button>
          {/*
            ⚠️ **指纹变了的时候不给「信任」** —— 那是中间人最典型的信号，
            把「继续」做成一键可达等于在最危险的时候给最顺手的按钮。
            要重连得先去右键菜单「忘记这台机器的指纹」。
          */}
          {!mismatch && (
            <button
              type="button"
              className="rd-btn rd-btn-primary"
              data-testid="agent-trust-accept"
              onClick={() => void store.trustHost()}
            >
              信任这台机器
            </button>
          )}
        </div>

        {mismatch && (
          <p className="rd-hint rd-muted">
            确认那台机器确实重装过之后，去工作目录上右键「忘记这台机器的指纹」，
            下次连它会重新问一遍。
          </p>
        )}
      </div>
    </div>
  );
}
