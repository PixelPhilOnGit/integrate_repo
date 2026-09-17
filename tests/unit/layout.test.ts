import { beforeEach, describe, expect, it } from 'vitest';
import { computeLayout, hitTest, L } from '../../src/modules/diagram/core/layout';
import { createApproxMeasurer, estimateTextWidth } from '../../src/shared/text';
import { createDemoDoc, createNewDoc } from '../../src/modules/diagram/core/samples';
import { addMessage, addParticipant, moveMessage } from '../../src/modules/diagram/core/commands';
import { __resetIdsForTest } from '../../src/shared/ids';
import { rectContainsPoint, rectsOverlap } from '../../src/shared/geometry';
import { defaultTheme } from '../../src/modules/diagram/core/theme';
import type { Doc } from '../../src/modules/diagram/core/model';

const measurer = createApproxMeasurer();
const layout = (doc: Doc) => computeLayout(doc, measurer);

/** 一个最小可用的两参与者文档，便于做聚焦断言 */
function twoPartyDoc(): Doc {
  const theme = defaultTheme();
  let doc = createNewDoc('t', theme);
  const [a, b] = doc.participants;
  const r = addMessage(doc, { kind: 'sync', from: a!.id, to: b!.id, label: '请求', y: 200 });
  doc = r.doc;
  return doc;
}

beforeEach(() => __resetIdsForTest());

describe('布局不变量', () => {
  it('参与者方框装得下它的名称', () => {
    const doc = createDemoDoc();
    const l = layout(doc);
    for (const p of l.participants) {
      const textW = estimateTextWidth(p.label, doc.theme.fontSize);
      expect(p.box.width).toBeGreaterThanOrEqual(textW);
    }
  });

  it('参与者方框互不重叠', () => {
    const doc = createDemoDoc();
    const l = layout(doc);
    for (let i = 0; i < l.participants.length; i += 1) {
      for (let j = i + 1; j < l.participants.length; j += 1) {
        expect(rectsOverlap(l.participants[i]!.box, l.participants[j]!.box)).toBe(false);
      }
    }
  });

  it('生命线起点在所有头部下方，且全部对齐', () => {
    const l = layout(createDemoDoc());
    for (const p of l.participants) {
      expect(l.lifelineTop).toBeGreaterThanOrEqual(p.box.y + p.box.height);
    }
    expect(new Set(l.lifelines.map((x) => x.y1)).size).toBe(1);
  });

  it('生命线终点在各个消息下方', () => {
    const doc = createDemoDoc();
    const l = layout(doc);
    for (const m of l.messages) {
      expect(l.lifelineBottom).toBeGreaterThanOrEqual(m.y1);
    }
  });

  it('包围盒覆盖所有可见元素', () => {
    const l = layout(createDemoDoc());
    const b = l.bounds;
    const covers = (x: number, y: number) =>
      x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height;

    for (const p of l.participants) {
      expect(covers(p.box.x, p.box.y)).toBe(true);
      expect(covers(p.box.x + p.box.width, p.box.y + p.box.height)).toBe(true);
    }
    for (const a of l.activations) {
      expect(covers(a.x, a.y + a.height)).toBe(true);
    }
  });

  it('空文档也能算出合法布局，不出现 NaN', () => {
    const doc = createNewDoc('空');
    const l = layout(doc);
    expect(Number.isFinite(l.bounds.width)).toBe(true);
    expect(Number.isFinite(l.bounds.height)).toBe(true);
    expect(l.bounds.width).toBeGreaterThan(0);
    expect(l.bounds.height).toBeGreaterThan(0);
  });
});

describe('消息', () => {
  it('消息按纵坐标升序排列', () => {
    const l = layout(createDemoDoc());
    for (let i = 1; i < l.messages.length; i += 1) {
      expect(l.messages[i]!.y1).toBeGreaterThanOrEqual(l.messages[i - 1]!.y1);
    }
  });

  it('自动编号跳过返回消息', () => {
    const doc = createDemoDoc();
    const l = layout(doc);
    const returnIds = new Set(doc.messages.filter((m) => m.kind === 'return').map((m) => m.id));
    for (const g of l.messages) {
      if (returnIds.has(g.id)) {
        expect(g.seqLabel).toBeNull();
      } else {
        expect(g.seqLabel).toBeTruthy();
      }
    }
    // 非返回消息的编号应当是连续的 1..n
    const nums = l.messages.filter((g) => g.seqLabel).map((g) => Number(g.seqLabel));
    expect(nums).toEqual(Array.from({ length: nums.length }, (_, i) => i + 1));
  });

  it('自调用消息画成闭环折线', () => {
    let doc = twoPartyDoc();
    const a = doc.participants[0]!;
    doc = addMessage(doc, { kind: 'self', from: a.id, to: a.id, label: '自处理' }).doc;
    const l = layout(doc);
    const self = l.messages.find((m) => m.kind === 'self');
    expect(self).toBeDefined();
    // M x y H x+w V y+h H x —— 起点和终点横坐标相同
    expect(self!.path.startsWith('M ')).toBe(true);
    expect(self!.x1).toBe(self!.x2);
    expect(self!.y2).toBeGreaterThan(self!.y1);
  });

  it('关闭序号显示后不再输出序号', () => {
    const doc = createDemoDoc();
    const themed = { ...doc, theme: { ...doc.theme, showSequenceNumbers: false } };
    expect(layout(themed).messages.every((m) => m.seqLabel === null)).toBe(true);
  });
});

