/**
 * 结果区：表格 / 影响行数 / 引擎报错。
 *
 * 三种结果分开画，因为它们本来就是三件事：
 * - 有行 → 表格
 * - 没有行但有影响行数 → 一句「影响 N 行」
 * - `error` 有值 → 红字报错。**这是引擎拒绝了一条 SQL，不是连接坏了**，
 *   所以它长在结果区里，而不是弹到外壳顶上
 */

import { useState, type ReactNode } from 'react';
import { platform } from '../../../shared/platform';
import { ContextMenu, type MenuItem } from '../../../shared/ui/ContextMenu';
import { csvBytes, csvFileName, rowCsvBytes, rowToCsv } from '../core/csv';
import { HARD_MAX_ROWS, MAX_ROWS_DEFAULT, type QueryResult } from '../core/types';
import { sqlStore } from '../state/store';

export function ResultGrid({ result }: { result: QueryResult | null }): ReactNode {
  // ⚠️ hooks 在早返回之前（早返回有好几个）
  const [rowMenu, setRowMenu] = useState<{ x: number; y: number; rowIndex: number } | null>(null);

  if (result === null) {
    return (
      <div className="rd-empty" data-testid="sql-result">
        写完 SQL 点「执行」（或按 Ctrl+Enter）
      </div>
    );
  }

  if (result.error !== undefined) {
    return (
      <div className="rd-sql-error" data-testid="sql-result" data-kind="error">
        {result.error}
      </div>
    );
  }

  if (result.rows.length === 0 && result.affected !== null) {
    return (
      <div className="rd-empty" data-testid="sql-result" data-kind="affected">
        执行成功，影响 {result.affected} 行（耗时 {result.elapsedMs}ms）
      </div>
    );
  }

  if (result.rows.length === 0) {
    return (
      <div className="rd-empty" data-testid="sql-result" data-kind="empty">
        查询成功，没有返回任何行（耗时 {result.elapsedMs}ms）
      </div>
    );
  }

  // —— result 到这里已经窄化过了，助手函数放这儿 ——

  /** 当前连接名（导出文件名用） */
  const connectionName =
    ((): string => {
      const snap = sqlStore.getSnapshot();
      return snap.profiles.find((p) => p.id === snap.selectedId)?.name ?? 'result';
    })();

  const exportAll = (): void => {
    void (async () => {
      const name = csvFileName(connectionName, new Date());
      const saved = await platform.exportFile(name, csvBytes(result), 'text/csv');
      if (saved !== null) sqlStore.reportStatus(`已导出 ${result.rows.length} 行 → ${saved}`);
    })().catch((e: unknown) => sqlStore.reportStatus(`导出失败：${String(e)}`));
  };

  const rowItems = (rowIndex: number): MenuItem[] => {
    const row = result.rows[rowIndex];
    if (row === undefined) return [];
    return [
      {
        label: '复制此行',
        onSelect: () => {
          void navigator.clipboard
            .writeText(rowToCsv(row))
            .then(() => sqlStore.reportStatus('这一行已经复制（CSV 字段）'))
            .catch(() => sqlStore.reportStatus('复制失败：剪贴板不可用'));
        },
      },
      {
        label: '导出此行为 CSV…',
        onSelect: () => {
          void (async () => {
            const name = csvFileName(`${connectionName}_第${rowIndex + 1}行`, new Date());
            const saved = await platform.exportFile(name, rowCsvBytes(row), 'text/csv');
            if (saved !== null) sqlStore.reportStatus(`已导出这一行 → ${saved}`);
          })();
        },
      },
    ];
  };

  return (
    <div className="rd-sql-result" data-testid="sql-result" data-kind="rows">
      <div className="rd-sql-result-meta">
        {result.rows.length} 行 · 耗时 {result.elapsedMs}ms
        {result.truncated && (
          <>
            {' · '}
            <span data-testid="sql-truncated">结果被截断</span>
            <button
              type="button"
              className="rd-btn"
              data-testid="sql-fetch-more"
              title={`一次加 ${MAX_ROWS_DEFAULT} 行，最多到 ${HARD_MAX_ROWS} 行`}
              onClick={() => sqlStore.fetchMore()}
            >
              再取 {MAX_ROWS_DEFAULT} 行
            </button>
          </>
        )}
        <span className="rd-spacer" />
        <button
          type="button"
          className="rd-btn"
          data-testid="sql-export-csv"
          title="把当前结果（含表头）导出为 CSV，Excel 直接能开"
          onClick={exportAll}
        >
          导出 CSV…
        </button>
      </div>

      <div className="rd-sql-table-wrap">
        <table className="rd-sql-table" data-testid="sql-table">
          <thead>
            <tr>
              <th className="rd-sql-rownum" />
              {result.columns.map((column, i) => (
                <th key={`${column.name}-${i}`} title={column.typeName}>
                  {column.name}
                  {column.typeName !== '' && <span className="rd-sql-coltype">{column.typeName}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row, rowIndex) => (
              // 行没有稳定 id（同一条 SQL 每次结果都可能不同），用下标即可
              <tr
                key={rowIndex}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setRowMenu({ x: e.clientX, y: e.clientY, rowIndex });
                }}
              >
                <td className="rd-sql-rownum">{rowIndex + 1}</td>
                {row.map((cell, colIndex) => (
                  <td
                    key={colIndex}
                    // NULL 和空串在视觉上必须分得开：前者是灰的斜体 (NULL)
                    className={cell.text === null ? 'is-null' : undefined}
                    title={cell.binary === true ? '二进制内容' : undefined}
                  >
                    {cell.text === null ? '(NULL)' : cell.binary === true ? '(二进制)' : cell.text}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {rowMenu !== null && (
        <ContextMenu
          x={rowMenu.x}
          y={rowMenu.y}
          items={rowItems(rowMenu.rowIndex)}
          onClose={() => setRowMenu(null)}
        />
      )}
    </div>
  );
}
