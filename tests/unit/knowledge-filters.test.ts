/**
 * 卡片筛选/计数/「下一张未评审」。
 *
 * 计数口径和任务模块同一条：**不含归档**（否则角标会挂着一个数被无视）。
 */

import { describe, expect, it } from 'vitest';
import {
  cardsUnder,
  childDirs,
  counts,
  nextUnreviewed,
  visibleCards,
} from '../../src/modules/knowledge/core/filters';
import type { CardRow } from '../../src/modules/knowledge/services/types';

const card = (rel: string, status: 'unreviewed' | 'reviewed', archived = false, created = '2026-01-01'): CardRow => ({
  rel,
  title: rel,
  status,
  archived,
  created,
  tags: [],
  sources: [],
  attachments: [],
  excerpt: '',
  mtime: 0,
  size: 0,
});

const cards: CardRow[] = [
  card('a.md', 'unreviewed', false, '2026-01-03'),
  card('b.md', 'reviewed', false, '2026-01-02'),
  card('c.md', 'unreviewed', false, '2026-01-01'),
  card('d.md', 'reviewed', true, '2026-01-04'),
];

describe('counts', () => {
  it('归档单独一档_不计入全部', () => {
    expect(counts(cards)).toEqual({ all: 3, unreviewed: 2, reviewed: 1, archived: 1 });
  });
});

describe('visibleCards', () => {
  it('未评审排前面_再按创建时间新的在前', () => {
    const v = visibleCards(cards, 'all', null);
    expect(v.map((c) => c.rel)).toEqual(['a.md', 'c.md', 'b.md']);
  });

  it('各档筛得对_归档只在归档档里', () => {
    expect(visibleCards(cards, 'unreviewed', null).map((c) => c.rel)).toEqual(['a.md', 'c.md']);
    expect(visibleCards(cards, 'reviewed', null).map((c) => c.rel)).toEqual(['b.md']);
    expect(visibleCards(cards, 'archived', null).map((c) => c.rel)).toEqual(['d.md']);
  });

  it('搜索命中集在时以它为底_筛选照旧叠加', () => {
    const hits = [card('b.md', 'reviewed')];
    expect(visibleCards(cards, 'all', hits).map((c) => c.rel)).toEqual(['b.md']);
    expect(visibleCards(cards, 'unreviewed', hits)).toHaveLength(0);
  });
});

describe('目录作用域', () => {
  const nested = [
    card('根.md', 'reviewed'),
    card('项目/甲.md', 'unreviewed'),
    card('项目/子/乙.md', 'reviewed'),
    card('项目二/丙.md', 'reviewed'),
  ];

  it('根目录 = 全部（老库里散在子目录的卡不消失）', () => {
    expect(cardsUnder(nested, '').map((c) => c.rel)).toEqual([
      '根.md',
      '项目/甲.md',
      '项目/子/乙.md',
      '项目二/丙.md',
    ]);
  });

  it('目录 = 整棵子树_不误伤同前缀的兄弟目录', () => {
    expect(cardsUnder(nested, '项目').map((c) => c.rel)).toEqual([
      '项目/甲.md',
      '项目/子/乙.md',
    ]);
    expect(cardsUnder(nested, '项目/子').map((c) => c.rel)).toEqual(['项目/子/乙.md']);
    expect(cardsUnder(nested, '项目二').map((c) => c.rel)).toEqual(['项目二/丙.md']);
  });

  it('子目录只取直接一层', () => {
    const dirs = ['项目', '项目/子', '项目/子/深', '项目二'];
    expect(childDirs(dirs, '')).toEqual(['项目', '项目二']);
    expect(childDirs(dirs, '项目')).toEqual(['项目/子']);
    expect(childDirs(dirs, '项目/子')).toEqual(['项目/子/深']);
    expect(childDirs(dirs, '不存在')).toEqual([]);
  });
});

describe('nextUnreviewed', () => {
  it('取可见序里之后的第一个未评审', () => {
    const v = visibleCards(cards, 'all', null); // a, c, b
    expect(nextUnreviewed(v, 'a.md')).toBe('c.md');
    expect(nextUnreviewed(v, 'c.md')).toBeNull(); // 后面没有未评审了
  });

  it('到头不回头_null', () => {
    const v = visibleCards(cards, 'all', null);
    expect(nextUnreviewed(v, 'b.md')).toBeNull();
  });

  it('fromRel 不在列表里（搜索命中集点开）→ 取第一张未评审', () => {
    const v = visibleCards(cards, 'all', null);
    expect(nextUnreviewed(v, '不在.md')).toBe('a.md');
  });
});
