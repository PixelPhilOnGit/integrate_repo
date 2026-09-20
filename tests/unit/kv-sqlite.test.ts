/**
 * 键值存储换底（JSON → SQLite）的两条**安全性质**。
 *
 * 这两条都是「出错时不能让用户的数据打不开」，所以值得单独钉住：
 *
 * 1. 走通了：读写都落到 kv 那三个命令上，值是 **JSON 文本**；
 * 2. **搬迁失败时退回老的 `tauri-plugin-store`** —— 这次会话照常用老数据，
 *    而不是把错误弹给用户（`kv.ts` 头部那段）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/shared/platform/invoke', () => ({ invoke: invokeMock }));

/** 假的老实现（`@tauri-apps/plugin-store`）：只在退路那条路上被用到 */
const pluginStore = vi.hoisted(() => {
  const memory = new Map<string, unknown>();
  return {
    memory,
    load: vi.fn(async () => ({
      get: async (k: string) => memory.get(k) ?? null,
      set: async (k: string, v: unknown) => void memory.set(k, v),
      save: async () => {},
    })),
  };
});
vi.mock('@tauri-apps/plugin-store', () => ({ load: pluginStore.load }));

import { createSqliteKeyValue, moduleOf } from '../../src/shared/platform/kv';

beforeEach(() => {
  invokeMock.mockReset();
  pluginStore.load.mockClear();
  pluginStore.memory.clear();
});

describe('模块名', () => {
  it('从老文件名里去掉 .json（搬迁靠它对上）', () => {
    expect(moduleOf('redis.json')).toBe('redis');
    expect(moduleOf('prefs.json')).toBe('prefs');
  });
});

describe('桌面端：走 SQLite', () => {
  it('先 kv_open（搬迁），再按 key 读', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'kv_open') return undefined;
      if (cmd === 'kv_get') return '{"a":1}';
      return undefined;
    });

    const kv = createSqliteKeyValue('redis');
    expect(await kv.get('profiles')).toEqual({ a: 1 });
    expect(invokeMock.mock.calls[0]).toEqual(['kv_open', { module: 'redis' }]);
    expect(invokeMock.mock.calls[1]).toEqual([
      'kv_get',
      { module: 'redis', key: 'profiles' },
    ]);
  });

  it('没有的键是 null（不是抛）', async () => {
    invokeMock.mockImplementation(async (cmd: string) =>
      cmd === 'kv_get' ? null : undefined,
    );
    const kv = createSqliteKeyValue('redis');
    expect(await kv.get('没有这个键')).toBeNull();
  });

  it('写出去的是 JSON 文本', async () => {
    invokeMock.mockImplementation(async () => undefined);
    const kv = createSqliteKeyValue('ssh');
    await kv.set('profiles', [{ id: 'p1' }]);

    expect(invokeMock).toHaveBeenCalledWith('kv_set', {
      module: 'ssh',
      key: 'profiles',
      value: '[{"id":"p1"}]',
    });
  });
});

describe('⚠️ 搬迁失败时退回老实现', () => {
  it('kv_open 报错 → 改用 plugin-store，数据照样读得到', async () => {
    invokeMock.mockRejectedValue(new Error('老数据文件搬迁失败：老文件没动'));
    // 老实现手里有数据（老 JSON 文件没被动过，所以它读得到）
    pluginStore.memory.set('profiles', [{ id: '老的' }]);

    const kv = createSqliteKeyValue('redis');
    expect(await kv.get('profiles')).toEqual([{ id: '老的' }]);

    // 而且之后不会再试一遍那个坏掉的命令（这次会话就认老实现了）
    const callsAfterFirst = invokeMock.mock.calls.length;
    await kv.get('profiles');
    expect(invokeMock.mock.calls.length).toBe(callsAfterFirst);
  });

  it('退路里写也是写回老文件（这次会话的数据不能丢）', async () => {
    invokeMock.mockRejectedValue(new Error('坏了'));
    const kv = createSqliteKeyValue('sql');
    await kv.set('profiles', [{ id: 'p2' }]);

    expect(pluginStore.memory.get('profiles')).toEqual([{ id: 'p2' }]);
  });
});
