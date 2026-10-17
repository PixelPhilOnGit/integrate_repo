/**
 * 「群组事件 → 聊天时间线」的纯函数 reducer。
 *
 * 这一组盯的是**并行/多流**特有的错法：事件配错成员、迟到的旧事件、
 * 第二轮 seq 从 1 重来、终态之后还有事件。这些在界面上往往表现为
 * 「某一格永远转圈」或者「回答串到别人身上」，跑界面很难看出来。
 */

import { describe, expect, it } from 'vitest';
import type { GroupEvent } from '../../src/modules/group/services/types';
import {
  emptyChat,
  messagesFromDb,
  reduceEvent,
  type ChatSlice,
} from '../../src/modules/group/core/chat';

/** Omit 作用在联合上会塌成公共字段；要分发。 */
type Payload = GroupEvent extends infer T
  ? T extends GroupEvent
    ? Omit<T, 'seq'>
    : never
  : never;

const NAMES: Record<string, string> = { m1: '甲', m2: '乙' };
const nameOf = (id: string): string => NAMES[id] ?? id;

/** 喂一串事件（seq 自动递增，除非事件自己带了 seq）。 */
function feed(events: ReadonlyArray<Payload & { seq?: number }>): ChatSlice {
  let seq = 0;
  let slice = emptyChat();
  for (const event of events) {
    seq += 1;
    slice = reduceEvent(slice, { ...event, seq: event.seq ?? seq } as GroupEvent, nameOf);
  }
  return slice;
}

function started(memberIds: string[] = ['m1', 'm2']): Payload {
  return {
    kind: 'turnStarted',
    turnId: 't1',
    groupId: 'g1',
    userMessageId: 1,
    userText: '说说看',
    memberIds,
    mode: 'sequential',
    startedAt: 0,
  };
}

describe('turnStarted', () => {
  it('用户消息 + 所有成员的占位气泡按配置顺序插入', () => {
    const s = feed([started()]);
    expect(s.messages.map((m) => m.speakerName)).toEqual(['你', '甲', '乙']);
    expect(s.messages[1]?.status).toBe('queued');
    expect(s.activeTurnId).toBe('t1');
  });

  it('并行模式下气泡位置仍然按成员顺序（不按完成先后）', () => {
    const s = feed([
      started(['m2', 'm1']),
      { kind: 'memberStarted', memberId: 'm1', startedAt: 1 },
      { kind: 'memberFinished', memberId: 'm1', messageId: 5, status: 'done', text: '甲先说', error: null, usage: null, elapsedMs: 10 },
      { kind: 'memberFinished', memberId: 'm2', messageId: 6, status: 'done', text: '乙后完成', error: null, usage: null, elapsedMs: 20 },
    ]);
    expect(s.messages.slice(1).map((m) => m.speakerName)).toEqual(['乙', '甲']);
    // 但内容各自归位
    expect(s.messages[1]?.text).toBe('乙后完成');
    expect(s.messages[2]?.text).toBe('甲先说');
  });
});

describe('正文与工具行', () => {
  it('增量只追加到对应成员', () => {
    const s = feed([
      started(),
      { kind: 'memberText', memberId: 'm1', text: '甲在' },
      { kind: 'memberText', memberId: 'm2', text: '乙在' },
      { kind: 'memberText', memberId: 'm1', text: '说话' },
    ]);
    const byName = Object.fromEntries(s.messages.map((m) => [m.speakerName, m.text]));
    expect(byName['甲']).toBe('甲在说话');
    expect(byName['乙']).toBe('乙在');
  });

  it('工具行按 toolId 配对；没有 id 时配最后一条没结果的', () => {
    const s = feed([
      started(['m1']),
      { kind: 'memberTool', memberId: 'm1', toolId: 'a', name: 'Read', display: '读 a', state: 'started' },
      { kind: 'memberTool', memberId: 'm1', toolId: 'b', name: 'Read', display: '读 b', state: 'started' },
      { kind: 'memberTool', memberId: 'm1', toolId: 'a', name: 'Read', display: '读 a', state: 'finished' },
      { kind: 'memberTool', memberId: 'm1', toolId: null, name: 'Read', display: '读 b', state: 'failed' },
    ]);
    const tools = s.messages[1]?.tools ?? [];
    expect(tools.find((t) => t.toolId === 'a')?.isError).toBe(false);
    expect(tools.find((t) => t.toolId === 'b')?.isError).toBe(true);
  });

  it('memberFinished 的 text 是权威终稿（覆盖流式拼接，不重复）', () => {
    const s = feed([
      started(['m1']),
      { kind: 'memberText', memberId: 'm1', text: '半截' },
      {
        kind: 'memberFinished',
        memberId: 'm1',
        messageId: 9,
        status: 'done',
        text: '完整回答',
        error: null,
        usage: null,
        elapsedMs: 12,
      },
    ]);
    expect(s.messages[1]?.text).toBe('完整回答');
    expect(s.messages[1]?.id).toBe(9);
    expect(s.runs['m1']?.phase).toBe('done');
  });
});

