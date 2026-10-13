/**
 * 浏览器版的**假 MongoDB**：解析（`mongoShell.ts`）+ 在内存里真的执行 + 把文档
 * 摆成一张表。
 *
 * # ⚠️ 写入是真的改内存
 *
 * `insertOne` 之后 `find` 真的能看到那条；`deleteMany` 真的删。理由和别处的假实现
 * （fakeSsh 的行规程、fakeRedis 的键空间）一样：**e2e 要验的是界面链路**
 *（执行 → 表格 → 计数 → 历史），一个不改数据的假实现会让「写完再查」那条路
 * 永远验不到。
 *
 * 假的是**引擎的深度**：过滤只支持常用的那几个算子、聚合只支持最常见的几级
 *（见 [`matches`] 和 [`aggregate`] 的文档）。真链路上这些全是 MongoDB 自己干的，
 * 不需要我们「支持」什么 —— 所以这里缺一样东西**不是缺口**，是假实现的边界。
 *
 * # 结果为什么要和真实现长得一样
 *
 * 表格的成形规则（列 = 顶层字段的并集、`_id` 排最前、嵌套压成一行 JSON、
 * ObjectId 给十六进制……）在真实现那边是 `mongo.rs` 的 `docs_to_table`。
 * 两边必须一致，否则 e2e 验的是一个界面上见不到的形状。
 */

import type { QueryResult } from './types';
import { parseMongoQuery, type MongoOp } from './mongoShell';

type Doc = Record<string, unknown>;

/** 字面量里那些「格式化成文本」的值（正则）。 */
const FAKE_SEQ = { next: 1000 };

/** 假集合。**可变** —— 写入类操作要真的改它。 */
let collections: Record<string, Doc[]> = seed();
let indexes: Record<string, Array<Record<string, unknown>>> = {};

function seed(): Record<string, Doc[]> {
  return {
    用户: [
      { _id: 'u1', name: '张三', email: 'zhang@example.com', age: 30, city: '北京', tags: ['admin'] },
      { _id: 'u2', name: '李四', age: 24, city: '上海' },
      { _id: 'u3', name: '王五', email: 'wang@example.com', age: 41, city: '北京', addr: { zip: '100000' } },
    ],
    订单: [
      { _id: 'o1', user: 'u1', total: 128.5, items: [{ sku: 'a', n: 2 }] },
      { _id: 'o2', user: 'u1', total: 42, items: [] },
      { _id: 'o3', user: 'u3', total: 999 },
    ],
  };
}

/** 测试辅助：把假库恢复成种子状态（e2e 每个用例都要干净的前置）。 */
export function __resetFakeMongo(): void {
  collections = seed();
  indexes = {};
  FAKE_SEQ.next = 1000;
}

/** Mongo 的集合列表（`schema` 就是库名，契约和另外三个引擎一致）。 */
export function fakeCollections(database: string): Array<{ name: string; schema: string; kind: 'collection' }> {
  return Object.keys(collections).map((name) => ({
    name,
    schema: database,
    kind: 'collection' as const,
  }));
}

/** 跑一段查询。**不抛异常**：出错走 `QueryResult.error`（一次成功的往返，只是没执行成）。 */
export function runFakeMongoQuery(text: string): QueryResult {
  let command;
  try {
    command = parseMongoQuery(text, '默认库');
  } catch (e) {
    return failure((e as Error).message);
  }

  const { op } = command;
  const name = command.collection;

  // 库级操作
  if (op.op === 'dropDatabase') {
    collections = {};
    return docsToTable([{ acknowledged: true, droppedDatabase: true }]);
  }
  if (op.op === 'createCollection') {
    collections[op.name] ??= [];
    return docsToTable([{ acknowledged: true, createdCollection: op.name }]);
  }

  if (name === undefined) return failure('这个操作要指定集合');

  // ⚠️ 只有**读**才做存在性检查：往不存在的集合里 insert 是合法的（Mongo 会建出来）
  if (isRead(op) && collections[name] === undefined) {
    return failure(`没有这个集合：${name}`);
  }

  try {
    return execute(name, op);
  } catch (e) {
    return failure((e as Error).message);
  }
}

function isRead(op: MongoOp): boolean {
  return [
    'find',
    'findOne',
    'count',
    'estimatedDocumentCount',
    'distinct',
    'aggregate',
    'getIndexes',
    'dropIndex',
  ].includes(op.op);
}

