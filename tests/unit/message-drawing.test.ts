/**
 * 拖拽画消息、激活条截断与分段。
 *
 * 这组对应的是直接操作（direct manipulation）：用户在画布上拖着鼠标就能画消息、
 * 拖着激活条边缘就能截断。因为交互本身没法在单元测试里模拟，所以把**手势背后的
 * 计算**都抽成了纯函数放在这里测 —— 手势层只负责把指针位置喂进来。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  addMessage,
  createDoc,
  insertMessageAfter,
  insertMessageAtY,
  messageBottom,
  messagesOnParticipant,
  nextMessageY,
  setActivationEndAtY,
  splitActivation,
} from '../../src/core/commands';
import { computeLayout, L } from '../../src/core/layout';
import { createApproxMeasurer } from '../../src/core/text';
import { __resetIdsForTest } from '../../src/core/ids';
import { defaultTheme } from '../../src/core/theme';
import type { Doc, Message } from '../../src/core/model';

beforeEach(() => __resetIdsForTest());

const measurer = createApproxMeasurer();
const layout = (doc: Doc) => computeLayout(doc, measurer);

const A = 'a';
const B = 'b';

/** 甲(120) —乙(420)，乙身上有 4 条消息：200 / 260 / 320 / 380 */
function fixture(): Doc {
  let doc = createDoc('t', defaultTheme());
  doc = {
    ...doc,
    participants: [
      { id: A, kind: 'object' as const, name: '甲', x: 120 },
      { id: B, kind: 'object' as const, name: '乙', x: 420 },
    ],
  };
  for (const y of [200, 260, 320, 380]) {
    doc = addMessage(doc, {
      kind: 'async', // 异步不会自动生成激活条，保持夹具干净
      from: A,
      to: B,
      label: `m${y}`,
      y,
    }).doc;
  }
  return doc;
}

const ys = (doc: Doc): number[] => doc.messages.map((m) => m.y);

describe('messagesOnParticipant：一条生命线上有哪些消息', () => {
  it('发送方和接收方都算', () => {
    const doc = fixture();
    expect(messagesOnParticipant(doc, B)).toHaveLength(4);
    expect(messagesOnParticipant(doc, A)).toHaveLength(4);
  });

  it('按纵向排序', () => {
    const doc = fixture();
    const list = messagesOnParticipant(doc, B);
    for (let i = 1; i < list.length; i += 1) {
      expect(list[i]!.y).toBeGreaterThanOrEqual(list[i - 1]!.y);
    }
  });

  it('无关的参与者返回空', () => {
    expect(messagesOnParticipant(fixture(), '幽灵')).toEqual([]);
  });
});

