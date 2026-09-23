/**
 * 历史去重 / 裁剪 / 读回来（`core/history.ts` + `core/saved.ts`）。
 *
 * 去重那条的取舍值得盯住：**只和最新那条比**。全局去重的话，「上周它还是 200、
 * 今天 500 了」这种最值钱的对比就没了。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { __resetIdsForTest } from '../../src/shared/ids';
import { newDraft } from '../../src/modules/request/core/draft';
import { HISTORY_LIMIT, parseHistory, pushHistory, removeHistory } from '../../src/modules/request/core/history';
import { parseSaved, removeSaved, upsertSaved } from '../../src/modules/request/core/saved';
import type { HistoryEntry, RequestOutcome } from '../../src/modules/request/core/types';

beforeEach(() => __resetIdsForTest());

const ok: RequestOutcome = { kind: 'ok', status: 200, totalMillis: 12, bytes: 34, truncated: false };

function entry(url: string, outcome: RequestOutcome = ok): HistoryEntry {
  const draft = { ...newDraft(), url };
  return { id: `e_${url}`, at: 1, method: draft.method, url, outcome, draft };
}

describe('记历史', () => {
  it('最新的在最前面', () => {
    const list = pushHistory(pushHistory([], entry('https://a')), entry('https://b'));
    expect(list.map((e) => e.url)).toEqual(['https://b', 'https://a']);
  });

  it('⚠️ 紧邻的同一条请求是**覆盖**，不再长一条（改一个头连发五次只留一条）', () => {
    let list: HistoryEntry[] = [];
    for (let i = 0; i < 5; i += 1) {
      list = pushHistory(list, { ...entry('https://a'), id: `e${i}`, at: i });
    }
    expect(list).toHaveLength(1);
    // 覆盖的是**新的那条**：时间戳和结果都跟着更新
    expect(list[0]!.id).toBe('e4');
    expect(list[0]!.at).toBe(4);
  });

  it('隔开的同一条请求留着（这才有「上周 200、今天 500」可比）', () => {
    let list: HistoryEntry[] = [];
    list = pushHistory(list, entry('https://a'));
    list = pushHistory(list, entry('https://b'));
    list = pushHistory(list, entry('https://a'));
    expect(list.map((e) => e.url)).toEqual(['https://a', 'https://b', 'https://a']);
  });

  it(`最多留 ${HISTORY_LIMIT} 条，从最旧的那头砍`, () => {
    let list: HistoryEntry[] = [];
    for (let i = 0; i < HISTORY_LIMIT + 10; i += 1) {
      list = pushHistory(list, entry(`https://x/${i}`));
    }
    expect(list).toHaveLength(HISTORY_LIMIT);
    expect(list[0]!.url).toBe(`https://x/${HISTORY_LIMIT + 9}`);
    expect(list[list.length - 1]!.url).toBe('https://x/10');
  });

  it('删一条', () => {
    const list = pushHistory(pushHistory([], entry('https://a')), entry('https://b'));
    expect(removeHistory(list, list[0]!.id).map((e) => e.url)).toEqual(['https://a']);
  });
});

describe('读回来', () => {
  it('正常的一条读得回来', () => {
    const list = parseHistory([entry('https://a')]);
    expect(list).toHaveLength(1);
    expect(list[0]!.url).toBe('https://a');
    expect(list[0]!.outcome).toEqual(ok);
  });

  it('⚠️ 坏数据静静丢掉，不白屏', () => {
    const list = parseHistory([
      null,
      '不是对象',
      { draft: 'x' }, // 草稿不是对象
      { draft: { url: 'https://ok' }, outcome: { kind: 'ok', status: 200 } }, // 这条能救
      { draft: { url: 'https://no-outcome' } }, // 没有结局 → 丢掉
    ]);
    expect(list).toHaveLength(1);
    expect(list[0]!.url).toBe('https://ok');
  });

  it('不是数组就当空的（第一次用这个模块就是这样）', () => {
    expect(parseHistory(null)).toEqual([]);
    expect(parseHistory({ 随便: '什么' })).toEqual([]);
  });

  it('失败的那条也读得回来（错误信息要留着）', () => {
    const failed: RequestOutcome = { kind: 'failed', errorKind: 'connect', message: '连不上', bytes: 0 };
    const list = parseHistory([entry('https://a', failed)]);
    expect(list[0]!.outcome).toEqual(failed);
  });
});

describe('保存的请求', () => {
  it('新的一条排在最前面', () => {
    const list = upsertSaved(upsertSaved([], '查用户', newDraft(), 1), '查订单', newDraft(), 2);
    expect(list.map((s) => s.name)).toEqual(['查订单', '查用户']);
  });

  it('⚠️ 同名就是同一条：覆盖它，id 和时间跟着更新（不再长一条）', () => {
    const first = upsertSaved([], '查用户', { ...newDraft(), url: 'https://a' }, 1);
    const list = upsertSaved(first, '查用户', { ...newDraft(), url: 'https://b' }, 9);
    expect(list).toHaveLength(1);
    expect(list[0]!.draft.url).toBe('https://b');
    expect(list[0]!.savedAt).toBe(9);
    expect(list[0]!.id).toBe(first[0]!.id);
  });

  it('名字两边的空格不算数', () => {
    const list = upsertSaved(upsertSaved([], '查用户', newDraft(), 1), '  查用户 ', newDraft(), 2);
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe('查用户');
  });

  it('删一条', () => {
    const list = upsertSaved([], '查用户', newDraft(), 1);
    expect(removeSaved(list, list[0]!.id)).toEqual([]);
  });

  it('读回来：名字空的、草稿坏掉的都丢掉', () => {
    const list = parseSaved([
      { id: 'a', name: '好的', savedAt: 1, draft: { url: 'https://x' } },
      { id: 'b', name: '  ', savedAt: 1, draft: { url: 'https://x' } },
      { id: 'c', name: '没有草稿' },
      null,
    ]);
    expect(list.map((s) => s.name)).toEqual(['好的']);
  });
});
