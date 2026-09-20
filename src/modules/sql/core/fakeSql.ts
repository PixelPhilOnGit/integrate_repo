/**
 * 浏览器版的内存假 SQL 引擎。
 *
 * 浏览器版必须能完整跑起来 —— 这是整个自动化验证链路的前提：headless 环境里
 * 起不了原生窗口，Playwright 只能驱动普通 Chromium 里的前端。所以这里要有一个
 * **足够真**的引擎：`SELECT * FROM 用户` 得真的回那几行，e2e 断言
 * 「连接 → 查询 → 展示结果」才有意义。
 *
 * # 它不是 SQL 解析器，是有意为之
 *
 * 它**不理解 SQL**，只认几个固定形状（几句话的正则），其余一律回错误。
 * 写一个真解析器不现实，而这个替身要证的是「界面链路通不通」，
 * 不是「SQL 引擎对不对」—— 后者归 Rust 侧打真数据库的集成测试管。
 *
 * 好处是错误分支也能被真实覆盖：随便敲一句不认识的 SQL，就能看到一个
 * **像样的引擎报错**（和真 MySQL 的文案对齐），而不是一个假的「不支持」。
 */

import type { Cell, ColumnInfo, QueryResult, TableInfo } from './types';

/** 演示库里的两张表 */
const TABLES: Record<string, { columns: ColumnInfo[]; rows: (string | null)[][] }> = {
  用户: {
    columns: [
      { name: 'id', typeName: 'int' },
      { name: '姓名', typeName: 'varchar' },
      { name: '城市', typeName: 'varchar' },
      { name: '注册时间', typeName: 'datetime' },
    ],
    rows: [
      ['1', '张三', '北京', '2026-03-11 09:20:00'],
      ['2', '李四', '上海', '2026-05-02 14:05:00'],
      ['3', '王五', null, '2026-08-19 20:41:00'],
    ],
  },
  订单: {
    columns: [
      { name: 'id', typeName: 'int' },
      { name: '用户id', typeName: 'int' },
      { name: '金额', typeName: 'decimal' },
    ],
    rows: [
      ['1001', '1', '199.00'],
      ['1002', '1', '58.50'],
      ['1003', '2', '1280.00'],
    ],
  },
};

/**
 * 演示用的库列表。
 *
 * **必须包含 `postgres`** —— 那是连接档案里 PostgreSQL 的默认库名。
 * 少了它就会出现「连上之后没有任何库是当前库」的怪状态，表一条都显示不出来。
 */
export const DEMO_DATABASES = ['postgres', 'demo', 'information_schema'];

/**
 * 每个库里有哪些表。
 *
 * 做成按库区分而不是「哪个库都回一样的东西」：不然「换库」在界面上看不出效果，
 * 而换库恰恰是这个模块里最需要被验证的交互之一。
 */
const TABLES_BY_DB: Record<string, string[]> = {
  postgres: ['用户', '订单'],
  demo: ['用户', '订单'],
  information_schema: [],
};

export function demoTables(database: string): TableInfo[] {
  // 假实现里**表都在 public 下**（和真机差不多：用户遇到 schema 问题是因为
  // 他的表在别的 schema 里）。想验「非默认 schema」那条路的话，
  // 把某张表改成 `schema: 'sales'` 就能在浏览器里复现 —— 建议的 SQL 会变成
  // `SELECT * FROM "sales"."订单" LIMIT 100`
  return (TABLES_BY_DB[database] ?? []).map((name) => ({
    name,
    schema: 'public',
    kind: 'table',
  }));
}

/**
 * 跑一条 SQL。
 *
 * 认得的形状：
 * - `SELECT 1`（以及 `SELECT <数字>`）—— 最小的连通性检查
 * - `SELECT * FROM <表>` —— 演示数据
 * - `INSERT` / `UPDATE` / `DELETE` —— 回一个影响行数（不改数据，它只是替身）
 *
 * 其余一律回**和真引擎同款文案**的错误。
 */
