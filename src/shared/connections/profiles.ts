/**
 * 连接档案的持久化 —— **全程序唯一读写连接密码的地方**。
 *
 * Redis / SQL / SSH 三个模块共用这一份，所以：
 *
 * 1. 校验和整形的**策略**只写一遍（逐条校验、坏记录不连坐、「尽力恢复不严格拒绝」）；
 *    各模块只需要提供自己那份字段清单。
 * 2. 将来的钥匙串迁移**一次覆盖三个模块**，而不是改三遍。
 *
 * # TODO(security)
 *
 * 密码目前以**明文**存进键值存储（桌面端是应用数据目录下 SQLite 的 `kv` 表，
 * 浏览器版是 localStorage）。这是明确知情的妥协。
 *
 * 代价说清楚：**任何能读到那份存储的进程都能拿到你的数据库/服务器密码。**
 * 同机器上的其他程序、备份软件、误传的配置目录快照，都算。
 * 共用电脑上不要填生产库密码。
 *
 * 真正拿它连生产环境之前，必须换成系统钥匙串
 * （Windows 凭据管理器 / macOS Keychain / Linux Secret Service）：
 *
 *   1. 把 `createProfileStore` 换成钥匙串实现（Rust 侧用 `keyring` crate，
 *      或者走 Tauri 插件）；
 *   2. 做一次一次性迁移：把已经存进去的 `password` 字段搬进钥匙串，
 *      然后**从存储里删掉那个字段**；
 *   3. 从 `ConnectionProfileBase`（`./types.ts`）上去掉 `password`。
 *
 * 因为三个模块共用这一条路径，上面三步做完就是全部 —— 这是把它们收拢在这里的
 * 主要理由。
 *
 * 顺带一提：Redis 命令台的回显脱敏解决的是**另一个**问题（别让同一个密码再泄漏到
 * 界面日志里）。两件事都要做。
 */

import type { KeyValueStore } from '../platform/kv';
import type { ProfileStore } from './types';

export interface ProfileStoreOptions<P> {
  /** 存储里的键名。三个模块各用各的键值命名空间，所以默认值够用 */
  key?: string;
  /**
   * 把存储里读出来的**不可信数据**整形成 `P[]`。
   *
   * 之所以让模块自己写：字段清单是模块专属的（Redis 有「库号」、SQL 有「数据库名」、
   * SSH 有「认证方式」）。但策略是共用的，用下面那几个 `as*` helper 拼就行。
   */
  sanitize: (raw: unknown) => P[];
}

const DEFAULT_KEY = 'profiles';

export function createProfileStore<P>(
  kv: KeyValueStore,
  options: ProfileStoreOptions<P>,
): ProfileStore<P> {
  const key = options.key ?? DEFAULT_KEY;

  return {
    async load(): Promise<P[]> {
      return options.sanitize(await kv.get<unknown>(key));
    },

    async save(profiles: readonly P[]): Promise<void> {
      await kv.set(key, profiles);
    },
  };
}

// ---------------------------------------------------------------- 整形 helper
//
// 存储里的内容不可信：可能是旧版本写的、可能被手工编辑过、也可能干脆坏了。
// 一条坏记录不该让整个连接列表消失，所以逐条校验、丢掉不合法的那些、
// 缺字段的补默认值 —— 目标是「尽力恢复」，不是「严格拒绝」。

/** 不是字符串就给空串 */
export function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** 端口必须是 1–65535 的整数，否则给默认值 */
export function asPort(value: unknown, fallback: number): number {
  const port = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : fallback;
}

/** 非负整数，否则给默认值 */
export function asNonNegativeInt(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

/** 数据是数组就逐条交给 `item`，不是数组就当空列表 */
export function asArray(raw: unknown): unknown[] {
  return Array.isArray(raw) ? raw : [];
}

/** 把一条记录当对象看；不是对象返回 null（调用方据此跳过这条） */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/**
 * 给新档案起一个不重名的名字：「新建连接」→「新建连接 2」→「新建连接 3」。
 *
 * ⚠️ 这个和 `shared/platform/path.ts` 的 `uniqueName` **看起来重复，但不能合并**：
 *
 * - `uniqueName` 是给**文件名**用的：大小写不敏感（Windows/macOS 的文件系统就是这样），
 *   而且不加分隔符（`未命名2`，因为文件名里多一个空格很别扭）。
 * - 这个是给**连接名**用的：大小写**敏感**（用户要能同时有 `prod` 和 `Prod`，
 *   那是两台不同的机器），而且带空格（`新建连接 2` 更好读）。
 *
 * 两边的语义恰好都相反，抽成一个必然让其中一边采用错误的行为。
 */
export function nextAvailableName(existing: readonly string[], base: string): string {
  const taken = new Set(existing);
  if (!taken.has(base)) return base;

  for (let n = 2; ; n += 1) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}
