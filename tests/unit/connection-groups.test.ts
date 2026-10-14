/**
 * 连接目录的纯逻辑。
 *
 * 这块是目录功能里最容易出错的地方 —— 未分组的落哪儿、空目录画不画、
 * 目录悬空/成环怎么办、嵌套的路径、防环、删子树时成员收不收全 —— 所以它单独成
 * 函数、单独钉在这里。界面那层（三个 `ConnectionTree`）只是把 `buildTree`
 * 的结果画出来。
 *
 * ⚠️ 存储是**用户手改得动的**，所以「悬空」「成环」这些不是理论情况：
 * 手改过的库一打开就得能画出来，还不能把递归渲染搞爆。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildTree,
  createGroupStore,
  descendantIds,
  groupPath,
  moveGroupIn,
  newGroup,
  removeGroupTree,
  subtreeCount,
  withGroup,
  withoutGroup,
} from '../../src/shared/connections/groups';
import type { ConnectionGroup, ConnectionProfileBase } from '../../src/shared/connections/types';
import type { KeyValueStore } from '../../src/shared/platform/kv';
import { __resetIdsForTest } from '../../src/shared/ids';

beforeEach(() => __resetIdsForTest());

/** 只带目录逻辑关心的字段 —— 各模块自己的 db / kind 那些这里用不上 */
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

function group(id: string, name: string, parentId?: string): ConnectionGroup {
  return { id, name, ...(parentId === undefined ? {} : { parentId }) };
}

describe('buildTree', () => {
  it('顺序契约：未分组在最前、同级目录按创建顺序、组内按传入顺序', () => {
    // ⚠️ 传进来的 profiles 都是过滤过的 —— **这个顺序就是用户摆出来的树的形状**，
    // 重排等于让树自己变形。第一条就钉死它
    const groups = [group('g1', '生产'), group('g2', '测试')];
    const profiles = [
      conn('a', 'pg-prod', 'g1'),
      conn('b', '散着的'),
      conn('c', 'pg-test', 'g2'),
      conn('d', '另一个散着的'),
    ];

    const result = buildTree(profiles, groups);

    // 未分组的在前：新建的连接就是未分组，不放最上面用户得先展开几层才找得着
    expect(result.ungrouped.map((p) => p.name)).toEqual(['散着的', '另一个散着的']);
    expect(result.roots.map((n) => n.group.name)).toEqual(['生产', '测试']);
    expect(result.roots[0]?.items.map((p) => p.name)).toEqual(['pg-prod']);
    expect(result.roots[1]?.items.map((p) => p.name)).toEqual(['pg-test']);
  });

  it('嵌套：子目录挂在父目录的 children 里，连接挂在自己那层', () => {
    const groups = [
      group('g1', '生产'),
      group('g2', '项目A', 'g1'),
      group('g3', '测试'),
    ];
    const profiles = [conn('a', 'a 库', 'g2'), conn('b', 'b 库', 'g1')];

    const result = buildTree(profiles, groups);

    expect(result.roots.map((n) => n.group.name)).toEqual(['生产', '测试']);
    const 生产 = result.roots[0]!;
    expect(生产.items.map((p) => p.name)).toEqual(['b 库']);
    expect(生产.children.map((n) => n.group.name)).toEqual(['项目A']);
    expect(生产.children[0]?.items.map((p) => p.name)).toEqual(['a 库']);
  });

  it('指向一个不存在的目录 = 未分组（删了目录之后成员自然落回去）', () => {
    const profiles = [conn('a', '孤儿', '已经没有这个目录了')];
    // 用 hideEmpty 把那个空目录滤掉 —— 这条测的是「成员落回未分组」
    const result = buildTree(profiles, [group('g1', '生产')], true);

    expect(result.ungrouped.map((p) => p.name)).toEqual(['孤儿']);
    expect(result.roots).toEqual([]);
  });

  it('⚠️ 悬空 parentId 的目录当顶层 —— 不丢东西', () => {
    // 父目录被删过、或者库被手改过。丢掉它的话里面挂着的连接会跟着一起
    // 「从树上消失」，看起来就是数据没了
    const groups = [group('g1', '孤儿目录', '父目录早没了'), group('g2', '正常')];
    const profiles = [conn('a', 'x', 'g1')];

    const result = buildTree(profiles, groups);

    expect(result.roots.map((n) => n.group.name)).toEqual(['孤儿目录', '正常']);
    expect(result.roots[0]?.items.map((p) => p.name)).toEqual(['x']);
  });

  it('⚠️ 成环剪断当顶层 —— 两个都画得出来，而且只画一次', () => {
    // 手改出来的 A 挂 B、B 挂 A。渲染是递归的，一个环就是栈爆；
    // 剪断之后环里每个都变顶层兄弟（父指针唯一，不会画两遍）
    const groups = [group('a', 'A', 'b'), group('b', 'B', 'a')];
    const profiles = [conn('x', 'x 库', 'a')];

    const result = buildTree(profiles, groups);

    expect(result.roots.map((n) => n.group.name)).toEqual(['A', 'B']);
    expect(result.roots.every((n) => n.children.length === 0)).toBe(true);
    expect(result.roots[0]?.items.map((p) => p.name)).toEqual(['x 库']);
  });

  it('自己指自己也当顶层（环的最小形态）', () => {
    const result = buildTree([], [group('a', 'A', 'a')]);
    expect(result.roots.map((n) => n.group.name)).toEqual(['A']);
  });

  it('⚠️ 空目录照画 —— 用户刚建出来的那个目录就是空的', () => {
    // 这里原来写的是「空组不画」，理由是「和 SQL 那边只画有连接的引擎一样」。
    // **那个类比是错的**：引擎是**系统给的**（四个固定的种类），空的是噪音；
    // 目录是**用户自己建的** —— 他刚点完「＋目录」，界面上什么都没出现，
    // 只会以为那个按钮坏了。e2e 一跑就撞出来了。
    const result = buildTree(
      [conn('a', 'x', 'g1')],
      [group('g1', '生产'), group('g2', '还没放东西')],
    );

    expect(result.roots.map((n) => n.group.name)).toEqual(['生产', '还没放东西']);
    expect(result.roots[1]?.items).toEqual([]);
  });

  it('搜索时（hideEmpty）**递归**藏空：自己没命中、后代也没有的才藏', () => {
    // 父目录直接成员 0、但子目录里有命中的 —— 父必须画出来，
    // 不然那条命中就被藏在一棵看不见的树上
    const groups = [
      group('g1', '生产'),
      group('g2', '项目A', 'g1'),
      group('g3', '测试'),
      group('g4', '测试A', 'g3'),
    ];
    // 只有「项目A」里有命中
    const profiles = [conn('a', '命中的', 'g2')];

    const result = buildTree(profiles, groups, true);

    expect(result.roots.map((n) => n.group.name)).toEqual(['生产']);
    expect(result.roots[0]?.children.map((n) => n.group.name)).toEqual(['项目A']);
  });

  it('没有目录的时候全都算未分组（老数据、还没建过目录的情况）', () => {
    const result = buildTree([conn('a', 'x'), conn('b', 'y', 'g1')], []);

    expect(result.ungrouped.map((p) => p.name)).toEqual(['x', 'y']);
    expect(result.roots).toEqual([]);
  });
});

