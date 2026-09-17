/**
 * Redis 连接档案的持久化。
 *
 * 骨架和「明文密码」那件已知妥协都在 `shared/connections/profiles.ts` ——
 * 那里是**全程序唯一读写连接密码的地方**，三个模块共用一份。
 * 这里只提供 Redis 档案自己的字段清单。
 */

import {
  asNonNegativeInt,
  asPort,
  asRecord,
  asString,
  asArray,
  createProfileStore,
} from '../../../shared/connections/profiles';
import type { KeyValueStore, ProfileStore } from '../../../shared/connections/types';
import type { ConnectionProfile } from '../core/types';

const DEFAULT_PORT = 6379;

export function createRedisProfileStore(kv: KeyValueStore): ProfileStore<ConnectionProfile> {
  return createProfileStore<ConnectionProfile>(kv, { sanitize });
}

/** 把存储里的不可信数据整形成 `ConnectionProfile[]`，坏记录丢掉而不是让整个列表消失 */
function sanitize(raw: unknown): ConnectionProfile[] {
  const profiles: ConnectionProfile[] = [];

  for (const item of asArray(raw)) {
    const record = asRecord(item);
    if (record === null) continue;

    const id = asString(record.id);
    if (id === '') continue; // 没有 id 的记录没法用：连接、断开、删除都要靠它

    profiles.push({
      id,
      name: asString(record.name) || '未命名连接',
      host: asString(record.host) || '127.0.0.1',
      port: asPort(record.port, DEFAULT_PORT),
      db: asNonNegativeInt(record.db, 0),
      username: asString(record.username),
      password: asString(record.password),
    });
  }

  return profiles;
}
