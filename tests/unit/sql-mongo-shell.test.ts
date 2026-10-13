/**
 * Mongo 这边的纯逻辑：**语法契约**（和 Rust 那份对齐）+ 假实现的执行与成形。
 *
 * # 最重要的那一条是「契约用例和共享夹具一致」
 *
 * 语法被实现了两遍（Rust 的真实现、这里的浏览器版），两遍就会漂移 ——
 * 而漂移的症状是「e2e 绿的、真机上打不开」。两边都拿
 * `tests/fixtures/mongo-queries.json` 跑一遍，就是这个文件的头等大事。
 * （Rust 那边对着同一条写在 `mongo_shell.rs` 末尾。）
 *
 * # 其次才是假实现的语义
 *
 * 表格怎么成形（列 = 并集、`_id` 最前、缺的是 NULL）、写操作真的改内存 ——
 * 这些要和真实现一致，否则 e2e 验的是一个界面上见不到的形状。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseMongoQuery } from '../../src/modules/sql/core/mongoShell';
import {
  __resetFakeMongo,
  docsToTable,
  fakeCollections,
  runFakeMongoQuery,
} from '../../src/modules/sql/core/fakeMongo';
import type { QueryResult } from '../../src/modules/sql/core/types';

beforeEach(() => __resetFakeMongo());

/** 把值里那些「只在 JS 里存在」的东西（正则）拍成文本，好和夹具比。 */
function normalize(value: unknown): unknown {
  if (value instanceof RegExp) return `/${value.source}/${value.flags}`;
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v)]));
  }
  return value;
}

/**
 * 解析结果 → 一段可比较的 JSON。
 *
 * ⚠️ 缺省值不写：filter 空对象、false 的那些开关（upsert / returnAfter / unique /
 * sparse）都不出现在结果里 —— 和 Rust 那边 `summary()` 的规矩一致。
 * `many` 例外：`false` 是有意义的（updateOne vs updateMany），要留着。
 */
function summary(command: ReturnType<typeof parseMongoQuery>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (command.collection !== undefined) out['collection'] = command.collection;
  out['op'] = command.op.op;

  const op = command.op as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(op)) {
    if (key === 'op' || value === undefined) continue;
    if (value === false && key !== 'many') continue;
    if (key === 'filter' && typeof value === 'object' && Object.keys(value as object).length === 0) {
      continue;
    }
    out[key] = normalize(value);
  }
  return out;
}

describe('⚠️ 契约用例和共享夹具一致（和 Rust 那份对齐）', () => {
  const fixture = JSON.parse(
    readFileSync(new URL('../fixtures/mongo-queries.json', import.meta.url), 'utf8'),
  ) as { cases: Array<Record<string, unknown>> };

  it('夹具本身是有内容的（空夹具等于没测）', () => {
    expect(fixture.cases.length).toBeGreaterThan(20);
  });

  for (const [index, entry] of fixture.cases.entries()) {
    const query = String(entry['query']);
    it(`#${index} ${query}`, () => {
      const command = parseMongoQuery(query, '默认库');
      const expected = { ...entry };
      delete expected['query'];
      expect(summary(command)).toEqual(expected);
    });
  }
});

describe('真假两版的分流', () => {
  it('db 开头走 shell 语法', () => {
    expect(parseMongoQuery('db.users.find({})').collection).toBe('users');
  });

  it('不是 db 开头就按 JSON（老写法还认，用户历史里躺着那种）', () => {
    const command = parseMongoQuery('{"collection":"users","limit":5}');
    expect(command.collection).toBe('users');
    expect(command.op).toMatchObject({ op: 'find', limit: 5 });
  });

  it('两样都不是时，两种写法都提一遍', () => {
    expect(() => parseMongoQuery('{不是 JSON')).toThrow(/db\.users\.find/);
  });

  it('前面带注释的也走 shell 那条路', () => {
    expect(parseMongoQuery('// 查用户\ndb.users.find({})').collection).toBe('users');
  });
});

