/**
 * 「点一张表生成什么 SQL」这条纯逻辑。
 *
 * 它值得单独测，因为它是**用户第一眼看到的东西**，而且错一次就是一个和他操作
 * 毫无关系的报错（真机上的 `relation "account_api" does not exist` 就是这么来的）。
 */
import { describe, expect, it } from 'vitest';
import {
  defaultSchema,
  displayName,
  qualifyName,
  suggestMongoQuery,
  suggestSelect,
} from '../../src/modules/sql/core/query';

describe('默认 schema', () => {
  it('PostgreSQL 是 public，MySQL / ClickHouse 是当前库', () => {
    expect(defaultSchema('postgres', 'mydb')).toBe('public');
    expect(defaultSchema('mysql', 'mydb')).toBe('mydb');
    expect(defaultSchema('clickhouse', 'mydb')).toBe('mydb');
  });
});

describe('标识符怎么加引号', () => {
  it('普通名字也加：统一加才不会「有时候行有时候不行」', () => {
    expect(qualifyName('postgres', 'db', 'public', 'users')).toBe('"users"');
  });

  it('名字里有双引号就翻倍（SQL 的转义写法）', () => {
    expect(qualifyName('postgres', 'db', 'public', 'we"ird')).toBe('"we""ird"');
  });
});

describe('建议的 SQL', () => {
  it('默认 schema 不带前缀', () => {
    expect(suggestSelect('postgres', 'db', 'public', 'users')).toBe(
      'SELECT * FROM "users" LIMIT 100',
    );
  });

  it('⚠️ 非默认 schema 一定带上 —— 这正是那个 relation 不存在的 bug', () => {
    expect(suggestSelect('postgres', 'db', 'account', 'account_api')).toBe(
      'SELECT * FROM "account"."account_api" LIMIT 100',
    );
  });

  it('MySQL 当前库的表不带前缀（库名就是 schema）', () => {
    expect(suggestSelect('mysql', 'shop', 'shop', 'orders')).toBe(
      'SELECT * FROM "orders" LIMIT 100',
    );
    // 换成别的库的表时要带（连接跨库查询是允许的）
    expect(suggestSelect('mysql', 'shop', 'other', 'orders')).toBe(
      'SELECT * FROM "other"."orders" LIMIT 100',
    );
  });
});

describe('显示名', () => {
  it('默认 schema 只显示表名', () => {
    expect(displayName('postgres', 'db', 'public', 'users')).toBe('users');
  });

  it('非默认 schema 带上前缀（一屏里两个同名的表得分得清）', () => {
    expect(displayName('postgres', 'db', 'account', 'users')).toBe('account.users');
  });
});

describe('Mongo 的查询串', () => {
  it('点一个集合给的是 JSON 查询，不是 SQL', () => {
    const text = suggestMongoQuery('users');
    expect(JSON.parse(text)).toEqual({ collection: 'users', filter: {}, limit: 50 });
  });
});
