/**
 * 系统钥匙串：连接密码的归宿。
 *
 * 在这之前，三个连接模块（Redis / 数据库 / SSH）的密码都是**明文**存在键值表里
 * （见 `shared/connections/profiles.ts` 一直挂着的 `TODO(security)`）。
 * 现在它们走操作系统的凭据存储：Windows 的凭据管理器、macOS 的钥匙串、
 * Linux 的 Secret Service。
 *
 * # 桌面端和浏览器版**不是同一件事**
 *
 * - **桌面端**：真的读写系统钥匙串。
 * - **浏览器版**：**没有钥匙串**，[`available`] 恒为 `false`。于是上面的
 *   `profiles.ts` 自动退回「密码存在 localStorage 里」那条老路 —— 和它现在的
 *   行为一模一样。e2e 跑的就是这条路。
 *
 * ⚠️ **`available()` 是这一层的核心接口，不是补充**：服务器和 headless 机器上
 * 压根没有钥匙串，那些环境里应用**照样得能用**。所以「用不了」不是错误，
 * 是一个**正常的分支**，调用方要顺着它退回老路 —— 但**不能静默**：界面上得
 * 说一句「这台机器上没有钥匙串，密码仍然存在本地文件里」，否则用户以为
 * 密码已经进钥匙串了。
 *
 * # 接口是批量的
 *
 * 一个模块几十条连接，一条一个 IPC 往返的话，切一次模块要等一串来回。
 * Rust 那边也照这个形状做的（`secret_commands.rs`）。
 */

import { isTauri } from './detect';
import { invoke } from './invoke';

export interface SecretsStore {
  /**
   * 这台机器上有没有可用的钥匙串。
   *
   * **返回 false 不是失败** —— 是「这里没有这个东西」，调用方该退回老路。
   */
  available(): Promise<boolean>;
  /** 一次读一批。**只包含真的存过的那些**（没存过的这里就没有，当空密码） */
  load(module: string, ids: readonly string[]): Promise<Record<string, string>>;
  /**
   * 一次写一批。空密码 = 删掉那一条。
   *
   * 返回**写完之后钥匙串还能不能用** —— 途中它可能整个掉线（桌面会话锁了）。
   */
  store(module: string, entries: ReadonlyArray<{ id: string; secret: string }>): Promise<boolean>;
}

/** Rust 侧 `secret_load` 的返回形状（和 `secret_commands.rs` 里的 `SecretsLoad` 对齐） */
interface SecretsLoad {
  available: boolean;
  secrets: Record<string, string>;
}

/**
 * 桌面端：真的系统钥匙串。
 *
 * 三个命令都是 `invoke`，**不做任何缓存**：钥匙串的状态会变（桌面会话锁上、
 * 服务重启），缓存「可用」会在它掉线之后继续往一个死掉的地方写。
 * 一次探测就是一个 IPC，比写丢密码便宜得多。
 */
function createTauriSecrets(): SecretsStore {
  return {
    async available(): Promise<boolean> {
      try {
        return await invoke<boolean>('secret_available');
      } catch {
        // 连命令都调不通（老版本后端、命令没注册）：当没有钥匙串处理 ——
        // 退回老路总比让用户连不上自己的库强
        return false;
      }
    },

    async load(module: string, ids: readonly string[]): Promise<Record<string, string>> {
      if (ids.length === 0) return {};
      try {
        const result = await invoke<SecretsLoad>('secret_load', { module, ids: [...ids] });
        return result.secrets;
      } catch {
        // 读不出来时**当作没存过**：界面上会显示空密码，用户重填一次即可。
        // 比让整个连接列表打不开强（那条路见 profiles.ts 的「坏记录不连坐」）
        return {};
      }
    },

    async store(
      module: string,
      entries: ReadonlyArray<{ id: string; secret: string }>,
    ): Promise<boolean> {
      if (entries.length === 0) return true;
      try {
        return await invoke<boolean>('secret_store', {
          module,
          entries: entries.map((e) => ({ id: e.id, secret: e.secret })),
        });
      } catch {
        return false;
      }
    },
  };
}

