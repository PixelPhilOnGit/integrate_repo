/**
 * 主区右侧：选中 key 的值。
 *
 * 按类型换渲染方式：string 是原文，list/set 是列表，hash/zset 是两列表格。
 * 「一个 hash 该显示成什么」这类判断在 `core/value.ts` 里（纯函数，可单测），
 * 这里只负责画出来。
 */

import type { ReactNode } from 'react';
import { formatSize, formatTtl, toValueView, type ValueView as View } from '../core/value';
import type { RedisState, RedisStore } from '../state/store';

interface Props {
  state: RedisState;
  store: RedisStore;
}

export function ValueView({ state }: Props): ReactNode {
  const { browse } = state;

  // 没选 key 的时候也要占住位置 —— 否则主区会随着内容宽度跳来跳去
  if (browse.selected === null) {
    return (
      <div className="rd-value" data-testid="value-view">
        <div className="rd-empty">在左边点一个 key 看它的值</div>
      </div>
    );
  }

  const meta = browse.selected;

  return (
    <div className="rd-value" data-testid="value-view">
      <div className="rd-value-head">
        <span className="rd-value-key" title={meta.key} data-testid="value-key">
          {meta.key}
        </span>
        <span className={`rd-key-type is-${meta.keyType}`}>{meta.keyType}</span>
      </div>

      {browse.detail && (
        <div className="rd-value-meta">
          <span>TTL：{formatTtl(browse.detail.ttl)}</span>
          {formatSize(browse.detail) && <span>大小：{formatSize(browse.detail)}</span>}
        </div>
      )}

      <div className="rd-value-body" data-testid="value-body">
        {browse.loadingDetail && <div className="rd-db-hint">读取中…</div>}

        {!browse.loadingDetail && browse.detail === null && (
          <div className="rd-empty">没拿到值</div>
        )}

        {!browse.loadingDetail && browse.detail && (
          <>
            <ValueBody view={toValueView(browse.detail)} />
            {browse.detail.truncated && (
              <p className="rd-db-hint" data-testid="value-truncated">
                内容太多，只显示了前一部分。想看全部的话去命令台用 LRANGE / HSCAN 之类的命令。
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function ValueBody({ view }: { view: View }): ReactNode {
  switch (view.kind) {
    case 'nil':
      return <p className="rd-value-nil">(nil)</p>;

    case 'text':
      if (view.binary) {
        return <p className="rd-value-nil">（二进制内容，{view.bytes} 字节，没法当文本显示）</p>;
      }
      // 空字符串和「没有值」是两回事，明确画出来
      return <pre className="rd-value-text">{view.text === '' ? '(空字符串)' : view.text}</pre>;

    case 'list':
      return view.items.length === 0 ? (
        <p className="rd-value-nil">(空)</p>
      ) : (
        <ol className="rd-value-list">
          {view.items.map((item, index) => (
            // 值本身可以重复，没有稳定 key，用下标即可（列表是只读的）
            <li key={index}>{item}</li>
          ))}
        </ol>
      );

    case 'pairs':
      return view.pairs.length === 0 ? (
        <p className="rd-value-nil">(空)</p>
      ) : (
        <table className="rd-value-table">
          <thead>
            <tr>
              <th>{view.leftLabel}</th>
              <th>{view.rightLabel}</th>
            </tr>
          </thead>
          <tbody>
            {view.pairs.map(([left, right], index) => (
              <tr key={index}>
                <td>{left}</td>
                <td>{right}</td>
              </tr>
            ))}
          </tbody>
        </table>
      );

    case 'raw':
      return view.lines.length === 0 ? (
        <p className="rd-value-nil">（这个类型还没做展示）</p>
      ) : (
        <pre className="rd-value-text">{view.lines.join('\n')}</pre>
      );
  }
}