export function runFakeQuery(sql: string): QueryResult {
  const text = sql.trim().replace(/;+\s*$/, '');
  const started = 0; // 耗时由调用方填，这里不假装知道

  if (text === '') {
    return failure('Query was empty', started);
  }

  // SELECT <数字> —— 最常见的连通性检查
  const literal = /^select\s+(\d+)\s*$/i.exec(text);
  if (literal) {
    return {
      columns: [{ name: String(Number(literal[1] ?? '0')), typeName: 'bigint' }],
      rows: [[{ text: literal[1] ?? '' }]],
      affected: null,
      truncated: false,
      elapsedMs: started,
    };
  }

  // SELECT * FROM <表>（也接受列出列名，但只回全部列）
  const select = /^select\s+.+?\s+from\s+[`"']?([^\s`"';]+)[`"']?/i.exec(text);
  if (select) {
    const table = select[1] ?? '';
    const found = TABLES[table];
    if (found === undefined) {
      // 文案和真 MySQL 对齐 —— 让错误分支看起来是真的
      return failure(`Table 'demo.${table}' doesn't exist`, started);
    }

    return {
      columns: found.columns,
      rows: found.rows.map((row) => row.map(toCell)),
      affected: null,
      truncated: false,
      elapsedMs: started,
    };
  }

  // 写操作：回一个影响行数，但不真的改数据
  const write = /^(insert|update|delete)\b/i.exec(text);
  if (write) {
    if (/\bfrom\s+[`"']?(\S+?)[`"']?$/i.test(text) || /\binto\s+[`"']?(\S+?)[`"']?/i.test(text)) {
      return {
        columns: [],
        rows: [],
        affected: 1,
        truncated: false,
        elapsedMs: started,
      };
    }
  }

  // 其余的都是语法错。和真引擎一样给个位置提示
  return failure(`You have an error in your SQL syntax near '${truncate(text)}'`, started);
}

/** 一个字符串单元格；空串和 NULL 是两回事 */
function toCell(value: string | null): Cell {
  return value === null ? { text: null } : { text: value };
}

function failure(message: string, elapsedMs: number): QueryResult {
  return {
    columns: [],
    rows: [],
    affected: null,
    truncated: false,
    elapsedMs,
    error: message,
  };
}

function truncate(text: string): string {
  return text.length <= 20 ? text : `${text.slice(0, 20)}…`;
}


// ---------------------------------------------------------------- 假的 Mongo

/**
 * 假的集合与文档。
 *
 * ⚠️ **够真是有意的**：这个假实现是 Playwright 唯一能驱动的那条路，Mongo 的
 * 界面（点集合 → 生成 JSON 查询 → 执行 → 读文档）全靠它才验得到。
 * 文档故意做成**参差的**（一份有 email、一份没有），因为那正是「文档不是表格」
 * 这件事的核心 —— 假数据要是整整齐齐，界面把它当表格渲染也看不出来。
 */
const MONGO_COLLECTIONS: Record<string, ReadonlyArray<Record<string, unknown>>> = {
  用户: [
    { _id: 'u1', name: '张三', email: 'zhang@example.com' },
    { _id: 'u2', name: '李四' },
  ],
  订单: [{ _id: 'o1', user: 'u1', total: 128.5 }],
};

/** Mongo 的集合列表（`schema` 就是库名，契约和另外三个引擎一致） */
export function fakeCollections(database: string): TableInfo[] {
  return Object.keys(MONGO_COLLECTIONS).map((name) => ({
    name,
    schema: database,
    kind: 'collection' as const,
  }));
}

/**
 * 跑一段 JSON 查询。
 *
 * 只认契约里那三个字段（`collection` / `filter` / `limit`）：`collection` 必填，
 * `filter` 只支持**顶层字段的等值匹配**（够 e2e 用了，真实现当然不止）。
 */
export function runFakeMongoQuery(text: string): QueryResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return errorResult(`查询不是合法的 JSON：${(e as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return errorResult('查询要是一个 JSON 对象，比如 {"collection":"用户"}');
  }

  const q = parsed as { collection?: unknown; filter?: unknown; limit?: unknown };
  const collection = typeof q.collection === 'string' ? q.collection : '';
  if (collection === '') {
    return errorResult('查询里要写 collection，比如 {"collection":"用户"}');
  }

  const docs = MONGO_COLLECTIONS[collection];
  if (docs === undefined) {
    return errorResult(`没有这个集合：${collection}`);
  }

  const filter =
    typeof q.filter === 'object' && q.filter !== null
      ? (q.filter as Record<string, unknown>)
      : {};
  const limit = typeof q.limit === 'number' && q.limit > 0 ? q.limit : 50;

  const matched = docs
    .filter((doc) => Object.entries(filter).every(([k, v]) => doc[k] === v))
    .slice(0, limit);

  return {
    columns: [{ name: 'document', typeName: 'json' }],
    rows: matched.map((doc) => [{ text: JSON.stringify(doc) }]),
    affected: null,
    truncated: false,
    elapsedMs: 1,
  };
}

/** 引擎报的错走 `error`（**不是抛异常** —— 那是一次成功的往返，只是没执行成） */
function errorResult(message: string): QueryResult {
  return {
    columns: [],
    rows: [],
    affected: null,
    truncated: false,
    elapsedMs: 0,
    error: message,
  };
}
