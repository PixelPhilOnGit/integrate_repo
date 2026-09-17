/**
 * 激活条的手动操作与生命周期。
 *
 * 自动维护（同步消息自动开、返回消息自动关）已经在 commands.test.ts 里覆盖了。
 * 这里测的是**用户手动介入**的那一半：属性面板上的开关、指定终点、删除，
 * 以及"消息变了激活条会怎样"的各种联动。这块之前完全没有单元测试。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  addMessage,
  createDoc,
  removeActivation,
  removeMessage,
  removeParticipant,
  setActivationEnd,
  toggleActivation,
  updateMessage,
} from '../../src/core/commands';
import { computeLayout, L } from '../../src/core/layout';
import { createApproxMeasurer } from '../../src/core/text';
import { __resetIdsForTest } from '../../src/core/ids';
import { defaultTheme } from '../../src/core/theme';
import type { Doc } from '../../src/core/model';

beforeEach(() => __resetIdsForTest());

const measurer = createApproxMeasurer();
const layout = (doc: Doc) => computeLayout(doc, measurer);

/** 两参与者 + 一条同步消息（会自动在接收方开一条激活条） */
function scenario(): { doc: Doc; a: string; b: string; msgId: string; actId: string } {
  let doc = createDoc('t', defaultTheme());
  doc = {
    ...doc,
    participants: [
      { id: 'a', kind: 'object' as const, name: '甲', x: 120 },
      { id: 'b', kind: 'object' as const, name: '乙', x: 420 },
    ],
  };
  const m = addMessage(doc, { kind: 'sync', from: 'a', to: 'b', label: '请求', y: 200 });
  doc = m.doc;
  return { doc, a: 'a', b: 'b', msgId: m.id, actId: doc.activations[0]!.id };
}

describe('手动开关', () => {
  it('同步消息会自动在接收方开一条（先确认前提）', () => {
    const { doc, b } = scenario();
    expect(doc.activations).toHaveLength(1);
    expect(doc.activations[0]!.participant).toBe(b);
  });

  it('再 toggle 一次会关掉它', () => {
    const { doc, msgId, actId, b } = scenario();
    const after = toggleActivation(doc, b, msgId);
    expect(after.activations.find((x) => x.id === actId)).toBeUndefined();
    expect(after.activations).toHaveLength(0);
  });

  it('在发送方手动开一条激活条（自动逻辑不会开，得手动加）', () => {
    const { doc, a, msgId } = scenario();
    expect(doc.activations.some((x) => x.participant === a)).toBe(false);

    const after = toggleActivation(doc, a, msgId);
    expect(after.activations.filter((x) => x.participant === a)).toHaveLength(1);
  });

  it('同一条消息上重复 toggle 不会产生重复激活条', () => {
    const { doc, a, msgId } = scenario();
    const on = toggleActivation(doc, a, msgId);
    const off = toggleActivation(on, a, msgId);
    const onAgain = toggleActivation(off, a, msgId);
    expect(onAgain.activations.filter((x) => x.participant === a)).toHaveLength(1);
  });

  it('手动开的激活条锚定在那条消息上', () => {
    const { doc, a, msgId } = scenario();
    const after = toggleActivation(doc, a, msgId);
    const manual = after.activations.find((x) => x.participant === a)!;
    expect(manual.startMessageId).toBe(msgId);
  });

  it('不修改传入的文档', () => {
    const { doc, b, msgId } = scenario();
    const snapshot = JSON.stringify(doc);
    toggleActivation(doc, b, msgId);
    expect(JSON.stringify(doc)).toBe(snapshot);
  });
});

