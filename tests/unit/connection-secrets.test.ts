/**
 * 连接密码走系统钥匙串那条路 —— **尤其是迁移**。
 *
 * 这一块的每一条都关系到「用户的密码会不会丢」，所以它不是「顺手测一下」，
 * 是这里最该被钉死的东西。三个场景：
 *
 * 1. **没有钥匙串**（服务器 / headless / 浏览器版）：密码照老样子存键值表里 ——
 *    那些环境里应用照样得能用，而这是它一直以来的行为。
 * 2. **有钥匙串**：密码进钥匙串，键值表里只剩能公开的字段。
 * 3. **迁移**：老数据里密码还在键值表里 → 搬进钥匙串 → 成功了才从键值表里删。
 *    ⚠️ 搬不进去的时候**一个字都不能动**（下次再试），这条比「搬迁做完」重要。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

/** 假的钥匙串。`available` / `store` 的返回值由各个用例自己摆 */
const { keychain } = vi.hoisted(() => ({
  keychain: {
    available: vi.fn<() => Promise<boolean>>(),
    load: vi.fn<(module: string, ids: readonly string[]) => Promise<Record<string, string>>>(),
    store:
      vi.fn<
        (
          module: string,
          entries: ReadonlyArray<{ id: string; secret: string }>,
        ) => Promise<boolean>
      >(),
  },
}));

vi.mock('../../src/shared/platform/secrets', () => ({
  createSecrets: () => keychain,
}));

const { createSecretProfileStore } = await import('../../src/shared/connections/profiles');

import type { KeyValueStore } from '../../src/shared/platform/kv';
import type { ConnectionProfileBase } from '../../src/shared/connections/types';

/** 带私钥口令的那种形状（SSH）—— 顺便钉住「敏感字段不止一个」 */
interface TestProfile extends ConnectionProfileBase {
  passphrase: string;
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

/** 读一眼键值表里到底存了什么（测试要断言「密码没在里面」） */
async function rawOf(kv: KeyValueStore, key = 'profiles'): Promise<unknown[]> {
  return (await kv.get<unknown[]>(key)) ?? [];
}

function profile(patch: Partial<TestProfile> = {}): TestProfile {
  return {
    id: 'p1',
    name: '本地',
    host: '127.0.0.1',
    port: 22,
    username: 'root',
    password: 'pw-secret',
    passphrase: 'pp-secret',
    ...patch,
  };
}

function sanitize(raw: unknown): TestProfile[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null)
    .map((r) => profile({ ...(r as Partial<TestProfile>), passphrase: String(r['passphrase'] ?? '') }));
}

const SECRET_FIELDS: ReadonlyArray<'password' | 'passphrase'> = ['password', 'passphrase'];

function store(kv: KeyValueStore) {
  return createSecretProfileStore<TestProfile>(kv, { sanitize, secretFields: SECRET_FIELDS });
}

beforeEach(() => {
  vi.clearAllMocks();
  keychain.load.mockResolvedValue({});
  keychain.store.mockResolvedValue(true);
});

describe('没有钥匙串时（服务器 / 浏览器版）', () => {
  beforeEach(() => keychain.available.mockResolvedValue(false));

  it('密码照老样子存在键值表里 —— 那些环境里应用照样要能用', async () => {
    const kv = fakeKv();
    await store(kv).save([profile()]);

    const raw = await rawOf(kv);
    expect(raw).toHaveLength(1);
    expect((raw[0] as Record<string, unknown>)['password']).toBe('pw-secret');

    // 读回来也对
    const loaded = await store(kv).load();
    expect(loaded[0]?.password).toBe('pw-secret');
    expect(loaded[0]?.passphrase).toBe('pp-secret');
  });

  it('压根不去碰钥匙串', async () => {
    const kv = fakeKv();
    await store(kv).save([profile()]);
    await store(kv).load();

    expect(keychain.load).not.toHaveBeenCalled();
    expect(keychain.store).not.toHaveBeenCalled();
  });
});

