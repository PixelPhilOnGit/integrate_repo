/**
 * 主区：上面一个页签，下面是要么「浏览」要么「命令台」。
 *
 * 浏览是**默认**页签 —— 这个模块的主界面是「看数据」，不是「敲命令」。
 * 命令台留着，但它现在是补充：想跑一条菜单里没有的命令时用。
 */

import type { ReactNode } from 'react';
import { Console } from './Console';
import { KeyList } from './KeyList';
import { ValueView } from './ValueView';
import type { RedisState, RedisStore } from '../state/store';

interface Props {
  state: RedisState;
  store: RedisStore;
}

export function BrowsePane({ state, store }: Props): ReactNode {
  return (
    <div className="rd-browse" data-testid="redis-main">
      <div className="rd-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={state.tab === 'browse'}
          className={state.tab === 'browse' ? 'is-active' : ''}
          data-testid="tab-browse"
          onClick={() => store.setTab('browse')}
        >
          浏览
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={state.tab === 'console'}
          className={state.tab === 'console' ? 'is-active' : ''}
          data-testid="tab-console"
          onClick={() => store.setTab('console')}
        >
          命令台
        </button>
      </div>

      {state.tab === 'browse' ? (
        <div className="rd-browse-split">
          <KeyList state={state} store={store} />
          <ValueView state={state} store={store} />
        </div>
      ) : (
        <Console state={state} store={store} />
      )}
    </div>
  );
}
