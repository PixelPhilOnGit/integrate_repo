/**
 * 工具栏动作的上下文定位。
 *
 * 这一组测试对应一组真实的用户抱怨：新增注释和自调用永远落在第一个参与者上、
 * 拖着注释横向不动、选中一条消息后新增的消息跑到图的最底下。
 * 根因是同一类问题 —— 动作完全无视"用户当前选中了什么、鼠标在哪"。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  addMessage,
  insertMessageAfter,
  notePlacement,
  resolveEndpoints,
} from '../../src/modules/diagram/core/commands';
import { computeLayout } from '../../src/modules/diagram/core/layout';
import { createApproxMeasurer } from '../../src/shared/text';
import { createDemoDoc, createNewDoc } from '../../src/modules/diagram/core/samples';
import { __resetIdsForTest } from '../../src/shared/ids';
import { defaultTheme } from '../../src/modules/diagram/core/theme';
import type { Doc, Message, Note } from '../../src/modules/diagram/core/model';

beforeEach(() => __resetIdsForTest());

const measurer = createApproxMeasurer();
const layout = (doc: Doc) => computeLayout(doc, measurer);

/** 两参与者 + 一条消息的最小场景 */
function twoParty(): { doc: Doc; a: string; b: string; c: string; m: Message } {
  const base = createNewDoc('t');
  const ps = base.participants;
  const doc: Doc = {
    ...base,
    participants: [
      ...ps,
      { id: 'c1', kind: 'object' as const, name: '第三个', x: 700 },
    ].sort((x, y) => x.x - y.x),
    messages: [
      { id: 'msg1', kind: 'sync', from: ps[0]!.id, to: ps[1]!.id, label: '一', y: 200 },
      { id: 'msg2', kind: 'sync', from: ps[1]!.id, to: 'c1', label: '二', y: 260 },
      { id: 'msg3', kind: 'sync', from: 'c1', to: ps[0]!.id, label: '三', y: 320 },
    ],
  };
  return { doc, a: ps[0]!.id, b: ps[1]!.id, c: 'c1', m: doc.messages[0]! };
}

describe('resolveEndpoints：新消息从谁发给谁', () => {
  it('没有选中时维持默认：最左发给次左', () => {
    const { doc, a, b } = twoParty();
    expect(resolveEndpoints(doc, { kind: 'none' }, 'sync')).toEqual({ from: a, to: b });
  });

  it('选中参与者时以它为发送方', () => {
    const { doc, b, c } = twoParty();
    expect(resolveEndpoints(doc, { kind: 'participant', id: b }, 'sync')).toEqual({
      from: b,
      to: c,
    });
  });

  it('选中参与者时自调用落在它自己身上（而不是第一个）', () => {
    const { doc, c } = twoParty();
    expect(resolveEndpoints(doc, { kind: 'participant', id: c }, 'self')).toEqual({
      from: c,
      to: c,
    });
  });

  it('选中最右边的参与者时，邻居取左边那个（不会没得选）', () => {
    const { doc, b, c } = twoParty();
    expect(resolveEndpoints(doc, { kind: 'participant', id: c }, 'sync')).toEqual({
      from: c,
      to: b,
    });
  });

  it('选中消息时承接它的流向，而不是从最左边重来', () => {
    const { doc, b, c } = twoParty();
    // msg2 是 b → c1，下一条同步消息应该从 c1 继续
    expect(resolveEndpoints(doc, { kind: 'message', id: 'msg2' }, 'sync')).toEqual({
      from: c,
      to: b,
    });
  });

  it('选中消息后加返回消息 = 原路返回', () => {
    const { doc, a, b } = twoParty();
    expect(resolveEndpoints(doc, { kind: 'message', id: 'msg1' }, 'return')).toEqual({
      from: b,
      to: a,
    });
  });

  it('选中消息后加自调用，落在它的接收方上', () => {
    const { doc, c } = twoParty();
    expect(resolveEndpoints(doc, { kind: 'message', id: 'msg2' }, 'self')).toEqual({
      from: c,
      to: c,
    });
  });

  it('选中的消息已经不存在时退回默认，不崩', () => {
    const { doc, a, b } = twoParty();
    expect(resolveEndpoints(doc, { kind: 'message', id: '幽灵' }, 'sync')).toEqual({
      from: a,
      to: b,
    });
  });

  it('没有任何参与者时返回 null', () => {
    const doc: Doc = { ...createNewDoc('t'), participants: [] };
    expect(resolveEndpoints(doc, { kind: 'none' }, 'sync')).toBeNull();
  });
});

