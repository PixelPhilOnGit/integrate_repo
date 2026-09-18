/**
 * 集成向导：往 Claude Code / Codex 的配置里装「状态检测」。
 *
 * # 这个弹窗要回答三个问题
 *
 * 1. **你要改我哪个文件？** —— 把完整路径和具体改动摆出来，不藏在「一键优化」后面
 * 2. **改坏了怎么办？** —— 写之前先备份，界面上就有撤销
 * 3. **它会看到我什么东西？** —— 我们的脚本只往一个文件里写一行状态，
 *    不读对话、不上传任何东西。这件事必须说清楚：用户是在授权一个外挂程序
 *    往他的 agent 配置里塞钩子
 *
 * # 为什么不说「立即生效」
 *
 * Claude Code 的 hook 是**启动时快照**的，改完配置对已经在跑的会话不起作用，
 * 新会话也可能要用户在 `/hooks` 里过一下确认。所以文案写的是「新开的会话才会生效」——
 * 说成「已启用，马上就好」的话，用户会盯着一个永远不变的状态点怀疑是我们坏了。
 */

import { useEffect, type ReactNode } from 'react';
import { elapsed } from '../core/elapsed';
import type { AgentsState, AgentsStore } from '../state/store';
import { TARGET_LABEL } from '../services/integrate';
import type { IntegrationTarget } from '../services/types';

interface Props {
  target: IntegrationTarget;
  state: AgentsState;
  store: AgentsStore;
  now: number;
  onClose: () => void;
}

export function IntegrateDialog({ target, state, store, now, onClose }: Props): ReactNode {
  // Escape 关闭。挂 window 而不是 div：弹窗是条件渲染的，
  // 这会儿键盘焦点还在终端那个 textarea 里
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const status = state.integration[target];
  const label = TARGET_LABEL[target];
  const installed = status?.state === 'installed' || status?.state === 'modified';
  const unusable = status?.state === 'unusable';

  return (
    <div className="rd-modal-backdrop" data-testid="agent-integrate-dialog">
      <div className="rd-modal" role="dialog" aria-modal="true" aria-labelledby="agent-int-title">
        <h2 className="rd-modal-title" id="agent-int-title">
          让 Devtoolkit 知道 {label} 的状态
        </h2>

        <p className="rd-hint">
          {label} 干完一件事、或者停下来等你确认的时候，本身不会告诉任何人。
          我们往它的配置里加一个小钩子：<strong>它自己</strong>会在这些时刻
          往一个文件里写一行字，我们读那个文件，于是界面上那些状态点就活了。
        </p>

        <p className="rd-hint">要改的文件：</p>
        <p className="rd-mono rd-agent-int-path" data-testid="agent-int-path">
          {status?.path ?? '（还不知道）'}
        </p>

        <p className="rd-hint">改动内容：</p>
        <pre className="rd-agent-preview rd-mono" data-testid="agent-int-preview">
          {status?.preview ?? ''}
        </pre>

        {unusable && (
          <p className="rd-danger" data-testid="agent-int-unusable">
            {status?.preview}
          </p>
        )}

        <p className="rd-hint">
          ⚠️ <strong>新开的会话才会生效</strong> —— 已经在跑的那些，它的钩子是在启动时
          定下来的。如果 {label} 提示你有新的钩子要确认，去它的 <code>/hooks</code> 里过一下。
        </p>

        <p className="rd-hint rd-muted">
          我们的脚本只写一行状态，不读你的对话、不联网、也不上传任何东西。
          改动前会先备份，下面的「撤销」可以还原。
        </p>

        <p className="rd-hint rd-muted" data-testid="agent-int-last-event">
          最近收到状态事件：{state.lastEventAt === null ? '还没有过' : elapsed(state.lastEventAt, now)}
        </p>

        <div className="rd-modal-actions">
          <button type="button" data-testid="agent-int-close" onClick={onClose}>
            关闭
          </button>
          {installed && (
            <button
              type="button"
              className="rd-danger"
              data-testid="agent-int-revert"
              disabled={state.integrating}
              onClick={() => void store.revertIntegration(target)}
            >
              撤销
            </button>
          )}
          {!installed && !unusable && (
            <button
              type="button"
              className="rd-btn-primary"
              data-testid="agent-int-apply"
              disabled={state.integrating}
              onClick={() => void store.applyIntegration(target)}
            >
              {state.integrating ? '正在写入…' : `启用 ${label} 的状态检测`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
