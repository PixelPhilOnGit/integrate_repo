/**
 * 视口（缩放/平移）与选择状态。
 *
 * 缩放的边界夹取和"缩放时锚点不动"是这个模块最容易出错的地方：
 * 前者出错会导致把图缩到看不见或放到失真，后者出错会让用户缩放时
 * 想看的那个点跑出屏幕 —— 这两个之前都没有测试。
 *
 * 另外这一组还覆盖"选中状态驱动的新增行为"，也就是用户报的那几个问题
 * 在 store 层的表现（端点解析 + 插入位置 + 新元素自动选中）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppStore, FIT_PADDING, MAX_ZOOM, MIN_ZOOM } from '../../src/state/store';
import { __resetIdsForTest } from '../../src/core/ids';

beforeEach(() => {
  __resetIdsForTest();
  // store 的 commit 会排一个 900ms 的自动保存定时器；用假定时器挡住，
  // 否则测试跑完定时器触发会去调平台层的存储接口
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const mk = () => new AppStore();

describe('视口默认值', () => {
  it('初始为 100% 且没有平移', () => {
    const vp = mk().getSnapshot().viewport;
    expect(vp).toEqual({ zoom: 1, panX: 0, panY: 0 });
  });

  it('局部更新：只改缩放时平移量保持不变', () => {
    const s = mk();
    s.setViewport({ panX: 40, panY: 60 });
    s.setViewport({ zoom: 1.5 });
    expect(s.getSnapshot().viewport).toEqual({ zoom: 1.5, panX: 40, panY: 60 });
  });

  it('局部更新：只改平移时缩放保持不变', () => {
    const s = mk();
    s.setViewport({ zoom: 2 });
    s.setViewport({ panX: 10 });
    expect(s.getSnapshot().viewport).toEqual({ zoom: 2, panX: 10, panY: 0 });
  });
});

describe('缩放边界夹取', () => {
  it('不会缩到比下限还小', () => {
    const s = mk();
    s.setViewport({ zoom: 0.0001 });
    expect(s.getSnapshot().viewport.zoom).toBe(MIN_ZOOM);
  });

  it('不会放到比上限还大', () => {
    const s = mk();
    s.setViewport({ zoom: 999 });
    expect(s.getSnapshot().viewport.zoom).toBe(MAX_ZOOM);
  });

  it('连续滚轮缩小到极限后停住，不会变成 0 或负数', () => {
    const s = mk();
    for (let i = 0; i < 40; i += 1) s.zoomAt(1 / 1.2, 400, 300);
    const z = s.getSnapshot().viewport.zoom;
    expect(z).toBe(MIN_ZOOM);
    expect(z).toBeGreaterThan(0);
  });

  it('连续滚轮放大到极限后停住', () => {
    const s = mk();
    for (let i = 0; i < 40; i += 1) s.zoomAt(1.2, 400, 300);
    expect(s.getSnapshot().viewport.zoom).toBe(MAX_ZOOM);
  });
});

describe('以鼠标位置为锚点缩放', () => {
  it('缩放后锚点下方的图内容停在原地', () => {
    const s = mk();
    s.setViewport({ zoom: 1, panX: 100, panY: 50 });
    const viewX = 300;
    const viewY = 200;

    const before = s.getSnapshot().viewport;
    const docX = before.panX + viewX / before.zoom;
    const docY = before.panY + viewY / before.zoom;

    s.zoomAt(2, viewX, viewY);

    const after = s.getSnapshot().viewport;
    // 同一个文档坐标，缩放后映射回屏幕应当是同一个点
    const screenX = (docX - after.panX) * after.zoom;
    const screenY = (docY - after.panY) * after.zoom;
    expect(screenX).toBeCloseTo(viewX, 6);
    expect(screenY).toBeCloseTo(viewY, 6);
  });

  it('缩小同样保持锚点不动', () => {
    const s = mk();
    s.setViewport({ zoom: 2, panX: -50, panY: -30 });
    const viewX = 120;
    const viewY = 480;
    const before = s.getSnapshot().viewport;
    const docX = before.panX + viewX / before.zoom;

    s.zoomAt(0.5, viewX, viewY);

    const after = s.getSnapshot().viewport;
    expect((docX - after.panX) * after.zoom).toBeCloseTo(viewX, 6);
  });

  it('已经在极限上时不再改变视口', () => {
    const s = mk();
    s.setViewport({ zoom: MAX_ZOOM });
    const before = s.getSnapshot().viewport;
    s.zoomAt(2, 100, 100);
    expect(s.getSnapshot().viewport).toEqual(before);
  });
});

describe('适应窗口', () => {
  const bounds = { x: 0, y: 0, width: 800, height: 600 };

  it('整张图落在视口内并留出边距', () => {
    const s = mk();
    s.fitTo(1000, 800, bounds);
    const { zoom, panX, panY } = s.getSnapshot().viewport;

    const left = (bounds.x - panX) * zoom;
    const top = (bounds.y - panY) * zoom;
    const right = (bounds.x + bounds.width - panX) * zoom;
    const bottom = (bounds.y + bounds.height - panY) * zoom;

    expect(left).toBeGreaterThanOrEqual(FIT_PADDING - 1);
    expect(top).toBeGreaterThanOrEqual(FIT_PADDING - 1);
    expect(right).toBeLessThanOrEqual(1000 - FIT_PADDING + 1);
    expect(bottom).toBeLessThanOrEqual(800 - FIT_PADDING + 1);
  });

  it('小图不会被放得太大（上限 125%）', () => {
    const s = mk();
    s.fitTo(2000, 2000, { x: 0, y: 0, width: 100, height: 80 });
    expect(s.getSnapshot().viewport.zoom).toBeLessThanOrEqual(1.25);
  });

  it('超大图不会被缩到看不见（下限 25%）', () => {
    const s = mk();
    s.fitTo(400, 300, { x: 0, y: 0, width: 100000, height: 100000 });
    expect(s.getSnapshot().viewport.zoom).toBe(MIN_ZOOM);
  });

  it('内容从非零坐标开始时也能正确对齐', () => {
    const s = mk();
    s.fitTo(800, 600, { x: -500, y: 120, width: 400, height: 300 });
    const { zoom, panX } = s.getSnapshot().viewport;
    expect((-500 - panX) * zoom).toBeCloseTo(FIT_PADDING, 4);
  });

  it('尺寸非法时保持原样，不产生 NaN 视口', () => {
    const s = mk();
    const before = s.getSnapshot().viewport;
    s.fitTo(0, 0, bounds);
    s.fitTo(800, 600, { x: 0, y: 0, width: 0, height: 0 });
    expect(s.getSnapshot().viewport).toEqual(before);
  });
});

describe('选择状态', () => {
  it('选中元素会同时退出内联编辑', () => {
    const s = mk();
    const p = s.getSnapshot().doc.participants[0]!;
    s.startEditing({ type: 'participant', id: p.id });
    expect(s.getSnapshot().editing).not.toBeNull();

    s.select({ type: 'message', id: 'x' });
    expect(s.getSnapshot().editing).toBeNull();
  });

  it('开始编辑会顺带选中那个元素', () => {
    const s = mk();
    const p = s.getSnapshot().doc.participants[0]!;
    s.startEditing({ type: 'participant', id: p.id });
    expect(s.getSnapshot().selection).toEqual({ type: 'participant', id: p.id });
  });

  it('结束编辑不会丢掉选中状态', () => {
    const s = mk();
    const p = s.getSnapshot().doc.participants[0]!;
    s.startEditing({ type: 'participant', id: p.id });
    s.stopEditing();
    expect(s.getSnapshot().editing).toBeNull();
    expect(s.getSnapshot().selection).toEqual({ type: 'participant', id: p.id });
  });
});

// ---------------------------------------------------------------------------
// 选中驱动的新增行为 —— 用户报的"为啥都在第一个主体上面"在 store 层的表现
// ---------------------------------------------------------------------------

describe('新增消息跟随选中', () => {
  it('什么都没选时，还是默认的最左发给次左', () => {
    const s = mk();
    const [a, b] = s.getSnapshot().doc.participants;
    s.addMessage('sync');
    const m = s.getSnapshot().doc.messages[0]!;
    expect(m.from).toBe(a!.id);
    expect(m.to).toBe(b!.id);
  });

  it('选中第二个参与者后加自调用 → 落在它身上，不是第一个', () => {
    const s = mk();
    const [a, b] = s.getSnapshot().doc.participants;
    s.select({ type: 'participant', id: b!.id });
    s.addMessage('self');

    const m = s.getSnapshot().doc.messages[0]!;
    expect(m.from).toBe(b!.id);
    expect(m.to).toBe(b!.id);
    expect(m.from).not.toBe(a!.id);
  });

  it('选中参与者后加同步消息 → 以它为发送方', () => {
    const s = mk();
    const [a, b] = s.getSnapshot().doc.participants;
    s.select({ type: 'participant', id: b!.id });
    s.addMessage('sync');

    const m = s.getSnapshot().doc.messages[0]!;
    expect(m.from).toBe(b!.id);
    expect(m.to).toBe(a!.id); // 右边没有了，取左边
  });

  it('选中一条消息后加消息 → 插在它后面，而不是追加到末尾', () => {
    const s = mk();
    s.addMessage('sync');
    const first = s.getSnapshot().doc.messages[0]!;
    s.select({ type: 'none' });
    s.addMessage('sync');
    const second = s.getSnapshot().doc.messages[1]!;

    // 现在选中第一条，在它后面插入
    s.select({ type: 'message', id: first.id });
    s.addMessage('async');

    const msgs = s.getSnapshot().doc.messages;
    expect(msgs).toHaveLength(3);
    expect(msgs[0]!.id).toBe(first.id);
    expect(msgs[2]!.id).toBe(second.id);
    // 中间就是新插入的那条
    expect(msgs[1]!.id).not.toBe(second.id);
    expect(msgs[1]!.y).toBeGreaterThan(msgs[0]!.y);
    expect(msgs[1]!.y).toBeLessThan(msgs[2]!.y);
  });

  it('新增后自动选中新元素，方便紧接着改属性', () => {
    const s = mk();
    s.addMessage('sync');
    const m = s.getSnapshot().doc.messages[0]!;
    expect(s.getSnapshot().selection).toEqual({ type: 'message', id: m.id });
  });

  it('新增参与者后自动选中它', () => {
    const s = mk();
    s.addParticipant('actor');
    const last = s.getSnapshot().doc.participants.at(-1)!;
    expect(s.getSnapshot().selection).toEqual({ type: 'participant', id: last.id });
  });

  it('没有参与者时给出提示而不是崩溃', () => {
    const s = mk();
    const doc = s.getSnapshot().doc;
    s.select({ type: 'none' });
    // 手动清空参与者
    for (const p of doc.participants) {
      s.select({ type: 'participant', id: p.id });
      s.deleteSelection();
    }
    s.addMessage('sync');
    expect(s.getSnapshot().error).toBeTruthy();
  });
});

describe('新增注释跟随选中', () => {
  it('选中参与者后加注释 → 放在它旁边并挂到它身上', () => {
    const s = mk();
    const b = s.getSnapshot().doc.participants[1]!;
    s.select({ type: 'participant', id: b.id });
    s.addNote();

    const n = s.getSnapshot().doc.notes[0]!;
    expect(n.attachTo).toBe(b.id);
    expect(n.x).toBeGreaterThan(b.x);
  });

  it('选中消息后加注释 → 纵向贴着那条消息', () => {
    const s = mk();
    s.addMessage('sync');
    const m = s.getSnapshot().doc.messages[0]!;
    s.select({ type: 'message', id: m.id });
    s.addNote();

    expect(s.getSnapshot().doc.notes[0]!.y).toBe(m.y);
  });

  it('什么都没选但点过画布 → 放在鼠标点过的位置', () => {
    const s = mk();
    s.lastPointer = { x: 654, y: 321 };
    s.select({ type: 'none' });
    s.addNote();

    expect(s.getSnapshot().doc.notes[0]!.x).toBe(654);
    expect(s.getSnapshot().doc.notes[0]!.y).toBe(321);
  });

  it('连加两个注释不会叠在同一个点上', () => {
    const s = mk();
    s.select({ type: 'none' });
    s.lastPointer = null;
    s.addNote();
    const first = s.getSnapshot().doc.notes[0]!;
    s.select({ type: 'none' });
    s.addNote();
    const second = s.getSnapshot().doc.notes[1]!;
    expect(second.y).not.toBe(first.y);
  });

  it('新增后进入编辑态，可以直接打字', () => {
    const s = mk();
    s.addNote();
    const n = s.getSnapshot().doc.notes[0]!;
    expect(s.getSnapshot().editing).toEqual({ type: 'note', id: n.id });
  });
});

describe('删除与撤销的联动', () => {
  it('删除选中元素后，选中状态被清空', () => {
    const s = mk();
    s.addParticipant('actor');
    s.deleteSelection();
    expect(s.getSnapshot().selection).toEqual({ type: 'none' });
  });

  it('删除后可以撤销回来', () => {
    const s = mk();
    const before = s.getSnapshot().doc.participants.length;
    s.addParticipant('actor');
    s.deleteSelection();
    expect(s.getSnapshot().doc.participants).toHaveLength(before);

    s.undo();
    expect(s.getSnapshot().doc.participants).toHaveLength(before + 1);
  });

  it('修改后标记为脏（提示未保存）', () => {
    const s = mk();
    expect(s.getSnapshot().dirty).toBe(false);
    s.addParticipant('actor');
    expect(s.getSnapshot().dirty).toBe(true);
  });

  it('撤销后仍然标记为脏（磁盘上还是旧内容）', () => {
    const s = mk();
    s.addParticipant('actor');
    s.undo();
    expect(s.getSnapshot().dirty).toBe(true);
  });
});
