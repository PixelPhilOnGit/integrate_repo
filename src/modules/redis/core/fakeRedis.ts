/**
 * 内存版假 Redis。
 *
 * 浏览器版必须能完整跑起来 —— 这是整个自动化验证链路的前提：headless 环境里
 * 起不了原生窗口，Playwright 只能驱动普通 Chromium 里的前端。所以这里要有一个
 * **足够真**的 Redis：`SET a 1` 之后再 `GET a` 得真的能拿回 `1`，
 * e2e 才能断言「连接 → 执行 → 展示结果」这条链路，而不是对着写死的假数据自欺。
 *
 * 纯函数式的内存实现：不碰 DOM、不碰 localStorage（持久化是 `services/` 的事），
 * 所以能在 node 下直接单测。
 *
 * 刻意**不追求完整**：只实现命令台演示和测试需要的那一小撮命令，
 * 其余一律回 `-ERR unknown command`（真 Redis 也是这么回的）。
 * 协议层的正确性由 Rust 侧打真 Redis 的集成测试负责，这里只保证界面链路能跑通。
 */

import type { RedisReply } from './types';

export interface FakeRedis {
  /** 执行一条命令。分词在外面做完，这里收的是 token 数组 */
  exec(args: readonly string[]): RedisReply;
}

const VERSION = '7.0.15';

type Entry =
  | { kind: 'string'; value: string; expireAt: number | null }
  | { kind: 'list'; value: string[]; expireAt: number | null }
  | { kind: 'set'; value: Set<string>; expireAt: number | null }
  | { kind: 'hash'; value: Map<string, string>; expireAt: number | null }
  | { kind: 'zset'; value: Map<string, number>; expireAt: number | null };

// ------------------------------------------------------------------ 回复构造

const ok = (): RedisReply => ({ type: 'status', text: 'OK' });
const status = (text: string): RedisReply => ({ type: 'status', text });
const err = (message: string): RedisReply => ({ type: 'error', message });
const int = (value: number): RedisReply => ({ type: 'integer', value });
const nil = (): RedisReply => ({ type: 'nil' });
const bulk = (text: string): RedisReply => ({
  type: 'bulk',
  text,
  binary: false,
  bytes: byteLength(text),
});
const arr = (items: RedisReply[]): RedisReply => ({ type: 'array', items });
/** redis 的数组里允许出现 nil（比如 MGET 遇到不存在的 key） */
const bulkOrNil = (text: string | null): RedisReply => (text === null ? nil() : bulk(text));

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

const WRONGTYPE = 'WRONGTYPE Operation against a key holding the wrong kind of value';

/**
 * 取第 i 个参数，缺了给空串。
 *
 * 这是为了应付 `noUncheckedIndexedAccess`（数组下标一律是 `T | undefined`）。
 * 代价要说清楚：**这个替身不做完整的 arity 校验** —— 参数不够时命令拿到的是空串，
 * 行为多半是「找不到这个 key」而不是真 Redis 的「参数个数错误」。
 * 真参数校验归真 Redis，由 Rust 侧打真实例的集成测试覆盖；
 * 这里只保证界面链路能跑通。
 */
function p(args: readonly string[], index: number): string {
  return args[index] ?? '';
}

// ------------------------------------------------------------------ 实现

