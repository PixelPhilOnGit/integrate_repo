import { describe, expect, it } from 'vitest';
import { DEMO_DATABASES, demoTables, runFakeQuery } from '../../src/modules/sql/core/fakeSql';

describe('假 SQL 引擎', () => {
  it('SELECT 1 回一行', () => {
    const result = runFakeQuery('SELECT 1');
    expect(result.error).toBeUndefined();
    expect(result.rows).toEqual([[{ text: '1' }]]);
    expect(result.columns).toHaveLength(1);
  });

  it('大小写和结尾分号都不影响', () => {
    expect(runFakeQuery('select 1;').rows).toEqual([[{ text: '1' }]]);
    expect(runFakeQuery('  SELECT  1  ').rows).toEqual([[{ text: '1' }]]);
  });

  it('SELECT FROM 演示表回真数据', () => {
    const result = runFakeQuery('SELECT * FROM 用户');
    expect(result.error).toBeUndefined();
    expect(result.columns.map((c) => c.name)).toEqual(['id', '姓名', '城市', '注册时间']);
    expect(result.rows).toHaveLength(3);
    expect(result.rows[0]?.[1]).toEqual({ text: '张三' });
  });

  it('列出列名也认（虽然只回全部列）', () => {
    const result = runFakeQuery('SELECT id, 姓名 FROM 用户');
    expect(result.error).toBeUndefined();
    expect(result.rows).toHaveLength(3);
  });

  it('表名带反引号也认', () => {
    expect(runFakeQuery('SELECT * FROM `订单`').rows).toHaveLength(3);
  });

  /** NULL 和空串是两回事 —— 演示数据里特意留了一个 NULL */
  it('NULL 是 null，不是空串', () => {
    const result = runFakeQuery('SELECT * FROM 用户');
    // 王五那一行的「城市」是 NULL
    expect(result.rows[2]?.[2]).toEqual({ text: null });
  });

  it('写操作回影响行数', () => {
    const result = runFakeQuery("INSERT INTO 用户 VALUES (4, '赵六', '广州', '2026-09-17')");
    expect(result.error).toBeUndefined();
    expect(result.affected).toBe(1);
    expect(result.rows).toEqual([]);
  });

  /**
   * 报错分支也要像真的 —— 这样 e2e 断言「错误显示在结果区里」
   * 才有意义，而不是对着一个假的「不支持」自欺。
   */
  it('不存在的表给的是引擎原话，不是「不支持」', () => {
    const result = runFakeQuery('SELECT * FROM 不存在的表');
    expect(result.error).toContain("doesn't exist");
    expect(result.error).toContain('不存在的表');
    expect(result.rows).toEqual([]);
  });

  it('乱敲的 SQL 给语法错', () => {
    const result = runFakeQuery('这是一句瞎写的');
    expect(result.error).toContain('syntax');
  });

  it('空 SQL 给空查询的错误', () => {
    expect(runFakeQuery('   ').error).toContain('empty');
  });

  it('库和表列表是稳定的', () => {
    expect(DEMO_DATABASES).toContain('demo');
    const tables = demoTables();
    // 别对中文的排序顺序做断言：JS 的 sort 按码点比（用 U+7528 < 订 U+8BA2），
    // 和「拼音顺序」不是一回事，写死了只会让测试变脆
    expect(new Set(tables.map((t) => t.name))).toEqual(new Set(['用户', '订单']));
    expect(tables.every((t) => t.kind === 'table')).toBe(true);
  });
});