describe('有钥匙串时', () => {
  beforeEach(() => keychain.available.mockResolvedValue(true));

  it('密码进钥匙串，键值表里**一个敏感字段都不留**', async () => {
    const kv = fakeKv();
    await store(kv).save([profile()]);

    const raw = (await rawOf(kv))[0] as Record<string, unknown>;
    expect(raw['password']).toBeUndefined();
    expect(raw['passphrase']).toBeUndefined();
    // 能公开的字段照旧在
    expect(raw['host']).toBe('127.0.0.1');
    expect(raw['username']).toBe('root');

    // 两个敏感字段打包成**一个**条目（一个连接一条，好管理也好删）
    const call = keychain.store.mock.calls.at(-1);
    expect(call?.[0]).toBe('profiles');
    const entry = call?.[1]?.[0];
    expect(entry?.id).toBe('p1');
    expect(JSON.parse(entry?.secret ?? '{}')).toEqual({
      password: 'pw-secret',
      passphrase: 'pp-secret',
    });
  });

  it('读的时候从钥匙串取回来', async () => {
    const kv = fakeKv({
      profiles: [{ id: 'p1', name: '本地', host: '127.0.0.1', port: 22, username: 'root' }],
    });
    keychain.load.mockResolvedValue({
      p1: JSON.stringify({ password: '从钥匙串来的', passphrase: '也是' }),
    });

    const loaded = await store(kv).load();
    expect(loaded[0]?.password).toBe('从钥匙串来的');
    expect(loaded[0]?.passphrase).toBe('也是');
  });
});

describe('老数据的迁移', () => {
  beforeEach(() => keychain.available.mockResolvedValue(true));

  it('键值表里还有明文、钥匙串里没有 → 搬过去，然后从键值表里删', async () => {
    const kv = fakeKv({ profiles: [profile()] });

    const loaded = await store(kv).load();

    // 搬进钥匙串了
    expect(keychain.store).toHaveBeenCalledTimes(1);
    const entry = keychain.store.mock.calls[0]?.[1]?.[0];
    expect(JSON.parse(entry?.secret ?? '{}')).toEqual({
      password: 'pw-secret',
      passphrase: 'pp-secret',
    });

    // 键值表里的明文没了
    const raw = (await rawOf(kv))[0] as Record<string, unknown>;
    expect(raw['password']).toBeUndefined();

    // 而用户读到的密码一点没变
    expect(loaded[0]?.password).toBe('pw-secret');
  });

  it('⚠️ 搬不进钥匙串时**一个字都不动**（下次再试，用户不丢密码）', async () => {
    const kv = fakeKv({ profiles: [profile()] });
    keychain.store.mockResolvedValue(false); // 写不进去

    const loaded = await store(kv).load();

    // 键值表原样：明文还在（下次启动还能再试一次）
    const raw = (await rawOf(kv))[0] as Record<string, unknown>;
    expect(raw['password']).toBe('pw-secret');

    // 而这次用户照样能读到自己的密码（从键值表里兜底）
    expect(loaded[0]?.password).toBe('pw-secret');
    expect(loaded[0]?.passphrase).toBe('pp-secret');
  });

  it('钥匙串里已经有了就不搬（避免每次启动都写一遍）', async () => {
    const kv = fakeKv({ profiles: [profile()] });
    keychain.load.mockResolvedValue({
      p1: JSON.stringify({ password: '在钥匙串里' }),
    });

    const loaded = await store(kv).load();

    expect(keychain.store).not.toHaveBeenCalled();
    expect(loaded[0]?.password).toBe('在钥匙串里');
  });

  it('本来就是空的敏感字段不搬（那是「这个连接不用密码」，不是待迁移的数据）', async () => {
    const kv = fakeKv({ profiles: [profile({ password: '', passphrase: '' })] });

    await store(kv).load();

    expect(keychain.store).not.toHaveBeenCalled();
  });
});

describe('钥匙串中途掉线', () => {
  it('读的时候整个不可用 → 退回键值表，而不是报错', async () => {
    const kv = fakeKv({ profiles: [profile()] });
    keychain.available.mockResolvedValue(true);
    keychain.load.mockRejectedValue(new Error('桌面会话锁了'));

    // `secrets.ts` 的实现里那条路是 catch 成 {}；这里直接验 store 的行为：
    // 掉线不该把 load 变成异常
    await expect(store(kv).load()).resolves.toBeDefined();
  });

  it('写的时候不可用 → 密码留在键值表里（不能写丢）', async () => {
    const kv = fakeKv();
    keychain.available.mockResolvedValue(false);

    await store(kv).save([profile()]);

    const raw = (await rawOf(kv))[0] as Record<string, unknown>;
    expect(raw['password']).toBe('pw-secret');
  });
});