describe('insertMessageAfter：插到选中消息之后', () => {
  it('新消息紧跟在锚点后面，间距等于主题设定的行距', () => {
    const { doc, a, b } = twoParty();
    const anchor = doc.messages[0]!;
    const r = insertMessageAfter(doc, anchor.id, { kind: 'sync', from: a, to: b });

    const inserted = r.doc.messages.find((m) => m.id === r.id)!;
    expect(inserted.y).toBe(anchor.y + doc.theme.messageSpacing);

    const i = r.doc.messages.findIndex((m) => m.id === r.id);
    expect(r.doc.messages[i - 1]!.id).toBe(anchor.id);
  });

  it('后面的消息整体下移，为它腾出位置', () => {
    const { doc, a, b } = twoParty();
    const before = new Map(doc.messages.map((m) => [m.id, m.y]));
    const r = insertMessageAfter(doc, doc.messages[0]!.id, { kind: 'sync', from: a, to: b });
    const gap = doc.theme.messageSpacing;

    for (const m of r.doc.messages) {
      if (m.id === r.id) continue;
      const y0 = before.get(m.id)!;
      // 锚点自己不动，它后面的都下移一个间距
      const expected = m.id === doc.messages[0]!.id ? y0 : y0 + gap;
      expect(m.y).toBe(expected);
    }
  });

  it('保持"数组顺序 == 纵向顺序"的不变量', () => {
    const { doc, a, b } = twoParty();
    const r = insertMessageAfter(doc, doc.messages[1]!.id, { kind: 'sync', from: a, to: b });
    for (let i = 1; i < r.doc.messages.length; i += 1) {
      expect(r.doc.messages[i]!.y).toBeGreaterThanOrEqual(r.doc.messages[i - 1]!.y);
    }
  });

  it('锚点消息不存在时退化成追加，不报错', () => {
    const { doc, a, b } = twoParty();
    const r = insertMessageAfter(doc, '幽灵', { kind: 'sync', from: a, to: b });
    expect(r.doc.messages).toHaveLength(doc.messages.length + 1);
  });

  it('尾部锚点（最后一条）也能正常插入', () => {
    const { doc, a, b } = twoParty();
    const last = doc.messages[doc.messages.length - 1]!;
    const r = insertMessageAfter(doc, last.id, { kind: 'return', from: a, to: b });
    const inserted = r.doc.messages.find((m) => m.id === r.id)!;
    expect(inserted.y).toBe(last.y + doc.theme.messageSpacing);
    // 正好在最后
    expect(r.doc.messages[r.doc.messages.length - 1]!.id).toBe(r.id);
  });
});

describe('notePlacement：新注释放哪儿', () => {
  it('选中参与者时放在它旁边，并挂到它身上', () => {
    const { doc, c } = twoParty();
    const target = doc.participants.find((p) => p.id === c)!;
    const p = notePlacement(doc, { kind: 'participant', id: c });
    expect(p.attachTo).toBe(c);
    expect(p.x).toBeGreaterThan(target.x);
  });

  it('选中消息时贴着那条消息，而不是跑到图顶部', () => {
    const { doc, c } = twoParty();
    const msg = doc.messages.find((m) => m.id === 'msg2')!;
    const p = notePlacement(doc, { kind: 'message', id: 'msg2' });
    expect(p.y).toBe(msg.y);
    expect(p.attachTo).toBe(c); // msg2 的接收方
  });

  it('什么都没选但鼠标点过某处时，放在鼠标位置', () => {
    const { doc } = twoParty();
    const p = notePlacement(doc, { kind: 'none' }, { x: 777, y: 555 });
    expect(p.x).toBe(777);
    expect(p.y).toBe(555);
  });

  it('连续新建的注释不会叠在同一位置', () => {
    const { doc } = twoParty();
    const p1 = notePlacement(doc, { kind: 'none' });
    const withNote: Doc = {
      ...doc,
      notes: [{ id: 'n1', text: 'x', x: p1.x, y: p1.y } as Note],
    };
    const p2 = notePlacement(withNote, { kind: 'none' });
    expect(p2.y).toBeGreaterThan(p1.y);
  });

  it('空文档也能给出可用位置，不返回 NaN', () => {
    const doc: Doc = { ...createNewDoc('t'), participants: [] };
    const p = notePlacement(doc, { kind: 'none' });
    expect(Number.isFinite(p.x)).toBe(true);
    expect(Number.isFinite(p.y)).toBe(true);
  });
});