describe('insertMessageAtY：拖到哪儿就画在哪儿', () => {
  const opts = { kind: 'sync' as const, from: A, to: B };

  it('拖到所有消息之下：落在拖到的位置', () => {
    const r = insertMessageAtY(fixture(), 500, opts);
    expect(r.doc.messages.some((m) => m.y === 500)).toBe(true);
    // 原有的都没动
    expect(ys(r.doc).slice(0, 4)).toEqual([200, 260, 320, 380]);
  });

  it('拖到两条消息之间：就落在那里，上下都不动', () => {
    const r = insertMessageAtY(fixture(), 290, opts);
    expect(ys(r.doc)).toEqual([200, 260, 290, 320, 380]);
  });

  it('离上一条太近：往下让到刚好不重叠的位置', () => {
    // 拖到 210，离上一条（200）只有 10px —— 标签会叠在一起，所以要往下让
    const r = insertMessageAtY(fixture(), 210, opts);
    const inserted = r.doc.messages.find((m) => m.y !== 200 && m.y < 260)!;
    expect(inserted.y).toBeGreaterThan(200);
    expect(inserted.y).toBeLessThan(260);
  });

  it('位置够宽敞时完全尊重用户拖到的位置，不做任何推挤', () => {
    // 260 和 320 之间只有 60px，放不下一个默认行距 44 的新消息 ——
    // 但拖放是用户明确指定的位置，只要标签不撞就该落在原地
    const r = insertMessageAtY(fixture(), 290, opts);
    expect(r.doc.messages.some((m) => m.y === 290)).toBe(true);
    expect(ys(r.doc)).toEqual([200, 260, 290, 320, 380]);
  });

  it('离下一条太近：把后面的整体推下去腾位置，且互不重叠', () => {
    const r = insertMessageAtY(fixture(), 370, opts);
    const sorted = ys(r.doc);
    expect(sorted).toHaveLength(5);
    for (let i = 1; i < sorted.length; i += 1) {
      // 至少留出标签不叠的底线间距
      expect(sorted[i]! - sorted[i - 1]!).toBeGreaterThanOrEqual(20);
    }
  });

  it('拖到最上面：落在第一条之上，其余不动', () => {
    const r = insertMessageAtY(fixture(), 120, opts);
    expect(ys(r.doc)).toEqual([120, 200, 260, 320, 380]);
  });

  it('空文档里也能用（还没有任何消息）', () => {
    let doc = createDoc('t', defaultTheme());
    doc = {
      ...doc,
      participants: [
        { id: A, kind: 'object' as const, name: '甲', x: 120 },
        { id: B, kind: 'object' as const, name: '乙', x: 420 },
      ],
    };
    const r = insertMessageAtY(doc, 333, opts);
    expect(r.doc.messages[0]!.y).toBe(333);
  });

  it('无论插在哪，都维持"数组顺序 == 纵向顺序"的不变量', () => {
    for (const y of [100, 210, 290, 370, 500]) {
      const r = insertMessageAtY(fixture(), y, opts);
      const arr = r.doc.messages.map((m) => m.y);
      expect([...arr].sort((p, q) => p - q)).toEqual(arr);
    }
  });

  it('插入同步消息时照常自动生成激活条', () => {
    const r = insertMessageAtY(fixture(), 500, opts);
    expect(r.doc.activations.some((a) => a.startMessageId === r.id)).toBe(true);
  });
});

/**
 * 甲(120) — 乙(420)。乙身上一条**从 200 开始**的激活条（由同步消息触发），
 * 其下是 260 / 320 / 380 / 440 四条异步消息（异步不产生激活条，保持夹具干净）。
 */
function withActivation(): { doc: Doc; actId: string; msgAt: (y: number) => string } {
  let doc = createDoc('t', defaultTheme());
  doc = {
    ...doc,
    participants: [
      { id: A, kind: 'object' as const, name: '甲', x: 120 },
      { id: B, kind: 'object' as const, name: '乙', x: 420 },
    ],
  };
  doc = addMessage(doc, { kind: 'sync', from: A, to: B, label: '开始', y: 200 }).doc;
  for (const y of [260, 320, 380, 440]) {
    doc = addMessage(doc, { kind: 'async', from: A, to: B, label: `m${y}`, y }).doc;
  }
  return {
    doc,
    actId: doc.activations[0]!.id,
    msgAt: (y: number) => doc.messages.find((x) => x.y === y)!.id,
  };
}

