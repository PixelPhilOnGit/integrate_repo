/**
 * SQL 连接档案的持久化。
 *
 * 骨架和「明文密码」那件已知妥协都在 `shared/connections/profiles.ts` ——
 * 那里是**全程序唯一读写连接密码的地方**，三个连接类模块共用一份。
 * 这里只提供 SQL 档案自己的字段清单。
 */

import {
  asArray,
  asPort,
  asRecord,
  asString,
  createProfileStore,
} from '../../../shared/connections/profiles';
import type { KeyValueStore } from '../../../shared/platform/kv';
import type { ProfileStore } from '../../../shared/connections/types';
import type { SqlKind, SqlProfile } from '../core/types';

export function createSqlProfileStore(kv: KeyValueStore): ProfileStore<SqlProfile> {
  return createProfileStore<SqlProfile>(kv, { sanitize });
}

function asKind(value: unknown): SqlKind {
  return value === 'mysql' ? 'mysql' : 'postgres';
}

/** 把存储里的不可信数据整形成 `SqlProfile[]`，坏记录丢掉而不是让整个列表消失 */
function sanitize(raw: unknown): SqlProfile[] {
  const profiles: SqlProfile[] = [];

  for (const item of asArray(raw)) {
    const record = asRecord(item);
    if (record === null) continue;

    const id = asString(record.id);
    if (id === '') continue; // 没有 id 的记录没法用：连接、断开、删除都要靠它

    const kind = asKind(record.kind);

    profiles.push({
      id,
      name: asString(record.name) || '未命名连接',
      kind,
      host: asString(record.host) || '127.0.0.1',
      port: asPort(record.port, kind === 'mysql' ? 3306 : 5432),
      username: asString(record.username) || (kind === 'mysql' ? 'root' : 'postgres'),
      database: asString(record.database),
      password: asString(record.password),
    });
  }

  return profiles;
}