describe('激活条', () => {
  it('激活条锚定消息：消息移动后跟着移动', () => {
    const doc = twoPartyDoc();
    const target = doc.participants[1]!;
    const msg = doc.messages[0]!;

    const before = layout(doc).activations.find((a) => a.participant === target.id);
    expect(before).toBeDefined();

    const moved = moveMessage(doc, msg.id, msg.y + 60);
    const after = layout(moved).activations.find((a) => a.participant === target.id);

    expect(after!.y).toBe(before!.y + 60);
  });

  it('激活条有最小高度，不会退化成一条线', () => {
    const l = layout(twoPartyDoc());
    for (const a of l.activations) {
      expect(a.height).toBeGreaterThanOrEqual(L.activationMinHeight);
    }
  });

  it('嵌套激活条横向错开，深度递增', () => {
    const a = { id: 'a1', kind: 'object' as const, name: 'A', x: 100 };
    const b = { id: 'b1', kind: 'object' as const, name: 'B', x: 300 };
    let doc: Doc = {
      schemaVersion: 1,
      title: 't',
      theme: defaultTheme(),
      participants: [a, b],
      messages: [],
      activations: [],
      notes: [],
    };
    // A→B 同步，B→A 返回，A→B 再同步：B 上出现两个激活条
    const m1 = addMessage(doc, { kind: 'sync', from: a.id, to: b.id, label: '1', y: 200 });
    doc = m1.doc;
    const m2 = addMessage(doc, { kind: 'sync', from: a.id, to: b.id, label: '2', y: 260 });
    doc = m2.doc;

    const l = layout(doc);
    const bActs = l.activations.filter((x) => x.participant === b.id);
    expect(bActs.length).toBe(2);

    // 第二条进来时 B 还在执行中（第一条没有终点）→ 自动嵌进第一条里。
    // 语义依据：没有显式终点的激活条 = 还在执行，此时到达的消息算重入。
    const outer = bActs.find((x) => x.depth === 0)!;
    const inner = bActs.find((x) => x.depth === 1)!;
    expect(outer).toBeDefined();
    expect(inner).toBeDefined();
    // 横向错开
    expect(inner.x).toBeGreaterThan(outer.x);
    // 外层不被内层截断 —— 这正是"嵌套"和"顺序"的区别
    expect(outer.y + outer.height).toBeGreaterThan(inner.y);
  });

  it('用返回消息闭合之后，下一次调用是顺序执行而不是嵌套', () => {
    const a = { id: 'a1', kind: 'object' as const, name: 'A', x: 100 };
    const b = { id: 'b1', kind: 'object' as const, name: 'B', x: 300 };
    let doc: Doc = {
      schemaVersion: 1,
      title: 't',
      theme: defaultTheme(),
      participants: [a, b],
      messages: [],
      activations: [],
      notes: [],
    };
    doc = addMessage(doc, { kind: 'sync', from: a.id, to: b.id, label: '一', y: 200 }).doc;
    // 返回消息把 B 的第一次执行闭合掉
    doc = addMessage(doc, { kind: 'return', from: b.id, to: a.id, label: '回', y: 260 }).doc;
    doc = addMessage(doc, { kind: 'sync', from: a.id, to: b.id, label: '二', y: 320 }).doc;

    const bActs = layout(doc).activations.filter((x) => x.participant === b.id);
    expect(bActs).toHaveLength(2);
    // 两段是**顺序**的，都在最外层
    expect(bActs.every((x) => x.depth === 0)).toBe(true);
    // 而且首尾相接，不重叠
    const sorted = [...bActs].sort((p, q) => p.y - q.y);
    expect(sorted[1]!.y).toBeGreaterThanOrEqual(sorted[0]!.y + sorted[0]!.height - 1);
  });

  it('包住另一个激活条的激活条深度更大、位置更靠左', () => {
    // 构造：B 上有一个长激活条，内部再有一个短的
    const a = { id: 'a1', kind: 'object' as const, name: 'A', x: 100 };
    const b = { id: 'b1', kind: 'object' as const, name: 'B', x: 300 };
    const doc: Doc = {
      schemaVersion: 1,
      title: 't',
      theme: defaultTheme(),
      participants: [a, b],
      messages: [
        { id: 'm1', kind: 'sync', from: a.id, to: b.id, label: '开始', y: 200 },
        { id: 'm2', kind: 'sync', from: b.id, to: b.id, label: '内部', y: 260 },
        { id: 'm3', kind: 'return', from: b.id, to: a.id, label: '结束', y: 380 },
      ],
      activations: [
        // 外层：从 m1 到 m3
        { id: 'act1', participant: b.id, startMessageId: 'm1', endMessageId: 'm3' },
        // 内层：从 m2 开始，自动延伸到外层结束
        { id: 'act2', participant: b.id, startMessageId: 'm2' },
      ],
      notes: [],
    };
    const l = layout(doc);
    const outer = l.activations.find((x) => x.id === 'act1')!;
    const inner = l.activations.find((x) => x.id === 'act2')!;

    expect(outer.depth).toBe(0);
    expect(inner.depth).toBe(1);
    expect(inner.x).toBeGreaterThan(outer.x);
  });
});

