/**
 * 连接分组的纯逻辑。
 *
 * 这块是分组功能里最容易出错的地方 —— 未分组的落哪儿、空组画不画、
 * 组没了成员怎么办、移出时字段留不留 —— 所以它单独成函数、单独钉在这里。
 * 界面那层（三个 `ConnectionTree`）只是把 `assignGroups` 的结果画出来。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  assignGroups,
  createGroupStore,
  newGroup,
  removeGroup,
  withGroup,
  withoutGroup,
} from '../../src/shared/connections/groups';
import type { ConnectionGroup, ConnectionProfileBase } from '../../src/shared/connections/types';
import type { KeyValueStore } from '../../src/shared/platform/kv';
import { __resetIdsForTest } from '../../src/shared/ids';

beforeEach(() => __resetIdsForTest());

/** 只带分组逻辑关心的字段 —— 各模块自己的 db / kind 那些这里用不上 */
function conn(id: string, name: string, groupId?: string): ConnectionProfileBase {
  return {
    id,
    name,
    host: '127.0.0.1',
    port: 1,
    username: 'u',
    password: '',
    ...(groupId === undefined ? {} : { groupId }),
  };
}

function group(id: string, name: string): ConnectionGroup {
  return { id, name };
}

describe('assignGroups', () => {
  it('未分组的排在最前面，分组按传进来的顺序（= 用户的创建顺序）', () => {
    const groups = [group('g1', '生产'), group('g2', '测试')];
    const profiles = [
      conn('a', 'pg-prod', 'g1'),
      conn('b', '散着的'),
      conn('c', 'pg-test', 'g2'),
      conn('d', '另一个散着的'),
    ];

    const result = assignGroups(profiles, groups);

    // 未分组的在前：新建的连接就是未分组，不放最上面用户得先展开某个组才找得着
    expect(result.ungrouped.map((p) => p.name)).toEqual(['散着的', '另一个散着的']);
    expect(result.groups.map((g) => g.group.name)).toEqual(['生产', '测试']);
    expect(result.groups[0]?.items.map((p) => p.name)).toEqual(['pg-prod']);
    expect(result.groups[1]?.items.map((p) => p.name)).toEqual(['pg-test']);
  });

  it('指向一个不存在的分组 = 未分组（删了组之后成员自然落回去）', () => {
    // 这条不是为了容错，是**故意的**：删组时不需要先要求用户把连接搬走。
    // 见 `ConnectionProfileBase.groupId` 的说明
    const profiles = [conn('a', '孤儿', '已经没有这个组了')];
    // 用 hideEmpty 把那个空组滤掉 —— 这条测的是「成员落回未分组」，
    // 空组画不画是上一条的职责
    const result = assignGroups(profiles, [group('g1', '生产')], true);

    expect(result.ungrouped.map((p) => p.name)).toEqual(['孤儿']);
    expect(result.groups).toEqual([]);
  });

  it('⚠️ 空组照画 —— 用户刚建出来的那个组就是空的', () => {
    // 这里原来写的是「空组不画」，理由是「和 SQL 那边只画有连接的引擎一样」。
    // **那个类比是错的**：引擎是**系统给的**（四个固定的种类），空的是噪音；
    // 分组是**用户自己建的** —— 他刚点完「＋分组」，界面上什么都没出现，
    // 只会以为那个按钮坏了。e2e 一跑就撞出来了。
    const result = assignGroups(
      [conn('a', 'x', 'g1')],
      [group('g1', '生产'), group('g2', '还没放东西')],
    );

    expect(result.groups.map((g) => g.group.name)).toEqual(['生产', '还没放东西']);
    expect(result.groups[1]?.items).toEqual([]);
  });

  it('搜索时（hideEmpty）一个都没命中的组不占位置', () => {
    // 搜索时用户在找具体的一条，一屏空壳是噪音
    const result = assignGroups(
      [conn('a', 'x', 'g1')],
      [group('g1', '生产'), group('g2', '空的')],
      true,
    );

    expect(result.groups.map((g) => g.group.name)).toEqual(['生产']);
  });

  it('没有分组的时候全都算未分组（老数据、还没建过组的情况）', () => {
    const result = assignGroups([conn('a', 'x'), conn('b', 'y', 'g1')], []);

    expect(result.ungrouped.map((p) => p.name)).toEqual(['x', 'y']);
    expect(result.groups).toEqual([]);
  });
});

