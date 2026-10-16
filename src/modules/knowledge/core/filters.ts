/**
 * 卡片列表的筛选/计数/「下一张未评审」—— 纯函数。
 *
 * 计数口径和任务模块一个规则：**不含归档**（见 HANDOFF「计数不含归档的」——
 * 否则角标会一直挂着一个数，久了就被无视）。
 */

import type { CardRow } from '../services/types';

/** 侧栏筛选用的一档。`all` = 全部**未归档** */
export type KbFilter = 'all' | 'unreviewed' | 'reviewed' | 'archived';

export interface KbCounts {
  all: number;
  unreviewed: number;
  reviewed: number;
  archived: number;
}

export function counts(cards: readonly CardRow[]): KbCounts {
  let all = 0;
  let unreviewed = 0;
  let reviewed = 0;
  let archived = 0;
  for (const c of cards) {
    if (c.archived) {
      archived += 1;
      continue;
    }
    all += 1;
    if (c.status === 'reviewed') reviewed += 1;
    else unreviewed += 1;
  }
  return { all, unreviewed, reviewed, archived };
}

/**
 * 当前筛选下的可见卡片。`hits` 非 null（搜索生效）时以命中集为底。
 * 排序：未评审的排前面（评审工作流：要处理的先看到），再按创建时间新的在前。
 */
export function visibleCards(
  cards: readonly CardRow[],
  filter: KbFilter,
  hits: readonly CardRow[] | null
): CardRow[] {
  const base = hits ?? cards;
  const kept = base.filter((c) => {
    if (filter === 'archived') return c.archived;
    if (c.archived) return false;
    if (filter === 'unreviewed') return c.status === 'unreviewed';
    if (filter === 'reviewed') return c.status === 'reviewed';
    return true;
  });
  return [...kept].sort((a, b) => {
    if (a.status !== b.status) return a.status === 'unreviewed' ? -1 : 1;
    if (a.created !== b.created) return a.created < b.created ? 1 : -1; // 新的在前
    // ⚠️ 决胜键用**码点比较**，不是 localeCompare —— Rust 侧（`ORDER BY rel`，
    // SQLite BINARY）就是码点序，两边口径必须一致（e2e 抓过一次：
    // locale 把全角「（续）」排到了小数点前面，两端的「下一张」就错位了）
    return a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0;
  });
}

/**
 * 「标为已评审 → 自动跳下一张未评审」：在 `cards`（**可见序**）里找
 * `fromRel` 之后的第一个未评审。到头就给 null（不回头 —— 回头会让人以为
 * 没保存成功）。找不到 fromRel（搜索命中集里点开的）就取第一张未评审。
 */
export function nextUnreviewed(cards: readonly CardRow[], fromRel: string | null): string | null {
  const idx = fromRel === null ? -1 : cards.findIndex((c) => c.rel === fromRel);
  for (let i = idx + 1; i < cards.length; i += 1) {
    const c = cards[i];
    if (c !== undefined && !c.archived && c.status === 'unreviewed') return c.rel;
  }
  return null;
}
