/**
 * 主区：编辑器 + 结果。
 *
 * 编辑器用普通 `<textarea>`，不上代码编辑器组件：查询台要的是「能敲、能执行、
 * 能看结果」，语法高亮和补全属于另一个量级的工程，等真有人天天用它写长 SQL 再说。
 *
 * # 一个面板管两种引擎（按选中的连接分流）
 *
 * SQL 那三种（PG / MySQL / ClickHouse）和 **Mongo** 共用编辑器、执行按钮、
 * 历史快捷键那些 —— 它们是**同一个操作**（写点什么 → 执行 → 看结果）：
 *
 * | | 写什么 |
 * |---|---|
 * | SQL | 一条 SQL |
 * | Mongo | `db.users.find({}).limit(10)` 那种 |
 *
 * 结果那一块现在也**共用**（`ResultGrid`）：2026-10-13 起 Mongo 的结果是一张
 * 表格（列 = 文档顶层字段的并集，一行一份文档），不再是一列一整段 JSON ——
 * 用户的原话是「不应该是类似于表格一样展示吗，一整个 json 怎么看」。
 * 所以这个文件里连「Mongo 走哪套渲染」这个分流都不需要了。
 */

import type { KeyboardEvent, ReactNode } from 'react';
import { shortcutLabel } from '../../../shared/platform/detect';
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
  /** Mongo 走文档那条路：写的是 JSON 查询，结果是一份份文档 */
  const mongo = profile?.kind === 'mongodb';

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
          placeholder={
            !connected
              ? '先连上一个数据库'
              : mongo
                ? 'db.users.find({ age: { $gt: 18 } }).sort({ age: -1 }).limit(50) —— Ctrl+Enter 执行'
                : '在这里写 SQL，Ctrl+Enter 执行'
          }
          onChange={(e) => store.setEditor(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="rd-sql-actions">
          <button
            type="button"
            data-testid="btn-sql-run"
            // 灰着的时候要说出为什么（2026-10-15 体验评审：灰按钮 + 静默的
            // Ctrl+Enter = 「点了按了都没反应，也没人告诉我为什么」）
            title={!connected ? '先连上一个数据库' : undefined}
            disabled={disabled || state.editor.trim() === ''}
            onClick={() => void store.run()}
          >
            {state.running ? '执行中…' : '执行'}
          </button>
          {!connected && (
            <span className="rd-hint is-error" data-testid="sql-run-blocker">
              先连上一个数据库 —— 左上角连接行的「连接」按钮，或右键选「连接」
            </span>
          )}
          <span
            className="rd-hint"
            // ⚠️ 命令清单挪进 title（2026-10-15 体验评审）：原来整句排在
            // 工具条上，窄一点就换行、第二行只剩一个孤零零的「认」吊着。
            // 清单本身还是有用的，进 tooltip 不减信息量
            title={
              mongo
                ? '支持：find / findOne / countDocuments / count / estimatedDocumentCount / distinct / aggregate / insert / update / delete'
                : undefined
            }
          >
            {/* 修饰键按平台翻（mac 上是 ⌘/⌥）——见 shortcutLabel */}
            {mongo
              ? `${shortcutLabel('Ctrl+Enter')} 执行 · 点左边的集合会自动填一段查询`
              : `${shortcutLabel('Ctrl+Enter')} 执行 · ${shortcutLabel('Alt+↑↓')} 翻历史`}
          </span>
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
