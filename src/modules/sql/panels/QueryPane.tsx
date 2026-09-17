/**
 * 主区：SQL 编辑器 + 结果。
 *
 * 编辑器用普通 `<textarea>`，不上代码编辑器组件：查询台要的是「能敲、能执行、
 * 能看结果」，语法高亮和补全属于另一个量级的工程，等真有人天天用它写长 SQL 再说。
 */

import type { KeyboardEvent, ReactNode } from 'react';
import type { SqlState, SqlStore } from '../state/store';
import { ResultGrid } from './ResultGrid';

interface Props {
  state: SqlState;
  store: SqlStore;
}

export function QueryPane({ state, store }: Props): ReactNode {
  const profile = store.selectedProfile();
  const connected = profile !== null && state.runtime[profile.id]?.status === 'connected';
  const disabled = !connected || state.running;

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    // Ctrl/Cmd+Enter 执行 —— 和多数 SQL 客户端一致，省得每次都去点按钮
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      void store.run();
      return;
    }

    // 历史用 Alt+上下：**不能占用裸的上下键**，那在文本框里是移动光标
    if (e.altKey && e.key === 'ArrowUp') {
      e.preventDefault();
      store.historyPrev();
      return;
    }
    if (e.altKey && e.key === 'ArrowDown') {
      e.preventDefault();
      store.historyNext();
    }
  };

  return (
    <div className="rd-query-pane" data-testid="sql-main">
      <div className="rd-sql-editor">
        <textarea
          data-testid="sql-editor"
          value={state.editor}
          spellCheck={false}
          placeholder={connected ? '在这里写 SQL，Ctrl+Enter 执行' : '先连上一个数据库'}
          onChange={(e) => store.setEditor(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="rd-sql-actions">
          <button
            type="button"
            data-testid="btn-sql-run"
            disabled={disabled || state.editor.trim() === ''}
            onClick={() => void store.run()}
          >
            {state.running ? '执行中…' : '执行'}
          </button>
          <span className="rd-hint">Ctrl+Enter 执行 · Alt+↑↓ 翻历史</span>
          {profile !== null && (
            <span className="rd-hint rd-right" data-testid="sql-target">
              {state.runtime[profile.id]?.server?.database ?? profile.database}
            </span>
          )}
        </div>
      </div>

      <ResultGrid result={state.result} />
    </div>
  );
}