describe('回归：注释的横向拖动必须生效', () => {
  it('注释位置只由自己的 x 决定，attachTo 不参与定位', () => {
    const { doc, a } = twoParty();
    const target = doc.participants.find((p) => p.id === a)!;
    const withNote: Doc = {
      ...doc,
      notes: [{ id: 'n1', text: '说明', x: 500, y: 300, attachTo: a }],
    };

    const note = layout(withNote).notes[0]!;
    // 关键：x 就是 500，而不是被 attachTo 拉回参与者的横坐标
    expect(note.x).toBe(500);
    expect(note.x).not.toBe(target.x);
  });

  it('改动 x 后布局位置跟着变（拖动有反馈）', () => {
    const { doc, a } = twoParty();
    const base: Doc = {
      ...doc,
      notes: [{ id: 'n1', text: '说明', x: 500, y: 300, attachTo: a }],
    };
    const moved: Doc = { ...base, notes: [{ ...base.notes[0]!, x: 880 }] };

    expect(layout(base).notes[0]!.x).toBe(500);
    expect(layout(moved).notes[0]!.x).toBe(880);
  });

  it('改动 y 后布局位置跟着变', () => {
    const { doc } = twoParty();
    const base: Doc = { ...doc, notes: [{ id: 'n1', text: '说明', x: 500, y: 300 }] };
    const moved: Doc = { ...base, notes: [{ ...base.notes[0]!, y: 640 }] };
    expect(layout(base).notes[0]!.y).toBe(300);
    expect(layout(moved).notes[0]!.y).toBe(640);
  });

  it('包围盒跟着注释走，拖出画面时不会被裁掉', () => {
    const { doc } = twoParty();
    const near: Doc = { ...doc, notes: [{ id: 'n1', text: '说明', x: 200, y: 300 }] };
    const far: Doc = { ...doc, notes: [{ id: 'n1', text: '说明', x: 1500, y: 300 }] };
    expect(layout(far).bounds.width).toBeGreaterThan(layout(near).bounds.width);
  });
});

