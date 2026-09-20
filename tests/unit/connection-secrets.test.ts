/**
 * 「把某些字段挪进系统钥匙串」那一层 —— **尤其是迁移**。
 *
 * 这一块的每一条都关系到「用户的密码会不会丢」，所以它不是「顺手测一下」，
 * 是这里最该被钉死的东西。
 *
 * # 为什么直接测 `withSecrets` 而不测 `createSecretProfileStore`
 *
 * 因为要**注入一个假的钥匙串**。这台开发机是 headless 容器、没有桌面会话，
 * 「有钥匙串时」那些场景在真实现下一条都跑不到；而 `createSecretProfileStore`
 * 内部写死了用真的那个。`withSecrets` 收一个 `secrets` 参数就是为了这个 ——
 * 那一层薄得只剩一个参数，单独测它等于把整条路都测了。
 *
 * ⚠️ 真钥匙串的读写只能在 Windows / macOS 上验（`secrets.rs` 里有两条端到端
 * 测试，跑不到时会明确打印说明）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withSecrets, type SecretsStore } from '../../src/shared/platform/secrets';
import type { KeyValueStore } from '../../src/shared/platform/kv';

/** 一条带两个敏感字段的记录形状（第二个用来钉「敏感字段不止一个」） */
interface Row {
  id: string;
  name: string;
  host: string;
  password: string;
  passphrase: string;
}

const FIELDS: ReadonlyArray<keyof Row & string> = ['password', 'passphrase'];

function row(patch: Partial<Row> = {}): Row {
  return {
    id: 'p1',
    name: '本地',
    host: '127.0.0.1',
    password: 'pw-secret',
    passphrase: 'pp-secret',
    ...patch,
  };
}

/** 一个够用的内存 kv */
function fakeKv(initial: Record<string, unknown> = {}): KeyValueStore {
  const data = { ...initial };
  return {
    get: async <T,>(key: string): Promise<T | null> => (data[key] as T) ?? null,
    set: async (key: string, value: unknown): Promise<void> => {
      data[key] = value;
    },
  };
}

/**
 * 假的钥匙串：`available` / `store` 的返回值由各个用例自己摆。
 *
 * ⚠️ `vi.fn` 的类型参数要显式写全 —— 只写返回类型的话，参数类型会被推成空的，
 * 于是 `mock.calls[0][1]` 这种断言拿不到东西（编译期就红）。
 */
function fakeKeychain() {
  return {
    available: vi.fn<() => Promise<boolean>>(async () => false),
    load: vi.fn<(module: string, ids: readonly string[]) => Promise<Record<string, string>>>(
      async () => ({}),
    ),
    store:
      vi.fn<
        (
          module: string,
          entries: ReadonlyArray<{ id: string; secret: string }>,
        ) => Promise<boolean>
      >(async () => true),
  };
}

/** 整形（真实现里各模块自己写的那份，这里用一个最小的） */
function sanitize(raw: unknown): Row[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null)
    .map((r) => row(r as Partial<Row>));
}

function store(kv: KeyValueStore, keychain: SecretsStore, key = 'profiles') {
  return withSecrets(
    {
      load: async () => sanitize(await kv.get<unknown>(key)),
      save: async (rows) => {
        await kv.set(key, rows);
      },
    },
    key,
    FIELDS,
    keychain,
  );
}

let keychain: ReturnType<typeof fakeKeychain>;

beforeEach(() => {
  keychain = fakeKeychain();
});

describe('没有钥匙串时（服务器 / 浏览器版）', () => {
  it('密码照老样子存在键值表里 —— 那些环境里应用照样要能用', async () => {
    const kv = fakeKv();
    await store(kv, keychain).save([row()]);

    const raw = (await kv.get<Row[]>('profiles')) ?? [];
    expect(raw[0]?.password).toBe('pw-secret');

    const loaded = await store(kv, keychain).load();
    expect(loaded[0]?.password).toBe('pw-secret');
    expect(loaded[0]?.passphrase).toBe('pp-secret');
  });

  it('压根不去碰钥匙串', async () => {
    const kv = fakeKv();
    await store(kv, keychain).save([row()]);
    await store(kv, keychain).load();

    expect(keychain.load).not.toHaveBeenCalled();
    expect(keychain.store).not.toHaveBeenCalled();
  });
});

