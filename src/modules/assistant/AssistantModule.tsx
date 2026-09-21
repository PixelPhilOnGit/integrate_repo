/**
 * 助手模块的各个槽位。
 *
 * 现在只有**配置**是能用的：主区域明说模型还没接上 —— 摆一个假的对话框比空着
 * 更糟（用户会以为发了消息只是没回复）。
 */

import { useSyncExternalStore, type ReactNode } from 'react';
import { PROVIDER_LABEL } from './core/config';
import { assistantStore } from './state/store';

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
  const configured = state.keyStatus?.configured ?? false;

  return (
    <div className="rd-main" data-testid="assistant-main">
      <div className="rd-agent-empty">
        <h3>模型还没接上</h3>
        <p className="rd-hint">
          配置界面已经能用了（右边）。对话、工具调用、上下文策略是接下来几步的事 ——
          循环内核本身已经跑通并测过了，缺的是 HTTP 客户端和这个界面。
        </p>
        {!configured && (
          <p className="rd-hint is-error" data-testid="assistant-main-nokey">
            还没配 API key —— 在右边的「模型」面板里填。
          </p>
        )}
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
 * 角标：还没配 key 的时候亮一下。
 *
 * `Module.badge` 的注释原话是「用户在别的模块里，而 agent 在等他」——
 * 现在还没有"等"，但**配错了要等很久才发现**是同一类问题：把状态放到
 * 用户看得见的地方。
 */
export function AssistantBadge(): ReactNode {
  const state = useAssistant();
  if (state.keyStatus === null || state.keyStatus.configured) return null;
  return (
    <span
      className="rd-module-badge"
      data-testid="assistant-badge"
      aria-label="还没配 API key"
    >
      !
    </span>
  );
}
