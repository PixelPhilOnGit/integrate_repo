/**
 * 连接档案的持久化 —— **全程序唯一决定「密码往哪儿写」的地方**。
 *
 * Redis / SQL / SSH 三个模块共用这一份，所以：
 *
 * 1. 校验和整形的**策略**只写一遍（逐条校验、坏记录不连坐、「尽力恢复不严格拒绝」）；
 *    各模块只需要提供自己那份字段清单。
 * 2. 钥匙串那条路**一次覆盖三个模块**，而不是改三遍 —— 当初把这一层抽出来的主要理由。
 *
 * # 密码去哪了
 *
 * 密码**不再存在这里**：它走操作系统的钥匙串（Windows 凭据管理器 / macOS 钥匙串 /
 * Linux 的 Secret Service），见 `shared/platform/secrets.ts` 和下面的 `withSecrets`。
 * 键值表里只剩主机、端口、用户名这些**可以公开的**字段。
 *
 * ⚠️ 两条仍然成立的：
 *
 * 1. **钥匙串用不了的机器上会退回老路**（密码跟档案一起存在键值表里）。服务器和
 *    headless 环境没有钥匙串，那里只能这样 —— 但界面上要说出来，不能让人以为
 *    密码已经进钥匙串了。
 * 2. **Redis 命令台的回显脱敏是另一件事**（`core/redact.ts`）：那个解决的是
 *    「别让同一个密码再泄漏到界面日志里」。两件事都要做。
 */

import type { KeyValueStore } from '../platform/kv';
import { withSecrets } from '../platform/secrets';
import type { ConnectionProfileBase, ProfileStore } from './types';

/**
 * 这个名字还是「我们替他起的」那个默认名吗（去重过的 `新建连接 2` 也算）。
 *
 * ⚠️ **不能只比全等。** `nextAvailableName` 会把第二条起成「新建 PostgreSQL
 * 连接 2」，而 `DEFAULT_NAME` 是「新建 PostgreSQL 连接」—— 全等比较会把去重
 * 过的名字判成「用户改过」，于是换引擎时名字**不跟着换**。
 *
 * 症状很具体（e2e 抓到的）：先建一条 PG、再建第二条并切成 MySQL，第二条会叫
 * 「新建 PostgreSQL 连接 2」—— 一个名字里写着 PostgreSQL 的 MySQL 连接。
 *
 * 判据是「等于 base，或者以 `base ` 开头」：后者正好盖住 `nextAvailableName`
 * 的 `base 2` / `base 3` 那种形状。
 */
export function isDefaultName(current: string, base: string): boolean {
  return current === base || current.startsWith(`${base} `);
}

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
  /**
   * 哪些字段是**敏感的**，要进系统钥匙串（而不是留在键值表里）。
   *
   * 不填就是 `['password']` —— 三个模块都有它。
   * ⚠️ **SSH 要额外加上 `passphrase`**（私钥口令）：它和密码一样是明文的，
   * 漏掉的话换了钥匙串也还是漏一个。
   */
  secretFields?: ReadonlyArray<keyof P & string>;
}

const DEFAULT_KEY = 'profiles';

/**
 * **连接类**模块的档案存储：密码（以及 SSH 的私钥口令）走系统钥匙串。
 *
 * # 钥匙串用不了时退回老路，但**不静默**
 *
 * 服务器和 headless 机器上没有钥匙串，那些环境里应用照样得能用 —— 所以退回
 * 「密码跟档案一起存在键值表里」那条老路，而不是报错。但调用方拿得到
 * `secrets.available()` 的结果，界面上要说一句，否则用户以为密码已经进钥匙串了。
 *
 * # 老数据的迁移
 *
 * 在这之前密码是明文存在键值表里的，所以读的时候有一趟**一次性搬迁**：
 * 键值表里还有明文、而钥匙串里没有的那些 → 写进钥匙串 → **成功了才**从键值表里删。
 * 任何一步失败都**保持原样**（下次再试），用户一个密码都不会丢 ——
 * 这条比「搬迁一定要做完」重要得多。
 */
export function createSecretProfileStore<P extends ConnectionProfileBase>(
  kv: KeyValueStore,
  options: ProfileStoreOptions<P>,
): ProfileStore<P> {
  return withSecrets(
    createProfileStore(kv, options),
    options.key ?? DEFAULT_KEY,
    options.secretFields ?? ['password'],
  );
}

/**
 * 通用的一份「记录列表」持久化：读出来整形、整个存回去。
 *
 * ⚠️ **它不管密码** —— 密码那件事在 [`createSecretProfileStore`] 里，只给三个
 * **连接类**模块用。这一份给的是「没有敏感字段的列表」：SSH 的已知主机指纹
 * （`KnownHost`）、连接分组（`ConnectionGroup`）。它们都只有 id 和几个公开字段，
 * 硬套连接档案那套形状反而是错的（泛型上就通不过）。
 */
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
