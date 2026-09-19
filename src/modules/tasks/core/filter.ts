/**
 * 筛选与计数：**纯函数**，不碰 DOM、不碰服务层。
 *
 * 任务一次全读进内存（几千条的量级），筛选在本地做 —— 所以这一层能被单测
 * 盖满，而「搜出来的东西不对」这类问题**不用开界面就能钉住**。
 *
 * # 顺序
 *
 * **不重排**：Rust 那边已经按「最近改过的在前」排好了，筛选只负责剔掉不该
 * 出现的。在这一层再排一次的话，两边的规则迟早会不一致（而且「最近改过的」
 * 这个语义在排序和写入之间来回跳会显得列表自己在动）。
 */

import type { Task, TaskStatus } from './types';

/** `all` = 不按状态筛 */
export type StatusFilter = TaskStatus | 'all';

export interface TaskFilter {
  /** 在标题和描述里找（大小写不敏感的**子串**匹配）。空串 = 不筛 */
  query: string;
  status: StatusFilter;
}

export const EMPTY_FILTER: TaskFilter = { query: '', status: 'all' };

/**
 * 按筛选条件挑出该显示的任务。
 *
 * 匹配用的是**子串**而不是模糊子序列：任务标题是用户自己写的中文短语，
 * 「子串」正好是他心里那个意思（搜「登录」就出「写登录页」）。模糊匹配留给
 * 连接列表那种「名字很长、要缩写搜」的场景（那是另一套匹配器）。
 */
export function filterTasks(tasks: readonly Task[], filter: TaskFilter): Task[] {
  const needle = filter.query.trim().toLowerCase();

  return tasks.filter((task) => {
    if (filter.status !== 'all' && task.status !== filter.status) return false;
    if (needle === '') return true;

    return (
      task.title.toLowerCase().includes(needle) ||
      task.body.toLowerCase().includes(needle) ||
      // 备注也搜：很多信息是做完之后才写进备注的（「那次是因为 X 才挂的」），
      // 而下次要找的正是那一句
      task.note.toLowerCase().includes(needle)
    );
  });
}

/** 各状态几条。侧栏的筛选器上显示，也是模块角标的来源 */
export function countByStatus(tasks: readonly Task[]): Record<TaskStatus, number> {
  const counts: Record<TaskStatus, number> = { todo: 0, doing: 0, done: 0 };
  for (const task of tasks) counts[task.status] += 1;
  return counts;
}

/** 「还没做完的」有几条 —— 模块角标上那个数 */
export function openCount(tasks: readonly Task[]): number {
  const counts = countByStatus(tasks);
  return counts.todo + counts.doing;
}
