/**
 * 任务的筛选和计数。
 *
 * 这一层是「搜出来的东西对不对」的全部依据，所以断言直接打在**结果集**上：
 * 搜标题能中、搜描述能中、搜备注也能中，而**不该中的一条都不能漏进来**。
 */
import { describe, expect, it } from 'vitest';
import {
  countByStatus,
  EMPTY_FILTER,
  filterTasks,
  openCount,
} from '../../src/modules/tasks/core/filter';
import type { Task } from '../../src/modules/tasks/core/types';

function task(id: string, patch: Partial<Task> = {}): Task {
  return {
    id,
    title: `任务 ${id}`,
    body: '',
    note: '',
    status: 'todo',
    createdAt: 1000,
    updatedAt: 1000,
    doneAt: null,
    ...patch,
  };
}

const SAMPLE: Task[] = [
  task('a', { title: '写登录页', body: '手机号 + 验证码' }),
  task('b', { title: '修连接池泄漏', status: 'doing', note: '是那个定时器没清' }),
  task('c', { title: '画时序图', status: 'done', doneAt: 2000 }),
];

describe('筛选', () => {
  it('空筛选返回全部，且**顺序不变**（顺序是 SQL 定的）', () => {
    expect(filterTasks(SAMPLE, EMPTY_FILTER).map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });

  it('按状态筛', () => {
    expect(filterTasks(SAMPLE, { query: '', status: 'doing' }).map((t) => t.id)).toEqual(['b']);
    expect(filterTasks(SAMPLE, { query: '', status: 'done' }).map((t) => t.id)).toEqual(['c']);
  });

  it('搜标题', () => {
    expect(filterTasks(SAMPLE, { query: '登录', status: 'all' }).map((t) => t.id)).toEqual(['a']);
  });

  it('搜描述', () => {
    expect(filterTasks(SAMPLE, { query: '验证码', status: 'all' }).map((t) => t.id)).toEqual(['a']);
  });

  it('搜备注 —— 很多信息是做完之后才写进备注的', () => {
    expect(filterTasks(SAMPLE, { query: '定时器', status: 'all' }).map((t) => t.id)).toEqual(['b']);
  });

  it('大小写不敏感；两头空白不算词', () => {
    const withCode = [task('x', { title: 'Fix Pool Leak' })];
    expect(filterTasks(withCode, { query: 'pool', status: 'all' })).toHaveLength(1);
    expect(filterTasks(withCode, { query: '  pool  ', status: 'all' })).toHaveLength(1);
  });

  it('搜不到就是空的（不是「全返回」）', () => {
    expect(filterTasks(SAMPLE, { query: '不存在的词', status: 'all' })).toEqual([]);
  });

  it('状态和搜索**同时**生效（不是取并集）', () => {
    // 「写登录页」是 todo，按 done 筛就该没有它
    expect(filterTasks(SAMPLE, { query: '登录', status: 'done' })).toEqual([]);
  });
});

describe('计数', () => {
  it('按状态数', () => {
    expect(countByStatus(SAMPLE)).toEqual({ todo: 1, doing: 1, done: 1 });
  });

  it('「还没做完的」= 待办 + 进行中（角标上那个数）', () => {
    expect(openCount(SAMPLE)).toBe(2);
    expect(openCount([task('only-done', { status: 'done' })])).toBe(0);
  });

  it('一条都没有时全是 0', () => {
    expect(countByStatus([])).toEqual({ todo: 0, doing: 0, done: 0 });
  });
});
