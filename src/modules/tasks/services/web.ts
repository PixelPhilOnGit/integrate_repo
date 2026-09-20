/**
 * 浏览器端的任务客户端：**内存假实现**。
 *
 * 这不是「顺便支持一下浏览器」：headless 环境里起不了原生窗口，Playwright 只能
 * 驱动普通 Chromium 里的前端 —— 这个实现是整条自动化验证链路的前提。
 * 所以它要**和 Rust 那边一个语义**：
 *
 * * id 的形状（`task_<十六进制时间>_<序号>`）
 * * `updatedAt` 每次改动都往前走
 * * **patch 里没提到的字段一个都不动**（`null` 和「不动」是两件事）
 * * 状态改成 `done` 时记 `doneAt`，改回去清掉
 *
 * 最后一条尤其重要：`doneAt` 的规则只在界面上一闪而过，e2e 靠这个假实现才
 * 验得到；假实现要是「差不多就行」，真机上那条规则就从来没被验过。
 *
 * 数据只在内存里：刷新页面就没了。这是刻意的 —— e2e 每个用例都从干净状态开始
 * （真持久化不归这一层管，那是 Rust 集成测试的职责）。
 */

import type { Progress, Task, TaskPatch } from '../core/types';
import type { TasksClient } from './types';

/** 模块级的一份数据：同一页面里的多次调用共用（和真库一样） */
let tasks: Task[] = [];
/** 进度记录。按任务 id 分组（和真库里那张表是一个意思） */
let progress = new Map<string, Progress[]>();
let seq = 0;

function newId(now: number): string {
  seq += 1;
  return `task_${now.toString(16)}_${seq.toString(16)}`;
}

/** 让「最近改过的在前」在假实现里也成立：每次读都按 updatedAt 倒序 */
function sorted(): Task[] {
  return [...tasks].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function createWebTasksClient(): TasksClient {
  return {
    async list() {
      return sorted();
    },

    async create(title, body) {
      const trimmed = title.trim();
      if (trimmed === '') throw new Error('这条任务存不下去：标题不能是空的');

      const now = Date.now();
      const task: Task = {
        id: newId(now),
        title: trimmed,
        body,
        note: '',
        status: 'todo',
        createdAt: now,
        updatedAt: now,
        doneAt: null,
        archived: false,
      };
      tasks = [...tasks, task];
      return task;
    },

    async update(id, patch: TaskPatch) {
      const current = tasks.find((t) => t.id === id);
      if (current === undefined) throw new Error(`没有这条任务：${id}`);

      const next: Task = { ...current };
      if (patch.title !== undefined) {
        const trimmed = patch.title.trim();
        if (trimmed === '') throw new Error('这条任务存不下去：标题不能改成空的');
        next.title = trimmed;
      }
      if (patch.body !== undefined) next.body = patch.body;
      if (patch.note !== undefined) next.note = patch.note;
      if (patch.status !== undefined) {
        if (patch.status !== current.status) {
          next.doneAt = patch.status === 'done' ? Date.now() : null;
        }
        next.status = patch.status;
      }
      if (patch.archived !== undefined) next.archived = patch.archived;
      next.updatedAt = Date.now();

      tasks = tasks.map((t) => (t.id === id ? next : t));
      return next;
    },

    async remove(id) {
      const before = tasks.length;
      tasks = tasks.filter((t) => t.id !== id);
      // 进度跟着走（真库那边是 ON DELETE CASCADE，语义要一致）
      progress.delete(id);
      return tasks.length !== before;
    },

    async progressOf(taskId) {
      return [...(progress.get(taskId) ?? [])];
    },

    async addProgress(taskId, text) {
      const trimmed = text.trim();
      if (trimmed === '') throw new Error('这条任务存不下去：这一笔是空的');
      if (!tasks.some((t) => t.id === taskId)) throw new Error(`没有这条任务：${taskId}`);

      const now = Date.now();
      const entry: Progress = { id: newId(now), taskId, at: now, text: trimmed };
      progress.set(taskId, [...(progress.get(taskId) ?? []), entry]);
      // 真库那边记一笔会顶起 updated_at（列表按它排），这边跟上
      tasks = tasks.map((t) => (t.id === taskId ? { ...t, updatedAt: now } : t));
      return entry;
    },
  };
}

/** 只给测试用：把假库清空（e2e 之间互不影响） */
export function __resetTasksForTest(): void {
  tasks = [];
  progress = new Map();
  seq = 0;
}