describe('假实现：表格怎么成形', () => {
  const table = (c: unknown[]): QueryResult => docsToTable(c as Array<Record<string, unknown>>);

  it('列是顶层字段的并集，_id 排最前', () => {
    const result = table([{ _id: 'a', name: 'x', age: 1 }, { _id: 'b', email: 'e' }]);
    expect(result.columns.map((c) => c.name)).toEqual(['_id', 'name', 'age', 'email']);
  });

  it('缺的字段是 NULL，不是空字符串', () => {
    const result = table([{ _id: 'a', email: 'e@x' }, { _id: 'b' }]);
    expect(result.rows[0]?.[1]?.text).toBe('e@x');
    expect(result.rows[1]?.[1]?.text).toBeNull();
  });

  it('嵌套的文档和数组压成一行 JSON', () => {
    const result = table([{ _id: 'a', addr: { city: '北京' }, tags: ['x'] }]);
    expect(result.rows[0]?.[1]?.text).toBe('{"city":"北京"}');
    expect(result.rows[0]?.[2]?.text).toBe('["x"]');
  });

  it('字符串不加引号，别的按显示的样子给', () => {
    const result = table([{ s: '张三', n: 5, ok: true, re: /^张/i }]);
    expect(result.rows[0]?.[0]?.text).toBe('张三');
    expect(result.rows[0]?.[1]?.text).toBe('5');
    expect(result.rows[0]?.[2]?.text).toBe('true');
    expect(result.rows[0]?.[3]?.text).toBe('/^张/i');
  });
});

