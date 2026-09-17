import { beforeEach, describe, expect, it } from 'vitest';
import { History } from '../../src/shared/history';
import { addMessage, addParticipant, moveParticipant } from '../../src/modules/diagram/core/commands';
import { __resetIdsForTest } from '../../src/shared/ids';
import { createNewDoc } from '../../src/modules/diagram/core/samples';
import { defaultTheme } from '../../src/modules/diagram/core/theme';
import type { Doc } from '../../src/modules/diagram/core/model';

beforeEach(() => __resetIdsForTest());

const mk = () => new History(createNewDoc('t', defaultTheme()));

describe('离散操作', () => {
  it('apply 之后可以撤销回原状', () => {
    const h = mk();
    const before = h.value.participants.length;

    const next = addParticipant(h.value, { name: '新' }).doc;
    h.apply(next);
    expect(h.value.participants.length).toBe(before + 1);
    expect(h.canUndo).toBe(true);

    h.undo();
    expect(h.value.participants.length).toBe(before);
    expect(h.canRedo).toBe(true);

    h.redo();
    expect(h.value.participants.length).toBe(before + 1);
  });

  it('没有变化时 apply 不入栈', () => {
    const h = mk();
    h.apply(h.value);
    expect(h.canUndo).toBe(false);
  });

  it('连续撤销能回到最初状态', () => {
    const h = mk();
    const initial = h.value;
    for (let i = 0; i < 5; i += 1) {
      h.apply(addParticipant(h.value, { name: `P${i}` }).doc);
    }
    while (h.canUndo) h.undo();
    expect(h.value).toBe(initial);
  });

  it('撤销后再做新操作会清空重做栈', () => {
    const h = mk();
    h.apply(addParticipant(h.value, { name: 'A' }).doc);
    h.undo();
    expect(h.canRedo).toBe(true);
    h.apply(addParticipant(h.value, { name: 'B' }).doc);
    expect(h.canRedo).toBe(false);
  });

  it('撤销到底后再撤销是安全的空操作', () => {
    const h = mk();
    const before = h.value;
    h.undo();
    h.undo();
    expect(h.value).toBe(before);
  });
});

describe('拖拽', () => {
  it('拖拽过程中的预览不进历史，松手才记一次', () => {
    const h = mk();
    const pid = h.value.participants[0]!.id;
    const startX = h.value.participants[0]!.x;
    const depthBefore = countUndo(h);

    h.beginDrag();
    // 模拟 100 次鼠标移动
    for (let i = 1; i <= 100; i += 1) {
      h.preview(moveParticipant(h.value, pid, startX + i));
    }
    // 拖拽中撤销栈没有变化
    expect(countUndo(h)).toBe(depthBefore);

    h.endDrag();
    expect(countUndo(h)).toBe(depthBefore + 1);

    // 一次撤销就回到拖拽前，而不是退 100 步
    h.undo();
    expect(h.value.participants[0]!.x).toBe(startX);
  });

  it('拖拽没有实际位移时不记历史', () => {
    const h = mk();
    const before = countUndo(h);
    h.beginDrag();
    h.preview(h.value);
    h.endDrag();
    expect(countUndo(h)).toBe(before);
  });

  it('cancelDrag 回到拖拽起点且不留历史', () => {
    const h = mk();
    const pid = h.value.participants[0]!.id;
    const startX = h.value.participants[0]!.x;
    const before = countUndo(h);

    h.beginDrag();
    h.preview(moveParticipant(h.value, pid, startX + 300));
    h.cancelDrag();

    expect(h.value.participants[0]!.x).toBe(startX);
    expect(countUndo(h)).toBe(before);
  });

  it('嵌套 beginDrag 不会覆盖起点', () => {
    const h = mk();
    const pid = h.value.participants[0]!.id;
    const startX = h.value.participants[0]!.x;

    h.beginDrag();
    h.preview(moveParticipant(h.value, pid, startX + 10));
    h.beginDrag(); // 重复调用应当无效果
    h.preview(moveParticipant(h.value, pid, startX + 20));
    h.endDrag();

    h.undo();
    expect(h.value.participants[0]!.x).toBe(startX);
  });
});

describe('换文档', () => {
  it('reset 清空历史，避免撤销穿越到另一个文件', () => {
    const h = mk();
    h.apply(addParticipant(h.value, { name: 'A' }).doc);
    h.apply(addParticipant(h.value, { name: 'B' }).doc);
    expect(h.canUndo).toBe(true);

    const another = createNewDoc('另一个', defaultTheme());
    h.reset(another);

    expect(h.canUndo).toBe(false);
    expect(h.canRedo).toBe(false);
    expect(h.value).toBe(another);
  });
});

describe('撤销栈上限', () => {
  it('超过上限后丢弃最早的记录，不会无限增长', () => {
    const h = mk();
    for (let i = 0; i < 260; i += 1) {
      h.apply(addMessage(h.value, {
        kind: 'async',
        from: h.value.participants[0]!.id,
        to: h.value.participants[1]!.id,
        label: `m${i}`,
        y: 200 + i * 10,
      }).doc);
    }
    // 仍然能撤销，但栈深被限制住了
    expect(h.canUndo).toBe(true);
    let steps = 0;
    while (h.canUndo && steps < 1000) {
      h.undo();
      steps += 1;
    }
    expect(steps).toBeLessThanOrEqual(200);
  });
});

const countUndo = (h: History<Doc>): number => h.undoDepth;