function execute(name: string, op: MongoOp): QueryResult {
  const docs = () => (collections[name] ??= []);

  switch (op.op) {
    case 'find': {
      const want = Math.min(op.limit ?? 50, 1000);
      let list = docs().filter((d) => matches(d, op.filter));
      list = sortDocs(list, op.sort);
      if (op.skip) list = list.slice(op.skip);
      const truncated = list.length > want;
      list = list.slice(0, want).map((d) => project(d, op.projection));
      return docsToTable(list, truncated);
    }
    case 'findOne': {
      let list = docs().filter((d) => matches(d, op.filter));
      list = sortDocs(list, op.sort);
      if (op.skip) list = list.slice(op.skip);
      const first = list[0];
      return docsToTable(first === undefined ? [] : [project(first, op.projection)]);
    }
    case 'count': {
      let list = docs().filter((d) => matches(d, op.filter));
      if (op.skip) list = list.slice(op.skip);
      if (op.limit) list = list.slice(0, op.limit);
      return countTable(list.length);
    }
    case 'estimatedDocumentCount':
      return countTable(docs().length);
    case 'distinct': {
      const seen: unknown[] = [];
      for (const doc of docs()) {
        if (!matches(doc, op.filter)) continue;
        const value = readPath(doc, op.field);
        if (value !== undefined && !seen.some((v) => sameValue(v, value))) seen.push(value);
      }
      return valuesToTable(seen, op.field);
    }
    case 'aggregate':
      return docsToTable(aggregate(docs(), op.pipeline));
    case 'insertOne': {
      const doc = withId({ ...op.document });
      docs().push(doc);
      return docsToTable([{ acknowledged: true, insertedId: doc['_id'] }]);
    }
    case 'insertMany': {
      const ids: Doc = {};
      op.documents.forEach((d, i) => {
        const doc = withId({ ...d });
        docs().push(doc);
        ids[String(i)] = doc['_id'];
      });
      return docsToTable([
        { acknowledged: true, insertedCount: op.documents.length, insertedIds: ids },
      ]);
    }
    case 'update':
    case 'replace': {
      const update = op.op === 'update' ? op.update : op.replacement;
      const list = docs();
      const hits = list.filter((d) => matches(d, op.filter));
      const targets = op.op === 'update' && op.many ? hits : hits.slice(0, 1);
      let modified = 0;
      for (const doc of targets) {
        const next = op.op === 'update' ? applyUpdate(doc, update) : replaceDoc(doc, update);
        if (JSON.stringify(next) !== JSON.stringify(doc)) modified += 1;
        Object.keys(doc).forEach((k) => delete doc[k]);
        Object.assign(doc, next);
      }
      const result: Doc = {
        acknowledged: true,
        matchedCount: targets.length,
        modifiedCount: modified,
      };
      if (targets.length === 0 && op.upsert) {
        // ⚠️ upsert 建出来的新文档**带着 filter 里的等值条件** —— 这是 Mongo 的
        // 规矩，不是我们加的方便：不这样的话
        // `updateOne({name:"新人"}, {$set:{age:1}}, {upsert:true})` 建出来的文档里
        // 没有 name，下一次同样的查询还会再插一条（一条永远收敛不了的 upsert）。
        // 替换（replaceOne）那条路不一样：只把 filter 里的 `_id` 带进去。
        const seed: Doc = {};
        for (const [key, value] of Object.entries(op.filter)) {
          if (key.startsWith('$') || isPlain(value)) continue;
          writePath(seed, key, value);
        }
        const fresh =
          op.op === 'update'
            ? applyUpdate(seed, update)
            : { ...update, ...(seed['_id'] === undefined ? {} : { _id: seed['_id'] }) };
        const doc = withId(fresh);
        list.push(doc);
        result['upsertedId'] = doc['_id'];
      }
      return docsToTable([result]);
    }
    case 'delete': {
      const list = docs();
      const hits = list.filter((d) => matches(d, op.filter));
      const targets = op.many ? hits : hits.slice(0, 1);
      for (const doc of targets) list.splice(list.indexOf(doc), 1);
      return docsToTable([{ acknowledged: true, deletedCount: targets.length }]);
    }
    case 'findOneAndUpdate':
    case 'findOneAndReplace':
    case 'findOneAndDelete': {
      const list = docs();
      const index = list.findIndex((d) => matches(d, op.filter));
      if (op.op === 'findOneAndDelete') {
        if (index < 0) return docsToTable([]);
        const [removed] = list.splice(index, 1);
        return docsToTable(removed === undefined ? [] : [removed]);
      }
      if (index < 0) {
        if (!op.upsert) return docsToTable([]);
        const fresh = op.op === 'findOneAndUpdate' ? applyUpdate({}, op.update) : { ...op.replacement };
        const doc = withId(fresh);
        list.push(doc);
        return docsToTable(op.returnAfter ? [doc] : []);
      }
      const before = structuredClone(list[index] ?? {});
      const next =
        op.op === 'findOneAndUpdate' ? applyUpdate(before, op.update) : replaceDoc(before, op.replacement);
      Object.keys(list[index] ?? {}).forEach((k) => delete (list[index] as Doc)[k]);
      Object.assign(list[index] as Doc, next);
      return docsToTable([op.returnAfter ? (list[index] as Doc) : before]);
    }
    case 'drop': {
      if (collections[name] === undefined) {
        // Mongo 对不存在的集合 drop 会回一个错误（ns not found）—— 如实
        return failure(`没有这个集合：${name}`);
      }
      delete collections[name];
      return docsToTable([{ acknowledged: true, dropped: name }]);
    }
    case 'getIndexes': {
      const created = indexes[name] ?? [];
      return docsToTable([{ name: '_id_', key: { _id: 1 } }, ...created]);
    }
    case 'createIndex': {
      const indexName = op.name ?? Object.entries(op.keys).map(([k, v]) => `${k}_${String(v)}`).join('_');
      const row: Doc = { name: indexName, key: op.keys };
      if (op.unique) row['unique'] = true;
      if (op.sparse) row['sparse'] = true;
      if (op.expireAfterSeconds !== undefined) row['expireAfterSeconds'] = op.expireAfterSeconds;
      (indexes[name] ??= []).push(row);
      return docsToTable([{ createdIndex: indexName }]);
    }
    case 'dropIndex': {
      const list = indexes[name] ?? [];
      const at = list.findIndex((i) => i['name'] === op.name);
      if (at < 0) return failure(`没有这个索引：${op.name}`);
      list.splice(at, 1);
      return docsToTable([{ droppedIndex: op.name }]);
    }
    default:
      return failure('这个操作假实现还不支持');
  }
}