describe('指定终点', () => {
  it('给激活条指定一条结束消息后，高度对应缩短', () => {
    let { doc } = scenario();
    const first = doc.activations[0]!;

    const ret = addMessage(doc, { kind: 'async', from: 'a', to: 'b', label: '二', y: 600 });
    doc = ret.doc;

    // 基线要在**同一个文档**上取：未指定终点时它会自动延伸到最后一条消息之下
    const openHeight = layout(doc).activations.find((x) => x.id === first.id)!.height;
    const closed = setActivationEnd(doc, first.id, ret.id);
    const closedHeight = layout(closed).activations.find((x) => x.id === first.id)!.height;

    expect(closedHeight).toBeLessThan(openHeight);
    // 起点 200、终点 600，高度正好是 400
    expect(closedHeight).toBe(400);
  });

  it('清除终点后恢复自动延伸', () => {
    let { doc } = scenario();
    const first = doc.activations[0]!;
    const ret = addMessage(doc, { kind: 'async', from: 'a', to: 'b', label: '二', y: 600 });
    doc = ret.doc;

    const closed = setActivationEnd(doc, first.id, ret.id);
    const reopened = setActivationEnd(closed, first.id, undefined);

    expect(reopened.activations.find((x) => x.id === first.id)!.endMessageId).toBeUndefined();
    const h = layout(reopened).activations.find((x) => x.id === first.id)!.height;
    expect(h).toBeGreaterThan(L.activationMinHeight);
  });

  it('指定不存在的激活条是安全的空操作', () => {
    const { doc } = scenario();
    expect(setActivationEnd(doc, '幽灵', 'x')).toEqual(doc);
  });
});

describe('删除', () => {
  it('按 id 删掉激活条', () => {
    const { doc, actId } = scenario();
    expect(removeActivation(doc, actId).activations).toHaveLength(0);
  });

  it('删不存在的激活条是安全的空操作', () => {
    const { doc } = scenario();
    expect(removeActivation(doc, '幽灵').activations).toHaveLength(1);
  });
});

describe('消息变化时的联动', () => {
  it('把同步消息改成异步时，自动生成的激活条被收回', () => {
    const { doc, msgId } = scenario();
    const after = updateMessage(doc, msgId, { kind: 'async', to: 'b' });
    expect(after.activations).toHaveLength(0);
  });

  it('但手动指定过终点的激活条不受类型切换影响（那是明确意图）', () => {
    let { doc, msgId } = scenario();
    const actId = doc.activations[0]!.id;
    const extra = addMessage(doc, { kind: 'async', from: 'a', to: 'b', label: '二', y: 600 });
    doc = setActivationEnd(extra.doc, actId, extra.id);

    const after = updateMessage(doc, msgId, { kind: 'async', to: 'b' });
    expect(after.activations.find((x) => x.id === actId)).toBeDefined();
  });

  it('把异步消息改成同步时，会自动补上激活条', () => {
    let { doc } = scenario();
    const async = addMessage(doc, { kind: 'async', from: 'a', to: 'b', label: '通知', y: 600 });
    doc = async.doc;
    expect(doc.activations.some((x) => x.startMessageId === async.id)).toBe(false);

    const after = updateMessage(doc, async.id, { kind: 'sync', to: 'b' });
    expect(after.activations.some((x) => x.startMessageId === async.id)).toBe(true);
  });

  it('删除消息时，锚定其上的激活条一并消失', () => {
    const { doc, msgId } = scenario();
    expect(removeMessage(doc, msgId).activations).toHaveLength(0);
  });

  it('删除参与者时，它身上的激活条一并消失', () => {
    const { doc, b } = scenario();
    const after = removeParticipant(doc, b);
    expect(after.activations.filter((x) => x.participant === b)).toHaveLength(0);
  });

  it('消息被拖动后，激活条的起点跟着走', () => {
    const { doc, msgId } = scenario();
    const before = layout(doc).activations[0]!.y;
    const moved = updateMessage(doc, msgId, { y: 500 });
    expect(layout(moved).activations[0]!.y).toBe(before + 300);
  });
});

describe('布局层面的约束', () => {
  it('激活条永远不短于最小高度（不会退化成一条线看不见）', () => {
    const { doc, actId } = scenario();
    // 把终点设成和起点同一条消息，长度会是 0
    const squeezed = setActivationEnd(doc, actId, doc.activations[0]!.startMessageId);
    expect(layout(squeezed).activations[0]!.height).toBeGreaterThanOrEqual(
      L.activationMinHeight,
    );
  });

  it('激活条画在对应参与者的生命线上', () => {
    const { doc, b } = scenario();
    const g = layout(doc);
    const act = g.activations[0]!;
    const lifeline = g.lifelines.find((l) => l.participantId === b)!;
    // 激活条以生命线为中线
    expect(act.x + act.width / 2).toBeCloseTo(lifeline.x, 5);
  });

  it('没有激活条时布局照常，不报错', () => {
    const { doc, actId } = scenario();
    const g = layout(removeActivation(doc, actId));
    expect(g.activations).toHaveLength(0);
    expect(Number.isFinite(g.bounds.height)).toBe(true);
  });
});