describe('命中测试', () => {
  it('能命中参与者头部', () => {
    const doc = createDemoDoc();
    const l = layout(doc);
    const box = l.participants[1]!;
    const hit = hitTest(l, { x: box.box.x + box.box.width / 2, y: box.box.y + 4 });
    expect(hit).toEqual({ type: 'participant', id: box.id });
  });

  it('能命中消息箭头，即使线很细', () => {
    const doc = twoPartyDoc();
    const l = layout(doc);
    const m = l.messages[0]!;
    const mid = { x: (m.x1 + m.x2) / 2, y: m.y1 };
    const hit = hitTest(l, mid);
    expect(hit).toEqual({ type: 'message', id: m.id });
  });

  it('点消息的文字标签也能选中消息（回归：曾经只能点中那 1px 的线）', () => {
    const doc = twoPartyDoc();
    const l = layout(doc);
    const m = l.messages[0]!;
    // 标签画在箭头**上方**，离线段有 7px，超出了线段距离判定的容差
    const onLabel = { x: m.labelX, y: m.labelY };
    expect(Math.abs(onLabel.y - m.y1)).toBeGreaterThan(6);
    expect(hitTest(l, onLabel)).toEqual({ type: 'message', id: m.id });
  });

  it('命中判定顺序与渲染层级一致：消息压在激活条之上', () => {
    const doc = twoPartyDoc();
    const l = layout(doc);
    const m = l.messages[0]!;
    const act = l.activations[0]!;
    // 箭头终点吸附在激活条边缘，取一个两者都覆盖的点
    const p = { x: m.x2, y: m.y2 };
    expect(rectContainsPoint(act.bounds, p)).toBe(true);
    // 消息渲染在激活条之后（更靠上），应当优先命中
    expect(hitTest(l, p)).toEqual({ type: 'message', id: m.id });
  });

  it('空白处返回 null', () => {
    const l = layout(twoPartyDoc());
    // 图的最右下角是空白区
    expect(hitTest(l, { x: l.bounds.x + l.bounds.width - 2, y: l.bounds.y + l.bounds.height - 2 })).toBeNull();
  });

  it('优先命中激活条而不是它背后的生命线', () => {
    const doc = twoPartyDoc();
    const l = layout(doc);
    const act = l.activations[0]!;
    const hit = hitTest(l, { x: act.x + act.width / 2, y: act.y + act.height / 2 });
    expect(hit).toEqual({ type: 'activation', id: act.id });
  });
});

describe('端点吸附', () => {
  it('有激活条时，消息端点吸附到条边缘而不是生命线中轴', () => {
    const doc = twoPartyDoc();
    const l = layout(doc);
    const target = doc.participants[1]!;
    const act = l.activations.find((a) => a.participant === target.id)!;
    const m = l.messages[0]!;

    // 消息从左向右，终点应当落在激活条左边缘，而不是 centerX
    expect(m.x2).toBeCloseTo(act.x, 5);
    expect(m.x2).not.toBeCloseTo(target.x, 5);
  });

  it('没有激活条时端点落在生命线上', () => {
    let doc = createNewDoc('t');
    const [a, b] = doc.participants;
    // async 不会自动创建激活条
    doc = addMessage(doc, { kind: 'async', from: a!.id, to: b!.id, label: '通知', y: 200 }).doc;
    const l = layout(doc);
    expect(l.messages[0]!.x1).toBe(a!.x);
    expect(l.messages[0]!.x2).toBe(b!.x);
  });
});

describe('新增参与者后的布局', () => {
  it('新参与者不会和已有的重叠', () => {
    let doc = createDemoDoc();
    doc = addParticipant(doc, { kind: 'object', name: '缓存' }).doc;
    const l = layout(doc);
    for (let i = 0; i < l.participants.length; i += 1) {
      for (let j = i + 1; j < l.participants.length; j += 1) {
        expect(rectsOverlap(l.participants[i]!.box, l.participants[j]!.box)).toBe(false);
      }
    }
  });
});