// ------------------------------------------------------------------ 执行的小工具

function withId(doc: Doc): Doc {
  if (doc['_id'] === undefined) {
    FAKE_SEQ.next += 1;
    doc['_id'] = FAKE_SEQ.next.toString(16).padStart(24, '0');
  }
  return doc;
}

function replaceDoc(doc: Doc, replacement: Doc): Doc {
  // `_id` 不能改（Mongo 会报错，这里照做）
  return { ...replacement, _id: doc['_id'] };
}

function applyUpdate(doc: Doc, update: Doc): Doc {
  const next = structuredClone(doc);
  for (const [key, value] of Object.entries(update)) {
    if (key === '$set' && isPlain(value)) {
      for (const [path, v] of Object.entries(value)) writePath(next, path, v);
    } else if (key === '$unset' && isPlain(value)) {
      for (const path of Object.keys(value)) writePath(next, path, undefined);
    } else if (key === '$inc' && isPlain(value)) {
      for (const [path, v] of Object.entries(value)) {
        const current = readPath(next, path);
        writePath(next, path, (typeof current === 'number' ? current : 0) + Number(v));
      }
    } else if (key.startsWith('$')) {
      throw new Error(`假实现还不支持更新算子 ${key}（真实现里是 MongoDB 自己干的，$set / $unset / $inc 有）`);
    } else {
      // 不带算子的更新对象 = 整个替换（Mongo 会直接报错，这里也报）
      throw new Error('更新要用算子（$set / $inc / $unset），不能直接给字段');
    }
  }
  return next;
}