describe('setActivationEndAtY：拖下边缘截断', () => {
  it('拖到某条消息附近：终点吸附到它上面', () => {
    const { doc, actId } = withActivation();
    const after = setActivationEndAtY(doc, actId, 265);
    const act = after.activations.find((a) => a.id === actId)!;
    expect(after.messages.find((m) => m.id === act.endMessageId)!.y).toBe(260);
  });

  it('截断后激活条高度确实变短了', () => {
    const { doc, actId } = withActivation();
    const before = layout(doc).activations.find((a) => a.id === actId)!.height;
    const after = layout(setActivationEndAtY(doc, actId, 265))
      .activations.find((a) => a.id === actId)!.height;
    expect(after).toBeLessThan(before);
    // 200 → 260，高度正好 60
    expect(after).toBe(60);
  });

  it('拖到所有消息之下：清除终点，恢复自动延伸（这是撤销截断的手势）', () => {
    const { doc, actId } = withActivation();
    const truncated = setActivationEndAtY(doc, actId, 265);
    expect(truncated.activations.find((a) => a.id === actId)!.endMessageId).toBeDefined();

    const reopened = setActivationEndAtY(truncated, actId, 9999);
    expect(reopened.activations.find((a) => a.id === actId)!.endMessageId).toBeUndefined();
  });

  it('拖到起点上方：吸附到最早的那个合法候选，不会短于最小高度', () => {
    const { doc, actId } = withActivation();
    const after = setActivationEndAtY(doc, actId, 0);
    const act = layout(after).activations.find((a) => a.id === actId)!;
    expect(act.height).toBeGreaterThanOrEqual(L.activationMinHeight);
  });

  it('绝不把终点吸附到起点之前（那会算出负高度）', () => {
    const { doc, actId } = withActivation();
    // 拖到正好是起点（200）的位置
    const after = setActivationEndAtY(doc, actId, 200);
    const act = layout(after).activations.find((a) => a.id === actId)!;
    expect(act.height).toBeGreaterThan(0);
    // 终点被推到了起点之后的某条消息上
    const endMsg = after.messages.find(
      (m) => m.id === after.activations.find((a) => a.id === actId)!.endMessageId,
    )!;
    expect(endMsg.y).toBeGreaterThanOrEqual(260);
  });

  it('激活条 id 不存在时是安全的空操作', () => {
    const { doc } = withActivation();
    expect(setActivationEndAtY(doc, '幽灵', 300)).toBe(doc);
  });
});

describe('splitActivation：截断并新开一段', () => {
  it('原激活条被截断到指定消息', () => {
    const { doc, actId, msgAt } = withActivation();
    const after = splitActivation(doc, actId, msgAt(260));
    expect(after.activations.find((a) => a.id === actId)!.endMessageId).toBe(msgAt(260));
  });

  it('在同一条生命线上下一条消息处新开一段', () => {
    const { doc, actId, msgAt } = withActivation();
    const after = splitActivation(doc, actId, msgAt(260));

    expect(after.activations).toHaveLength(2);
    const fresh = after.activations.find((a) => a.id !== actId)!;
    expect(fresh.participant).toBe(B);
    expect(fresh.startMessageId).toBe(msgAt(320));
    expect(fresh.endMessageId).toBeUndefined();
  });

  it('两段之间真的空出一段（这正是"分段执行"的视觉表现）', () => {
    const { doc, actId, msgAt } = withActivation();
    const after = splitActivation(doc, actId, msgAt(260));
    const g = layout(after);
    const [first, second] = g.activations
      .filter((a) => a.participant === B)
      .sort((p, q) => p.y - q.y);

    // 第一段到 260 就结束了，第二段从 320 才开始
    expect(first!.y + first!.height).toBe(260);
    expect(second!.y).toBe(320);
    expect(second!.y - (first!.y + first!.height)).toBe(60);
  });

  it('断点之后没有更多消息时：只截断，不新开（也不报错）', () => {
    const { doc, actId, msgAt } = withActivation();
    const after = splitActivation(doc, actId, msgAt(440)); // 440 是最后一条
    expect(after.activations).toHaveLength(1);
    expect(after.activations[0]!.endMessageId).toBe(msgAt(440));
  });

  it('断点消息不存在时原样返回', () => {
    const { doc, actId } = withActivation();
    expect(splitActivation(doc, actId, '幽灵')).toBe(doc);
  });

  it('激活条 id 不存在时原样返回', () => {
    const { doc, msgAt } = withActivation();
    expect(splitActivation(doc, '幽灵', msgAt(260))).toBe(doc);
  });

  it('可以连续断两次，分出三段依次排开', () => {
    const { doc, actId, msgAt } = withActivation();
    const once = splitActivation(doc, actId, msgAt(260));
    const second = once.activations.find((a) => a.id !== actId && a.participant === B)!;
    const twice = splitActivation(once, second.id, msgAt(380));

    const onB = twice.activations.filter((a) => a.participant === B);
    expect(onB).toHaveLength(3);

    const sorted = layout(twice)
      .activations.filter((a) => a.participant === B)
      .sort((p, q) => p.y - q.y);
    for (let i = 1; i < sorted.length; i += 1) {
      expect(sorted[i]!.y).toBeGreaterThanOrEqual(sorted[i - 1]!.y + sorted[i - 1]!.height);
    }
  });

  it('不修改传入的文档', () => {
    const { doc, actId, msgAt } = withActivation();
    const snapshot = JSON.stringify(doc);
    splitActivation(doc, actId, msgAt(260));
    expect(JSON.stringify(doc)).toBe(snapshot);
  });
});