describe('示例文档仍然自洽', () => {
  it('演示文档的注释位置不受 attachTo 影响', () => {
    const doc = createDemoDoc();
    const withNote: Doc = {
      ...doc,
      notes: [...doc.notes, { id: 'nx', text: '注', x: 1234, y: 567, attachTo: doc.participants[0]!.id }],
    };
    const g = layout(withNote).notes.find((n) => n.id === 'nx')!;
    expect(g.x).toBe(1234);
    expect(g.y).toBe(567);
  });

  it('默认主题下距离常量是有限的（防止把 NaN 写进模型）', () => {
    const t = defaultTheme();
    expect(t.messageSpacing).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 下面这组把「解析端点 → 插入/追加 → 重新布局」串起来验证。
// 单独测每个函数都过、合起来行为不对，是这类改动最容易出的问题。
// ---------------------------------------------------------------------------

describe('串联验证：工具栏动作的完整效果', () => {
  it('选中第二个参与者后加自调用 → 消息落在第二个参与者身上，不是第一个', () => {
    const { doc, a, b } = twoParty();
    const ends = resolveEndpoints(doc, { kind: 'participant', id: b }, 'self')!;
    const r = insertMessageAfter(doc, 'msg1', { kind: 'self', ...ends });

    const self = r.doc.messages.find((m) => m.id === r.id)!;
    expect(self.from).toBe(b);
    expect(self.to).toBe(b);
    expect(self.from).not.toBe(a);

    // 布局上确实画在第二个参与者的生命线上（而不是第一个）
    const g = layout(r.doc);
    const selfGeom = g.messages.find((m) => m.id === r.id)!;
    const firstLifeline = g.lifelines.find((l) => l.participantId === a)!;
    const secondLifeline = g.lifelines.find((l) => l.participantId === b)!;

    expect(Math.abs(selfGeom.x1 - secondLifeline.x)).toBeLessThan(
      Math.abs(selfGeom.x1 - firstLifeline.x),
    );
    // 注意 x1 不一定等于生命线中轴：接收方身上有激活条时，
    // 自调用从激活条的右边缘出发（这正是避免箭头穿过激活条的处理）
    expect(selfGeom.x1).toBeGreaterThanOrEqual(secondLifeline.x);
  });

  it('选中一条消息后加同步消息 → 新消息排在它后面，且发送方是它的接收方', () => {
    const { doc, c } = twoParty();
    const anchor = doc.messages.find((m) => m.id === 'msg2')!; // 第二个参与者 → c1
    const ends = resolveEndpoints(doc, { kind: 'message', id: 'msg2' }, 'sync')!;
    expect(ends.from).toBe(c);

    const r = insertMessageAfter(doc, anchor.id, { kind: 'sync', ...ends });
    const g = layout(r.doc);
    const inserted = g.messages.find((m) => m.id === r.id)!;

    // 纵向：夹在锚点和它原本的下一条之间
    const anchorGeom = g.messages.find((m) => m.id === anchor.id)!;
    const nextGeom = g.messages.find((m) => m.id === 'msg3')!;
    expect(inserted.y1).toBeGreaterThan(anchorGeom.y1);
    expect(inserted.y1).toBeLessThan(nextGeom.y1);
  });

  it('插入消息后，锚点之前的消息一点没动', () => {
    const { doc, a, b } = twoParty();
    const firstY = doc.messages[0]!.y;
    const r = insertMessageAfter(doc, 'msg2', { kind: 'sync', from: a, to: b });

    expect(r.doc.messages.find((m) => m.id === 'msg1')!.y).toBe(firstY);
  });

  it('插入消息后，锚定在后续消息上的激活条跟着一起下移', () => {
    // B 在 msg2 上被激活；在 msg1 之后插一条，msg2 下移，激活条必须跟着
    const { doc, b, c } = twoParty();
    const withAct: Doc = {
      ...doc,
      activations: [{ id: 'act1', participant: b, startMessageId: 'msg2' }],
    };
    const beforeY = layout(withAct).activations[0]!.y;

    const r = insertMessageAfter(withAct, 'msg1', { kind: 'sync', from: b, to: c });
    const afterY = layout(r.doc).activations[0]!.y;

    expect(afterY).toBe(beforeY + withAct.theme.messageSpacing);
  });

  it('连续在末尾追加三条消息，纵向顺序与创建顺序一致', () => {
    let doc = twoParty().doc;
    const gap = doc.theme.messageSpacing;
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const r = insertMessageAfter(doc, doc.messages[doc.messages.length - 1]!.id, {
        kind: 'async',
        from: 'c1',
        to: doc.participants[0]!.id,
      });
      doc = r.doc;
      ids.push(r.id);
    }
    const tail = doc.messages.slice(-3).map((m) => m.id);
    expect(tail).toEqual(ids);
    // 间距均匀
    const ys = doc.messages.slice(-3).map((m) => m.y);
    expect(ys[1]! - ys[0]!).toBe(gap);
    expect(ys[2]! - ys[1]!).toBe(gap);
  });

  it('在只有两个参与者时，选中右边那个，邻居回退到左边', () => {
    const doc = createNewDoc('t');
    const [a, b] = doc.participants;
    const ends = resolveEndpoints(doc, { kind: 'participant', id: b!.id }, 'sync');
    expect(ends).toEqual({ from: b!.id, to: a!.id });
  });

  it('异步消息同样承接流向（不是只有同步消息才认得选中）', () => {
    const { doc, c } = twoParty();
    const ends = resolveEndpoints(doc, { kind: 'message', id: 'msg2' }, 'async');
    expect(ends!.from).toBe(c);
  });

  it('选中注释时不影响新消息的端点判断（注释不是时间轴上的东西）', () => {
    const { doc, a, b } = twoParty();
    // 界面层会把 note 选中映射成 {kind:'none'}，这里验证那个映射带来的结果
    const ends = resolveEndpoints(doc, { kind: 'none' }, 'sync');
    expect(ends).toEqual({ from: a, to: b });
  });
});

describe('串联验证：注释的完整生命周期', () => {
  it('按选中参与者创建 → 拖动 → 位置仍然是你拖到的地方', () => {
    const { doc, c } = twoParty();
    const place = notePlacement(doc, { kind: 'participant', id: c });
    let d: Doc = { ...doc, notes: [{ id: 'n1', text: '说明', ...place }] };

    // 模拟拖动：横向挪 300、纵向挪 120
    const n = d.notes[0]!;
    d = { ...d, notes: [{ ...n, x: n.x + 300, y: n.y + 120 }] };

    const g = layout(d).notes[0]!;
    expect(g.x).toBe(place.x + 300);
    expect(g.y).toBe(place.y + 120);
  });

  it('拖动后序列化再读回，位置依然是拖过的位置', () => {
    const { doc, c } = twoParty();
    const place = notePlacement(doc, { kind: 'participant', id: c });
    const d: Doc = { ...doc, notes: [{ id: 'n1', text: '说明', ...place, x: place.x + 210 }] };

    const back = JSON.parse(JSON.stringify(d)) as Doc;
    expect(layout(back).notes[0]!.x).toBe(place.x + 210);
  });

  it('参与者被删掉后，挂在它上面的注释仍然保留在原位（不消失、不跳走）', () => {
    const { doc, c } = twoParty();
    const place = notePlacement(doc, { kind: 'participant', id: c });
    const d: Doc = { ...doc, notes: [{ id: 'n1', text: '说明', ...place }] };

    const withoutC: Doc = {
      ...d,
      participants: d.participants.filter((p) => p.id !== c),
    };
    const g = layout(withoutC).notes[0]!;
    expect(g.x).toBe(place.x);
    expect(g.y).toBe(place.y);
  });
});

describe('回归：不能画出零长度的消息', () => {
  it('选中自调用后加返回消息，不会得到 from === to 的退化箭头', () => {
    const { doc, a } = twoParty();
    // 在第一个参与者上放一条自调用
    const self = addMessage(doc, { kind: 'self', from: a, to: a, label: '自处理', y: 400 });
    const d = self.doc;

    const ends = resolveEndpoints(d, { kind: 'message', id: self.id }, 'return')!;
    expect(ends.from).not.toBe(ends.to);
  });

  it('选中自调用后加自调用，仍然是自调用（这条本来就该相同）', () => {
    const { doc, a } = twoParty();
    const self = addMessage(doc, { kind: 'self', from: a, to: a, label: '自', y: 400 });
    const ends = resolveEndpoints(self.doc, { kind: 'message', id: self.id }, 'self')!;
    expect(ends.from).toBe(ends.to);
    expect(ends.from).toBe(a);
  });

  it('渲染出来确实有长度，不是压在生命线上的一个点', () => {
    const { doc, a, b } = twoParty();
    const self = addMessage(doc, { kind: 'self', from: a, to: a, label: '自', y: 400 });
    const ends = resolveEndpoints(self.doc, { kind: 'message', id: self.id }, 'return')!;
    const r = addMessage(self.doc, { kind: 'return', ...ends, y: 500 });

    const g = layout(r.doc).messages.find((m) => m.id === r.id)!;
    expect(Math.abs(g.x2 - g.x1)).toBeGreaterThan(20);
    // 两端各自落在一条生命线上
    const xs = layout(r.doc).lifelines.map((l) => l.x);
    expect(xs.some((x) => Math.abs(x - g.x1) < 20)).toBe(true);
    void b;
  });
});