describe('withGroup / withoutGroup', () => {
  it('放进分组就是写一个字段', () => {
    const next = withGroup(conn('a', 'x'), 'g1');
    expect(next.groupId).toBe('g1');
  });

  it('移出分组时字段被真的删掉，而不是留一个 undefined', () => {
    // 留 `undefined` 的话存进 JSON 会变成 `"groupId": null`，
    // 下次读出来又是另一种形状 —— 没必要给自己找事
    const next = withoutGroup(conn('a', 'x', 'g1'));
    expect(next.groupId).toBeUndefined();
    expect(Object.hasOwn(next, 'groupId')).toBe(false);
  });

  it('传 null 走的就是移出那条路', () => {
    const next = withGroup(conn('a', 'x', 'g1'), null);
    expect(Object.hasOwn(next, 'groupId')).toBe(false);
  });

  it('不改原来那个对象（store 里是拿它算新数组的）', () => {
    const original = conn('a', 'x');
    withGroup(original, 'g1');
    expect(original.groupId).toBeUndefined();
  });
});

describe('removeGroup', () => {
  it('删组时成员落回未分组，别的组一个不动', () => {
    const profiles = [
      conn('a', 'x', 'g1'),
      conn('b', 'y', 'g2'),
      conn('c', 'z'),
    ];

    const next = removeGroup(profiles, 'g1');

    expect(next.find((p) => p.id === 'a')?.groupId).toBeUndefined();
    expect(next.find((p) => p.id === 'b')?.groupId).toBe('g2');
    expect(next.find((p) => p.id === 'c')?.groupId).toBeUndefined();
  });
});

describe('newGroup', () => {
  it('名字自动去重', () => {
    const first = newGroup([]);
    expect(first.name).toBe('新建分组');

    const second = newGroup([first]);
    expect(second.name).toBe('新建分组 2');

    expect(second.id).not.toBe(first.id);
  });
});

describe('createGroupStore', () => {
  /** 一个够用的内存 kv（组只用到 get/set） */
  function fakeKv(initial: Record<string, unknown> = {}): KeyValueStore & {
    data: Record<string, unknown>;
  } {
    const data = { ...initial };
    return {
      data,
      get: async <T,>(key: string): Promise<T | null> => (data[key] as T) ?? null,
      set: async (key: string, value: unknown): Promise<void> => {
        data[key] = value;
      },
    };
  }

  it('存的是**另一个键**，不和连接档案挤在一起', async () => {
    // 形状不同（组的 sanitize 和连接的完全不一样），混在一个键里迟早互相带坏
    const kv = fakeKv({ profiles: [{ id: 'conn-1' }] });
    const store = createGroupStore(kv);

    await store.save([group('g1', '生产')]);

    expect(kv.data.groups).toEqual([group('g1', '生产')]);
    expect(kv.data.profiles).toEqual([{ id: 'conn-1' }]); // 连接档案一个字没动
  });

  it('坏记录被丢掉，而不是让整份分组列表消失', async () => {
    const kv = fakeKv({
      groups: [
        { id: 'g1', name: '生产' },
        { name: '没有 id 的' }, // 没有 id 挂不住连接
        'not an object',
        { id: 'g2' }, // 没有名字 → 补默认值，而不是丢掉
      ],
    });

    const groups = await createGroupStore(kv).load();

    expect(groups).toEqual([
      { id: 'g1', name: '生产' },
      { id: 'g2', name: '未命名分组' },
    ]);
  });

  it('存储里根本没有这个键时给空列表（第一次用这个功能）', async () => {
    expect(await createGroupStore(fakeKv()).load()).toEqual([]);
  });
});
