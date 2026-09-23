/**
 * 顶部工具栏：**方法 + 地址 + 发送**。
 *
 * 这三样就是调接口的全部动作，所以它们占着通栏那一条 —— 其余的东西
 *（头、正文、选项）都是围着这一次发送服务的。
 *
 * # 方法那里为什么是输入框 + 建议，不是下拉框
 *
 * 传输层**没有方法白名单**（`PROPFIND` / `PURGE` / 各家自己造的扩展方法都合法，
 * 而调接口时最需要试的恰恰是那些）。下拉框会把这些方法挡在门外 ——
 * 而「挡住了但用户不知道」比「要自己打四个字母」贵得多。
 *
 * # 灰着的按钮要说清为什么
 *
 * 助手上线时踩过：按钮灰着而界面上一个字都不说，用户只能得出「它坏了」
 *（HANDOFF ⑧）。所以这里把 `store.blocker()` 那句话直接摆在按钮旁边 ——
 * 它和按钮的禁用条件是**同一个判断**（`canSend`），不会对不上。
 */

import type { ReactNode } from 'react';
import type { RequestState, RequestStore } from '../state/store';

/** 建议的方法（不是白名单 —— 输入框里打什么都行）。 */
const COMMON_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

export interface RequestToolbarProps {
  state: RequestState;
  store: RequestStore;
}

export function RequestToolbarView({ state, store }: RequestToolbarProps): ReactNode {
  const running = state.response.phase === 'running';
  const blocker = store.blocker();
  const canSend = blocker === null;

  return (
    <div className="rd-toolbar" data-testid="request-toolbar">
      <div className="rd-group rd-req-url-group">
        <input
          type="text"
          className="rd-req-method"
          data-testid="request-method"
          aria-label="HTTP 方法"
          list="rd-req-methods"
          spellCheck={false}
          value={state.draft.method}
          onChange={(e) => store.setMethod(e.target.value)}
          onKeyDown={(e) => {
            // 在地址栏按回车 = 发送（调接口时的手感就是这样）
            if (e.key === 'Enter') store.send();
          }}
        />
        <datalist id="rd-req-methods">
          {COMMON_METHODS.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>

        <input
          type="text"
          className="rd-req-url"
          data-testid="request-url"
          aria-label="请求地址"
          spellCheck={false}
          placeholder="https://api.example.com/users（要连 http:// 或 https:// 一起写）"
          value={state.draft.url}
          onChange={(e) => store.setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') store.send();
          }}
        />

        <button
          type="button"
          className="rd-btn rd-btn-primary"
          data-testid="request-send"
          disabled={!canSend}
          title={blocker ?? '发出去（在地址栏里按回车也一样）'}
          onClick={() => store.send()}
        >
          {running ? '发送中…' : '发送'}
        </button>
      </div>

      {/* ⚠️ 不能发的时候，把原因**写出来**（和助手的空状态清单同一条规矩）。
          能发的时候这一格空着 —— 平时不该占着用户的注意力 */}
      {blocker !== null && (
        <span className="rd-req-blocker" data-testid="request-blocker">
          {blocker}
        </span>
      )}

      <span className="rd-spacer" />

      {state.response.phase !== 'idle' && state.response.head !== null && (
        <span className="rd-muted" data-testid="request-toolbar-status">
          {state.response.head.status} {state.response.head.reason}
        </span>
      )}
    </div>
  );
}