// ---------------------------------------------------------------------------
// 自调用在纵向上占的高度
// ---------------------------------------------------------------------------

describe('自调用的纵向占位', () => {
  it('自调用比普通消息多占一段高度（它往右下绕了一圈）', () => {
    const plain: Message = { id: 'm', kind: 'async', from: A, to: B, label: 'x', y: 200 };
    const loop: Message = { id: 'm', kind: 'self', from: A, to: A, label: 'x', y: 200 };
    expect(messageBottom(plain)).toBe(200);
    expect(messageBottom(loop)).toBeGreaterThan(200);
  });

  it('在自调用之后追加消息时，会把它往下让出一整圈的高度', () => {
    let doc = createDoc('t', defaultTheme());
    doc = {
      ...doc,
      participants: [
        { id: A, kind: 'object' as const, name: '甲', x: 120 },
        { id: B, kind: 'object' as const, name: '乙', x: 420 },
      ],
    };
    doc = addMessage(doc, { kind: 'self', from: A, to: A, label: '自', y: 200 }).doc;
    const loopBottom = messageBottom(doc.messages[0]!);

    const y = nextMessageY(doc);
    // 不是简单地 200 + 44，而是在折线**下沿**之后再留一个行距
    expect(y).toBeGreaterThanOrEqual(loopBottom + doc.theme.messageSpacing);
  });

  it('回归：下一条消息的文字不会压在自调用的折线上', () => {
    let doc = createDoc('t', defaultTheme());
    doc = {
      ...doc,
      participants: [
        { id: A, kind: 'object' as const, name: '甲', x: 120 },
        { id: B, kind: 'object' as const, name: '乙', x: 420 },
      ],
    };
    doc = addMessage(doc, { kind: 'self', from: A, to: A, label: '自', y: 200 }).doc;
    const r = addMessage(doc, { kind: 'async', from: A, to: B, label: '下一条', y: nextMessageY(doc) });
    doc = r.doc;

    const g = layout(doc);
    const loop = g.messages.find((m) => m.kind === 'self')!;
    const next = g.messages.find((m) => m.id === r.id)!;
    // 折线的下沿（自调用实际画到 y + 折线高度）
    const loopBottom = loop.y1 + (loop.y2 - loop.y1);
    // 下一条消息的文字标签在箭头之上，必须整条都在折线下方
    expect(next.labelY).toBeGreaterThan(loopBottom);
  });

  it('insertMessageAfter 以锚点的下沿起算，而不是它的 y', () => {
    let doc = createDoc('t', defaultTheme());
    doc = {
      ...doc,
      participants: [
        { id: A, kind: 'object' as const, name: '甲', x: 120 },
        { id: B, kind: 'object' as const, name: '乙', x: 420 },
      ],
    };
    const self = addMessage(doc, { kind: 'self', from: A, to: A, label: '自', y: 200 });
    doc = self.doc;

    const r = insertMessageAfter(doc, self.id, { kind: 'async', from: A, to: B });
    expect(r.doc.messages[1]!.y).toBe(messageBottom(doc.messages[0]!) + doc.theme.messageSpacing);
  });

  it('普通消息之间仍然是一个行距，没有多余的间隙', () => {
    const doc = fixture();
    const anchor = doc.messages[0]!;
    const r = insertMessageAfter(doc, anchor.id, { kind: 'async', from: A, to: B });
    expect(r.doc.messages.find((m) => m.id === r.id)!.y).toBe(anchor.y + doc.theme.messageSpacing);
  });
});
