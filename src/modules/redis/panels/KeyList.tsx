/**
 * 主区左侧：key 列表。
 *
 * 带过滤框和**滚动到底自动加载下一页** —— `SCAN` 是一条条翻的，
 * 一个几十万 key 的库不可能一次拿完。翻完之前底部一直有「加载更多」兜底，
 * 因为自动加载在窗口很高、首屏没占满时不会触发。
 */

import { useRef, type KeyboardEvent, type ReactNode, type UIEvent } from 'react';
import type { KeyMeta } from '../core/types';
import type { RedisState, RedisStore } from '../state/store';

interface Props {
  state: RedisState;
  store: RedisStore;
}

/** 离底部还有这么多像素就开始加载下一页，省得用户等 */
const PREFETCH_PX = 120;

/** 每种类型的短标签，列表里一眼能分辨 */
const TYPE_LABEL: Record<string, string> = {
  string: 'str',
  list: 'list',
  hash: 'hash',
  set: 'set',
  zset: 'zset',
  stream: 'stm',
  none: '?',
};

export function KeyList({ state, store }: Props): ReactNode {
  const { browse } = state;
  const bodyRef = useRef<HTMLDivElement>(null);

  const onScroll = (e: UIEvent<HTMLDivElement>): void => {
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight > PREFETCH_PX) return;
    void store.loadMoreKeys();
  };

  const onFilterKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void store.reloadKeys();
    }
  };

  if (browse.db === null) {
    return (
      <div className="rd-keylist" data-testid="key-list">
        <div className="rd-empty">在左边选一个库</div>
      </div>
    );
  }

  // 还有下一页的判据：cursor 非 0（0 既是起点也是终点，第一页之后才有效）
  const more = browse.cursor !== 0;

  return (
    <div className="rd-keylist" data-testid="key-list">
      <div className="rd-keylist-head">
        <input
          type="text"
          data-testid="key-filter"
          value={browse.pattern}
          spellCheck={false}
          placeholder="过滤，如 user:*"
          onChange={(e) => store.setPattern(e.target.value)}
          onKeyDown={onFilterKeyDown}
        />
        <button
          type="button"
          data-testid="btn-key-reload"
          title="按当前过滤条件重新加载"
          onClick={() => void store.reloadKeys()}
        >
          刷新
        </button>
      </div>

      <div className="rd-keylist-body" ref={bodyRef} onScroll={onScroll} data-testid="key-list-body">
        {browse.keysError && (
          <div className="rd-hint is-error" data-testid="key-list-error">
            {browse.keysError}
          </div>
        )}

        {browse.keys.length === 0 && !browse.loadingKeys && !browse.keysError && (
          <div className="rd-empty">
            {browse.pattern === '*'
              ? '这个库里没有 key'
              : `没有匹配「${browse.pattern}」的 key`}
          </div>
        )}

        {browse.keys.map((meta) => (
          <KeyRow
            key={meta.key}
            meta={meta}
            selected={browse.selected?.key === meta.key}
            onSelect={() => void store.selectKey(meta)}
          />
        ))}

        {browse.loadingKeys && <div className="rd-db-hint">加载中…</div>}

        {more && !browse.loadingKeys && (
          <button
            type="button"
            className="rd-key-more"
            data-testid="btn-key-more"
            onClick={() => void store.loadMoreKeys()}
          >
            加载更多
          </button>
        )}
      </div>
    </div>
  );
}

function KeyRow({
  meta,
  selected,
  onSelect,
}: {
  meta: KeyMeta;
  selected: boolean;
  onSelect: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      className={`rd-key-row${selected ? ' is-selected' : ''}`}
      data-testid={`key-${meta.key}`}
      data-key-type={meta.keyType}
      title={meta.key}
      onClick={onSelect}
    >
      <span className={`rd-key-type is-${meta.keyType}`}>{TYPE_LABEL[meta.keyType] ?? '?'}</span>
      <span className="rd-key-name">{meta.key}</span>
    </button>
  );
}
