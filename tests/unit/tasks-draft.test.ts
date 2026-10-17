/**
 * 「刚建出来、还没动过」的空任务 —— 两处界面行为共用的判断（2026-10-15 体验评审）：
 *
 *   - 侧栏「新建」连点：已有一条这样的任务时选中它，而不是再落一条空库；
 *   - 标题框 Esc：这样一条任务被放弃时直接删掉。
 *
 * 判断错了的代价不对称：**多留一条空的**只是乱，**误删有内容的**是真丢数据 ——
 * 所以边界都往「不算空」那边倒（有进度/资料/改过名，一律不是草稿）。
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_TITLE, isFreshDraft } from '../../src/modules/tasks/core/draft';
import type { Task } from '../../src/modules/tasks/core/types';

function make(over: Partial<Task> = {}): Task {
  return {
    id: 't1',
    title: DEFAULT_TITLE,
    body: '',
    status: 'todo',
    createdAt: 0,
    updatedAt: 0,
    doneAt: null,
    archived: false,
    attachments: [],
    todos: [],
    ...over,
  };
}

describe('isFreshDraft', () => {
  it('默认标题 + 空描述 + 无资料 + 待办 = 空草稿', () => {
    expect(isFreshDraft(make())).toBe(true);
  });

  it('起了名字就不是了', () => {
    expect(isFreshDraft(make({ title: '买牛奶' }))).toBe(false);
  });

  it('写了描述就不是了', () => {
    expect(isFreshDraft(make({ body: '顺便买鸡蛋' }))).toBe(false);
  });

  it('挂了资料就不是了', () => {
    expect(
      isFreshDraft(make({ attachments: [{ id: 'a1', taskId: 't1', kind: 'text', text: 'x' } as never] }))
    ).toBe(false);
  });

  it('动过状态 / 归档过都不是', () => {
    expect(isFreshDraft(make({ status: 'doing' }))).toBe(false);
    expect(isFreshDraft(make({ status: 'done', doneAt: 1 }))).toBe(false);
    expect(isFreshDraft(make({ archived: true }))).toBe(false);
  });
});