export function createFakeRedis(): FakeRedis {
  /** 库号 → (key → 值)。默认 16 个库，和真 Redis 的默认配置一致 */
  const databases = new Map<number, Map<string, Entry>>();
  let currentDb = 0;

  const db = (): Map<string, Entry> => {
    let store = databases.get(currentDb);
    if (!store) {
      store = new Map();
      databases.set(currentDb, store);
    }
    return store;
  };

  /** 取一个还没过期的值；顺手清掉过期的 */
  const live = (key: string): Entry | undefined => {
    const entry = db().get(key);
    if (!entry) return undefined;
    if (entry.expireAt !== null && entry.expireAt <= Date.now()) {
      db().delete(key);
      return undefined;
    }
    return entry;
  };

  const put = (key: string, entry: Entry): void => {
    db().set(key, entry);
  };

  /** 拿一个字符串值；类型不对报 WRONGTYPE，没有返回 null */
  const stringOf = (key: string): { ok: true; value: string | null } | { ok: false; reply: RedisReply } => {
    const entry = live(key);
    if (!entry) return { ok: true, value: null };
    if (entry.kind !== 'string') return { ok: false, reply: err(WRONGTYPE) };
    return { ok: true, value: entry.value };
  };

  const fail = (message: string): RedisReply => err(message);
  const unknown = (name: string): RedisReply =>
    fail(`ERR unknown command '${name}', with args beginning with: `);

  return {
    exec(rawArgs: readonly string[]): RedisReply {
      if (rawArgs.length === 0) return fail('ERR wrong number of arguments');
      const name = (rawArgs[0] ?? '').toUpperCase();
      const args = rawArgs.slice(1);

      switch (name) {
        case 'PING':
          return args.length === 0 ? status('PONG') : bulk(p(args, 0));

        case 'ECHO':
          return args.length === 1 ? bulk(p(args, 0)) : fail('ERR wrong number of arguments for \'echo\' command');

        case 'AUTH':
          // 假 Redis 不设密码：任何 AUTH 都成功（真 Redis 没配密码时也是这个行为）
          return ok();

        case 'SELECT': {
          const index = Number(p(args, 0));
          if (!Number.isInteger(index) || index < 0) {
            return fail('ERR DB index is out of range');
          }
          currentDb = index;
          return ok();
        }

        case 'SET':
          return doSet(args);

        case 'GET': {
          const read = stringOf(p(args, 0));
          if (!read.ok) return read.reply;
          return bulkOrNil(read.value);
        }

        case 'MGET': {
          const items = args.map((key) => {
            const read = stringOf(key);
            return read.ok ? bulkOrNil(read.value) : nil();
          });
          return arr(items);
        }

        case 'DEL': {
          const store = db();
          let removed = 0;
          for (const key of args) {
            // 过期的也算不存在
            const existed = live(key) !== undefined;
            if (existed) {
              store.delete(key);
              removed += 1;
            }
          }
          return int(removed);
        }

        case 'EXISTS': {
          let count = 0;
          for (const key of args) if (live(key)) count += 1;
          return int(count);
        }

        case 'DBSIZE':
          // 先把过期的清一清再数，否则会把死键算进去
          return int([...db().keys()].filter((key) => live(key) !== undefined).length);

        case 'FLUSHDB':
          databases.set(currentDb, new Map());
          return ok();

        case 'FLUSHALL':
          databases.clear();
          return ok();

        case 'TYPE': {
          const entry = live(p(args, 0));
          return status(entry ? entry.kind : 'none');
        }

        case 'KEYS':
          return arr([...db().keys()].filter((k) => live(k) !== undefined)
            .filter((k) => matchPattern(p(args, 0) || '*', k))
            .map(bulk));

        case 'SCAN':
          return doScan(args);

        case 'INCR':
        case 'DECR':
          return doIncrDecr(name, args);

        case 'APPEND': {
          const read = stringOf(p(args, 0));
          if (!read.ok) return read.reply;
          const next = (read.value ?? '') + p(args, 1);
          put(p(args, 0), { kind: 'string', value: next, expireAt: expiryOf(p(args, 0)) });
          return int(byteLength(next));
        }

        case 'STRLEN': {
          const read = stringOf(p(args, 0));
          if (!read.ok) return read.reply;
          return int(read.value === null ? 0 : byteLength(read.value));
        }

        case 'EXPIRE':
          return doExpire(args);

        case 'TTL':
          return doTtl(args);

        case 'HSET':
          return doHset(args);

        case 'HGET': {
          const entry = live(p(args, 0));
          if (!entry) return nil();
          if (entry.kind !== 'hash') return err(WRONGTYPE);
          return bulkOrNil(entry.value.get(p(args, 1)) ?? null);
        }

        case 'HGETALL':
          return doHgetall(args);

        case 'HDEL': {
          const entry = live(p(args, 0));
          if (!entry) return int(0);
          if (entry.kind !== 'hash') return err(WRONGTYPE);
          let removed = 0;
          for (const field of args.slice(1)) if (entry.value.delete(field)) removed += 1;
          return int(removed);
        }

        case 'LPUSH':
        case 'RPUSH':
          return doPush(name, args);

        case 'LRANGE':
          return doLrange(args);

        case 'LLEN': {
          const entry = live(p(args, 0));
          if (!entry) return int(0);
          if (entry.kind !== 'list') return err(WRONGTYPE);
          return int(entry.value.length);
        }

        case 'SADD':
          return doSadd(args);

        case 'SMEMBERS': {
          const entry = live(p(args, 0));
          if (!entry) return arr([]);
          if (entry.kind !== 'set') return err(WRONGTYPE);
          return arr([...entry.value].map(bulk));
        }

        case 'SREM': {
          const entry = live(p(args, 0));
          if (!entry) return int(0);
          if (entry.kind !== 'set') return err(WRONGTYPE);
          let removed = 0;
          for (const member of args.slice(1)) if (entry.value.delete(member)) removed += 1;
          return int(removed);
        }

        case 'SISMEMBER': {
          const entry = live(p(args, 0));
          if (!entry) return int(0);
          if (entry.kind !== 'set') return err(WRONGTYPE);
          return int(entry.value.has(p(args, 1)) ? 1 : 0);
        }

        case 'ZADD':
          return doZadd(args);

        case 'ZRANGE':
          return doZrange(args);

        case 'INFO':
          return bulk(infoText());

        default:
          return unknown(name);
      }
    },
  };

  // ---------------------------------------------------------------- 各命令

  function expiryOf(key: string): number | null {
    return live(key)?.expireAt ?? null;
  }

  function doSet(args: string[]): RedisReply {
    if (args.length < 2) return fail('ERR wrong number of arguments for \'set\' command');

    let expireAt: number | null = null;
    let onlyIfAbsent = false;
    let onlyIfPresent = false;

    for (let i = 2; i < args.length; i += 1) {
      const option = p(args, i).toUpperCase();
      if (option === 'EX') {
        expireAt = Date.now() + Number(p(args, i + 1)) * 1000;
        i += 1;
      } else if (option === 'PX') {
        expireAt = Date.now() + Number(p(args, i + 1));
        i += 1;
      } else if (option === 'NX') {
        onlyIfAbsent = true;
      } else if (option === 'XX') {
        onlyIfPresent = true;
      } else {
        return fail('ERR syntax error');
      }
    }

    const exists = live(p(args, 0)) !== undefined;
    if (onlyIfAbsent && exists) return nil();
    if (onlyIfPresent && !exists) return nil();

    put(p(args, 0), { kind: 'string', value: p(args, 1), expireAt });
    return ok();
  }

  function doScan(args: string[]): RedisReply {
    // 简化：一次返回全部匹配项，游标恒为 0（不分页）。
    // 真 Redis 的游标语义是「可能重复、可能不完整」的近似保证，
    // 命令台的场景下一次性给全反而更好用。
    let pattern = '*';
    for (let i = 1; i < args.length; i += 1) {
      if (p(args, i).toUpperCase() === 'MATCH') pattern = p(args, i + 1) || '*';
    }
    const keys = [...db().keys()]
      .filter((k) => live(k) !== undefined && matchPattern(pattern, k))
      .map(bulk);
    return arr([bulk('0'), arr(keys)]);
  }

  function doIncrDecr(command: string, args: string[]): RedisReply {
    const read = stringOf(p(args, 0));
    if (!read.ok) return read.reply;

    const current = read.value === null ? 0 : Number(read.value);
    if (read.value !== null && !Number.isInteger(current)) {
      return fail('ERR value is not an integer or out of range');
    }

    const next = current + (command === 'INCR' ? 1 : -1);
    put(p(args, 0), { kind: 'string', value: String(next), expireAt: expiryOf(p(args, 0)) });
    return int(next);
  }

  function doExpire(args: string[]): RedisReply {
    const entry = live(p(args, 0));
    if (!entry) return int(0);
    entry.expireAt = Date.now() + Number(p(args, 1)) * 1000;
    return int(1);
  }

  function doTtl(args: string[]): RedisReply {
    const entry = live(p(args, 0));
    if (!entry) return int(-2); // 键不存在
    if (entry.expireAt === null) return int(-1); // 存在但没有过期时间
    return int(Math.max(0, Math.round((entry.expireAt - Date.now()) / 1000)));
  }

  function doHset(args: string[]): RedisReply {
    if (args.length < 3 || args.length % 2 === 0) {
      return fail('ERR wrong number of arguments for \'hset\' command');
    }
    const entry = live(p(args, 0));
    let hash: Map<string, string>;
    if (!entry) {
      hash = new Map();
      put(p(args, 0), { kind: 'hash', value: hash, expireAt: null });
    } else if (entry.kind === 'hash') {
      hash = entry.value;
    } else {
      return err(WRONGTYPE);
    }

    let added = 0;
    for (let i = 1; i < args.length; i += 2) {
      if (!hash.has(p(args, i))) added += 1;
      hash.set(p(args, i), p(args, i + 1));
    }
    return int(added);
  }

  function doHgetall(args: string[]): RedisReply {
    const entry = live(p(args, 0));
    if (!entry) return arr([]);
    if (entry.kind !== 'hash') return err(WRONGTYPE);
    const items: RedisReply[] = [];
    for (const [field, value] of entry.value) {
      items.push(bulk(field), bulk(value));
    }
    return arr(items);
  }

  function doPush(command: string, args: string[]): RedisReply {
    const entry = live(p(args, 0));
    let list: string[];
    if (!entry) {
      list = [];
      put(p(args, 0), { kind: 'list', value: list, expireAt: null });
    } else if (entry.kind === 'list') {
      list = entry.value;
    } else {
      return err(WRONGTYPE);
    }

    if (command === 'LPUSH') list.unshift(...args.slice(1));
    else list.push(...args.slice(1));
    return int(list.length);
  }

  function doLrange(args: string[]): RedisReply {
    const entry = live(p(args, 0));
    if (!entry) return arr([]);
    if (entry.kind !== 'list') return err(WRONGTYPE);

    const list = entry.value;
    const start = normalizeIndex(Number(p(args, 1)), list.length);
    const stop = normalizeIndex(Number(p(args, 2)), list.length);
    return arr(list.slice(start, stop + 1).map(bulk));
  }

  /** Redis 的下标可以是负数（-1 是最后一个），且超出范围要夹住 */
  function normalizeIndex(index: number, length: number): number {
    const resolved = index < 0 ? length + index : index;
    return Math.min(Math.max(resolved, 0), length - 1);
  }

  function doSadd(args: string[]): RedisReply {
    const entry = live(p(args, 0));
    let set: Set<string>;
    if (!entry) {
      set = new Set();
      put(p(args, 0), { kind: 'set', value: set, expireAt: null });
    } else if (entry.kind === 'set') {
      set = entry.value;
    } else {
      return err(WRONGTYPE);
    }

    let added = 0;
    for (const member of args.slice(1)) {
      if (!set.has(member)) {
        set.add(member);
        added += 1;
      }
    }
    return int(added);
  }

  function doZadd(args: string[]): RedisReply {
    if (args.length < 3 || args.length % 2 === 0) {
      return fail('ERR wrong number of arguments for \'zadd\' command');
    }
    const entry = live(p(args, 0));
    let sorted: Map<string, number>;
    if (!entry) {
      sorted = new Map();
      put(p(args, 0), { kind: 'zset', value: sorted, expireAt: null });
    } else if (entry.kind === 'zset') {
      sorted = entry.value;
    } else {
      return err(WRONGTYPE);
    }

    let added = 0;
    for (let i = 1; i < args.length; i += 2) {
      const score = Number(p(args, i));
      if (Number.isNaN(score)) return fail('ERR value is not a valid float');
      if (!sorted.has(p(args, i + 1))) added += 1;
      sorted.set(p(args, i + 1), score);
    }
    return int(added);
  }

  function doZrange(args: string[]): RedisReply {
    const entry = live(p(args, 0));
    if (!entry) return arr([]);
    if (entry.kind !== 'zset') return err(WRONGTYPE);

    // 按分数升序（同分按成员名字典序），够用了 —— 不支持 WITHSCORES 之外的选项
    const sorted = [...entry.value.entries()].sort((a, b) =>
      a[1] === b[1] ? (a[0] < b[0] ? -1 : 1) : a[1] - b[1],
    );

    const offset = Number(p(args, 1)) || 0;
    // 没给 stop 就是「到末尾」—— 真 Redis 的 ZRANGE 至少要求 3 个参数，
    // 这里宽容一点，测试里少写一个参数也能用
    const stop = args.length > 2 ? Number(p(args, 2)) : sorted.length - 1;
    const end = stop < 0 ? sorted.length + stop : stop;
    const slice = sorted.slice(offset, end + 1).map(([member]) => member);

    return arr(slice.map(bulk));
  }

  function infoText(): string {
    return [
      '# Server',
      `redis_version:${VERSION}`,
      'redis_mode:standalone',
      'os:Devtoolkit 浏览器版（内存假实现）',
      '# Keyspace',
      `db${currentDb}:keys=${db().size},expires=0,avg_ttl=0`,
      '',
    ].join('\r\n');
  }
}

/**
 * Redis 的 glob 模式：`*` 任意串、`?` 单字符、`[...]` 字符集。
 * 只实现前两个（覆盖用户实际会用到的场景），其余按字面量处理。
 */
function matchPattern(pattern: string, text: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|\\]/g, '\\$&');
  const regex = new RegExp(`^${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 's');
  return regex.test(text);
}
