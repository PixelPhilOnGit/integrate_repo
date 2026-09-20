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
import { createSecrets } from '../platform/secrets';
import type { ConnectionProfileBase, ProfileStore } from './types';

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
 * 把一份档案里**敏感字段摘掉** —— 存进键值表的从来是这个形状。
 *
 * 摘掉（而不是设成空串）是有意的：空串和「密码在别处」在 JSON 里长得一样，
 * 而这两件事的含义完全不同（一个是「这个连接不要密码」，一个是「密码在钥匙串里」）。
 * 字段不在了就是「不在这儿」。
 */
function stripSecrets<P extends ConnectionProfileBase>(
  profile: P,
  fields: ReadonlyArray<keyof P & string>,
): P {
  const next: Partial<P> = { ...profile };
  for (const field of fields) delete next[field];
  return next as P;
}

/** 一份档案里那些敏感字段的**值**（空的不要 —— 那表示「这个连接不用它」） */
function secretsOf<P extends ConnectionProfileBase>(
  profile: P,
  fields: ReadonlyArray<keyof P & string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of fields) {
    const value: unknown = profile[field];
    if (typeof value === 'string' && value !== '') out[field] = value;
  }
  return out;
}

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

/**
 * 在「记录列表」外面套一层钥匙串。
 *
 * 泛型约束是 `P extends ConnectionProfileBase`（一定带 `password`），所以这里能
 * 放心地碰那几个敏感字段 —— 上面那个通用版就不行，它收的东西里根本没有密码。
 */
function withSecrets<P extends ConnectionProfileBase>(
  base: ProfileStore<P>,
  module: string,
  fields: ReadonlyArray<keyof P & string>,
): ProfileStore<P> {
  const secrets = createSecrets();

  /** 读回来的那一串 JSON 解成「字段 → 值」；解不出来当没有（坏条目别连坐） */
  const parse = (raw: string | undefined): Record<string, string> => {
    if (raw === undefined) return {};
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return {};
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'string') out[k] = v;
      }
      return out;
    } catch {
      return {};
    }
  };

  return {
    async load(): Promise<P[]> {
      // ⚠️ **先 base.load()（它内部会 sanitize）、再问钥匙串**：老数据里密码还在
      // 键值表里（迁移之前），而 sanitize 会把它读出来 —— 那正是要搬进钥匙串的
      // 东西，在读出来之前就丢掉的话，用户的密码就真没了。
      const rows = await base.load();
      if (rows.length === 0) return rows;

      // ⚠️ 钥匙串那一整块**包在 try 里**：它出任何事（不可用、或者实现里抛）
      // 都不该让整个连接列表打不开。**拿不到密码是遗憾，打不开是事故。**
      let stored: Record<string, string> | null = null;
      try {
        if (await secrets.available()) {
          stored = await secrets.load(
            module,
            rows.map((r) => r.id),
          );
        }
      } catch {
        return rows;
      }
      if (stored === null) return rows; // 没有钥匙串：就用键值表里的

      // 一次性搬迁：键值表里还有明文、而钥匙串里还没有的那些。
      // 「还有明文」= 这几个敏感字段里至少有一个非空。
      const pending = rows
        .map((row) => ({ row, values: secretsOf(row, fields) }))
        .filter((p) => Object.keys(p.values).length > 0 && stored[p.row.id] === undefined);

      if (pending.length > 0) {
        const ok = await secrets.store(
          module,
          pending.map((p) => ({ id: p.row.id, secret: JSON.stringify(p.values) })),
        );
        // ⚠️ **写进钥匙串成功了才从键值表里删** —— 反过来的话，
        // 中间失败一次就是「两边都没有」，那是真的丢密码
        if (ok) await base.save(rows.map((r) => stripSecrets(r, fields)));
      }

      // 组装最终形状：**钥匙串里的优先，缺的用键值表里读出来的兜底**。
      //
      // 后半句是给老数据留的 —— 搬迁没成（钥匙串写不进去）、或者那一条的存档
      // 本来就解不出来时，用户在界面上看到的仍是自己填过的那个密码，而不是一片空白。
      return rows.map((row) => {
        const fromKeychain = parse(stored[row.id]);
        // ⚠️ 走 `Record<string, unknown>` 中转：`P` 里除了这几个敏感字段还有别的
        // 东西（端口是数字、`kind` 是枚举），而 `fields` 是运行时才知道的 ——
        // TS 没法证明「给 P 的某个键赋一个 string」是安全的。断言就收在这一处。
        const out: Record<string, unknown> = { ...row, ...fromKeychain };
        for (const field of fields) {
          if (fromKeychain[field] !== undefined) continue;
          const value: unknown = row[field];
          if (typeof value === 'string') out[field] = value;
        }
        return out as P;
      });
    },

    async save(profiles: readonly P[]): Promise<void> {
      let wroteToKeychain = false;
      try {
        if (await secrets.available()) {
          // ⚠️ 顺序是**先钥匙串、后键值表**：反过来的话，两次写之间崩了就是
          // 「键值表里没密码、钥匙串里也没有」—— 那是真的丢密码。这个顺序最坏
          // 也只是「钥匙串里多存了一份没人用的」，下次 save 会覆盖掉。
          wroteToKeychain = await secrets.store(
            module,
            profiles.map((p) => ({ id: p.id, secret: JSON.stringify(secretsOf(p, fields)) })),
          );
        }
      } catch {
        wroteToKeychain = false;
      }

      // ⚠️ **写进钥匙串了才把明文从键值表里摘掉。** 没写进去（没有钥匙串、
      // 或者它这会儿不可用）就照老样子连密码一起存 —— **绝不能两个地方都没有**。
      await base.save(wroteToKeychain ? profiles.map((p) => stripSecrets(p, fields)) : profiles);
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
