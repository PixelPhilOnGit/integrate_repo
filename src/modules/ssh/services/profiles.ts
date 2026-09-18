/**
 * SSH 连接档案的持久化。
 *
 * 骨架和「明文密码」那件已知妥协都在 `shared/connections/profiles.ts` ——
 * 那里是**全程序唯一读写连接密码的地方**，四个连接类模块共用一份。
 * 这里只提供 SSH 档案自己的字段清单。
 *
 * ⚠️ SSH 比另外三个多一个明文凭据：**私钥口令**。它和密码走的是同一条路径、
 * 同一个文件，所以将来迁移到系统钥匙串时**一起覆盖**，不用单独处理。
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
import { DEFAULT_SSH_PORT, type KnownHost, type SshAuthKind, type SshProfile } from '../core/types';
import { KNOWN_HOSTS_KEY, sanitizeKnownHosts } from '../core/knownHosts';

export function createSshProfileStore(kv: KeyValueStore): ProfileStore<SshProfile> {
  return createProfileStore<SshProfile>(kv, { sanitize });
}

/**
 * 已知主机的信任记录。
 *
 * 复用共享层那个 `createProfileStore` —— 它的形状（load/save 一整份数组）
 * 正好就是我们要的，而且它已经带了「尽力恢复」那套整形策略。
 * 只是换个键名和整形函数。
 *
 * 和档案**存在同一个文件里但不同键**（`ssh.json` 的 `profiles` / `knownHosts`）。
 * 放一个文件是因为它们生命周期一致（都是这个模块的用户数据）；
 * 分开键是因为结构完全不同，混在一起整形会互相牵连。
 */
export function createKnownHostStore(kv: KeyValueStore): ProfileStore<KnownHost> {
  return createProfileStore<KnownHost>(kv, {
    key: KNOWN_HOSTS_KEY,
    sanitize: sanitizeKnownHosts,
  });
}

function asAuthKind(value: unknown): SshAuthKind {
  return value === 'key' ? 'key' : 'password';
}

/** 把存储里的不可信数据整形成 `SshProfile[]`，坏记录丢掉而不是让整个列表消失 */
function sanitize(raw: unknown): SshProfile[] {
  const profiles: SshProfile[] = [];

  for (const item of asArray(raw)) {
    const record = asRecord(item);
    if (record === null) continue;

    const id = asString(record.id);
    if (id === '') continue; // 没有 id 的记录没法用：连接、重命名、删除都要靠它

    profiles.push({
      id,
      name: asString(record.name) || '未命名连接',
      host: asString(record.host) || '127.0.0.1',
      port: asPort(record.port, DEFAULT_SSH_PORT),
      username: asString(record.username),
      authKind: asAuthKind(record.authKind),
      password: asString(record.password),
      privateKeyPath: asString(record.privateKeyPath),
      passphrase: asString(record.passphrase),
    });
  }

  return profiles;
}
