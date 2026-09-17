import { beforeEach, describe, expect, it } from 'vitest';
import {
  addMessage,
  addNote,
  addParticipant,
  createDoc,
  distributeParticipants,
  moveMessage,
  moveParticipant,
  removeMessage,
  removeParticipant,
  updateParticipant,
} from '../../src/core/commands';
import { __resetIdsForTest } from '../../src/core/ids';
import { createNewDoc } from '../../src/core/samples';
import { defaultTheme } from '../../src/core/theme';
import type { Doc } from '../../src/core/model';

beforeEach(() => __resetIdsForTest());

function twoParty(): { doc: Doc; a: string; b: string } {
  const doc = createNewDoc('t', defaultTheme());
  const [a, b] = doc.participants;
  return { doc, a: a!.id, b: b!.id };
}

describe('不可变性', () => {
  it('所有命令都不修改传入的文档', () => {
    const { doc, a, b } = twoParty();
    const snapshot = JSON.stringify(doc);

    addParticipant(doc, { name: '新' });
    addMessage(doc, { kind: 'sync', from: a, to: b, label: 'x', y: 200 });
    updateParticipant(doc, a, { name: '改名' });
    moveParticipant(doc, a, 999);
    removeParticipant(doc, b);
    distributeParticipants(doc);

    expect(JSON.stringify(doc)).toBe(snapshot);
  });
});

describe('参与者', () => {
  it('默认追加到最右侧', () => {
    const { doc } = twoParty();
    const before = Math.max(...doc.participants.map((p) => p.x));
    const r = addParticipant(doc, { name: '新对象' });
    const added = r.doc.participants.find((p) => p.id === r.id)!;
    expect(added.x).toBeGreaterThan(before);
  });

  it('插到中间时把后面的整体右移，避免重叠', () => {
    const { doc } = twoParty();
    const beforeXs = doc.participants.map((p) => p.x);
    const r = addParticipant(doc, { name: '中间', index: 1 });

    const inserted = r.doc.participants.find((p) => p.id === r.id)!;
    // 原本第 1 个位置的人被推到新人的右边
    const movedOld = r.doc.participants.find((p) => p.id === doc.participants[1]!.id)!;
    expect(inserted.x).toBeLessThan(movedOld.x);
    expect(movedOld.x).toBeGreaterThan(beforeXs[1]!);
  });

  it('删除参与者会级联清理引用它的消息、激活条和附着注释', () => {
    let { doc, a, b } = twoParty();
    doc = addMessage(doc, { kind: 'sync', from: a, to: b, label: '请求', y: 200 }).doc;
    doc = addMessage(doc, { kind: 'return', from: b, to: a, label: '响应', y: 260 }).doc;
    doc = addNote(doc, { text: '备注', x: 10, y: 10, attachTo: b }).doc;
    expect(doc.messages.length).toBe(2);

    const after = removeParticipant(doc, b);

    expect(after.participants.map((p) => p.id)).toEqual([a]);
    expect(after.messages).toHaveLength(0);
    expect(after.activations).toHaveLength(0);
    expect(after.notes).toHaveLength(0);
  });

  it('改坐标后数组重新排序，维持"顺序即逻辑"不变量', () => {
    const { doc, a, b } = twoParty();
    // 把第一个挪到最右边
    const after = moveParticipant(doc, a, 5000);
    expect(after.participants[after.participants.length - 1]!.id).toBe(a);
    expect(after.participants[0]!.id).toBe(b);
  });
});

