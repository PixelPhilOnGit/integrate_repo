/**
 * 助手配置的 store：迁移、钥匙串搬迁的重试、key 跟着配置走、删除。
 *
 * ⚠️ 这一组盯的是**升级**那条路 —— 用户从旧版（只有一份配置、key 按提供方存）
 * 升上来时，配置和钥匙串里那把 key 都得跟着过来。丢任何一个都会变成
 * 「我明明配过，怎么又要填」那种最难查的症状。
 *
 * ⚠️ 用假的 KV 和假的 client（`AssistantStore` 的构造支持注入）——
 * 不碰 localStorage、不碰平台层，跑在 node 里毫秒级。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// `deleteProfile` 里「配过 key 就先问一句」走的是 `platform.confirm`。
// 浏览器版那层是 `window.confirm`，node 里没有 —— 换成可控的替身。
const confirmMock = vi.hoisted(() => vi.fn(async () => true));
vi.mock('../../src/shared/platform', () => ({
  platform: { confirm: confirmMock },
}));

import { LEGACY_PROFILE_ID } from '../../src/modules/assistant/core/config';
import type { ProviderProfile } from '../../src/modules/assistant/core/config';
import { AssistantStore } from '../../src/modules/assistant/state/store';
import type { AssistantClient } from '../../src/modules/assistant/services/types';
import type { KeyValueStore } from '../../src/shared/platform/kv';

/** 内存 KV 替身。`set(key, null)` 等于删掉（和真实现同一套语义）。 */
type FakeKv = KeyValueStore & { rows: Map<string, unknown> };

function fakeKv(seed: Record<string, unknown> = {}): FakeKv {
  const rows = new Map(Object.entries(seed));
  return {
    rows,
    async get<T>(key: string): Promise<T | null> {
      return (rows.get(key) as T) ?? null;
    },
    async set(key: string, value: unknown): Promise<void> {
      if (value === null || value === undefined) rows.delete(key);
      else rows.set(key, value);
    },
  };
}

/** 假钥匙串 + 假 client。记下每个调用，好断言「有没有调、调了几次」。 */
function fakeClient() {
  const keys = new Map<string, string>();
  /** 老命名（`api_key:<提供方>`）那一份 —— 模拟从旧版升上来的机器。 */
  const legacy = new Map<string, string>();
  const calls: string[] = [];

  const client: AssistantClient = {
    async keyStatus(profileId) {
      calls.push(`status:${profileId}`);
      return { available: true, configured: keys.has(profileId) };
    },
    async setApiKey(profileId, key) {
      calls.push(`set:${profileId}`);
      if (key.trim() === '') keys.delete(profileId);
      else keys.set(profileId, key);
    },
    async migrateApiKey(fromKind, toProfileId) {
      calls.push(`migrate:${fromKind}->${toProfileId}`);
      // 和 Rust 侧 `plan_key_move` 同一套：读来源 → 写目标（非空不写）→ 删来源
      const source = legacy.get(fromKind);
      if (source === undefined) return;
      if (!keys.has(toProfileId)) keys.set(toProfileId, source);
      legacy.delete(fromKind);
    },
    async testConnection() {
      return { ok: true, millis: 1, message: '通了', reply: '好' };
    },
    async send(request) {
      calls.push(`send:${request.profileId}`);
      return 1;
    },
    async approve() {
      return true;
    },
    async cancel() {},
    async clearSession() {},
  };

  return { client, keys, legacy, calls };
}

/** 起一个初始化完的 store。 */
async function makeStore(seed: Record<string, unknown> = {}) {
  const kv = fakeKv(seed);
  const fake = fakeClient();
  const store = new AssistantStore(fake.client, kv);
  await store.init();
  return { store, kv, ...fake };
}

/** 旧版那份裸配置（存在 KV 键 `provider` 里）。 */
const LEGACY_CONFIG = {
  kind: 'openai',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
};

beforeEach(() => {
  confirmMock.mockClear();
  confirmMock.mockResolvedValue(true);
});

describe('全新安装', () => {
  it('兜一份默认配置并选中它', async () => {
    const { store } = await makeStore();
    const state = store.getSnapshot();

    expect(state.profiles).toHaveLength(1);
    expect(state.selectedId).toBe(state.profiles[0]?.id);
    expect(store.selected()?.kind).toBe('anthropic');
  });
});

