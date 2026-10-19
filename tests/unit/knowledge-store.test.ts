import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 知识库 store 的行为测试。
 *
 * 走的是**真的浏览器假实现**（`services/web.ts`，纯内存、node 里跑得动）——
 * 这样测到的编排语义和 e2e 是同一份；真落盘/真提取/真 CLI 归 Rust 那组测试。
 */

vi.mock('../../src/modules/knowledge/services', async () => {
  const { createWebKnowledgeClient } = await import('../../src/modules/knowledge/services/web');
  // 每个测试文件一份干净的内存假实现（模块级实例；用例之间用不重名的库隔离）
  return { knowledgeServices: { client: createWebKnowledgeClient() } };
});

import { knowledgeStore } from '../../src/modules/knowledge/state/store';
import { __resetWebKnowledgeForTest } from '../../src/modules/knowledge/services/web';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function readyOnSeed(): Promise<void> {
  await knowledgeStore.init();
  await knowledgeStore.setActiveVault('示例库');
}

beforeEach(async () => {
  // ⚠️ store 和假实现都是**模块级单例**：两样都要归位，用例才互相独立。
  // 假 vault 归位后重建种子，store 靠 setActiveVault 重新拉一遍。
  __resetWebKnowledgeForTest();
  knowledgeStore.setFilter('all');
  knowledgeStore.setQuery('');
  knowledgeStore.dismissGen();
  await knowledgeStore.selectCard(null);
  await readyOnSeed();
  await sleep(300); // 让去抖的搜索空转过去
});

describe('KnowledgeStore', () => {
  it('init 后落在示例库_卡片墙的口径分得清评审和归档', async () => {
    await readyOnSeed();
    const s = knowledgeStore.getSnapshot();
    expect(s.activeVault).toBe('示例库');
    expect(knowledgeStore.counts()).toEqual({ all: 2, unreviewed: 1, reviewed: 1, archived: 1 });
  });

  it('点开卡片读全文_标为已评审会自动跳下一张未评审', async () => {
    await readyOnSeed();
    const first = knowledgeStore.visible()[0];
    expect(first).toBeDefined();
    // 种子里恰好一张未评审（登录流程）——点它、评审、后面没有未评审了
    await knowledgeStore.selectCard('登录流程.md');
    expect(knowledgeStore.getSnapshot().detail?.title).toBe('登录流程');

    await knowledgeStore.markReviewedAndNext('登录流程.md');
    const s = knowledgeStore.getSnapshot();
    expect(knowledgeStore.counts().unreviewed).toBe(0);
    expect(s.selectedRel).toBeNull(); // 没有下一张
  });

  it('搜索下推（假实现里是子串）_命中集覆盖列表', async () => {
    await readyOnSeed();
    knowledgeStore.setQuery('架构图');
    await sleep(320);
    const s = knowledgeStore.getSnapshot();
    expect(s.hits?.cards.map((c) => c.rel)).toEqual(['架构备忘.md']);
    // 清空恢复
    knowledgeStore.setQuery('');
    await sleep(320);
    expect(knowledgeStore.getSnapshot().hits).toBeNull();
  });

  it('挂资料 → 生成 → 卡片入墙（未评审）_notes 有现场', async () => {
    await readyOnSeed();
    const added = await knowledgeStore.addSource();
    expect(added).not.toBeNull();
    const rel = added!.added[0]!.rel;

    await knowledgeStore.generate([rel], 'claude', '');
    const s = knowledgeStore.getSnapshot();
    expect(s.gen?.done).toBe(2);
    expect(s.gen?.runId).toBe('run_fake_1');
    expect(s.gen?.notes.length).toBeGreaterThan(2);
    // 两张新卡进墙、都是未评审
    expect(s.cards.some((c) => c.rel === '整理：示例资料1.md')).toBe(true);
    expect(knowledgeStore.counts().unreviewed).toBe(3); // 种子 1 + 新 2
  });

  it('取消生成：runId 从第一条事件来_错误留在面板（不进外壳错误条）', async () => {
    await readyOnSeed();
    const added = await knowledgeStore.addSource();
    const rel = added!.added[0]!.rel;
    const p = knowledgeStore.generate([rel], 'claude', '');
    await sleep(5); // 第一条事件（带 runId）已经到了
    expect(knowledgeStore.getSnapshot().gen?.runId).not.toBeNull();
    await knowledgeStore.cancelGenerate();
    await p;
    const gen = knowledgeStore.getSnapshot().gen;
    // 具体文案由底层给（假实现说「被取消了」；真 Rust 说「被取消了」同款），
    // 这里钉的是「面板上有一句取消的交代」
    expect(gen?.error).toMatch(/取消/);
    expect(gen?.done).toBeNull();
  });

  it('删来源的两种语义：保留卡片=断链_连带=卡片一起走', async () => {
    await readyOnSeed();
    const added = await knowledgeStore.addSource();
    const rel = added!.added[0]!.rel;
    await knowledgeStore.generate([rel], 'claude', '');
    expect(knowledgeStore.getSnapshot().cards.some((c) => c.rel === '整理：示例资料1.md')).toBe(true);

    // ① 保留卡片：卡片还在，来源引用断了
    await knowledgeStore.deleteSource(rel, false);
    let cards = knowledgeStore.getSnapshot().cards;
    const kept = cards.find((c) => c.rel === '整理：示例资料1.md');
    expect(kept).toBeDefined();
    expect(kept?.sources).toEqual([]);

    // ② 再来一轮，这次连带删
    const again = await knowledgeStore.addSource();
    const rel2 = again!.added[0]!.rel;
    await knowledgeStore.generate([rel2], 'claude', '');
    const removed = await knowledgeStore.deleteSource(rel2, true);
    expect(removed).toBe(2);
    cards = knowledgeStore.getSnapshot().cards;
    expect(cards.some((c) => c.rel.includes('示例资料2'))).toBe(false);
  });

  it('多份资料生成：卡片的 sources 包含全部所选、run 记 sourceRels', async () => {
    await readyOnSeed();
    const a = await knowledgeStore.addSource();
    const b = await knowledgeStore.addSource();
    const rels = [a!.added[0]!.rel, b!.added[0]!.rel];

    await knowledgeStore.generate(rels, 'claude', '');
    const s = knowledgeStore.getSnapshot();
    expect(s.gen?.sourceRels).toEqual(rels);
    const card = s.cards.find((c) => c.title === '整理：综合 2 份资料');
    expect(card?.sources).toEqual(rels);
  });

  it('wikilink 按标题找卡_找不到给 null（断链）', async () => {
    await readyOnSeed();
    expect(knowledgeStore.cardByTitle('登录流程')?.rel).toBe('登录流程.md');
    expect(knowledgeStore.cardByTitle('不存在的卡')).toBeNull();
  });
});
