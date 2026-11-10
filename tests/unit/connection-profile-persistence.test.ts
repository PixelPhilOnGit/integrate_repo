/**
 * 连接档案「保存 → 重新加载」的回归测试。
 *
 * 2026-11-10 用户真机报的两条，根因是同一类：
 *
 * 1. **SSH 连接移进目录后，重装/升级完就掉回未分组**；
 * 2. **新增的 MongoDB 连接，重装后全变成 PostgreSQL**。
 *
 * 两个 `sanitize` 都按手写字段清单重建对象：
 * - 三个连接模块**都没把 `groupId` 写回档案**（目录只存在于内存里）；
 * - SQL 的 kind 白名单只认 `mysql`，其余一律回落 `postgres`。
 *
 * 这类 bug 功能 e2e 抓不到 —— 移动目录、切引擎在当次会话里都对，
 * **只有重新读盘才丢**。所以这里用「新建一个 store 读同一份 KV」直接模拟
 * 重启，三个模块各钉一条。
 */

import { describe, expect, it } from 'vitest';
import { createGroupStore } from '../../src/shared/connections/groups';
import type { KeyValueStore } from '../../src/shared/platform/kv';
import { createRedisProfileStore } from '../../src/modules/redis/services/profiles';
import { createSshProfileStore } from '../../src/modules/ssh/services/profiles';
import { createSqlProfileStore } from '../../src/modules/sql/services/profiles';
import type { ConnectionProfile } from '../../src/modules/redis/core/types';
import type { SshProfile } from '../../src/modules/ssh/core/types';
import type { SqlKind, SqlProfile } from '../../src/modules/sql/core/types';

/** 内存 KV：同一个实例喂给两个 store 就是「重启前 / 重启后读同一份盘」 */
function memoryKv(): KeyValueStore {
  const data = new Map<string, unknown>();
  return {
    async get<T>(key: string): Promise<T | null> {
      return (data.get(key) as T | undefined) ?? null;
    },
    async set(key: string, value: unknown): Promise<void> {
      data.set(key, value);
    },
  };
}

const SSH: SshProfile = {
  id: 'ssh-1',
  name: '生产机',
  kind: 'ssh',
  localShell: '',
  host: '10.0.0.5',
  port: 22,
  username: 'deploy',
  authKind: 'password',
  password: 'secret',
  privateKeyPath: '',
  passphrase: '',
};

const REDIS: ConnectionProfile = {
  id: 'redis-1',
  name: '缓存',
  host: '127.0.0.1',
  port: 6379,
  db: 3,
  username: '',
  password: 'secret',
};

function sqlProfile(kind: SqlKind): SqlProfile {
  const base = {
    id: `sql-${kind}`,
    name: `连接 ${kind}`,
    host: '127.0.0.1',
    password: 'secret',
    kind,
  };
  switch (kind) {
    case 'postgres':
      return { ...base, port: 5432, username: 'postgres', database: 'postgres' };
    case 'mysql':
      return { ...base, port: 3306, username: 'root', database: '' };
    case 'clickhouse':
      return { ...base, port: 8123, username: 'default', database: '' };
    case 'mongodb':
      return { ...base, port: 27017, username: '', database: '' };
  }
}

describe('目录归属：保存再重新加载不能丢', () => {
  it('回归：SSH 连接移进目录后，重装/重启仍然在那个目录里', async () => {
    const kv = memoryKv();
    await createSshProfileStore(kv).save([{ ...SSH, groupId: 'grp-prod' }]);

    // 新实例 = 下次启动（sanitize 会重新跑一遍）
    const [profile] = await createSshProfileStore(kv).load();
    expect(profile!.groupId).toBe('grp-prod');
  });

  it('回归：Redis 连接移进目录后，重装/重启仍然在那个目录里', async () => {
    const kv = memoryKv();
    await createRedisProfileStore(kv).save([{ ...REDIS, groupId: 'grp-prod' }]);

    const [profile] = await createRedisProfileStore(kv).load();
    expect(profile!.groupId).toBe('grp-prod');
  });

  it('回归：数据库连接移进目录后，重装/重启仍然在那个目录里', async () => {
    const kv = memoryKv();
    await createSqlProfileStore(kv).save([{ ...sqlProfile('postgres'), groupId: 'grp-prod' }]);

    const [profile] = await createSqlProfileStore(kv).load();
    expect(profile!.groupId).toBe('grp-prod');
  });

  it('没有 groupId 时不要造一个空字段（存回去的 JSON 保持干净）', async () => {
    const kv = memoryKv();
    await createRedisProfileStore(kv).save([REDIS]);

    const [profile] = await createRedisProfileStore(kv).load();
    expect(Object.hasOwn(profile!, 'groupId')).toBe(false);
  });

  it('坏 groupId（数字 / null）当作未分组，而不是让整条记录消失', async () => {
    const kv = memoryKv();
    await kv.set('profiles', [
      { ...REDIS, id: 'bad-number', groupId: 42 },
      { ...REDIS, id: 'bad-null', groupId: null },
    ]);

    const profiles = await createRedisProfileStore(kv).load();
    expect(profiles.map((p) => p.id)).toEqual(['bad-number', 'bad-null']);
    expect(profiles.every((p) => !Object.hasOwn(p, 'groupId'))).toBe(true);
  });

  it('目录自己的层级（parentId）也要能跨重启读回来', async () => {
    const kv = memoryKv();
    const groups = createGroupStore(kv);
    await groups.save([
      { id: 'grp-prod', name: '生产' },
      { id: 'grp-sub', name: '数据库', parentId: 'grp-prod' },
    ]);

    const reloaded = await createGroupStore(kv).load();
    expect(reloaded.find((g) => g.id === 'grp-sub')?.parentId).toBe('grp-prod');
  });
});

describe('SQL 引擎种类：保存再重新加载不能变形', () => {
  it('回归：MongoDB / ClickHouse 连接重装后不会变成 PostgreSQL', async () => {
    const kv = memoryKv();
    const all = (['postgres', 'mysql', 'clickhouse', 'mongodb'] as const).map(sqlProfile);
    await createSqlProfileStore(kv).save(all);

    const reloaded = await createSqlProfileStore(kv).load();
    expect(reloaded.map((p) => p.kind)).toEqual(['postgres', 'mysql', 'clickhouse', 'mongodb']);
  });

  it('重载后的端口 / 用户名 / 库名跟着各自引擎走', async () => {
    const kv = memoryKv();
    await createSqlProfileStore(kv).save([sqlProfile('mongodb'), sqlProfile('clickhouse')]);

    const [mongo, clickhouse] = await createSqlProfileStore(kv).load();
    expect(mongo).toMatchObject({ kind: 'mongodb', port: 27017, username: '', database: '' });
    expect(clickhouse).toMatchObject({
      kind: 'clickhouse',
      port: 8123,
      username: 'default',
      database: '',
    });
  });

  it('端口坏了按**该引擎**的默认值兜底（Mongo 不会变成 5432）', async () => {
    const kv = memoryKv();
    await kv.set('profiles', [{ ...sqlProfile('mongodb'), port: '不是数字', username: '' }]);

    const [mongo] = await createSqlProfileStore(kv).load();
    expect(mongo!.kind).toBe('mongodb');
    expect(mongo!.port).toBe(27017);
  });

  it('认不出来的 kind 才回落 postgres（老数据的安全默认）', async () => {
    const kv = memoryKv();
    await kv.set('profiles', [{ ...sqlProfile('postgres'), kind: 'oracle' }]);

    const [profile] = await createSqlProfileStore(kv).load();
    expect(profile!.kind).toBe('postgres');
  });
});