describe('升级迁移（KV 侧）', () => {
  it('⚠️ 旧版那份裸配置会被采纳成第一条，而且字段一个不丢', async () => {
    const { store, kv } = await makeStore({ provider: LEGACY_CONFIG });

    const profile = store.selected();
    expect(profile?.id).toBe(LEGACY_PROFILE_ID);
    expect(profile?.kind).toBe('openai');
    expect(profile?.baseUrl).toBe('https://api.deepseek.com');
    expect(profile?.model).toBe('deepseek-chat');

    // 名单落盘了，旧键被消费掉
    expect(kv.rows.get('profiles')).toBeDefined();
    expect(kv.rows.has('provider')).toBe(false);
  });

  it('⚠️ 旧键只在**名单为空**时才被采纳', async () => {
    // 名单已经有内容了（用户已经在用新版）—— 旧键一个字都不该影响它。
    // 这是「先写名单、后消费旧键」那个顺序的兜底：万一消费那一步没成功，
    // 下次启动也不会把旧配置又端上来。
    const existing: ProviderProfile[] = [
      {
        id: 'p_mine',
        name: '我自己建的',
        kind: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        model: 'claude-opus-5',
      },
    ];
    const { store } = await makeStore({ profiles: existing, provider: LEGACY_CONFIG });

    expect(store.getSnapshot().profiles).toHaveLength(1);
    expect(store.selected()?.name).toBe('我自己建的');
  });

  it('旧键认不出来（或者根本没有）就兜一份全新的', async () => {
    const { store } = await makeStore();
    expect(store.selected()?.id).not.toBe(LEGACY_PROFILE_ID);
  });

  it('选中的那份如果在名单里找不到，落到第一条', async () => {
    const { store } = await makeStore({ selected: 'p_已经被删了' });
    expect(store.getSnapshot().selectedId).toBe(store.getSnapshot().profiles[0]?.id);
  });
});

