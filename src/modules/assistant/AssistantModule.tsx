/**
 * 助手模块的各个槽位。
 *
 * 三块：**模型配置**（右侧检查器）、**对话**（主区域）、**角标**。
 *
 * 对话是「说一句话 → 看它读文件 / 改文件 / 跑命令 → 要动你的东西时先问你」。
 * 审批那块界面（`ApprovalSheet`）是这个模块最要紧的东西 —— 见它的注释。
 */

import { useState, useSyncExternalStore, type ReactNode } from 'react';
import { basename, platform } from '../../shared/platform';
import { PROVIDER_LABEL, validateConfig } from './core/config';
import { assistantStore } from './state/store';
import type { AssistantState, PendingApproval } from './state/store';

function useAssistant(): ReturnType<typeof assistantStore.getSnapshot> {
  return useSyncExternalStore(assistantStore.subscribe, assistantStore.getSnapshot);
}

export function AssistantSidebar(): ReactNode {
  const state = useAssistant();
  const configured = state.keyStatus?.configured ?? false;

  return (
    <div className="rd-panel rd-sidebar" data-testid="assistant-sidebar">
      <div className="rd-panel-head">
        <span>助手</span>
      </div>
      <div className="rd-panel-body">
        <div className="rd-form">
          <div className="rd-field">
            <span>模型</span>
            <span data-testid="assistant-sidebar-provider">
              {PROVIDER_LABEL[state.config.kind]}
            </span>
          </div>
          <div className="rd-field">
            <span>key</span>
            <span data-testid="assistant-sidebar-key">
              {state.keyStatus === null ? '…' : configured ? '已配置' : '还没配'}
            </span>
          </div>
          {!ready(state) && <p className="rd-hint">正在读配置…</p>}
        </div>
      </div>
    </div>
  );
}

function ready(state: { ready: boolean }): boolean {
  return state.ready;
}

export function AssistantMain(): ReactNode {
  const state = useAssistant();
  const [draft, setDraft] = useState('');

  const submit = (): void => {
    const text = draft;
    if (text.trim() === '') return;
    setDraft('');
    void assistantStore.send(text);
  };

  return (
    <div className="rd-main rd-assistant-chat" data-testid="assistant-main">
      <ChatBar />
      <ChatStream />
      <Composer
        draft={draft}
        onDraft={setDraft}
        onSubmit={submit}
        canSend={assistantStore.canSend()}
        running={state.running}
      />
      {state.pending !== null && <ApprovalSheet pending={state.pending} />}
    </div>
  );
}

/** 顶栏：在哪个目录里干活、用哪条上下文策略、清空。 */
function ChatBar(): ReactNode {
  const state = useAssistant();

  const pick = async (): Promise<void> => {
    const picked = await platform.pickWorkspace();
    if (picked !== null) assistantStore.setWorkspace(picked);
  };

  return (
    <div className="rd-assistant-bar">
      <button
        type="button"
        className="rd-btn"
        data-testid="assistant-pick-workspace"
        onClick={() => void pick()}
        disabled={state.running}
      >
        {state.workspace === null ? '选工作目录…' : '换目录'}
      </button>
      <span className="rd-assistant-workspace" data-testid="assistant-workspace">
        {state.workspace === null ? '还没选目录' : basename(state.workspace)}
      </span>

      <label className="rd-assistant-strategy">
        <span>上下文</span>
        <select
          data-testid="assistant-strategy"
          value={state.strategy}
          disabled={state.running}
          onChange={(e) => assistantStore.setStrategy(e.target.value)}
        >
          <option value="full">全量</option>
          <option value="rolling:20">只留最近 20 段</option>
          <option value="rolling:8">只留最近 8 段</option>
        </select>
      </label>

      <button
        type="button"
        className="rd-btn"
        data-testid="assistant-clear"
        onClick={() => assistantStore.clearChat()}
        // ⚠️ 跑的时候不让清 —— 界面空了但钱还在烧是最糟的那种。
        disabled={state.running || state.messages.length === 0}
      >
        清空
      </button>
    </div>
  );
}

