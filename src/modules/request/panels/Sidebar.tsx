/**
 * 侧栏：**历史 + 保存的请求**，共用一个搜索框。
 *
 * # 为什么是这两样（用户拍板的）
 *
 * 调接口的过程就是「刚发过什么」和「常发的那些」两件事，前者是自动记的、
 * 后者是手动留的。Postman 那边还有「集合 / 环境变量」那一整套，这一版**不做**
 *（环境变量是另一件大工程：变量表、作用域、替换规则）。
 *
 * # 搜索是两边一起筛的
 *
 * 一个搜索框管两块列表，和智能体会话的「筛选 + 搜索是与的关系」一个口径 ——
 * 两个模块不该有两套直觉。**平铺的列表按相关度排**（树形的才保序，
 * 见 HANDOFF 里那条口径）。
 *
 * # 合并显示，不分成两个搜索框
 *
 * 用户搜 `api` 的时候心里没有「这是历史还是保存的」这个问题 ——
 * 分成两块各自搜的话，他要搜两次。
 */

import type { ReactNode } from 'react';
import { fuzzyFilter } from '../../../shared/search';
import { NoMatch, SearchBox } from '../../../shared/ui/SearchBox';
import { hasSensitiveHeaders, shortUrl } from '../core/draft';
import { formatBytes, formatClock, formatMillis } from '../core/format';
import type { HistoryEntry, SavedRequest } from '../core/types';
import type { RequestState, RequestStore } from '../state/store';

export interface RequestSidebarProps {
  state: RequestState;
  store: RequestStore;
}

export function RequestSidebarView({ state, store }: RequestSidebarProps): ReactNode {
  const history = fuzzyFilter(state.history, state.query, (e) => [e.method, e.url]);
  const saved = fuzzyFilter(state.saved, state.query, (s) => [s.name, s.draft.url, s.draft.method]);
  const filtering = state.query.trim() !== '';
  const nothing = history.length === 0 && saved.length === 0;

  return (
    <div className="rd-panel" data-testid="request-sidebar">
      <div className="rd-panel-head">
        <span>接口调试</span>
        <span className="rd-spacer" />
        <button
          type="button"
          className="rd-btn"
          data-testid="request-reset"
          title="清空编辑器，回到一个空请求"
          onClick={() => store.resetDraft()}
        >
          新建
        </button>
      </div>

      {(state.history.length > 0 || state.saved.length > 0) && (
        <SearchBox
          value={state.query}
          onChange={(q) => store.setQuery(q)}
          testId="request-search"
          placeholder="搜方法、地址、名字"
        />
      )}

      <div className="rd-panel-body">
        {state.error !== null && (
          <div className="rd-req-error" data-testid="request-error">
            <div>{state.error}</div>
            <button type="button" className="rd-btn" onClick={() => void store.retry()}>
              重试
            </button>
          </div>
        )}

        {nothing && !filtering && state.error === null && (
          <div className="rd-empty" data-testid="request-empty">
            还没发过请求。上面填个地址，点「发送」。
          </div>
        )}
        {nothing && filtering && <NoMatch testId="request-nomatch" />}

        {saved.length > 0 && (
          <>
            <div className="rd-req-section">
              <span>已保存</span>
              <span className="rd-muted">{state.saved.length}</span>
            </div>
            {saved.map((s) => (
              <SavedRow key={s.id} entry={s} selected={s.id === state.selectedSavedId} store={store} />
            ))}
          </>
        )}

        {history.length > 0 && (
          <>
            <div className="rd-req-section">
              <span>历史</span>
              <span className="rd-muted">{state.history.length}</span>
              <span className="rd-spacer" />
              <button
                type="button"
                className="rd-req-link"
                data-testid="request-clear-history"
                title="把历史清空（保存的请求不受影响）"
                onClick={() => store.clearHistory()}
              >
                清空
              </button>
            </div>
            {history.map((e) => (
              <HistoryRow key={e.id} entry={e} store={store} />
            ))}
          </>
        )}

        {/* ⚠️ 一句实话，放在用户看得见的地方：历史和保存都是**明文**存在本机的
            （连接密码和助手的 key 走系统钥匙串，这一层没有那个待遇）。
            不写出来的话，没人会想到「我贴过的那个 token 还在磁盘上」。 */}
        {(state.history.length > 0 || state.saved.length > 0) && (
          <div className="rd-hint rd-req-hint">
            历史和保存是明文存在本机的 —— 别把生产 token 长期留在里面。
          </div>
        )}
      </div>
    </div>
  );
}

function HistoryRow({ entry, store }: { entry: HistoryEntry; store: RequestStore }): ReactNode {
  const status = entry.outcome.kind === 'ok' ? `${entry.outcome.status}` : '失败';
  const tone = entry.outcome.kind === 'ok' ? toneOf(entry.outcome.status) : 'failed';
  const meta =
    entry.outcome.kind === 'ok'
      ? `${formatMillis(entry.outcome.totalMillis)} · ${formatBytes(entry.outcome.bytes)}`
      : entry.outcome.message;

  return (
    <div
      className="rd-req-row"
      data-testid="request-history-row"
      role="button"
      tabIndex={0}
      onClick={() => store.openHistory(entry.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') store.openHistory(entry.id);
      }}
    >
      <span className={`rd-req-tag is-${tone}`}>{status}</span>
      <span className="rd-req-row-text">
        <span className="rd-req-row-title">
          <b>{entry.method}</b> {shortUrl(entry.url)}
        </span>
        <span className="rd-req-row-meta" title={meta}>
          {formatClock(entry.at)} · {meta}
        </span>
      </span>
      {hasSensitiveHeaders(entry.draft) && (
        <span className="rd-req-warn" title="这条请求带着凭据类的头（明文存在本机）">
          ⚠
        </span>
      )}
      <button
        type="button"
        className="rd-req-row-x"
        data-testid="request-history-remove"
        title="从历史里删掉这一条"
        onClick={(e) => {
          e.stopPropagation();
          store.removeHistoryEntry(entry.id);
        }}
      >
        ×
      </button>
    </div>
  );
}

function SavedRow({
  entry,
  selected,
  store,
}: {
  entry: SavedRequest;
  selected: boolean;
  store: RequestStore;
}): ReactNode {
  return (
    <div
      className={`rd-req-row${selected ? ' is-selected' : ''}`}
      data-testid="request-saved-row"
      role="button"
      tabIndex={0}
      onClick={() => store.openSaved(entry.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') store.openSaved(entry.id);
      }}
    >
      <span className="rd-req-tag is-saved">{entry.draft.method}</span>
      <span className="rd-req-row-text">
        <span className="rd-req-row-title">{entry.name}</span>
        <span className="rd-req-row-meta" title={entry.draft.url}>
          {shortUrl(entry.draft.url) || '（还没填地址）'}
        </span>
      </span>
      {hasSensitiveHeaders(entry.draft) && (
        <span className="rd-req-warn" title="这条请求带着凭据类的头（明文存在本机）">
          ⚠
        </span>
      )}
      <button
        type="button"
        className="rd-req-row-x"
        data-testid="request-saved-remove"
        title="删掉这条保存的请求（历史不受影响）"
        onClick={(e) => {
          e.stopPropagation();
          store.removeSavedEntry(entry.id);
        }}
      >
        ×
      </button>
    </div>
  );
}

/** 状态码 → 那粒小标签的色档。 */
function toneOf(status: number): string {
  if (status >= 200 && status < 300) return 'ok';
  if (status >= 300 && status < 400) return 'redirect';
  if (status >= 400 && status < 500) return 'client';
  return 'server';
}