/**
 * 浏览器版：**没有钥匙串**。
 *
 * 不是「还没实现」—— 浏览器里就不存在这东西。恒返回 `false` 让上层自动
 * 退回 localStorage 那条路（那是浏览器版一直以来的行为，用户和 e2e 都按它来的）。
 */
function createWebSecrets(): SecretsStore {
  return {
    async available(): Promise<boolean> {
      return false;
    },
    async load(): Promise<Record<string, string>> {
      return {};
    },
    async store(): Promise<boolean> {
      return false;
    },
  };
}

/** 按运行环境挑一份实现。构造过程不碰平台（和 `kv.ts` 一样） */
export function createSecrets(): SecretsStore {
  return isTauri() ? createTauriSecrets() : createWebSecrets();
}

// ---------------------------------------------------------------- 整块记录
//
// 下面这三个是「把一份记录列表里的某些字段挪进钥匙串」那套。它和**连接**无关：
// 智能体会话的工作目录（里面有远端机器的密码）也走这里。

/**
 * 把一份记录里**敏感字段摘掉** —— 存进键值表的从来是这个形状。
 *
 * 摘掉（而不是设成空串）是有意的：空串和「密码在别处」在 JSON 里长得一样，
 * 而这两件事的含义完全不同（一个是「这个连接不要密码」，一个是「密码在钥匙串里」）。
 * 字段不在了就是「不在这儿」。
 */
function stripSecrets<P extends { id: string }>(
  profile: P,
  fields: ReadonlyArray<keyof P & string>,
): P {
  const next: Partial<P> = { ...profile };
  for (const field of fields) delete next[field];
  return next as P;
}

/** 一份记录里那些敏感字段的**值**（空的不要 —— 那表示「这个连接不用它」） */
function secretsOf<P extends { id: string }>(
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
 * 「一整块记录」的读写形状。
 *
 * ⚠️ **刻意写成结构化的**（而不是 import `connections/` 里的 `ProfileStore`）：
 * 这一层在 `platform/`，不该认识连接模块的任何东西 —— 而 `ProfileStore` 的形状
 * 恰好就是这个，所以两边天然兼容，不需要那道依赖。
 */
export interface RecordList<P> {
  load(): Promise<P[]>;
  save(rows: readonly P[]): Promise<void>;
}

/**
 * 在一份「记录列表」外面套一层钥匙串。
 *
 * ⚠️ **泛型只要求 `{ id: string }`**：这一层不认识「连接」是什么，它只管
 * 「把声明过的那几个字段挪到钥匙串去」。所以连接的档案和智能体会话的
 * **工作目录**（远端那台机器的密码、私钥口令也在里面）都能用它。
 *
 * # 几条拿不准就会丢密码的规矩
 *
 * - **搬迁是「写进钥匙串成功了才从键值表里删」**：反过来的话，中间失败一次
 *   就是「两边都没有」。搬不进去就一个字都不动，下次再试。
 * - **写的时候先钥匙串、后键值表**：这个顺序最坏也只是「钥匙串里多存了一份
 *   没人用的」，下次 save 会覆盖掉。
 * - **整块包在 try 里**：钥匙串出任何事都不该让整份记录打不开 ——
 *   **拿不到密码是遗憾，打不开是事故。**
 */
export function withSecrets<P extends { id: string }>(
  base: RecordList<P>,
  module: string,
  fields: ReadonlyArray<keyof P & string>,
  /**
   * 钥匙串。**默认就是真的那一个** —— 参数化出来只是为了测试：
   * 这台开发机（headless 容器）上没有可用钥匙串，「有钥匙串时」那些场景
   * 在真实现下压根跑不到。
   */
  secrets: SecretsStore = createSecrets(),
): RecordList<P> {

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

