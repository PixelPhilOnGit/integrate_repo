/**
 * 结果区：表格 / 影响行数 / 引擎报错。
 *
 * 三种结果分开画，因为它们本来就是三件事：
 * - 有行 → 表格
 * - 没有行但有影响行数 → 一句「影响 N 行」
 * - `error` 有值 → 红字报错。**这是引擎拒绝了一条 SQL，不是连接坏了**，
 *   所以它长在结果区里，而不是弹到外壳顶上
 */

import type { ReactNode } from 'react';
import type { QueryResult } from '../core/types';

export function ResultGrid({ result }: { result: QueryResult | null }): ReactNode {
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

  return (
    <div className="rd-sql-result" data-testid="sql-result" data-kind="rows">
      <div className="rd-sql-result-meta">
        {result.rows.length} 行 · 耗时 {result.elapsedMs}ms
        {result.truncated ? ' · 结果被截断，加个 LIMIT 看完整的' : ''}
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
              <tr key={rowIndex}>
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
    </div>
  );
}
