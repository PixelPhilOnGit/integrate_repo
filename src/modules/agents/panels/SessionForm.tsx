/**
 * 右侧检查器：选中会话的详情，外加「状态检测」那张卡片。
 *
 * # 为什么状态检测放在这里
 *
 * 状态点不准的时候（装了没生效、配置被改过、事件目录读不了），用户第一件事
 * 是找「为什么」。答案全在这一块：装没装、装到哪个文件、最近一次收到事件是
 * 什么时候。**没有这块，一个永远显示「空闲」的界面对用户来说就是坏的**，
 * 而且他没有任何线索。
 */

import { useState, type ReactNode } from 'react';
import { clock, elapsed } from '../core/elapsed';
import { STATUS_LABEL, type AgentSession } from '../core/types';
import { statusLine } from '../core/status';
import type { AgentsState, AgentsStore } from '../state/store';
import { TARGET_LABEL } from '../services/integrate';
import type { IntegrationTarget } from '../services/types';
import { IntegrateDialog } from './IntegrateDialog';
import { StatusDot } from './StatusDot';

interface Props {
  state: AgentsState;
  store: AgentsStore;
  now: number;
}

const TARGETS: readonly IntegrationTarget[] = ['claude', 'codex'];

export function SessionForm({ state, store, now }: Props): ReactNode {
  const [dialog, setDialog] = useState<IntegrationTarget | null>(null);
  const session = state.sessions.find((s) => s.id === state.selectedId) ?? null;
  const workspace =
    session === null ? null : (state.workspaces.find((w) => w.id === session.workspaceId) ?? null);

  return (
    <>
      <div className="rd-panel" data-testid="agent-inspector">
        <div className="rd-panel-body">
          {session === null ? (
            <div className="rd-empty">点左边的一个会话，这里显示它的详情</div>
          ) : (
            <SessionDetail session={session} path={workspace?.path ?? ''} now={now} />
          )}

          <div className="rd-agent-section" data-testid="agent-integration">
            <h4 className="rd-agent-section-title">状态检测</h4>
            <p className="rd-hint">
              让 agent 在「干完了」和「需要你」的时候主动报一声。没有它的话，
              状态点只能靠终端输出猜，而那是猜不准的。
            </p>

            {TARGETS.map((target) => (
              <div className="rd-agent-int-row" key={target} data-testid={`agent-int-${target}`}>
                <span className="rd-agent-int-name">{TARGET_LABEL[target]}</span>
                <span
                  className={`rd-agent-int-state is-${state.integration[target]?.state ?? 'unknown'}`}
                  data-testid={`agent-int-state-${target}`}
                >
                  {store.integrationLabel(target)}
                </span>
                <button
                  type="button"
                  className="rd-btn"
                  data-testid={`agent-int-open-${target}`}
                  onClick={() => {
                    void store.refreshIntegration(target);
                    setDialog(target);
                  }}
                >
                  设置
                </button>
              </div>
            ))}

            <p className="rd-hint rd-muted" data-testid="agent-events-dir">
              事件目录：{state.eventsDir ?? '（还不知道）'}
            </p>
            <p className="rd-hint rd-muted">
              最近收到状态：{state.lastEventAt === null ? '还没有过' : elapsed(state.lastEventAt, now)}
            </p>
            {state.eventsError !== null && (
              // 安静但看得见：轮询一秒一次，弹错误条会把界面刷爆
              <p className="rd-danger" data-testid="agent-events-error">
                读不到事件目录：{state.eventsError}
              </p>
            )}
          </div>
        </div>
      </div>

      {dialog !== null && (
        <IntegrateDialog
          target={dialog}
          state={state}
          store={store}
          now={now}
          onClose={() => setDialog(null)}
        />
      )}
    </>
  );
}

function SessionDetail({
  session,
  path,
  now,
}: {
  session: AgentSession;
  path: string;
  now: number;
}): ReactNode {
  return (
    <div className="rd-agent-section" data-testid="agent-session-detail">
      <h3 className="rd-agent-detail-title" title={session.title}>
        {session.title}
      </h3>

      <div className="rd-agent-detail-status">
        <StatusDot status={session.status} />
        <span data-testid="agent-detail-line">{statusLine(session)}</span>
        <span className="rd-muted">{elapsed(session.statusAt, now)}</span>
      </div>

      <dl className="rd-agent-detail">
        <dt>启动命令</dt>
        <dd className="rd-mono">{session.command === '' ? '（只起一个 shell）' : session.command}</dd>
        <dt>工作目录</dt>
        <dd className="rd-mono" title={path}>
          {path}
        </dd>
        <dt>进程</dt>
        <dd>
          {session.status === 'exited'
            ? `已退出${session.exitCode === null ? '' : `（退出码 ${session.exitCode}）`}`
            : '运行中'}
        </dd>
      </dl>

      {session.history.length > 0 && (
        <>
          <h4 className="rd-agent-section-title">最近的状态变化</h4>
          <ul className="rd-agent-history" data-testid="agent-history">
            {session.history.map((h, i) => (
              <li key={`${h.at}-${i}`} className="rd-agent-history-item">
                <span className="rd-mono rd-muted">{clock(h.at)}</span>
                <span>{STATUS_LABEL[h.status]}</span>
                {h.detail !== null && <span className="rd-muted">{h.detail}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