describe('钥匙串搬迁', () => {
  it('⚠️ 迁过来的那份还没 key → 自动搬一次（老条目里的搬过来）', async () => {
    const { store, keys, legacy, calls } = await makeStore({ provider: LEGACY_CONFIG });
    legacy.set('openai', 'sk-old');

    await store.refreshKeyStatus();

    expect(keys.get(LEGACY_PROFILE_ID)).toBe('sk-old');
    expect(legacy.has('openai')).toBe(false);
    expect(store.getSnapshot().keyStatus?.configured).toBe(true);
    expect(calls).toContain(`migrate:openai->${LEGACY_PROFILE_ID}`);
  });

  it('⚠️ 搬不成的话下次还会再试 —— 不落任何「搬过了」的标记', async () => {
    // 这是「搬到一半崩了」「钥匙串当时锁着」能自愈的全部理由。
    const { store, client } = await makeStore({ provider: LEGACY_CONFIG });
    const migrate = vi.spyOn(client, 'migrateApiKey');

    await store.refreshKeyStatus();
    await store.refreshKeyStatus();
    await store.refreshKeyStatus();

    // 还没有 key（假 client 的老条目是空的），所以每次都在试
    expect(migrate.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('已经配好了就不再调搬迁', async () => {
    const { store, keys, client } = await makeStore({ provider: LEGACY_CONFIG });
    keys.set(LEGACY_PROFILE_ID, 'sk-新填的');
    const migrate = vi.spyOn(client, 'migrateApiKey');

    await store.refreshKeyStatus();
    expect(migrate).not.toHaveBeenCalled();
  });

  it('新建的配置不碰搬迁（它没有老条目要搬）', async () => {
    const { store, client } = await makeStore();
    const migrate = vi.spyOn(client, 'migrateApiKey');

    await store.createProfile();
    expect(migrate).not.toHaveBeenCalled();
  });
});

describe('多份配置', () => {
  it('新建一份会选中它，名字去重', async () => {
    const { store } = await makeStore();
    await store.createProfile();
    await store.createProfile();

    // 三条：兜的那份默认配置 + 新建的两份（名字依次去重）
    const state = store.getSnapshot();
    expect(state.profiles.map((p) => p.name)).toEqual([
      '新建配置',
      '新建配置 2',
      '新建配置 3',
    ]);
    expect(state.selectedId).toBe(state.profiles[2]?.id);
  });

  it('⚠️ key 跟着配置走：切一份就问那份的状态', async () => {
    const { store, keys, calls } = await makeStore();
    const first = store.getSnapshot().profiles[0]!;
    keys.set(first.id, 'sk-a');

    const second = await store.createProfile();
    expect(store.getSnapshot().selectedId).toBe(second);
    // 新那份没有 key
    expect(store.getSnapshot().keyStatus?.configured).toBe(false);

    store.select(first.id);
    await vi.waitFor(() => {
      expect(store.getSnapshot().keyStatus?.configured).toBe(true);
    });
    expect(calls).toContain(`status:${first.id}`);
  });

  it('换提供方时地址和模型跟着换成那一家的默认值', async () => {
    const { store } = await makeStore();
    const id = store.selected()!.id;

    await store.updateProfile(id, { kind: 'openai' });
    const p = store.profileById(id);
    expect(p?.kind).toBe('openai');
    // OpenAI 兼容没有默认地址，所以是空串（该让用户填的还是要他填）
    expect(p?.baseUrl).toBe('');
    expect(p?.model).not.toBe('claude-opus-5');
  });

  it('改配置会把上一次的测试结果清掉', async () => {
    const { store } = await makeStore();
    const id = store.selected()!.id;
    await store.testConnection();
    expect(store.getSnapshot().test).not.toBeNull();

    await store.updateProfile(id, { model: '别的模型' });
    // 留着的话，用户改完看到上一次那句「通了」，会以为新的这套也通了
    expect(store.getSnapshot().test).toBeNull();
  });

  it('选中的那份持久化 —— 重启之后还是它', async () => {
    const { store, kv, ...rest } = await makeStore();
    const second = await store.createProfile();

    // 拿同一份 KV 再起一个 store（模拟重启）
    const again = new AssistantStore(rest.client, kv);
    await again.init();
    expect(again.getSnapshot().selectedId).toBe(second);
  });
});

describe('删除', () => {
  it('删选中的那份 → 落到第一条', async () => {
    const { store } = await makeStore();
    const first = store.getSnapshot().profiles[0]!.id;
    const second = await store.createProfile();

    await store.deleteProfile(second);
    expect(store.getSnapshot().profiles.map((p) => p.id)).toEqual([first]);
    expect(store.getSnapshot().selectedId).toBe(first);
  });

  it('⚠️ 配过 key 会先问一句；拒绝就什么都不删', async () => {
    const { store, keys } = await makeStore();
    const id = store.selected()!.id;
    keys.set(id, 'sk-a');
    confirmMock.mockResolvedValue(false);

    await store.deleteProfile(id);
    expect(confirmMock).toHaveBeenCalled();
    expect(store.getSnapshot().profiles).toHaveLength(1);
    expect(keys.has(id)).toBe(true);
  });

  it('⚠️ 确认之后连钥匙串那条一起删', async () => {
    // id 随机生成、永不复用，留着就是纯垃圾
    const { store, keys } = await makeStore();
    await store.createProfile();
    const id = store.getSnapshot().profiles[1]!.id;
    keys.set(id, 'sk-a');

    await store.deleteProfile(id);
    expect(store.getSnapshot().profiles).toHaveLength(1);
    expect(keys.has(id)).toBe(false);
  });

  it('没配过 key 就不问（多一次确认只是烦）', async () => {
    const { store } = await makeStore();
    await store.deleteProfile(store.selected()!.id);
    expect(confirmMock).not.toHaveBeenCalled();
  });
});

describe('发送时用哪一份', () => {
  it('⚠️ 发的是**选中的那份**，config 和 profileId 都跟着它', async () => {
    const { store, keys, calls } = await makeStore();
    const second = await store.createProfile();
    // 发之前得先有 key —— 没有的话 `send` 会在前置检查那儿就返回
    keys.set(second, 'sk-test');
    store.setWorkspace('/tmp/ws');
    await store.refreshKeyStatus();

    await store.send('你好');

    expect(calls).toContain(`send:${second}`);
  });

  it('一份配置都没有就发不出去，而且说得出原因', async () => {
    const { store } = await makeStore();
    await store.deleteProfile(store.getSnapshot().profiles[0]!.id);

    expect(store.canSend()).toBe(false);
    expect(store.configProblem()).toContain('还没有模型配置');
  });
});
