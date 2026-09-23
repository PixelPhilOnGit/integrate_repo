/**
 * 请求编辑器：**头** 和 **正文** 两页。
 *
 * # 为什么是两页而不是一屏排开
 *
 * 调接口时看的是「这次要调什么」——头通常要精确核对（少一个 `authorization`
 * 就是 401），正文通常整段粘进去。两者挤在一屏的话，浏览器窗口一窄，
 * 头那张表只剩两三行可见。分成两页，各自都能占满。
 *
 * # 头那一页的三条规矩
 *
 * 1. **一行一个开关**：关掉某条头试一次是最常用的动作，所以它得是**一键**的
 *    （清空名字再打一遍不叫一键）；
 * 2. **空行不画提示也不发出去** —— 那三行空白是「往这儿写」的意思，
 *    `enabledHeaders` 会滤掉它们；
 * 3. 末尾常驻一个「加一行」——表格空着的时候用户得知道下一步点哪儿。
 */

import type { ReactNode } from 'react';
import type { RequestState, RequestStore } from '../state/store';

export interface RequestEditorProps {
  state: RequestState;
  store: RequestStore;
}

export function RequestEditorView({ state, store }: RequestEditorProps): ReactNode {
  const headers = state.draft.headers;
  const headerCount = headers.filter((h) => h.enabled && h.name.trim() !== '').length;
  const bodyBytes = new TextEncoder().encode(state.draft.body).length;

  return (
    <div className="rd-req-editor">
      <div className="rd-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={state.editorTab === 'headers'}
          className={state.editorTab === 'headers' ? 'is-active' : ''}
          data-testid="request-tab-headers"
          onClick={() => store.setEditorTab('headers')}
        >
          头（{headerCount}）
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={state.editorTab === 'body'}
          className={state.editorTab === 'body' ? 'is-active' : ''}
          data-testid="request-tab-body"
          onClick={() => store.setEditorTab('body')}
        >
          正文{bodyBytes > 0 ? `（${bodyBytes} 字节）` : ''}
        </button>
      </div>

      {state.editorTab === 'headers' ? (
        <div className="rd-req-editor-body" data-testid="request-headers">
          {headers.map((h) => (
            <div className="rd-req-header-row" key={h.id}>
              <input
                type="checkbox"
                className="rd-req-header-toggle"
                aria-label="这一条发不发"
                checked={h.enabled}
                data-testid="request-header-enabled"
                onChange={(e) => store.updateHeaderRow(h.id, { enabled: e.target.checked })}
              />
              <input
                type="text"
                className="rd-req-header-name"
                spellCheck={false}
                placeholder="名字"
                aria-label="请求头名字"
                data-testid="request-header-name"
                value={h.name}
                onChange={(e) => store.updateHeaderRow(h.id, { name: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') store.addHeader();
                }}
              />
              <input
                type="text"
                className="rd-req-header-value"
                spellCheck={false}
                placeholder="值"
                aria-label="请求头的值"
                data-testid="request-header-value"
                value={h.value}
                onChange={(e) => store.updateHeaderRow(h.id, { value: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') store.addHeader();
                }}
              />
              <button
                type="button"
                className="rd-req-row-x"
                title="删掉这一条"
                data-testid="request-header-remove"
                onClick={() => store.removeHeaderRow(h.id)}
              >
                ×
              </button>
            </div>
          ))}

          <button
            type="button"
            className="rd-req-add"
            data-testid="request-add-header"
            onClick={() => store.addHeader()}
          >
            ＋ 加一行
          </button>

          <div className="rd-hint">
            ⚠️ <code>content-length</code> 和 <code>transfer-encoding</code>
            会被丢掉（hyper 自己管这两个 —— 两边都设会得到一个和用户填了什么
            毫无关系的报错）。<code>host</code> 可以覆盖我们算出来的那个。
          </div>
        </div>
      ) : (
        <div className="rd-req-editor-body" data-testid="request-body">
          <textarea
            className="rd-req-body-input"
            spellCheck={false}
            placeholder="请求体（GET 一般不用填）。留空 = 不带 body。"
            aria-label="请求体"
            data-testid="request-body-input"
            value={state.draft.body}
            onChange={(e) => store.setBody(e.target.value)}
          />
          <div className="rd-hint">
            {bodyBytes === 0
              ? '现在是空的 —— 发出去的时候不带 body（不是带一个长度为 0 的）'
              : `${bodyBytes} 字节，按 UTF-8 发`}
            {/* 一期只有文本：传输层支持任意字节，但界面上还没有「选个文件当 body」的入口 */}
          </div>
        </div>
      )}
    </div>
  );
}
