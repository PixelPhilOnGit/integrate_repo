/**
 * Mongo 的结果区：一份份文档，不是一个表格。
 *
 * # 为什么不复用结果表格
 *
 * 文档是**参差的** —— 这一份有 `email`、那一份没有，硬塞进网格会出现一堆空
 * 单元格，而且长文档会被挤成一行。用户看 Mongo 的结果时想读的是**文档本身**，
 * 所以这里一份一块、带缩进地排开（就像 Navicat / Compass 那样）。
 *
 * # 数据从哪来
 *
 * 后端按约定返回「一列，每行一个文档的 JSON 文本」（见 `conn.rs` 里 Mongo
 * 那条路的说明）。所以这里**不做任何取数**，只负责把那段文本排好看：
 * 能解析就美化，解析不了就原样显示（**绝不吞掉** —— 用户宁可看到一段丑 JSON，
 * 也不能看到一片空白）。
 */

import type { ReactNode } from 'react';
import type { QueryResult } from '../core/types';

export function DocumentList({ result }: { result: QueryResult | null }): ReactNode {
  if (result === null) return null;

  if (result.error !== null && result.error !== undefined) {
    return (
      <div className="rd-sql-result">
        <p className="rd-danger" data-testid="mongo-error">
          {result.error}
        </p>
      </div>
    );
  }

  const rows = result.rows;
  return (
    <div className="rd-sql-result" data-testid="mongo-documents">
      <p className="rd-hint rd-muted" data-testid="mongo-count">
        查到 {rows.length} 份文档
      </p>
      {rows.length === 0 ? (
        <div className="rd-empty">没有匹配的文档</div>
      ) : (
        rows.map((row, i) => (
          <pre className="rd-mongo-doc rd-mono" data-testid={`mongo-doc-${i}`} key={i}>
            {pretty(row[0]?.text ?? '')}
          </pre>
        ))
      )}
    </div>
  );
}

/** 能解析就缩进排开，解析不了就原样返回（别吞） */
function pretty(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}
