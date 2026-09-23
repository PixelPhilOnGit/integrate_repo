/**
 * 响应区：状态行 + 三个页签（正文 / 响应头 / 跳转）。
 *
 * # 正文是**边收边显示**的
 *
 * 流式响应（SSE、长轮询、慢网关）的价值全在「它已经开始回了」这件事上，
 * 所以这里不做任何「收完再渲染」的事 —— `state.response.text` 每来一块就更新
 * 一次，界面自然就是那个打字效果。撞上 2 MiB 上限时也一样：显示已经收到的，
 * 上面挂一条明说「只显示了前 2 MiB」的横幅。
 *
 * # 二进制内容画十六进制，不画乱码
 *
 * content-type 说是二进制的（图片、protobuf、gzip），就把前 1 KiB 画成
 * 十六进制 + ASCII。直接 `textContent` 贴上去的话，屏幕上是一大片替换字符，
 * 用户既看不出它是什么，也不知道它有多大。
 *
 * # ⚠️ 这里显示的正文**不是**「原样字节」
 *
 * 它是按 UTF-8 解出来的（`core/body.ts`）。要看原样的字节，得用别的工具 ——
 * 这一版的定位是「调接口时看一眼」，不是十六进制编辑器。
 */

import type { ReactNode } from 'react';
import { hexDump, isJson, isTextual, prettyJson } from '../core/body';
import { contentTypeOf, errorHint, formatBytes, formatMillis, statusTone } from '../core/format';
import type { RequestState, RequestStore } from '../state/store';

export interface ResponseViewProps {
  state: RequestState;
  store: RequestStore;
}

export function ResponseView({ state, store }: ResponseViewProps): ReactNode {
  const { response } = state;
  const head = response.head;
  const redirects = head?.redirects ?? [];
  const contentType = contentTypeOf(head);
  const textual = isTextual(contentType);
  // JSON 自动美化（和浏览器、Postman 一样）。⚠️ **解析不了就显示原文** ——
  // 流式响应的半截 JSON、或者对端其实就是想给一段坏 JSON，都不该看不见。
  const pretty = isJson(contentType) ? prettyJson(response.text) : null;

  return (
    <div className="rd-req-response" data-testid="request-response">
      <div className="rd-req-status-line">
        {head !== null ? (
          <>
            <span className={`rd-req-tag is-${statusTone(head.status)}`} data-testid="request-status">
              {head.status} {head.reason}
            </span>
            <span className="rd-muted" data-testid="request-elapsed">
              {formatMillis(head.elapsedMillis)} 到响应头
            </span>
            {response.totalMillis !== null && (
              <span className="rd-muted">{formatMillis(response.totalMillis)} 总耗时</span>
            )}
            {response.bytes > 0 && <span className="rd-muted">{formatBytes(response.bytes)}</span>}
            <span className="rd-muted">{head.httpVersion}</span>
            {head.finalUrl !== state.draft.url.trim() && (
              <span className="rd-muted" title={head.finalUrl}>
                跟到了 {head.finalUrl}
              </span>
            )}
          </>
        ) : (
          <span className="rd-muted">
            {response.phase === 'running' ? '正在发…' : '还没发过请求'}
          </span>
        )}
        {response.phase === 'running' && head !== null && (
          <span className="rd-muted" data-testid="request-receiving">
            正在接收…（{formatBytes(response.bytes)}）
          </span>
        )}
      </div>

      {/* ⚠️ 撞上转发上限要**明说**：不说的话用户会以为这就是全部内容
          （「这个接口就返回了 2 MiB」），而不是「界面上只显示到这里」 */}
      {response.truncated && (
        <div className="rd-req-notice" data-testid="request-truncated">
          响应比 2 MiB 还大 —— 这里只显示了前 2 MiB，后面的<b>没有收</b>（连接已经收掉了）。
          要看完整的，用 curl 或者别的下载工具。
        </div>
      )}

      {response.error !== null && (
        <div className="rd-req-error" data-testid="request-response-error">
          <div>{response.error.message}</div>
          {errorHint(response.error.errorKind) !== null && (
            <div className="rd-muted">{errorHint(response.error.errorKind)}</div>
          )}
          {response.error.bytes > 0 && (
            <div className="rd-muted">
              （断之前收到了 {formatBytes(response.error.bytes)}，在下面的正文里）
            </div>
          )}
        </div>
      )}

      <div className="rd-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={state.responseTab === 'body'}
          className={state.responseTab === 'body' ? 'is-active' : ''}
          data-testid="response-tab-body"
          onClick={() => store.setResponseTab('body')}
        >
          正文
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={state.responseTab === 'headers'}
          className={state.responseTab === 'headers' ? 'is-active' : ''}
          data-testid="response-tab-headers"
          onClick={() => store.setResponseTab('headers')}
        >
          响应头{(head?.headers.length ?? 0) > 0 ? `（${head?.headers.length}）` : ''}
        </button>
        {/* 没有跳转就不画这个页签 —— 一个永远空着的页签只会让人点它 */}
        {redirects.length > 0 && (
          <button
            type="button"
            role="tab"
            aria-selected={state.responseTab === 'redirects'}
            className={state.responseTab === 'redirects' ? 'is-active' : ''}
            data-testid="response-tab-redirects"
            onClick={() => store.setResponseTab('redirects')}
          >
            跳转（{redirects.length}）
          </button>
        )}
      </div>

      <div className="rd-req-response-body">
        {state.responseTab === 'body' && (
          <>
            {response.phase === 'idle' && (
              <div className="rd-empty">发一个请求，这里显示它回了什么</div>
            )}
            {response.phase !== 'idle' && !textual && (
              <div className="rd-req-binary" data-testid="request-binary">
                <div className="rd-muted">
                  二进制内容（{contentType ?? '没说 content-type'}，{formatBytes(response.bytes)}）
                </div>
                <pre>{hexDump(response.prefix)}</pre>
              </div>
            )}
            {response.phase !== 'idle' && textual && (
              <pre data-testid="request-body-text">{pretty ?? response.text}</pre>
            )}
            {response.phase === 'running' && response.text === '' && head !== null && (
              <div className="rd-muted">响应头到了，正文还在路上…</div>
            )}
          </>
        )}

        {state.responseTab === 'headers' && (
          <div data-testid="request-response-headers">
            {head === null ? (
              <div className="rd-empty">还没有响应头</div>
            ) : (
              head.headers.map(([name, value], i) => (
                <div className="rd-req-kv" key={`${name}-${i}`}>
                  <span className="rd-req-kv-name">{name}</span>
                  <span className="rd-req-kv-value">{value}</span>
                </div>
              ))
            )}
          </div>
        )}

        {state.responseTab === 'redirects' && (
          <div data-testid="request-response-redirects">
            {redirects.map((r, i) => (
              <div className="rd-req-redirect" key={`${r.from}-${i}`}>
                <span className={`rd-req-tag is-${statusTone(r.status)}`}>{r.status}</span>
                <span className="rd-req-kv-value">{r.from}</span>
                <span className="rd-muted">→</span>
                <span className="rd-req-kv-value">{r.to}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
