/**
 * 群组 store 的接线：用浏览器假实现驱动一整轮。
 *
 * 验的是**状态机**而不是界面：@ 路由、顺序模式的内容传递、停止、切群时
 * 事件不串线、结束后用历史对账。这些都是「界面看着正常但状态错了」的重灾区。
 */

import { describe, expect, it } from 'vitest';
import { GroupStore } from '../../src/modules/group/state/store';
import { createWebGroupClient } from '../../src/modules/group/services/web';
import { __resetGroupsForTest } from '../../src/modules/group/services/web';

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('等待超时');
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function makeStore(): Promise<GroupStore> {
  __resetGroupsForTest();
  const store = new GroupStore(createWebGroupClient());
  await store.init();
  return store;
}

/** 建群 + 两个成员（甲 / 乙）。返回成员 id。 */
async function twoMembers(store: GroupStore): Promise<{ groupId: string; m1: string; m2: string }> {
  await store.createGroup('项目群');
  const detail = store.getSnapshot().detail;
  if (detail === null) throw new Error('群没建出来');
  const groupId = detail.id;

  await store.addMember();
  const first = store.getSnapshot().detail?.members[0];
  if (first === undefined) throw new Error('第一个成员没加出来');
  store.patchMember(first.id, { name: '甲' });
  await store.persist();

  await store.addMember();
  const second = store.getSnapshot().detail?.members[1];
  if (second === undefined) throw new Error('第二个成员没加出来');
  store.patchMember(second.id, { name: '乙' });
  await store.persist();

  // 共享工作目录（浏览器版 pickWorkspace 返回 /工作区，这里直接写）
  store.patchDetail({ workspace: '/工作区' });
  await store.persist();

  return { groupId, m1: first.id, m2: second.id };
}

async function waitTurnDone(store: GroupStore): Promise<void> {
  await waitFor(() => {
    const s = store.getSnapshot();
    return s.activeTurnId === null && s.sending === false;
  });
}

describe('跑一轮', () => {
  it('不 @：两个成员都回答；顺序模式下第二个能看到第一个', async () => {
    const store = await makeStore();
    await twoMembers(store);

    expect(await store.send('各自说说')).toBe(true);
    await waitTurnDone(store);

    const members = store
      .getSnapshot()
      .messages.filter((m) => m.role === 'member');
    expect(members.map((m) => m.speakerName)).toEqual(['甲', '乙']);
    expect(members[1]?.text).toContain('看到');
    expect(members[1]?.text).toContain('甲');
  });

  it('@ 谁就只有谁回答', async () => {
    const store = await makeStore();
    const { m2 } = await twoMembers(store);

    expect(await store.send(`@乙 你来说`)).toBe(true);
    await waitTurnDone(store);

    const members = store
      .getSnapshot()
      .messages.filter((m) => m.role === 'member');
    expect(members).toHaveLength(1);
    expect(members[0]?.memberId).toBe(m2);
    expect(members[0]?.speakerName).toBe('乙');
  });

  it('未知 @ 被拦住，一条消息都不发', async () => {
    const store = await makeStore();
    await twoMembers(store);

    expect(await store.send('@张三 你说')).toBe(false);
    expect(store.getSnapshot().error).toContain('@张三');
    expect(store.getSnapshot().messages).toHaveLength(0);
  });

  it('停止：成员标成已停止，整轮收尾', async () => {
    const store = await makeStore();
    await twoMembers(store);

    expect(await store.send('慢慢说')).toBe(true);
    await store.stop();
    await waitTurnDone(store);

    const s = store.getSnapshot();
    const members = s.messages.filter((m) => m.role === 'member');
    expect(members.every((m) => m.status === 'cancelled' || m.status === 'done')).toBe(true);
    expect(s.runningGroups[Object.keys(s.runningGroups)[0] ?? '']).toBeUndefined();
  });
});

describe('切群', () => {
  it('一轮跑到一半切走：事件不串到另一个群的时间线上', async () => {
    const store = await makeStore();
    const { groupId } = await twoMembers(store);
    await store.createGroup('另一个群');
    const otherId = store.getSnapshot().detail?.id;
    if (otherId === undefined) throw new Error('第二个群没建出来');
    await store.selectGroup(groupId);

    expect(await store.send('说点长的')).toBe(true);
    await store.selectGroup(otherId);

    const before = store.getSnapshot().messages.length;
    await waitFor(() => store.getSnapshot().sending === false);
    // 等后台那一轮真的跑完
    await new Promise((r) => setTimeout(r, 300));

    expect(store.getSnapshot().selectedId).toBe(otherId);
    expect(store.getSnapshot().messages).toHaveLength(before);

    // 切回来能看到完整历史（浏览器版把成员消息落进了 history）
    await store.selectGroup(groupId);
    await waitFor(() => store.getSnapshot().detail !== null);
    const names = store
      .getSnapshot()
      .messages.filter((m) => m.role === 'member')
      .map((m) => m.speakerName);
    expect(names).toEqual(['甲', '乙']);
  });

  it('对账之后消息 id 是数据库 id（key 以 db: 开头）', async () => {
    const store = await makeStore();
    await twoMembers(store);
    expect(await store.send('你好')).toBe(true);
    await waitTurnDone(store);
    await waitFor(() => store.getSnapshot().messages.every((m) => m.key.startsWith('db:')));
    expect(store.getSnapshot().messages.every((m) => m.id !== null)).toBe(true);
  });
});

describe('配置', () => {
  it('成员重名保存会报错（前端先拦）', async () => {
    const store = await makeStore();
    await twoMembers(store);
    const second = store.getSnapshot().detail?.members[1];
    if (second === undefined) throw new Error('没有第二个成员');
    store.patchMember(second.id, { name: '甲' });
    expect(await store.persist()).toBe(false);
    expect(store.getSnapshot().error).toContain('重复');
  });

  it('删除成员后历史仍然读得到（名字是快照）', async () => {
    const store = await makeStore();
    const { m2 } = await twoMembers(store);
    expect(await store.send('留个记录')).toBe(true);
    await waitTurnDone(store);
    await waitFor(() => store.getSnapshot().messages.every((m) => m.key.startsWith('db:')));

    await store.removeMember(m2);
    const names = store
      .getSnapshot()
      .messages.filter((m) => m.role === 'member')
      .map((m) => m.speakerName);
    expect(names).toContain('乙');
  });

  it('有轮次在跑时清空历史是空操作', async () => {
    const store = await makeStore();
    await twoMembers(store);
    expect(await store.send('别清')).toBe(true);
    await store.clearHistory();
    // 停止后消息仍然在（清空被拦下了）
    await store.stop();
    await waitTurnDone(store);
    expect(store.getSnapshot().messages.length).toBeGreaterThan(0);
  });
});
