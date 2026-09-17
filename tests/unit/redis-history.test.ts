import { describe, expect, it } from 'vitest';
import {
  MAX_HISTORY,
  moveHistory,
  pushHistory,
} from '../../src/modules/redis/core/history';

describe('命令历史', () => {
  it('依次追加', () => {
    let history: string[] = [];
    history = pushHistory(history, 'PING');
    history = pushHistory(history, 'GET a');
    expect(history).toEqual(['PING', 'GET a']);
  });

  it('连续重复的不重复记（连按两次回车很常见）', () => {
    let history: string[] = [];
    history = pushHistory(history, 'PING');
    history = pushHistory(history, 'PING');
    expect(history).toEqual(['PING']);

    // 但隔了一条之后再出现，还是要记
    history = pushHistory(history, 'GET a');
    history = pushHistory(history, 'PING');
    expect(history).toEqual(['PING', 'GET a', 'PING']);
  });

  it('空白命令不进历史', () => {
    let history: string[] = [];
    history = pushHistory(history, '   ');
    history = pushHistory(history, '');
    expect(history).toEqual([]);
  });

  it('记录时去掉首尾空白，比较也用去掉之后的', () => {
    let history: string[] = [];
    history = pushHistory(history, '  PING  ');
    expect(history).toEqual(['PING']);
    history = pushHistory(history, 'PING');
    expect(history).toEqual(['PING']);
  });

  it('超出上限时丢掉最老的', () => {
    let history: string[] = [];
    for (let i = 0; i < MAX_HISTORY + 10; i += 1) history = pushHistory(history, `CMD${i}`);

    expect(history).toHaveLength(MAX_HISTORY);
    expect(history[0]).toBe('CMD10');
    expect(history[MAX_HISTORY - 1]).toBe(`CMD${MAX_HISTORY + 9}`);
  });

  it('不修改传进来的数组（纯函数）', () => {
    const original = ['PING'];
    const next = pushHistory(original, 'GET a');
    expect(original).toEqual(['PING']);
    expect(next).not.toBe(original);
  });
});

describe('上下键导航', () => {
  const history = ['CMD1', 'CMD2', 'CMD3'];

  it('第一次按 ↑ 从最新一条开始', () => {
    expect(moveHistory(history, null, 'prev', '')).toEqual({ index: 2, value: 'CMD3' });
  });

  it('继续按 ↑ 往前翻', () => {
    expect(moveHistory(history, 2, 'prev', '')).toEqual({ index: 1, value: 'CMD2' });
    expect(moveHistory(history, 1, 'prev', '')).toEqual({ index: 0, value: 'CMD1' });
  });

  it('翻到最老一条之后再按 ↑ 停在那里，不越界', () => {
    expect(moveHistory(history, 0, 'prev', '')).toEqual({ index: 0, value: 'CMD1' });
  });

  it('↓ 往新翻', () => {
    expect(moveHistory(history, 0, 'next', '')).toEqual({ index: 1, value: 'CMD2' });
    expect(moveHistory(history, 1, 'next', '')).toEqual({ index: 2, value: 'CMD3' });
  });

  it('↓ 翻过最新一条之后回到草稿，并把没敲完的内容还回来', () => {
    const result = moveHistory(history, 2, 'next', 'GET incomp');
    expect(result).toEqual({ index: null, value: 'GET incomp' });
  });

  it('没在翻历史时按 ↓ 什么也不做，别把草稿吃掉', () => {
    expect(moveHistory(history, null, 'next', 'GET incomp')).toBeNull();
  });

  it('历史为空时两个方向都无事可做', () => {
    expect(moveHistory([], null, 'prev', 'draft')).toBeNull();
    expect(moveHistory([], null, 'next', 'draft')).toBeNull();
  });
});
