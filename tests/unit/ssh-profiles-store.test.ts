/**
 * SSH 档案的读盘整形 —— 重点是**「本地终端」这次加字段的迁移**。
 *
 * 关键风险很窄但很要命：`kind` 是新加的字段，而 v0.4 之前的档案里**没有它**。
 * 读错的代价是「用户所有连接突然都变成本地终端」（或者反过来，本地终端被当成
 * 要连的机器）。所以这一组盯的就是那个默认值：
 *
 * - 旧档案（连 `kind` 都没有）→ **必须当 ssh**
 * - 只有明确写了 `local` → 才是本地终端
 */
import { describe, expect, it } from 'vitest';
import { createSshProfileStore } from '../../src/modules/ssh/services/profiles';
import type { KeyValueStore } from '../../src/shared/platform/kv';

/** 最小 kv 替身：读什么由用例给，写什么都不关心 */
function kvWith(stored: unknown): KeyValueStore {
  return {
    async get<T>(): Promise<T | null> {
      return (stored as T) ?? null;
    },
    async set(): Promise<void> {},
  };
}

/** v0.4 之前的档案形状：没有 kind / localShell */
const LEGACY = {
  id: 'old1',
  name: '生产机',
  host: '10.0.0.5',
  port: 2222,
  username: 'deploy',
  authKind: 'key',
  password: '',
  privateKeyPath: '/home/me/.ssh/id_ed25519',
  passphrase: '',
};

describe('档案迁移：旧档案当 ssh', () => {
  it('⚠️ 没有 kind 字段的旧档案读进来是 **ssh**（不是本地终端）', async () => {
    const store = createSshProfileStore(kvWith([LEGACY]));
    const [profile] = await store.load();

    expect(profile!.kind).toBe('ssh');
    expect(profile!.localShell).toBe('');
    // 其它字段一个不丢
    expect(profile!.host).toBe('10.0.0.5');
    expect(profile!.port).toBe(2222);
    expect(profile!.privateKeyPath).toBe('/home/me/.ssh/id_ed25519');
  });

  it('明确写了 local 的才是本地终端，shell 也读得回来', async () => {
    const store = createSshProfileStore(
      kvWith([{ ...LEGACY, id: 'loc1', kind: 'local', localShell: 'cmd' }]),
    );
    const [profile] = await store.load();

    expect(profile!.kind).toBe('local');
    expect(profile!.localShell).toBe('cmd');
  });

  it('⚠️ 认不出来的 kind 一律当 ssh（白名单，不是「不是 ssh 就是 local」）', async () => {
    // 手改过的、或者更新的版本写进来的值 —— 猜成「本地」的话用户会连错地方
    for (const weird of ['LOCAL', 'localx', 42, null, {}]) {
      const store = createSshProfileStore(kvWith([{ ...LEGACY, kind: weird }]));
      const [profile] = await store.load();
      expect(profile!.kind).toBe('ssh');
    }
  });

  it('坏记录照样只丢那一条（整份列表不该因为一条作废）', async () => {
    const store = createSshProfileStore(
      kvWith([LEGACY, { name: '没有 id' }, null, { id: 'ok', kind: 'local' }]),
    );
    const profiles = await store.load();
    expect(profiles.map((p) => p.id)).toEqual(['old1', 'ok']);
  });
});
