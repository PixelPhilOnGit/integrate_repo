/**
 * 连接档案的持久化 —— **全程序唯一读写连接密码的地方**。
 *
 * # TODO(security)
 *
 * 密码目前以**明文**存进键值存储（桌面端是应用配置目录下的 `redis.json`，
 * 浏览器版是 localStorage）。这是明确知情的妥协，沿用本项目对工作区路径那套
 * 「先明文、标记待改」的做法。
 *
 * 代价说清楚：**任何能读到那个文件的进程都能拿到你的 Redis 密码。**
 * 同机器上的其他程序、备份软件、误传的配置目录快照，都算。
 *
 * 真正开始用这个功能连生产库之前，必须换成系统钥匙串：
 *
 *   1. 把下面两个函数换成钥匙串实现（Windows 凭据管理器 / macOS Keychain /
 *      Linux Secret Service，Rust 侧用 `keyring` crate，或者走 Tauri 插件）；
 *   2. 做一次一次性迁移：把已经存进去的 `password` 字段搬进钥匙串，
 *      然后**从存储里删掉那个字段**；
 *   3. 从 `ConnectionProfile` 类型上去掉 `password`（见 `core/types.ts`）。
 *
 * 之所以把读写收敛在这一个文件里，就是为了让上面这三步是**可控的局部改动**，
 * 而不是满仓库找哪里碰过密码。
 *
 * 顺带一提：命令台的回显脱敏（`core/redact.ts`）解决的是另一个问题 ——
 * 别让同一个密码再泄漏到界面日志里。两件事都要做。
 */

import type { ConnectionProfile } from '../core/types';
import type { KeyValueStore, ProfileStore } from './types';

const PROFILES_KEY = 'profiles';

export function createProfileStore(kv: KeyValueStore): ProfileStore {
  return {
    async load(): Promise<ConnectionProfile[]> {
      const raw = await kv.get<unknown>(PROFILES_KEY);
      return sanitize(raw);
    },

    async save(profiles: readonly ConnectionProfile[]): Promise<void> {
      await kv.set(PROFILES_KEY, profiles);
    },
  };
}

/**
 * 把存储里读出来的东西整形回 `ConnectionProfile[]`。
 *
 * 存储里的内容不可信：可能是旧版本写的、可能被手工编辑过、也可能干脆坏了。
 * 一条坏记录不该让整个连接列表消失，所以逐条校验、丢掉不合法的那些，
 * 缺字段的补默认值 —— 目标是「尽力恢复」，不是「严格拒绝」。
 */
function sanitize(raw: unknown): ConnectionProfile[] {
  if (!Array.isArray(raw)) return [];

  const profiles: ConnectionProfile[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;

    const id = asString(record.id);
    if (id === '') continue; // 没有 id 的记录没法用，连接、断开、删除都要靠它

    profiles.push({
      id,
      name: asString(record.name) || '未命名连接',
      host: asString(record.host) || '127.0.0.1',
      port: asPort(record.port),
      db: asNonNegativeInt(record.db, 0),
      username: asString(record.username),
      password: asString(record.password),
    });
  }
  return profiles;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asPort(value: unknown): number {
  const port = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 6379;
}

function asNonNegativeInt(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}