describe('subtreeCount', () => {
  it('数的是**整棵子树**的连接数，不是直接成员', () => {
    // 嵌套之后「直接成员 0、后代里还有 3 条」显示 0 看着就像个空目录
    const groups = [group('g1', '生产'), group('g2', '项目A', 'g1'), group('g3', '更深', 'g2')];
    const profiles = [conn('a', 'a', 'g1'), conn('b', 'b', 'g2'), conn('c', 'c', 'g3')];

    const result = buildTree(profiles, groups);

    expect(subtreeCount(result.roots[0]!)).toBe(3);
  });
});

describe('groupPath', () => {
  it('拼出全路径 —— 嵌套之后同名目录光看名字分不清', () => {
    const groups = [group('g1', '生产'), group('g2', '项目A', 'g1')];
    expect(groupPath(groups, 'g2')).toBe('生产/项目A');
    expect(groupPath(groups, 'g1')).toBe('生产');
  });

  it('手改出的环不会让它转不完', () => {
    const groups = [group('a', 'A', 'b'), group('b', 'B', 'a')];
    const path = groupPath(groups, 'a');
    expect(path).toContain('A');
    expect(path).toContain('B');
  });
});

describe('descendantIds', () => {
  it('全部后代（不含自己），环里也不会转不完', () => {
    const groups = [
      group('g1', '生产'),
      group('g2', '项目A', 'g1'),
      group('g3', '更深', 'g2'),
      group('g4', '别的'),
    ];
    expect([...descendantIds(groups, 'g1')].sort()).toEqual(['g2', 'g3']);
    expect([...descendantIds(groups, 'g4')]).toEqual([]);

    const cyclic = [group('a', 'A', 'b'), group('b', 'B', 'a')];
    expect([...descendantIds(cyclic, 'a')].sort()).toEqual(['b']);
  });
});

