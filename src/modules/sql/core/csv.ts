/**
 * 查询结果 → CSV（纯函数；导出按钮和单行复制都用它）。
 *
 * # 几条规矩（都是 Excel 实战里来的）
 *
 * * 字段里出现逗号 / 引号 / 换行 → 整体加引号、内部引号翻倍（RFC 4180）；
 * * NULL → **空字段**（而不是字面量 `NULL` 或 `(null)`）：导进 Excel 是空单元格，
 *   回到别的工具里再次导入也不歧义；
 * * 二进制列（非 UTF-8 的字节列）→ 用 lossy 文本 + 后缀 `(binary)`？**不加后缀** ——
 *   后缀会污染数据。就导出 lossy 文本（Rust 侧 `Cell.text` 本来就是 lossy 结果），
 *   真要无损得等「导出二进制」那条路（没有就不装）。
 * * 每个文件的**开头加 UTF-8 BOM**：不加的话 Excel 会把中文读成乱码 ——
 *   这是「导出结果给同事看」最常见的翻车点。
 */

import type { QueryResult } from './types';

export function resultToCsv(result: QueryResult): string {
  const lines: string[] = [];
  lines.push(result.columns.map((c) => csvField(c.name)).join(','));
  for (const row of result.rows) {
    lines.push(row.map((cell) => csvField(cell.text ?? '')).join(','));
  }
  // 行尾统一 \r\n（RFC 4180 的写法，Excel 最稳）
  return lines.join('\r\n');
}

/** 带 BOM 的字节（导出文件直接用这个） */
export function csvBytes(result: QueryResult): Uint8Array {
  const text = resultToCsv(result);
  const body = new TextEncoder().encode(text);
  const out = new Uint8Array(body.length + 3);
  out.set([0xef, 0xbb, 0xbf], 0); // UTF-8 BOM
  out.set(body, 3);
  return out;
}

/** 单行 → CSV（不带表头；「复制此行 / 导出此行」用） */
export function rowToCsv(row: readonly { text: string | null }[]): string {
  return row.map((cell) => csvField(cell.text ?? '')).join(',');
}

function csvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}

/** 单行 → 带 BOM 的字节（「导出此行」直接用） */
export function rowCsvBytes(row: readonly { text: string | null }[]): Uint8Array {
  const body = new TextEncoder().encode(rowToCsv(row));
  const out = new Uint8Array(body.length + 3);
  out.set([0xef, 0xbb, 0xbf], 0);
  out.set(body, 3);
  return out;
}

/** 导出文件名：连接名 + 时间戳（`prod_20261016-2140.csv` 这种） */
export function csvFileName(connectionName: string, now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  const safe = connectionName.replace(/[^\p{L}\p{N}_-]/gu, '_').slice(0, 40);
  return `${safe || 'result'}_${stamp}.csv`;
}
