/**
 * 从表生成「点一下就执行」的 SQL。
 *
 * # 为什么是纯函数、单独一个文件
 *
 * 这条 SQL 是**用户第一眼看到的东西** —— 它错一次（比如漏了 schema），用户就
 * 会撞上一个跟自己操作毫无关系的报错（真机上报过：`relation "account_api"
 * does not exist`，因为表在非 `public` 的 schema 里，而生成的是裸表名）。
 * 抽出来之后，「该不该带 schema、要不要加引号」这些判断不用起数据库就能测。
 *
 * # 两条规矩
 *
 * 1. **schema 不是默认的那个就带上**（PostgreSQL 的默认是 `public`，MySQL /
 *    ClickHouse 是当前库）。带上是唯一能让跨 schema 的表选得中的写法 ——
 *    PG 解析裸表名只看 `search_path`。
 * 2. **名字一律加双引号。** 大小写混写的表名（`"AccountAPI"`）不加引号选不中，
 *    而加引号对普通小写名毫无影响 —— 所以统一加，省得「有时候行有时候不行」。
 *    引号是 SQL 的双引号，**里面的双引号要翻倍**（`"` → `""`）才是转义。
 */
import type { SqlKind } from './types';

/** 这种引擎的「默认 schema」——名字等于它的时候就省略 */
export function defaultSchema(kind: SqlKind, database: string): string {
  switch (kind) {
    case 'postgres':
      return 'public';
    // MySQL / ClickHouse 的「schema」就是当前库
    case 'mysql':
    case 'clickhouse':
      return database;
    case 'mongodb':
      return '';
  }
}

/**
 * 点一张表时该塞给编辑器的那句 SQL。
 *
 * ⚠️ **Mongo 没有 SQL**：那边传的是 JSON 查询（形如
 * `{"collection":"users","filter":{},"limit":50}`），由调用方分流，别走到这里。
 */
export function suggestSelect(
  kind: SqlKind,
  database: string,
  schema: string,
  name: string,
): string {
  return `SELECT * FROM ${qualifyName(kind, database, schema, name)} LIMIT 100`;
}

/**
 * 表名该怎么写：非默认 schema 带上 schema，名字一律加引号。
 *
 * 侧栏那行的 `title` 也用这个 —— 让用户**先看见**会生成什么，
 * 而不是点下去才发现报错。
 */
export function qualifyName(
  kind: SqlKind,
  database: string,
  schema: string,
  name: string,
): string {
  const needsSchema = schema !== '' && schema !== defaultSchema(kind, database);
  return needsSchema ? `${quoteIdent(schema)}.${quoteIdent(name)}` : quoteIdent(name);
}

/** 侧栏里显示的名字：非默认 schema 时带上它（否则一屏表里两个同名的分不清） */
export function displayName(kind: SqlKind, database: string, schema: string, name: string): string {
  const needsSchema = schema !== '' && schema !== defaultSchema(kind, database);
  return needsSchema ? `${schema}.${name}` : name;
}

/** Mongo 那边点一个集合时塞进查询框的 JSON */
export function suggestMongoQuery(collection: string): string {
  return JSON.stringify({ collection, filter: {}, limit: 50 }, null, 2);
}

/** SQL 标识符加引号（双引号翻倍转义） */
function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}