function isPlain(value: unknown): value is Doc {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 点号路径读（`addr.zip`）。 */
function readPath(doc: Doc, path: string): unknown {
  let current: unknown = doc;
  for (const part of path.split('.')) {
    if (!isPlain(current)) return undefined;
    current = current[part];
  }
  return current;
}

function writePath(doc: Doc, path: string, value: unknown): void {
  const parts = path.split('.');
  let current: Doc = doc;
  for (const part of parts.slice(0, -1)) {
    const next = current[part];
    if (!isPlain(next)) current[part] = {};
    current = current[part] as Doc;
  }
  const last = parts[parts.length - 1] ?? '';
  if (value === undefined) delete current[last];
  else current[last] = value;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * 过滤匹配。
 *
 * 支持的算子：等值（含点号路径）、`$gt` `$gte` `$lt` `$lte` `$ne` `$in` `$nin`
 * `$exists` `$regex`（正则字面量也认）。⚠️ 这是**假实现的边界**，不是「还缺什么」——
 * 真链路上过滤是 MongoDB 自己干的。
 */
function matches(doc: Doc, filter: Doc): boolean {
  return Object.entries(filter).every(([key, condition]) => {
    const value = readPath(doc, key);

    if (isPlain(condition) && Object.keys(condition).some((k) => k.startsWith('$'))) {
      return Object.entries(condition).every(([op, operand]) => {
        switch (op) {
          case '$gt':
            return typeof value === 'number' && value > Number(operand);
          case '$gte':
            return typeof value === 'number' && value >= Number(operand);
          case '$lt':
            return typeof value === 'number' && value < Number(operand);
          case '$lte':
            return typeof value === 'number' && value <= Number(operand);
          case '$ne':
            return !sameValue(value, operand);
          case '$in':
            return Array.isArray(operand) && operand.some((o) => sameValue(value, o));
          case '$nin':
            return Array.isArray(operand) && !operand.some((o) => sameValue(value, o));
          case '$exists':
            return operand === true ? value !== undefined : value === undefined;
          case '$regex':
            return new RegExp(String(operand)).test(String(value ?? ''));
          default:
            throw new Error(`假实现还不支持过滤算子 ${op}`);
        }
      });
    }

    if (condition instanceof RegExp) return typeof value === 'string' && condition.test(value);
    return sameValue(value, condition);
  });
}

/** 排序（多字段按写的顺序）。 */
function sortDocs(list: Doc[], sort: Doc | undefined): Doc[] {
  if (sort === undefined) return list;
  const keys = Object.entries(sort);
  return [...list].sort((a, b) => {
    for (const [key, direction] of keys) {
      const x = readPath(a, key);
      const y = readPath(b, key);
      if (sameValue(x, y)) continue;
      const factor = Number(direction) < 0 ? -1 : 1;
      if (x === undefined) return -1 * factor;
      if (y === undefined) return 1 * factor;
      if (typeof x === 'number' && typeof y === 'number') return (x - y) * factor;
      return String(x).localeCompare(String(y)) * factor;
    }
    return 0;
  });
}

/** 投影：`{字段: 1}` 只留、`{字段: 0}` 去掉（不能混着用，和 Mongo 一样）。 */
function project(doc: Doc, projection: Doc | undefined): Doc {
  if (projection === undefined) return doc;
  const entries = Object.entries(projection);
  const includes = entries.filter(([, v]) => Number(v) === 1).map(([k]) => k);
  const excludes = entries.filter(([, v]) => Number(v) === 0).map(([k]) => k);
  if (includes.length > 0 && excludes.length > 0 && !excludes.includes('_id')) {
    throw new Error('投影里不能混着写「要」和「不要」（除了 _id）');
  }
  if (includes.length > 0) {
    const out: Doc = {};
    for (const key of includes) {
      const value = readPath(doc, key);
      if (value !== undefined) writePath(out, key, value);
    }
    if (!excludes.includes('_id') && doc['_id'] !== undefined) out['_id'] = doc['_id'];
    return out;
  }
  const out = structuredClone(doc);
  for (const key of excludes) writePath(out, key, undefined);
  return out;
}

/**
 * 聚合管道的一个**子集**：`$match` `$sort` `$skip` `$limit` `$count` `$group` `$project`。
 *
 * ⚠️ `$group` 只认 `_id` 分组和几个累加器（`$sum` / `$avg` / `$min` / `$max` / `$push`）。
 * 真链路上整个管道都是 MongoDB 跑的。
 */
function aggregate(input: Doc[], pipeline: Doc[]): Doc[] {
  let docs = [...input];
  for (const stage of pipeline) {
    const [key] = Object.keys(stage);
    const value = stage[key ?? ''];
    switch (key) {
      case '$match':
        docs = docs.filter((d) => matches(d, (value ?? {}) as Doc));
        break;
      case '$sort':
        docs = sortDocs(docs, value as Doc);
        break;
      case '$skip':
        docs = docs.slice(Number(value));
        break;
      case '$limit':
        docs = docs.slice(0, Number(value));
        break;
      case '$count':
        docs = [{ [String(value)]: docs.length }];
        break;
      case '$project':
        docs = docs.map((d) => project(d, value as Doc));
        break;
      case '$group': {
        const spec = (value ?? {}) as Doc;
        const groups = new Map<string, Doc[]>();
        for (const doc of docs) {
          const id = evaluateExpression(spec['_id'], doc);
          const bucketKey = JSON.stringify(id);
          const bucket = groups.get(bucketKey);
          if (bucket === undefined) groups.set(bucketKey, [doc]);
          else bucket.push(doc);
        }
        docs = [...groups.entries()].map(([bucketKey, bucket]) => {
          const out: Doc = { _id: JSON.parse(bucketKey) as unknown };
          for (const [field, accumulator] of Object.entries(spec)) {
            if (field === '_id') continue;
            out[field] = accumulate(accumulator, bucket);
          }
          return out;
        });
        break;
      }
      default:
        throw new Error(`假实现还不支持聚合阶段 ${key}（$match/$sort/$group/$skip/$limit/$count/$project 有）`);
    }
  }
  return docs;
}

/** `"$city"` 这种字段引用（假实现只认整段的单字段引用）。 */
function evaluateExpression(expression: unknown, doc: Doc): unknown {
  if (typeof expression === 'string' && expression.startsWith('$')) {
    return readPath(doc, expression.slice(1));
  }
  return expression ?? null;
}

function accumulate(spec: unknown, docs: Doc[]): unknown {
  const [op] = isPlain(spec) ? Object.keys(spec) : [];
  const operand = isPlain(spec) ? spec[op ?? ''] : undefined;
  const values = docs.map((d) => evaluateExpression(operand, d)).filter((v) => v !== undefined);
  switch (op) {
    case '$sum':
      return values.reduce((sum: number, v) => sum + (typeof v === 'number' ? v : 0), 0);
    case '$avg':
      return values.length === 0
        ? null
        : values.reduce((sum: number, v) => sum + (typeof v === 'number' ? v : 0), 0) / values.length;
    case '$min':
      return values.reduce((min: unknown, v) => (min === undefined || (v as number) < (min as number) ? v : min), undefined) ?? null;
    case '$max':
      return values.reduce((max: unknown, v) => (max === undefined || (v as number) > (max as number) ? v : max), undefined) ?? null;
    case '$push':
      return values;
    default:
      throw new Error(`假实现还不支持累加器 ${op}`);
  }
}

// ------------------------------------------------------------------ 摆成表格

/**
 * 一批文档 → 一张表。
 *
 * ⚠️ 规则必须和真实现（`sql/src/mongo.rs` 的 `docs_to_table`）**一字不差**：
 * 列 = 顶层字段的并集、`_id` 排最前、缺的字段是 NULL（不是空串）、
 * 嵌套的值压成一行 JSON。
 */
export function docsToTable(docs: Doc[], truncated = false): QueryResult {
  const names = columnNames(docs);
  const rows = docs.map((doc) =>
    names.map((name) => {
      const value = doc[name];
      return value === undefined || value === null ? { text: null } : { text: cellText(value) };
    }),
  );
  return {
    columns: names.map((name) => ({ name, typeName: 'any' })),
    rows,
    affected: null,
    truncated,
    elapsedMs: 1,
  };
}

function countTable(n: number): QueryResult {
  return {
    columns: [{ name: 'count', typeName: 'number' }],
    rows: [[{ text: String(n) }]],
    affected: null,
    truncated: false,
    elapsedMs: 1,
  };
}

function valuesToTable(values: unknown[], column: string): QueryResult {
  return {
    columns: [{ name: column, typeName: 'any' }],
    rows: values.map((value) => [{ text: value === null || value === undefined ? null : cellText(value) }]),
    affected: null,
    truncated: false,
    elapsedMs: 1,
  };
}

function columnNames(docs: Doc[]): string[] {
  const names: string[] = [];
  let hasId = false;
  for (const doc of docs) {
    for (const key of Object.keys(doc)) {
      if (key === '_id') {
        hasId = true;
        continue;
      }
      if (!names.includes(key)) names.push(key);
    }
  }
  if (hasId) names.unshift('_id');
  return names;
}

/** 一个值 → 单元格里的文本（字符串不加引号，其余按 `humanize` 再字符串化）。 */
function cellText(value: unknown): string {
  if (typeof value === 'string') return value;
  const humanized = humanize(value);
  return typeof humanized === 'string' ? humanized : JSON.stringify(humanized);
}

/** 给人看的样子（⚠️ 和 Rust 的 `humanize` 同一套规矩）。 */
function humanize(value: unknown): unknown {
  if (value instanceof RegExp) return `/${value.source}/${value.flags}`;
  if (Array.isArray(value)) return value.map(humanize);
  if (isPlain(value)) {
    const out: Doc = {};
    for (const [k, v] of Object.entries(value)) out[k] = humanize(v);
    return out;
  }
  return value ?? null;
}

/** 引擎报的错走 `error`（**不是抛异常** —— 那是一次成功的往返，只是没执行成）。 */
function failure(message: string): QueryResult {
  return {
    columns: [],
    rows: [],
    affected: null,
    truncated: false,
    elapsedMs: 0,
    error: message,
  };
}
