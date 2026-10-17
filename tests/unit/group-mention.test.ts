/**
 * `@成员` 的解析与补全（纯函数）。
 *
 * 这里守的是几条**用户一眼看不出错**的规则：邮箱里的 @ 不算提及、
 * 未知提及不能退化成「所有人」、名字前缀不能互相抢（`@甲虫` ≠ `@甲`）。
 */

import { describe, expect, it } from 'vitest';
import {
  applyMention,
  filterCandidates,
  mentionQuery,
  parseMentions,
} from '../../src/modules/group/core/mention';

const members = [
  { memberId: 'm1', name: '甲' },
  { memberId: 'm2', name: '乙' },
  { memberId: 'm3', name: '前端 小王' },
];

describe('parseMentions', () => {
  it('没有 @ 就是广播（mentions 为空、unknown 为空）', () => {
    const parsed = parseMentions('大家一起看看这个仓库', members);
    expect(parsed.mentions).toEqual([]);
    expect(parsed.unknown).toEqual([]);
  });

  it('单个 @ 点名', () => {
    const parsed = parseMentions('@甲 你先说', members);
    expect(parsed.mentions.map((m) => m.memberId)).toEqual(['m1']);
  });

  it('多个 @ 按出现顺序、去重', () => {
    const parsed = parseMentions('@乙 @甲 @乙 你们俩', members);
    expect(parsed.mentions.map((m) => m.name)).toEqual(['乙', '甲']);
  });

  it('未知提及要报出来（不能静默当成广播）', () => {
    const parsed = parseMentions('@张三 你说呢', members);
    expect(parsed.mentions).toEqual([]);
    expect(parsed.unknown).toEqual(['张三']);
  });

  it('邮箱里的 @ 不算提及', () => {
    const parsed = parseMentions('发到 foo@bar.com 就行', members);
    expect(parsed.mentions).toEqual([]);
    expect(parsed.unknown).toEqual([]);
  });

  it('名字前缀不能互相抢：@甲虫 是未知，不是 @甲', () => {
    const parsed = parseMentions('@甲虫 你好', members);
    expect(parsed.mentions).toEqual([]);
    expect(parsed.unknown).toEqual(['甲虫']);
  });

  it('带空格的中文名也能匹配', () => {
    const parsed = parseMentions('@前端 小王 看一下样式', members);
    expect(parsed.mentions.map((m) => m.memberId)).toEqual(['m3']);
  });

  it('标点/换行后面的 @ 也算边界', () => {
    const parsed = parseMentions('先这样。@甲 接着来', members);
    expect(parsed.mentions.map((m) => m.memberId)).toEqual(['m1']);
  });
});

describe('mentionQuery / filterCandidates / applyMention', () => {
  it('光标在 @ 后面时给候选', () => {
    const text = '请 @前';
    expect(mentionQuery(text, text.length)).toEqual({ start: 2, query: '前' });
    expect(filterCandidates(members, '前').map((m) => m.name)).toEqual(['前端 小王']);
  });

  it('@ 前面是字母时不触发（邮箱）', () => {
    const text = 'foo@bar';
    expect(mentionQuery(text, text.length)).toBeNull();
  });

  it('光标后面还有标点就认为片段结束了', () => {
    const text = '@甲，你好';
    expect(mentionQuery(text, text.length)).toBeNull();
  });

  it('空 query 给全部候选', () => {
    expect(filterCandidates(members, '').length).toBe(3);
  });

  it('选中候选后把 @query 换成 @名字 并移动光标', () => {
    const text = '请 @前 看看';
    const caret = 4; // 光标在「前」后面
    const next = applyMention(text, caret, '前端 小王');
    // 后面已经有一个空格了，不再补第二个
    expect(next.text).toBe('请 @前端 小王 看看');
    expect(next.caret).toBe('请 @前端 小王 '.length);
  });

  it('光标在结尾时补一个空格，方便接着打字', () => {
    const next = applyMention('@甲', 2, '乙');
    expect(next.text).toBe('@乙 ');
    expect(next.caret).toBe(3);
  });

  it('大小写不敏感', () => {
    const mixed = [{ memberId: 'x', name: 'Alice' }];
    expect(filterCandidates(mixed, 'ali').length).toBe(1);
  });
});
