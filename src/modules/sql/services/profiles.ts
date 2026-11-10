/**
 * SQL 连接档案的持久化。
 *
 * 骨架和「明文密码」那件已知妥协都在 `shared/connections/profiles.ts` ——
 * 那里是**全程序唯一读写连接密码的地方**，三个连接类模块共用一份。
 * 这里只提供 SQL 档案自己的字段清单。
 */

import {
  asArray,
  asGroupId,
  asPort,
  asRecord,
  asString,
  createSecretProfileStore,
} from '../../../shared/connections/profiles';
import type { KeyValueStore } from '../../../shared/platform/kv';
import type { ProfileStore } from '../../../shared/connections/types';
import {
  asSqlKind,
  DEFAULT_DATABASE,
  DEFAULT_PORT,
  DEFAULT_USER,
  type SqlProfile,
} from '../core/types';

export function createSqlProfileStore(kv: KeyValueStore): ProfileStore<SqlProfile> {
  return createSecretProfileStore<SqlProfile>(kv, { sanitize });
}

/** 把存储里的不可信数据整形成 `SqlProfile[]`，坏记录丢掉而不是让整个列表消失 */
function sanitize(raw: unknown): SqlProfile[] {
  const profiles: SqlProfile[] = [];

  for (const item of asArray(raw)) {
    const record = asRecord(item);
    if (record === null) continue;

    const id = asString(record.id);
    if (id === '') continue; // 没有 id 的记录没法用：连接、断开、删除都要靠它

    // ⚠️ **四种引擎都要认**。这里以前写的是「是 mysql 就 mysql，否则 PG」——
    // 用户新增的 Mongo / ClickHouse 连接一重载就变成 PG，端口和用户也一起
    // 掉回 PG 的默认值。2026-11-10 真机反馈的原话就是这个。
    const kind = asSqlKind(record.kind);

    profiles.push({
      // ⚠️ 目录归属也要读回来 —— 少了这一行，连接重载后就掉回未分组
      ...asGroupId(record),
      id,
      name: asString(record.name) || '未命名连接',
      kind,
      host: asString(record.host) || '127.0.0.1',
      // 端口兜底跟着引擎走：Mongo 的坏端口不该变成 5432
      port: asPort(record.port, DEFAULT_PORT[kind]),
      // 用户名/库名同理，沿用新建档案时的那张表
      username: asString(record.username) || DEFAULT_USER[kind],
      database: asString(record.database) || DEFAULT_DATABASE[kind],
      password: asString(record.password),
    });
  }

  return profiles;
}
