/**
 * 「事件 → 消息列表」那段逻辑。
 *
 * 它是纯函数（`core/chat.ts`），所以这里能穷举那些**跑界面看不出来**的错 ——
 * 尤其是「并行工具调用的结果该配到哪一条上」：配错了界面上一切正常，
 * 只是两个工具的成败对调了。
 *
 * ⚠️ 这里的 `AssistantEvent` 形状是照着 **Rust 那边会发出来的 JSON** 写的。
 * 那条缝两端各自的测试都盖不到（前端跑假实现、Rust 直接构造值），
 * 所以 Rust 侧另有一组 `contract_*` 测试钉字段名。
 */

import { describe, expect, it } from 'vitest';
import { emptyChat, reduceChat } from '../../src/modules/assistant/core/chat';
import type { ChatSlice } from '../../src/modules/assistant/core/chat';
import type { AssistantEvent } from '../../src/modules/assistant/services/types';

const ZERO = {
  uncachedInput: 0,
  cacheRead: 0,
  cacheCreation5m: 0,
  cacheCreation1h: 0,
  output: 0,
};

/** 喂一串事件进去，id 是确定的一串（断言里能直接写 `m1`）。 */
function feed(events: readonly AssistantEvent[]): ChatSlice {
  let seq = 0;
  const nextId = (): string => `m${++seq}`;
  return events.reduce((s, e) => reduceChat(s, e, nextId), emptyChat());
}

describe('消息流', () => {
  it('连着几段文字累积在同一条消息上', () => {
    // 流式响应是一片一片来的，每次新起一条的话界面上会变成一堆碎片。
    const s = feed([
      { kind: 'iteration', n: 1 },
      { kind: 'textDelta', text: '我看' },
      { kind: 'textDelta', text: '一下' },
    ]);
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]?.text).toBe('我看一下');
  });

  it('下一轮另起一条 —— 不同轮次糊在一起就读不出哪句是哪轮的', () => {
    const s = feed([
      { kind: 'iteration', n: 1 },
      { kind: 'textDelta', text: '先看看' },
      { kind: 'iteration', n: 2 },
      { kind: 'textDelta', text: '看完了' },
    ]);
    expect(s.messages).toHaveLength(2);
    expect(s.messages.map((m) => m.text)).toEqual(['先看看', '看完了']);
  });

  it('思考不显示', () => {
    const s = feed([
      { kind: 'iteration', n: 1 },
      { kind: 'thinkingDelta', text: '嗯……' },
    ]);
    expect(s.messages).toHaveLength(0);
  });
});

describe('工具痕迹', () => {
  it('先出一行「在跑」，结果回来之后标上成败', () => {
    const s = feed([
      { kind: 'iteration', n: 1 },
      { kind: 'toolRequested', name: 'read_file', display: '读 a.txt' },
    ]);
    expect(s.messages[0]?.tools[0]).toMatchObject({
      display: '读 a.txt',
      isError: null,
    });

    const done = reduceChat(
      s,
      { kind: 'toolFinished', name: 'read_file', isError: false, content: '' },
      () => 'x',
    );
    expect(done.messages[0]?.tools[0]?.isError).toBe(false);
  });

  it('⚠️ 并行调用的结果要一条一条对上去（回归）', () => {
    // 一轮里调了两个工具，结果是**按请求顺序**回来的。
    // 从前往后找第一条「还没结果」的话，第二条的结果会写到第一条头上 ——
    // 界面上看起来完全正常，只是两个工具的成败对调了。
    const s = feed([
      { kind: 'iteration', n: 1 },
      { kind: 'toolRequested', name: 'read_file', display: '读 a.txt' },
      { kind: 'toolRequested', name: 'read_file', display: '读 b.txt' },
      { kind: 'toolFinished', name: 'read_file', isError: false, content: '' },
      { kind: 'toolFinished', name: 'read_file', isError: true, content: '' },
    ]);

    const tools = s.messages[0]?.tools ?? [];
    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({ display: '读 a.txt', isError: false });
    expect(tools[1]).toMatchObject({ display: '读 b.txt', isError: true });
  });

  it('重试会留一行痕迹 —— 用户要能看出「刚才卡了一下」', () => {
    const s = feed([
      { kind: 'iteration', n: 1 },
      { kind: 'retrying', attempt: 1, reason: '连接断了' },
    ]);
    expect(s.messages[0]?.tools[0]?.display).toContain('第 1 次');
  });
});

describe('审批', () => {
  it('弹层出现又收掉', () => {
    const asked = feed([
      { kind: 'iteration', n: 1 },
      {
        kind: 'approvalNeeded',
        key: { run: 3, call: 'c1' },
        tool: 'write_file',
        display: '写入 a.txt（10 B）',
        canRemember: true,
      },
    ]);
    expect(asked.pending?.display).toBe('写入 a.txt（10 B）');
    expect(asked.pending?.canRemember).toBe(true);

    const answered = reduceChat(
      asked,
      { kind: 'approvalDecided', key: { run: 3, call: 'c1' }, decision: 'allowed' },
      () => 'x',
    );
    expect(answered.pending).toBeNull();
  });

  it('⚠️ 不能记住的操作照样要弹 —— `canRemember` 是给界面看的，不是开关', () => {
    // 跑 shell 解释器的时候 Rust 那边给 false（记住 `bash` 等于免审一切）。
    // 它只是让「记住」那个按钮不出现，**该问还是要问**。
    const s = feed([
      { kind: 'iteration', n: 1 },
      {
        kind: 'approvalNeeded',
        key: { run: 1, call: 'c1' },
        tool: 'run_command',
        display: '运行 bash -c …',
        canRemember: false,
      },
    ]);
    expect(s.pending).not.toBeNull();
    expect(s.pending?.canRemember).toBe(false);
  });

  it('⚠️ 结束时挂着的审批要一起收掉（取消那条路）', () => {
    // 取消的时候那条审批正挂着。不收的话界面上会留一个弹层，
    // 而它对应的 run 已经死了 —— 用户点它什么也不会发生。
    const s = feed([
      { kind: 'iteration', n: 1 },
      {
        kind: 'approvalNeeded',
        key: { run: 1, call: 'c1' },
        tool: 'write_file',
        display: '写入 a.txt',
        canRemember: true,
      },
      { kind: 'finished', status: { kind: 'cancelled' }, usage: ZERO, iterations: 1 },
    ]);
    expect(s.pending).toBeNull();
    expect(s.running).toBe(false);
  });
});

describe('收尾', () => {
  it('finished 是最后一条，它把 running 收掉', () => {
    const s = feed([
      { kind: 'iteration', n: 1 },
      { kind: 'textDelta', text: '好了' },
      {
        kind: 'finished',
        status: { kind: 'completed', reason: 'endTurn' },
        usage: ZERO,
        iterations: 1,
      },
    ]);
    expect(s.running).toBe(false);
    expect(s.messages[0]?.text).toBe('好了');
  });

  it('中止也要带上结局（界面上要说清为什么停的）', () => {
    const s = feed([
      { kind: 'iteration', n: 1 },
      {
        kind: 'finished',
        status: {
          kind: 'aborted',
          reason: { kind: 'budgetExhausted', used: 120, budget: 100 },
        },
        usage: ZERO,
        iterations: 3,
      },
    ]);
    expect(s.running).toBe(false);
  });
});
