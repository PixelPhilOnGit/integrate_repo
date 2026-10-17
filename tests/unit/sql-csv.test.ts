/**
 * 查询结果 → CSV（导出按钮和单行复制共用这份纯函数）。
 */

import { describe, expect, it } from 'vitest';
import { csvBytes, csvFileName, resultToCsv, rowToCsv } from '../../src/modules/sql/core/csv';
import type { QueryResult } from '../../src/modules/sql/core/types';

const result = (rows: ({ text: string | null }[])[]): QueryResult => ({
  columns: [
    { name: 'id', typeName: 'int4' },
    { name: '名字', typeName: 'text' },
  ],
  rows,
  affected: null,
  truncated: false,
  elapsedMs: 1,
});

describe('resultToCsv', () => {
  it('表头 + 行，逗号分隔，CRLF 行尾', () => {
    const csv = resultToCsv(result([[{ text: '1' }, { text: '张三' }]]));
    expect(csv).toBe('id,名字\r\n1,张三');
  });

  it('逗号/引号/换行的字段正确加引号', () => {
    const csv = resultToCsv(
      result([[{ text: 'a,b' }, { text: '带"引号"' }], [{ text: '带\n换行' }, { text: '平' }]]),
    );
    expect(csv).toContain('"a,b"');
    expect(csv).toContain('"带""引号"""');
    expect(csv).toContain('"带\n换行"');
  });

  it('NULL 导出成**空字段**（不是字面量 NULL）', () => {
    const csv = resultToCsv(result([[{ text: null }, { text: '' }]]));
    expect(csv.split('\r\n')[1]).toBe(',');
  });
});

describe('csvBytes / rowToCsv / csvFileName', () => {
  it('字节带 UTF-8 BOM（不加 Excel 中文乱码）', () => {
    const bytes = csvBytes(result([[{ text: '1' }, { text: '张三' }]]));
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder().decode(bytes.slice(3))).toContain('张三');
  });

  it('单行不带表头', () => {
    expect(rowToCsv([{ text: '1' }, { text: 'a,b' }])).toBe('1,"a,b"');
  });

  it('文件名清洗掉路径不友好字符并带时间戳', () => {
    const name = csvFileName('生产/库: 主力', new Date(2026, 9, 16, 21, 40));
    expect(name).toBe('生产_库__主力_20261016-2140.csv');
  });
});
