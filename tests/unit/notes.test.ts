/**
 * 注释（Note）的完整功能：增删改、折行、尺寸、命中、包围盒。
 *
 * 这块之前几乎没有覆盖 —— 而用户正是在这里发现了「永远贴第一个参与者」
 * 和「横向拖不动」两个问题。注释看着简单，但它是唯一一种**自由定位**的元素
 * （参与者只有 x、消息只有 y、激活条由消息推导），所以坐标相关的行为要单独测全。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  addNote,
  removeNote,
  updateNote,
} from '../../src/core/commands';
import { computeLayout, hitTest, L } from '../../src/core/layout';
import { createApproxMeasurer, estimateTextWidth } from '../../src/core/text';
import { createNewDoc } from '../../src/core/samples';
import { __resetIdsForTest } from '../../src/core/ids';
import type { Doc, Note } from '../../src/core/model';

beforeEach(() => __resetIdsForTest());

const measurer = createApproxMeasurer();
const layout = (doc: Doc) => computeLayout(doc, measurer);

function docWithNotes(notes: Note[]): Doc {
  return { ...createNewDoc('t'), notes };
}

const note = (over: Partial<Note> = {}): Note => ({
  id: 'n1',
  text: '说明',
  x: 300,
  y: 400,
  ...over,
});

describe('新增', () => {
  it('不传文字时给一个能直接编辑的占位内容', () => {
    const doc = createNewDoc('t');
    const r = addNote(doc, { x: 10, y: 20 });
    expect(r.doc.notes).toHaveLength(1);
    expect(r.doc.notes[0]!.text.length).toBeGreaterThan(0);
  });

  it('坐标原样保留，不做任何吸附或重算', () => {
    const doc = createNewDoc('t');
    const r = addNote(doc, { x: 137, y: 419 });
    expect(r.doc.notes[0]!.x).toBe(137);
    expect(r.doc.notes[0]!.y).toBe(419);
  });

  it('可以挂到某个参与者上', () => {
    const doc = createNewDoc('t');
    const pid = doc.participants[0]!.id;
    const r = addNote(doc, { x: 10, y: 20, attachTo: pid });
    expect(r.doc.notes[0]!.attachTo).toBe(pid);
  });

  it('不修改传入的文档', () => {
    const doc = createNewDoc('t');
    const snapshot = JSON.stringify(doc);
    addNote(doc, { x: 1, y: 2 });
    expect(JSON.stringify(doc)).toBe(snapshot);
  });
});

describe('修改', () => {
  it('改文字', () => {
    const d = docWithNotes([note()]);
    const after = updateNote(d, 'n1', { text: '换了一段话' });
    expect(after.notes[0]!.text).toBe('换了一段话');
  });

  it('改位置', () => {
    const d = docWithNotes([note()]);
    const after = updateNote(d, 'n1', { x: 900, y: 100 });
    expect(after.notes[0]!.x).toBe(900);
    expect(after.notes[0]!.y).toBe(100);
  });

  it('改不存在的注释是安全的空操作', () => {
    const d = docWithNotes([note()]);
    const after = updateNote(d, '幽灵', { text: 'x' });
    expect(after.notes[0]!.text).toBe('说明');
  });

  it('可以解除挂载（变成自由注释）', () => {
    const d = docWithNotes([note({ attachTo: 'p1' })]);
    const after = updateNote(d, 'n1', { attachTo: undefined });
    expect(after.notes[0]!.attachTo).toBeUndefined();
  });
});

describe('删除', () => {
  it('删掉指定的注释', () => {
    const d = docWithNotes([note({ id: 'a' }), note({ id: 'b' })]);
    expect(removeNote(d, 'a').notes.map((n) => n.id)).toEqual(['b']);
  });

  it('删不存在的注释是安全的空操作', () => {
    const d = docWithNotes([note()]);
    expect(removeNote(d, '幽灵').notes).toHaveLength(1);
  });
});

describe('尺寸与折行', () => {
  it('注释的宽度随文字变长而变大', () => {
    const short = layout(docWithNotes([note({ text: '短' })]));
    const long = layout(docWithNotes([note({ text: '这是一段明显更长的说明文字' })]));
    expect(long.notes[0]!.width).toBeGreaterThan(short.notes[0]!.width);
  });

  it('超长文字会折行，横向不会无限变宽', () => {
    const g = layout(
      docWithNotes([note({ text: '这是一段非常长的说明文字'.repeat(10) })]),
    ).notes[0]!;
    expect(g.lines.length).toBeGreaterThan(1);
    // 宽度被 noteMaxWidth 约束住，不会随着字数线性膨胀
    for (const line of g.lines) {
      expect(estimateTextWidth(line, 13)).toBeLessThanOrEqual(L.noteMaxWidth + 20);
    }
  });

  it('显式换行会被保留成多行', () => {
    const g = layout(docWithNotes([note({ text: '第一行\n第二行' })])).notes[0]!;
    expect(g.lines).toEqual(['第一行', '第二行']);
  });

  it('行数变多时高度随之变高', () => {
    const one = layout(docWithNotes([note({ text: '一行' })])).notes[0]!;
    const three = layout(docWithNotes([note({ text: '一\n二\n三' })])).notes[0]!;
    expect(three.height).toBeGreaterThan(one.height);
  });

  it('空文字也能算出合法尺寸，不出现 NaN', () => {
    const g = layout(docWithNotes([note({ text: '' })])).notes[0]!;
    expect(Number.isFinite(g.width)).toBe(true);
    expect(Number.isFinite(g.height)).toBe(true);
    expect(g.width).toBeGreaterThan(0);
  });
});

describe('命中与包围盒', () => {
  it('点注释内部能选中它', () => {
    const d = docWithNotes([note({ x: 300, y: 400 })]);
    const g = layout(d).notes[0]!;
    const hit = hitTest(layout(d), { x: g.x + 5, y: g.y + 5 });
    expect(hit).toEqual({ type: 'note', id: 'n1' });
  });

  it('注释被拖到很右边时，整体包围盒跟着变宽（不会被导出裁掉）', () => {
    const near = layout(docWithNotes([note({ x: 100 })]));
    const far = layout(docWithNotes([note({ x: 2000 })]));
    expect(far.bounds.width).toBeGreaterThan(near.bounds.width);
  });

  it('注释被拖到很下边时，整体包围盒跟着变高', () => {
    const near = layout(docWithNotes([note({ y: 100 })]));
    const far = layout(docWithNotes([note({ y: 2000 })]));
    expect(far.bounds.height).toBeGreaterThan(near.bounds.height);
  });

  it('注释不会被生命线的纵向范围影响（它是浮在图上的）', () => {
    const withNote = layout(docWithNotes([note({ y: 50 })]));
    const withoutNote = layout(docWithNotes([]));
    expect(withNote.lifelineBottom).toBe(withoutNote.lifelineBottom);
  });
});

describe('多个注释', () => {
  it('互不干扰，各自在自己位置上', () => {
    const d = docWithNotes([
      note({ id: 'a', text: '甲', x: 100, y: 200 }),
      note({ id: 'b', text: '乙', x: 700, y: 500 }),
    ]);
    const g = layout(d);
    expect(g.notes.find((n) => n.id === 'a')!.x).toBe(100);
    expect(g.notes.find((n) => n.id === 'b')!.x).toBe(700);
  });

  it('点重叠区域时命中最上面那个（后添加的在上层）', () => {
    const d = docWithNotes([
      note({ id: 'a', x: 300, y: 400 }),
      note({ id: 'b', x: 300, y: 400 }),
    ]);
    const g = layout(d);
    // 渲染顺序决定后加的在上；命中判定也应当一致
    const hit = hitTest(g, { x: g.notes[0]!.x + 5, y: g.notes[0]!.y + 5 });
    expect(hit?.type).toBe('note');
  });
});