describe('有钥匙串时', () => {
  beforeEach(() => {
    keychain.available.mockResolvedValue(true);
  });

  it('敏感字段进钥匙串，键值表里**一个都不留**', async () => {
    const kv = fakeKv();
    await store(kv, keychain).save([row()]);

    const raw = ((await kv.get<Record<string, unknown>[]>('profiles')) ?? [])[0];
    expect(raw?.['password']).toBeUndefined();
    expect(raw?.['passphrase']).toBeUndefined();
    // 能公开的字段照旧在
    expect(raw?.['host']).toBe('127.0.0.1');
    expect(raw?.['name']).toBe('本地');

    // 两个字段打包成**一条**（一条记录一条，好管理也好删）
    const entry = keychain.store.mock.calls[0]?.[1]?.[0] as { id: string; secret: string };
    expect(entry.id).toBe('p1');
    expect(JSON.parse(entry.secret)).toEqual({
      password: 'pw-secret',
      passphrase: 'pp-secret',
    });
  });

  it('读的时候从钥匙串取回来', async () => {
    const kv = fakeKv({ profiles: [{ id: 'p1', name: '本地', host: '127.0.0.1' }] });
    keychain.load.mockResolvedValue({
      p1: JSON.stringify({ password: '从钥匙串来的', passphrase: '也是' }),
    });

    const loaded = await store(kv, keychain).load();
    expect(loaded[0]?.password).toBe('从钥匙串来的');
    expect(loaded[0]?.passphrase).toBe('也是');
  });

  it('一条记录的存档解不出来时，退回键值表里的那个（不连坐）', async () => {
    const kv = fakeKv({ profiles: [row()] });
    keychain.load.mockResolvedValue({ p1: '不是合法 JSON' });

    const loaded = await store(kv, keychain).load();
    expect(loaded[0]?.password).toBe('pw-secret');
  });
});

describe('老数据的迁移', () => {
  beforeEach(() => {
    keychain.available.mockResolvedValue(true);
  });

  it('键值表里还有明文、钥匙串里没有 → 搬过去，然后从键值表里删', async () => {
    const kv = fakeKv({ profiles: [row()] });

    const loaded = await store(kv, keychain).load();

    expect(keychain.store).toHaveBeenCalledTimes(1);
    const entry = keychain.store.mock.calls[0]?.[1]?.[0] as { secret: string };
    expect(JSON.parse(entry.secret)).toEqual({
      password: 'pw-secret',
      passphrase: 'pp-secret',
    });

    // 键值表里的明文没了
    const raw = ((await kv.get<Record<string, unknown>[]>('profiles')) ?? [])[0];
    expect(raw?.['password']).toBeUndefined();

    // 而用户读到的密码一点没变
    expect(loaded[0]?.password).toBe('pw-secret');
  });

  it('⚠️ 搬不进钥匙串时**一个字都不动**（下次再试，用户不丢密码）', async () => {
    const kv = fakeKv({ profiles: [row()] });
    keychain.store.mockResolvedValue(false); // 写不进去

    const loaded = await store(kv, keychain).load();

    const raw = ((await kv.get<Record<string, unknown>[]>('profiles')) ?? [])[0];
    expect(raw?.['password']).toBe('pw-secret');

    // 这次用户照样读得到（从键值表里兜底）
    expect(loaded[0]?.password).toBe('pw-secret');
    expect(loaded[0]?.passphrase).toBe('pp-secret');
  });

  it('钥匙串里已经有了就不搬（免得每次启动都写一遍）', async () => {
    const kv = fakeKv({ profiles: [row()] });
    keychain.load.mockResolvedValue({ p1: JSON.stringify({ password: '在钥匙串里' }) });

    const loaded = await store(kv, keychain).load();

    expect(keychain.store).not.toHaveBeenCalled();
    expect(loaded[0]?.password).toBe('在钥匙串里');
  });

  it('本来就是空的敏感字段不搬（那是「这条记录不用它」，不是待迁移的数据）', async () => {
    const kv = fakeKv({ profiles: [row({ password: '', passphrase: '' })] });

    await store(kv, keychain).load();

    expect(keychain.store).not.toHaveBeenCalled();
  });
});

describe('钥匙串中途出问题', () => {
  it('读的时候它抛了 → 退回键值表，而不是让整份列表打不开', async () => {
    const kv = fakeKv({ profiles: [row()] });
    keychain.available.mockResolvedValue(true);
    keychain.load.mockRejectedValue(new Error('桌面会话锁了'));

    // **拿不到密码是遗憾，打不开是事故**
    const loaded = await store(kv, keychain).load();
    expect(loaded[0]?.password).toBe('pw-secret');
  });

  it('写的时候它抛了 → 密码留在键值表里（不能写丢）', async () => {
    const kv = fakeKv();
    keychain.available.mockResolvedValue(true);
    keychain.store.mockRejectedValue(new Error('写不进去'));

    await store(kv, keychain).save([row()]);

    const raw = ((await kv.get<Record<string, unknown>[]>('profiles')) ?? [])[0];
    expect(raw?.['password']).toBe('pw-secret');
  });

  it('写的时候它整个不可用 → 同样留在键值表里', async () => {
    const kv = fakeKv();
    keychain.available.mockResolvedValue(false);

    await store(kv, keychain).save([row()]);

    const raw = ((await kv.get<Record<string, unknown>[]>('profiles')) ?? [])[0];
    expect(raw?.['password']).toBe('pw-secret');
  });
});