describe('moveGroupIn', () => {
  const groups = [
    group('g1', '生产'),
    group('g2', '项目A', 'g1'),
    group('g3', '更深', 'g2'),
    group('g4', '测试'),
  ];

  it('挪进另一个目录，写的是 parentId', () => {
    const next = moveGroupIn(groups, 'g4', 'g1');
    expect(next.find((g) => g.id === 'g4')?.parentId).toBe('g1');
    // 别的目录一个字不动
    expect(next.find((g) => g.id === 'g2')?.parentId).toBe('g1');
  });

  it('挪到顶层时把字段真的删掉（不是设成 undefined）', () => {
    const next = moveGroupIn(groups, 'g2', null);
    const moved = next.find((g) => g.id === 'g2');
    expect(moved?.parentId).toBeUndefined();
    expect(Object.hasOwn(moved ?? {}, 'parentId')).toBe(false);
  });

  it('⚠️ 目标是**自己**或**自己的后裔** → no-op（那是环）', () => {
    // 防环的权威在这一层：UI 的「不亮高亮」只是配合，真调进来也得拦住
    expect(moveGroupIn(groups, 'g1', 'g1').find((g) => g.id === 'g1')?.parentId).toBeUndefined();
    expect(moveGroupIn(groups, 'g1', 'g3').find((g) => g.id === 'g1')?.parentId).toBeUndefined();
    // 「更深」没被动过
    expect(moveGroupIn(groups, 'g1', 'g3').find((g) => g.id === 'g3')?.parentId).toBe('g2');
  });

  it('目标不存在、或者已经在那儿了 → 内容不变', () => {
    expect(moveGroupIn(groups, 'g4', '没这个目录')).toEqual(groups);
    expect(moveGroupIn(groups, 'g2', 'g1')).toEqual(groups); // 已经挂在 g1 下
    expect(moveGroupIn(groups, '不存在的', 'g1')).toEqual(groups);
  });
});

describe('removeGroupTree', () => {
  it('收的是**整棵子树**：子目录里的连接也算进去', () => {
    // ⚠️ 只按被点的那一个 id 挑连接的话，子目录里的会悬空落回未分组 ——
    // 界面上看就是「目录没了、连接还在」，会被当成 bug 来查
    const groups = [group('g1', '生产'), group('g2', '项目A', 'g1'), group('g3', '别的')];
    const profiles = [
      conn('a', 'a', 'g1'),
      conn('b', 'b', 'g2'),
      conn('c', 'c', 'g3'),
      conn('d', 'd'),
    ];

    const { removedGroupIds, removedProfiles, remainingGroups } = removeGroupTree(
      profiles,
      groups,
      'g1',
    );

    expect([...removedGroupIds].sort()).toEqual(['g1', 'g2']);
    expect(removedProfiles.map((p) => p.id).sort()).toEqual(['a', 'b']);
    expect(remainingGroups.map((g) => g.id)).toEqual(['g3']);
  });
});

describe('withGroup / withoutGroup', () => {
  it('放进目录就是写一个字段', () => {
    const next = withGroup(conn('a', 'x'), 'g1');
    expect(next.groupId).toBe('g1');
  });

  it('移出时字段被真的删掉，而不是留一个 undefined', () => {
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

describe('newGroup', () => {
  it('名字在**同级**里去重（不同分支下同名是允许的，有全路径兜着）', () => {
    const root = newGroup([]);
    expect(root.name).toBe('新建目录');
    expect(Object.hasOwn(root, 'parentId')).toBe(false);

    // 同一层里已经有「新建目录」→ 下一个是 2
    const second = newGroup([root], null);
    expect(second.name).toBe('新建目录 2');
    expect(second.id).not.toBe(root.id);

    // 另一个分支下的「新建目录」不占这一层的号
    const nested = newGroup([root, group('x', '新建目录', '别的父')], null);
    expect(nested.name).toBe('新建目录 2');
  });

  it('带 parentId 建的目录挂在那一层', () => {
    const child = newGroup([group('g1', '生产')], 'g1');
    expect(child.parentId).toBe('g1');
  });
});

describe('createGroupStore', () => {
  /** 一个够用的内存 kv（目录只用到 get/set） */
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
    // 形状不同（目录的 sanitize 和连接的完全不一样），混在一个键里迟早互相带坏
    const kv = fakeKv({ profiles: [{ id: 'conn-1' }] });
    const store = createGroupStore(kv);

    await store.save([group('g1', '生产')]);

    expect(kv.data.groups).toEqual([group('g1', '生产')]);
    expect(kv.data.profiles).toEqual([{ id: 'conn-1' }]); // 连接档案一个字没动
  });

  it('parentId 能存能读；老数据（没有这个字段）原样是顶层', async () => {
    const kv = fakeKv({
      groups: [
        { id: 'g1', name: '生产' }, // 老数据：没有 parentId
        { id: 'g2', name: '项目A', parentId: 'g1' },
        { id: 'g3', name: '坏的', parentId: 42 }, // 不是字符串 → 当没有
      ],
    });

    const groups = await createGroupStore(kv).load();

    expect(groups[0]).toEqual({ id: 'g1', name: '生产' });
    expect(groups[1]).toEqual({ id: 'g2', name: '项目A', parentId: 'g1' });
    expect(Object.hasOwn(groups[2] ?? {}, 'parentId')).toBe(false);
  });

  it('坏记录被丢掉，而不是让整份目录列表消失', async () => {
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
      { id: 'g2', name: '未命名目录' },
    ]);
  });

  it('存储里根本没有这个键时给空列表（第一次用这个功能）', async () => {
    expect(await createGroupStore(fakeKv()).load()).toEqual([]);
  });
});
