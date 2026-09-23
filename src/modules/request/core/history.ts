/**
 * 历史列表的纯逻辑：**去重**和**裁剪**。
 *
 * # 为什么去重
 *
 * 调一个接口的真实过程是这样的：敲地址 → 发送 → 改一个头 → 再发 →
 * 改回来 → 再发…… 每点一次都进一条的话，十条历史里九条是同一个请求，
 * 而历史这块地方总共就这么大。所以**紧邻的两条如果是同一个请求，
 * 就覆盖它**（时间戳和结果更新成新的，不新增一条）。
 *
 * ⚠️ 只和**最新那一条**比，不做全局去重：隔了三天重新发一次同一个请求，
 * 那是两个时间点上的两件事，都值得留着（「上周它还是 200，今天 500 了」
 * 正是历史的价值）。
 *
 * # 为什么有上限
 *
 * 每条历史里存着**整份草稿**（点一下就能回到当时那个请求 —— 那正是历史
 * 的用处）。不限量的话，一个用了一年的模块会在键值库里躺着几千条完整的
 * 请求。50 条够覆盖「今天调过哪些」。
 */

import type { HistoryEntry } from './types';
import { readDraft, sameRequest } from './draft';

/** 最多留多少条。 */
export const HISTORY_LIMIT = 50;

/**
 * 记一条历史，最新的在最前面。
 *
 * 去重见文件头部；裁剪总是从**最旧**的那头砍（`slice(0, LIMIT)`）。
 */
export function pushHistory(list: HistoryEntry[], entry: HistoryEntry): HistoryEntry[] {
  const newest = list[0];
  if (newest !== undefined && sameRequest(newest.draft, entry.draft)) {
    return [entry, ...list.slice(1)];
  }
  return [entry, ...list].slice(0, HISTORY_LIMIT);
}

/** 清掉一条（侧栏行上那个 ×）。 */
export function removeHistory(list: HistoryEntry[], id: string): HistoryEntry[] {
  return list.filter((e) => e.id !== id);
}

/**
 * 从键值库里读回来。
 *
 * ⚠️ 逐条校验（见 `draft.ts` 的 `readDraft`）：一条坏数据不该让整个侧栏白屏。
 * 读不成的那条**静静丢掉**——历史是自动记的，少一条没有任何代价。
 */
export function parseHistory(raw: unknown): HistoryEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: HistoryEntry[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const o = item as Record<string, unknown>;
    const draft = readDraft(o['draft']);
    if (draft === null) continue;
    const outcome = readOutcome(o['outcome']);
    if (outcome === null) continue;
    out.push({
      id: typeof o['id'] === 'string' && o['id'] !== '' ? o['id'] : `hist_${out.length}`,
      at: typeof o['at'] === 'number' ? o['at'] : 0,
      method: typeof o['method'] === 'string' ? o['method'] : draft.method,
      url: typeof o['url'] === 'string' ? o['url'] : draft.url,
      outcome,
      draft,
    });
  }
  return out.slice(0, HISTORY_LIMIT);
}

function readOutcome(raw: unknown): HistoryEntry['outcome'] | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (o['kind'] === 'ok') {
    return {
      kind: 'ok',
      status: typeof o['status'] === 'number' ? o['status'] : 0,
      totalMillis: typeof o['totalMillis'] === 'number' ? o['totalMillis'] : 0,
      bytes: typeof o['bytes'] === 'number' ? o['bytes'] : 0,
      truncated: o['truncated'] === true,
    };
  }
  if (o['kind'] === 'failed') {
    return {
      kind: 'failed',
      errorKind: typeof o['errorKind'] === 'string' ? o['errorKind'] : 'connect',
      message: typeof o['message'] === 'string' ? o['message'] : '',
      bytes: typeof o['bytes'] === 'number' ? o['bytes'] : 0,
    };
  }
  return null;
}
