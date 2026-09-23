/**
 * 右侧检查器：**这一次请求怎么发**（超时、跳转、证书）+ **把它存下来**。
 *
 * # 为什么这些都是「每次请求」的选项，而不是全局设置
 *
 * 调接口时这几个值**因请求而异**：测一个挂着的服务要 300 秒超时，
 * 打自签证书的内网要关校验，跟一个短链要开跳转 —— 全局一份的话，
 * 用户每次都得回来改，而改完忘了改回去就是下一次的坑。
 *
 * # 证书那个开关为什么必须有红字
 *
 * ⚠️ 它**只跳过证书链校验，不跳过签名校验**（拿别人的合法证书来冒充仍然会被挡下，
 * 见 `request/src/tls.rs`）。即便如此，它关了之后**中间人**就能看到全部内容 ——
 * 所以这里写清楚，而且默认是关的。
 */

import { useState, type ReactNode } from 'react';
import type { RequestState, RequestStore } from '../state/store';

export interface RequestInspectorProps {
  state: RequestState;
  store: RequestStore;
}

export function RequestInspectorView({ state, store }: RequestInspectorProps): ReactNode {
  const [name, setName] = useState('');
  const opts = state.draft.options;

  const save = (): void => {
    if (store.save(name)) setName('');
  };

  return (
    <div className="rd-panel" data-testid="request-inspector">
      <div className="rd-panel-head">这次怎么发</div>
      <div className="rd-panel-body">
        <div className="rd-form">
          <label className="rd-field">
            <span>超时（秒）</span>
            <input
              type="number"
              min={1}
              max={3600}
              data-testid="request-opt-timeout"
              value={opts.timeoutSecs}
              onChange={(e) => {
                const n = Number.parseInt(e.target.value, 10);
                // ⚠️ 空输入框给的是 NaN —— 不处理的话那个值会变成 NaN 一路传到
                // Rust（`Duration::from_secs(NaN 的整数化)`），而症状是「地址栏
                // 看着没问题但请求发不出去」。范围最终由 Rust 夹（见 OptionsSpec）
                if (Number.isFinite(n)) store.setOption({ timeoutSecs: n });
              }}
            />
            <span className="rd-muted">建连 + TLS 握手 + 等响应头</span>
          </label>

          <label className="rd-field">
            <span>空闲超时（秒）</span>
            <input
              type="number"
              min={1}
              max={3600}
              data-testid="request-opt-idle"
              value={opts.idleTimeoutSecs}
              onChange={(e) => {
                const n = Number.parseInt(e.target.value, 10);
                if (Number.isFinite(n)) store.setOption({ idleTimeoutSecs: n });
              }}
            />
            <span className="rd-muted">
              正文两块数据之间最多等多久。⚠️ 有些网关不是真流式（攒完整段才吐），
              那种网关要把这个调大
            </span>
          </label>

          <label className="rd-field rd-check">
            <input
              type="checkbox"
              data-testid="request-opt-follow"
              checked={opts.followRedirects}
              onChange={(e) => store.setOption({ followRedirects: e.target.checked })}
            />
            <span>跟着 3xx 跳转</span>
          </label>

          {opts.followRedirects && (
            <>
              <label className="rd-field">
                <span>最多跟几跳</span>
                <input
                  type="number"
                  min={0}
                  max={20}
                  data-testid="request-opt-max-redirects"
                  value={opts.maxRedirects}
                  onChange={(e) => {
                    const n = Number.parseInt(e.target.value, 10);
                    if (Number.isFinite(n)) store.setOption({ maxRedirects: n });
                  }}
                />
              </label>
              <div className="rd-hint">
                ⚠️ 301/302/303 按惯例改成 GET 并丢掉正文；307/308 原样重发。
                <b>跨主机跳转会丢掉 `authorization` / `cookie`</b>（curl 和 Postman
                都这么做 —— 那两样是发给原来那台机器的）。
              </div>
            </>
          )}

          <label className="rd-field rd-check">
            <input
              type="checkbox"
              data-testid="request-opt-insecure"
              checked={opts.acceptInvalidCerts}
              onChange={(e) => store.setOption({ acceptInvalidCerts: e.target.checked })}
            />
            <span>跳过证书校验</span>
          </label>
          {opts.acceptInvalidCerts && (
            <div className="rd-req-danger" data-testid="request-insecure-warning">
              ⚠️ 这一条开着：证书链不校验了，中间人能看到全部内容。
              内网自签证书调完就关掉。签名仍然校验（拿别人的证书冒充挡得住）。
            </div>
          )}
        </div>

        <div className="rd-panel-head">存下来</div>
        <div className="rd-form">
          <label className="rd-field">
            <span>名字</span>
            <input
              type="text"
              placeholder="比如：查用户"
              data-testid="request-save-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') save();
              }}
            />
          </label>
          <button
            type="button"
            className="rd-btn"
            data-testid="request-save"
            disabled={name.trim() === '' || state.draft.url.trim() === ''}
            title={
              state.draft.url.trim() === ''
                ? '先填个地址再存'
                : '存下这份请求（连头、正文和选项一起）'
            }
            onClick={save}
          >
            保存
          </button>
          <div className="rd-hint">
            ⚠️ <b>同名就是同一条</b>：再存一次会覆盖它（改完名字另存就是了）。
            保存的内容包括请求头 —— 里面有 token 的话，它是明文存在本机的。
          </div>
        </div>
      </div>
    </div>
  );
}