describe('边界', () => {
  it('turnFinished 之后：占位收成「已停止」、activeTurnId 清空', () => {
    const s = feed([
      started(),
      { kind: 'memberStarted', memberId: 'm1', startedAt: 1 },
      { kind: 'turnFinished', turnId: 't1', status: 'cancelled', error: null, elapsedMs: 30 },
    ]);
    expect(s.activeTurnId).toBeNull();
    expect(s.messages[1]?.status).toBe('cancelled');
    expect(s.messages[2]?.status).toBe('cancelled');
  });

  it('turnFinished 之后迟到的事件一律忽略', () => {
    const s = feed([
      started(),
      { kind: 'turnFinished', turnId: 't1', status: 'done', error: null, elapsedMs: 1 },
      { kind: 'memberText', memberId: 'm1', text: '迟到的正文' },
    ]);
    expect(s.messages[1]?.text).toBe('');
  });

  it('重复/倒序的旧事件被丢弃', () => {
    const s = feed([
      started(['m1']),
      { kind: 'memberText', memberId: 'm1', text: '一', seq: 2 },
      { kind: 'memberText', memberId: 'm1', text: '二', seq: 2 },
      { kind: 'memberText', memberId: 'm1', text: '旧的', seq: 1 },
    ]);
    expect(s.messages[1]?.text).toBe('一');
  });

  it('回归：第二轮 seq 从 1 重新开始也要能接上', () => {
    // Rust 的 EventSink 是**每轮一个**，seq 每轮从 1 起。曾经拿上一轮的
    // lastSeq 去挡 turnStarted，结果第二轮彻底收不到事件（界面像卡住）。
    let s = feed([
      started(['m1']),
      { kind: 'memberFinished', memberId: 'm1', messageId: 3, status: 'done', text: '第一轮', error: null, usage: null, elapsedMs: 1 },
      { kind: 'turnFinished', turnId: 't1', status: 'done', error: null, elapsedMs: 2 },
    ]);
    // 第二轮：事件 seq 从 1 重新开始
    const second = [
      { ...started(['m1']), turnId: 't2', userMessageId: 2, userText: '第二轮' },
      { kind: 'memberText' as const, memberId: 'm1', text: '收到' },
      { kind: 'memberFinished' as const, memberId: 'm1', messageId: 4, status: 'done' as const, text: '第二轮回答', error: null, usage: null, elapsedMs: 3 },
      { kind: 'turnFinished' as const, turnId: 't2', status: 'done' as const, error: null, elapsedMs: 4 },
    ];
    let seq = 0;
    for (const e of second) {
      seq += 1;
      s = reduceEvent(s, { ...e, seq } as GroupEvent, nameOf);
    }
    expect(s.messages.at(-1)?.text).toBe('第二轮回答');
    expect(s.activeTurnId).toBeNull();
  });
});

describe('messagesFromDb（重开模块时）', () => {
  it('状态/错误/工具都还原；空错误变 null', () => {
    const rows = messagesFromDb([
      {
        id: 7,
        turnId: 't1',
        speakerKind: 'member',
        memberId: 'm1',
        speakerName: '甲',
        memberPosition: 0,
        text: '回答',
        tools: [{ toolId: 'x', name: 'Read', display: '读 a', isError: false }],
        status: 'done',
        error: '',
        usage: null,
      },
    ]);
    expect(rows[0]?.key).toBe('db:7');
    expect(rows[0]?.status).toBe('done');
    expect(rows[0]?.error).toBeNull();
    expect(rows[0]?.tools[0]?.display).toBe('读 a');
  });
});