describe('假实现：跑查询', () => {
  it('find 按条件过滤，limit 管用', () => {
    const result = runFakeMongoQuery('db.用户.find({ city: "北京" }).limit(1)');
    expect(result.error).toBeUndefined();
    expect(result.rows).toHaveLength(1);
    // 截断了就要说（我们多要一条来判断「是不是还有」）
    expect(result.truncated).toBe(true);
  });

  it('sort 真的排（-1 是倒序）', () => {
    const result = runFakeMongoQuery('db.用户.find({}).sort({ age: -1 })');
    const names = result.rows.map((row) => row.find((_, i) => result.columns[i]?.name === 'name')?.text);
    expect(names[0]).toBe('王五');
  });

  it('投影：只留写了的字段（_id 默认还在）', () => {
    const result = runFakeMongoQuery('db.用户.find({ _id: "u1" }, { name: 1 })');
    expect(result.columns.map((c) => c.name)).toEqual(['_id', 'name']);
  });

  it('点号路径能读（addr.zip）', () => {
    const result = runFakeMongoQuery('db.用户.find({ "addr.zip": "100000" })');
    expect(result.rows).toHaveLength(1);
  });

  it('countDocuments / estimatedDocumentCount', () => {
    expect(runFakeMongoQuery('db.用户.countDocuments({ city: "北京" })').rows[0]?.[0]?.text).toBe('2');
    expect(runFakeMongoQuery('db.用户.estimatedDocumentCount()').rows[0]?.[0]?.text).toBe('3');
  });

  it('distinct 去重，列名就是那个字段', () => {
    const result = runFakeMongoQuery('db.用户.distinct("city")');
    expect(result.columns[0]?.name).toBe('city');
    expect(result.rows.map((r) => r[0]?.text).sort()).toEqual(['上海', '北京']);
  });

  it('aggregate：$match + $group', () => {
    const result = runFakeMongoQuery(
      'db.用户.aggregate([{ $match: { city: "北京" } }, { $group: { _id: "$city", n: { $sum: 1 } } }])',
    );
    expect(result.columns.map((c) => c.name)).toEqual(['_id', 'n']);
    expect(result.rows[0]?.[1]?.text).toBe('2');
  });

  it('⚠️ 写操作真的改内存：插进去再查得到', () => {
    const inserted = runFakeMongoQuery('db.用户.insertOne({ name: "赵六", city: "广州" })');
    expect(inserted.columns.map((c) => c.name)).toEqual(['acknowledged', 'insertedId']);

    const found = runFakeMongoQuery('db.用户.find({ name: "赵六" })');
    expect(found.rows).toHaveLength(1);
    expect(runFakeMongoQuery('db.用户.countDocuments({})').rows[0]?.[0]?.text).toBe('4');
  });

  it('update 带 $set / $inc，结果文档和 mongosh 打印的一样', () => {
    const result = runFakeMongoQuery('db.用户.updateOne({ _id: "u2" }, { $set: { city: "深圳" }, $inc: { age: 1 } })');
    expect(result.columns.map((c) => c.name)).toEqual(['acknowledged', 'matchedCount', 'modifiedCount']);
    expect(result.rows[0]?.[1]?.text).toBe('1');

    const after = runFakeMongoQuery('db.用户.findOne({ _id: "u2" })');
    const city = after.rows[0]?.[after.columns.findIndex((c) => c.name === 'city')]?.text;
    const age = after.rows[0]?.[after.columns.findIndex((c) => c.name === 'age')]?.text;
    expect(city).toBe('深圳');
    expect(age).toBe('25');
  });

  it('upsert 没命中就插一条，并给出 upsertedId', () => {
    const result = runFakeMongoQuery('db.用户.updateOne({ name: "新人" }, { $set: { age: 1 } }, { upsert: true })');
    expect(result.columns.map((c) => c.name)).toContain('upsertedId');
    expect(runFakeMongoQuery('db.用户.countDocuments({ name: "新人" })').rows[0]?.[0]?.text).toBe('1');
  });

  it('deleteMany 真的删，deletedCount 报对', () => {
    const result = runFakeMongoQuery('db.用户.deleteMany({ city: "北京" })');
    expect(result.rows[0]?.[1]?.text).toBe('2');
    expect(runFakeMongoQuery('db.用户.countDocuments({})').rows[0]?.[0]?.text).toBe('1');
  });

  it('findOneAndUpdate 默认返回改之前的样子', () => {
    const before = runFakeMongoQuery('db.用户.findOneAndUpdate({ _id: "u1" }, { $set: { city: "杭州" } })');
    const name = before.rows[0]?.[before.columns.findIndex((c) => c.name === 'city')]?.text;
    expect(name).toBe('北京');

    const after = runFakeMongoQuery(
      'db.用户.findOneAndUpdate({ _id: "u1" }, { $set: { city: "成都" } }, { returnDocument: "after" })',
    );
    const city = after.rows[0]?.[after.columns.findIndex((c) => c.name === 'city')]?.text;
    expect(city).toBe('成都');
  });

  it('索引那三个', () => {
    expect(runFakeMongoQuery('db.用户.getIndexes()').rows.length).toBeGreaterThan(0);
    const created = runFakeMongoQuery('db.用户.createIndex({ email: 1 }, { unique: true })');
    expect(created.rows[0]?.[0]?.text).toBe('email_1');
    const indexes = runFakeMongoQuery('db.用户.getIndexes()');
    expect(indexes.rows.length).toBe(2);
    expect(runFakeMongoQuery('db.用户.dropIndex("email_1")').rows[0]?.[0]?.text).toBe('email_1');
  });

  it('drop 之后这个集合就没了（再查报「没有这个集合」）', () => {
    expect(runFakeMongoQuery('db.订单.drop()').error).toBeUndefined();
    expect(runFakeMongoQuery('db.订单.find({})').error).toContain('没有这个集合');
    expect(fakeCollections('demo').map((c) => c.name)).toEqual(['用户']);
  });

  it('⚠️ 往不存在的集合里 insert 是合法的（Mongo 会顺手建出来）', () => {
    const result = runFakeMongoQuery('db.新集合.insertOne({ a: 1 })');
    expect(result.error).toBeUndefined();
    expect(runFakeMongoQuery('db.新集合.countDocuments({})').rows[0]?.[0]?.text).toBe('1');
  });
});

describe('假实现：报错的样子', () => {
  it('语法错原样给出来（用户要照着改）', () => {
    const result = runFakeMongoQuery('db.用户.find({');
    expect(result.error).toBeTruthy();
    expect(result.rows).toHaveLength(0);
  });

  it('不支持的操作会把支持的列出来', () => {
    const result = runFakeMongoQuery('db.用户.mapReduce({})');
    expect(result.error).toContain('find');
    expect(result.error).toContain('aggregate');
  });

  it('不支持的过滤算子要明说，不能悄悄当不匹配', () => {
    const result = runFakeMongoQuery('db.用户.find({ name: { $where: "x" } })');
    expect(result.error).toContain('$where');
  });
});