/**
 * 现在**发不出去**的原因，一条一条列清楚（空数组 = 能发）。
 *
 * ⚠️ 这是 [`assistantStore.canSend`] 的另一面 —— **同一个判断，加条件时两边都要改**。
 *
 * 为什么非得把它摆出来：发送按钮的禁用条件有五个，任何一个不满足都是
 * **灰的、点了完全没反应**。而「点了一个按钮什么也没发生」是用户唯一
 * 得不出任何信息的失败方式 —— 他会直接得出「这玩意儿坏了」。
 */
function sendBlockers(state: AssistantState): string[] {
  const out: string[] = [];
  if (!state.ready) out.push('正在读配置…');
  if (state.workspace === null) {
    out.push('还没选工作目录 —— 助手要有个地方干活，它碰不到那个目录以外的任何文件。');
  }
  const problem = validateConfig(state.config);
  if (problem !== null) out.push(problem);
  if (state.keyStatus === null) {
    out.push('读不到 key 的状态 —— 右边那个面板里应该有更具体的原因。');
  } else if (!state.keyStatus.configured) {
    out.push('还没配 API key —— 在右边的「模型」面板里填一把。');
  }
  return out;
}

/** 消息流。 */
function ChatStream(): ReactNode {
  const state = useAssistant();

  if (state.messages.length === 0) {
    const blockers = sendBlockers(state);

    return (
      <div className="rd-assistant-stream" data-testid="assistant-stream">
        <div className="rd-agent-empty" data-testid="assistant-empty">
          <h3>{blockers.length > 0 ? '还差几样东西' : '说点什么'}</h3>
          {blockers.length === 0 ? (
            <p className="rd-hint">
              助手会在上面那个目录里读文件、改文件、跑命令。
              <br />
              改文件和跑命令**每次都会先问你** —— 你点了允许它才动。
            </p>
          ) : (
            <ul className="rd-hint rd-assistant-blockers" data-testid="assistant-blockers">
              {blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="rd-assistant-stream" data-testid="assistant-stream">
      {state.messages.map((m) => (
        <div
          key={m.id}
          className={`rd-assistant-msg is-${m.role}`}
          data-testid={`assistant-msg-${m.role}`}
        >
          {m.text !== '' && <div className="rd-assistant-text">{m.text}</div>}
          {m.tools.map((t, i) => (
            <div
              key={`${m.id}-t${i}`}
              className={`rd-assistant-tool${t.isError === true ? ' is-error' : ''}`}
              data-testid="assistant-tool"
            >
              <span className="rd-assistant-tool-mark">
                {t.isError === null ? '·' : t.isError ? '✗' : '✓'}
              </span>
              <span>{t.display}</span>
            </div>
          ))}
        </div>
      ))}
      {state.running && (
        <div className="rd-hint" data-testid="assistant-running">
          正在跑…（点下面的「停止」可以随时叫停）
        </div>
      )}
    </div>
  );
}

/** 输入区。 */
function Composer({
  draft,
  onDraft,
  onSubmit,
  canSend,
  running,
}: {
  draft: string;
  onDraft: (v: string) => void;
  onSubmit: () => void;
  canSend: boolean;
  running: boolean;
}): ReactNode {
  const state = useAssistant();

  return (
    <div className="rd-assistant-composer">
      {state.error !== null && (
        <p className="rd-hint is-error" data-testid="assistant-chat-error">
          {state.error}
        </p>
      )}
      <div className="rd-assistant-row">
        <textarea
          className="rd-assistant-input"
          data-testid="assistant-input"
          placeholder={
            state.workspace === null
              ? '先选一个工作目录…'
              : '想让助手做什么？（Enter 发送，Shift+Enter 换行）'
          }
          value={draft}
          rows={2}
          onChange={(e) => onDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              onSubmit();
            }
          }}
        />
        {running ? (
          <button
            type="button"
            className="rd-btn"
            data-testid="assistant-stop"
            onClick={() => void assistantStore.cancel()}
          >
            停止
          </button>
        ) : (
          <button
            type="button"
            className="rd-btn rd-assistant-go"
            data-testid="assistant-send"
            disabled={!canSend || draft.trim() === ''}
            onClick={onSubmit}
          >
            发送
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * 审批弹层。
 *
 * ⚠️ **这是这个模块最要紧的一块界面。** 审批默认**不超时**（它一直等你），
 * 所以这块东西必须足够显眼、而且随时能撤 —— 用户去干别的了回来，
 * 得一眼看出「它在等我点一下」。
 *
 * 「记住」那个按钮要不要给是由 Rust 说了算的（`canRemember`）：
 * 跑 shell 解释器的时候不给 —— 记住 `bash` 等于免审之后所有的 `bash -c "…"`，
 * 而用户点「记住」时看到的是**当时那一条**命令。给一个点了没用的按钮
 * 比不给更糟，所以这里严格按那个字段来。
 */
function ApprovalSheet({ pending }: { pending: PendingApproval }): ReactNode {
  return (
    <div className="rd-assistant-approval" data-testid="assistant-approval">
      <div className="rd-assistant-approval-card">
        <h4>要动你的东西了</h4>
        <p className="rd-assistant-approval-what" data-testid="assistant-approval-what">
          {pending.display}
        </p>
        <p className="rd-hint">
          {pending.canRemember
            ? '允许之后，这一类操作在本会话里不再问。'
            : '这一步每次都会问（它跑的东西能执行任意代码，记住它等于全部放行）。'}
        </p>
        <div className="rd-assistant-row">
          <button
            type="button"
            className="rd-btn"
            data-testid="assistant-approval-deny"
            onClick={() => void assistantStore.approve('deny')}
          >
            拒绝这次
          </button>
          <button
            type="button"
            className="rd-btn rd-assistant-go"
            data-testid="assistant-approval-allow"
            onClick={() => void assistantStore.approve('allow')}
          >
            允许
          </button>
          {pending.canRemember && (
            <button
              type="button"
              className="rd-btn"
              data-testid="assistant-approval-session"
              onClick={() => void assistantStore.approve('session')}
            >
              允许，本会话都别再问
            </button>
          )}
          {/*
            ⚠️ **这个按钮必须在弹层里。** 弹层盖住了整个主区域，包括下面的
            输入框和「停止」—— 只靠那个停止按钮的话，用户点了「写文件」之后
            就只剩下两个选择：允许或者拒绝。而审批**默认不超时**，
            于是「我不干了」这件事就变成了「必须先允许它一次」。
          */}
          <button
            type="button"
            className="rd-btn rd-danger rd-assistant-stop-all"
            data-testid="assistant-approval-stop"
            title="这次任务整个停下，不只是跳过这一步"
            onClick={() => void assistantStore.cancel()}
          >
            整个停掉
          </button>
        </div>
      </div>
    </div>
  );
}

export function AssistantStatusItems(): ReactNode {
  const state = useAssistant();
  return (
    <span data-testid="assistant-status">
      {PROVIDER_LABEL[state.config.kind]} · {state.config.model || '（没填模型）'}
    </span>
  );
}

/**
 * 角标：**用户在别的模块里时唯一看得见的地方**。
 *
 * 两种情况，按急迫程度排：
 *
 * 1. **它在等你点确认** —— 这是 `Module.badge` 注释的原话那个场景，
 *    而且审批**默认不超时**（它一直等下去），所以这件事最急：
 *    不亮的话用户根本不知道去点哪儿。
 * 2. 还没配 key —— 「配错了要等很久才发现」是同一类问题，放在同一个位置。
 *
 * ⚠️ 两件事共用一个槽位（外壳只给一个），所以要有优先级 ——
 * 「在等你」比「还没配」急：前者是进行中的事，后者是还没开始的事。
 */
export function AssistantBadge(): ReactNode {
  const state = useAssistant();

  if (state.pending !== null) {
    return (
      <span
        className="rd-module-badge"
        data-testid="assistant-badge"
        data-reason="waiting"
        aria-label="助手在等你确认"
      >
        !
      </span>
    );
  }

  if (state.keyStatus === null || state.keyStatus.configured) return null;
  return (
    <span
      className="rd-module-badge"
      data-testid="assistant-badge"
      data-reason="nokey"
      aria-label="还没配 API key"
    >
      !
    </span>
  );
}