describe('消息', () => {
  it('同步消息自动在接收方开启激活条', () => {
    const { doc, a, b } = twoParty();
    const r = addMessage(doc, { kind: 'sync', from: a, to: b, label: '请求', y: 200 });
    expect(r.doc.activations).toHaveLength(1);
    expect(r.doc.activations[0]!.participant).toBe(b);
    expect(r.doc.activations[0]!.startMessageId).toBe(r.id);
  });

  it('自调用在自身开启激活条', () => {
    const { doc, a } = twoParty();
    const r = addMessage(doc, { kind: 'self', from: a, to: a, label: '自处理', y: 200 });
    expect(r.doc.activations).toHaveLength(1);
    expect(r.doc.activations[0]!.participant).toBe(a);
    expect(r.doc.messages[0]!.to).toBe(a);
  });

  it('异步消息不创建激活条', () => {
    const { doc, a, b } = twoParty();
    const r = addMessage(doc, { kind: 'async', from: a, to: b, label: '通知', y: 200 });
    expect(r.doc.activations).toHaveLength(0);
  });

  it('返回消息关闭发送方最近的开放激活条', () => {
    const { doc, a, b } = twoParty();
    let d = addMessage(doc, { kind: 'sync', from: a, to: b, label: '请求', y: 200 }).doc;
    const ret = addMessage(d, { kind: 'return', from: b, to: a, label: '响应', y: 260 });
    d = ret.doc;

    const act = d.activations.find((x) => x.participant === b)!;
    expect(act.endMessageId).toBe(ret.id);
  });

  it('返回消息关闭的是最近一个开放激活条，而不是最早的', () => {
    const { doc, a, b } = twoParty();
    let d = addMessage(doc, { kind: 'sync', from: a, to: b, label: '一', y: 200 }).doc;
    const second = addMessage(d, { kind: 'sync', from: a, to: b, label: '二', y: 260 });
    d = second.doc;
    const ret = addMessage(d, { kind: 'return', from: b, to: a, label: '回', y: 320 });
    d = ret.doc;

    const acts = d.activations.filter((x) => x.participant === b);
    expect(acts).toHaveLength(2);
    const closed = acts.find((x) => x.endMessageId === ret.id)!;
    expect(closed.startMessageId).toBe(second.id); // 后开的先关
    expect(acts.find((x) => x.startMessageId !== second.id)!.endMessageId).toBeUndefined();
  });

  it('删除消息会连同锚定其上的激活条一起删除', () => {
    const { doc, a, b } = twoParty();
    const r = addMessage(doc, { kind: 'sync', from: a, to: b, label: '请求', y: 200 });
    expect(r.doc.activations).toHaveLength(1);
    const after = removeMessage(r.doc, r.id);
    expect(after.messages).toHaveLength(0);
    expect(after.activations).toHaveLength(0);
  });

  it('删除作为终点的消息时，激活条退回"自动延伸"而不是被删掉', () => {
    const { doc, a, b } = twoParty();
    let d = addMessage(doc, { kind: 'sync', from: a, to: b, label: '请求', y: 200 }).doc;
    const ret = addMessage(d, { kind: 'return', from: b, to: a, label: '响应', y: 260 });
    d = ret.doc;
    expect(d.activations[0]!.endMessageId).toBe(ret.id);

    const after = removeMessage(d, ret.id);
    expect(after.activations).toHaveLength(1);
    expect(after.activations[0]!.endMessageId).toBeUndefined();
  });

  it('移动消息后重新按 y 排序', () => {
    const { doc, a, b } = twoParty();
    let d = addMessage(doc, { kind: 'sync', from: a, to: b, label: '一', y: 200 }).doc;
    const second = addMessage(d, { kind: 'sync', from: a, to: b, label: '二', y: 300 });
    d = second.doc;

    // 把第二条拖到第一条上面
    const after = moveMessage(d, second.id, 150);
    expect(after.messages[0]!.id).toBe(second.id);
  });
});

describe('均匀分布', () => {
  it('参与者间距拉匀，首尾位置不变', () => {
    let doc = createDoc('t', defaultTheme());
    doc = addParticipant(doc, { name: 'A' }).doc;
    doc = addParticipant(doc, { name: 'B' }).doc;
    doc = addParticipant(doc, { name: 'C' }).doc;
    // 人为破坏间距
    doc = moveParticipant(doc, doc.participants[1]!.id, doc.participants[0]!.x + 20);

    const after = distributeParticipants(doc);
    const xs = after.participants.map((p) => p.x);
    const d1 = xs[1]! - xs[0]!;
    const d2 = xs[2]! - xs[1]!;
    expect(Math.abs(d1 - d2)).toBeLessThanOrEqual(1);
    expect(xs[0]).toBe(doc.participants[0]!.x);
    expect(xs[2]).toBe(doc.participants[2]!.x);
  });

  it('少于三个元素时不做任何事', () => {
    const { doc } = twoParty();
    expect(distributeParticipants(doc)).toBe(doc);
  });
});
