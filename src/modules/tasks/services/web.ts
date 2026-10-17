/**
 * 浏览器端的任务客户端：**内存假实现**。
 *
 * 这不是「顺便支持一下浏览器」：headless 环境里起不了原生窗口，Playwright 只能
 * 驱动普通 Chromium 里的前端 —— 这个实现是整条自动化验证链路的前提。
 * 所以它要**和 Rust 那边一个语义**：
 *
 * * id 的形状（`task_<十六进制时间>_<序号>`，资料是 `att_…`，进度是 `prog_…`）
 * * `updatedAt` 每次改动都往前走（加/删/改资料也算「动过它」，同 Rust 侧的 touch）
 * * **patch 里没提到的字段一个都不动**（`null` 和「不动」是两件事）
 * * 状态改成 `done` 时记 `doneAt`，改回去清掉
 * * 资料内嵌在任务里一起回来；删任务资料跟着走（真库那边是外键级联）
 * * 文件资料的「字节」返回真正的 1×1 PNG（ArrayBuffer）
 *
 * 最后几条尤其重要：`doneAt` 的规则、资料的语义都只在界面上一闪而过，
 * e2e 靠这个假实现才验得到；假实现要是「差不多就行」，真机上那些规则就
 * 从来没被验过。
 *
 * ⚠️ **挂文件的系统对话框这里没有，也不假装有**：那是 Rust 侧的事（路径不过
 * IPC，见 `task_commands.rs` 的模块头），浏览器里根本开不出来。点击「加文件」
 * 直接造一条**假资料**（「示例截图.png」+ 真 PNG 字节）—— e2e 验证的是**界面
 * 链路**（条目的出现、缩略图、打开大图、删除），不是对话框本身。
 *
 * 数据只在内存里：刷新页面就没了。这是刻意的 —— e2e 每个用例都从干净状态开始
 * （真持久化不归这一层管，那是 Rust 集成测试的职责）。
 */

import type { Attachment, Progress, Task, TaskPatch, TodoItem } from '../core/types';
import type { TasksClient } from './types';

/** 模块级的一份数据：同一页面里的多次调用共用（和真库一样） */
let tasks: Task[] = [];
/** 进度记录。按任务 id 分组（和真库里那张表是一个意思） */
let progress = new Map<string, Progress[]>();
let seq = 0;

function newId(prefix: string, now: number): string {
  seq += 1;
  return `${prefix}_${now.toString(16)}_${seq.toString(16)}`;
}

/** 让「最近改过的在前」在假实现里也成立：每次读都按 updatedAt 倒序 */
function sorted(): Task[] {
  return [...tasks].sort((a, b) => b.updatedAt - a.updatedAt);
}

/** 动过它（同 Rust 侧的 `touch`）：列表按 updatedAt 排，动完该冒头 */
function touch(taskId: string, now: number): void {
  tasks = tasks.map((t) => (t.id === taskId ? { ...t, updatedAt: now } : t));
}

/** 在所有任务里找一条资料（及它挂在谁身上） */
function findAttachment(id: string): { task: Task; att: Attachment } | null {
  for (const task of tasks) {
    const att = task.attachments.find((a) => a.id === id);
    if (att !== undefined) return { task, att };
  }
  return null;
}

/**
 * 1×1 的透明 PNG（67 字节）—— 浏览器版「挂文件」时当文件内容用。
 * 是真的 PNG 字节，`<img src=blob:…>` 渲染得出来，e2e 能把缩略图那段走完。
 */
const FAKE_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
  0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f,
  0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00,
  0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
  0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

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
        id: newId('task', now),
        title: trimmed,
        body,
        status: 'todo',
        createdAt: now,
        updatedAt: now,
        doneAt: null,
        archived: false,
        attachments: [],
        todos: [],
      };
      tasks = [...tasks, task];
      return task;
    },

    async update(id, patch: TaskPatch) {
      const current = tasks.find((t) => t.id === id);
      if (current === undefined) throw new Error(`没有这条记录：${id}`);

      const next: Task = { ...current };
      if (patch.title !== undefined) {
        const trimmed = patch.title.trim();
        if (trimmed === '') throw new Error('这条任务存不下去：标题不能改成空的');
        next.title = trimmed;
      }
      if (patch.body !== undefined) next.body = patch.body;
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
      // 资料内嵌在任务里，任务一走它们跟着走（真库那边是 ON DELETE CASCADE，
      // 语义要一致）
      tasks = tasks.filter((t) => t.id !== id);
      progress.delete(id);
      return tasks.length !== before;
    },

    async progressOf(taskId) {
      return [...(progress.get(taskId) ?? [])];
    },

    async addProgress(taskId, text) {
      const trimmed = text.trim();
      if (trimmed === '') throw new Error('这条任务存不下去：这一笔是空的');
      if (!tasks.some((t) => t.id === taskId)) throw new Error(`没有这条记录：${taskId}`);

      const now = Date.now();
      const entry: Progress = { id: newId('prog', now), taskId, at: now, text: trimmed };
      progress.set(taskId, [...(progress.get(taskId) ?? []), entry]);
      // 真库那边记一笔会顶起 updated_at（列表按它排），这边跟上
      touch(taskId, now);
      return entry;
    },

    // -------------------------------------------------------------- 待办项

    async addTodo(taskId, text) {
      const trimmed = text.trim();
      if (trimmed === '') throw new Error('待办内容不能是空的');
      const task = tasks.find((t) => t.id === taskId);
      if (!task) throw new Error(`没有这条记录：${taskId}`);

      const now = Date.now();
      const item: TodoItem = {
        id: newId('todo', now),
        taskId,
        text: trimmed,
        done: false,
        createdAt: now,
        doneAt: null,
      };
      task.todos = [...task.todos, item];
      touch(taskId, now);
      return item;
    },

    async setTodoDone(id, done) {
      for (const task of tasks) {
        const item = task.todos.find((t) => t.id === id);
        if (!item) continue;
        const now = Date.now();
        item.done = done;
        // 取消勾选把 doneAt 清回去（和 Rust 侧一字不差）
        item.doneAt = done ? now : null;
        touch(task.id, now);
        return { ...item };
      }
      throw new Error(`没有这条待办：${id}`);
    },

    async updateTodoText(id, text) {
      const trimmed = text.trim();
      if (trimmed === '') throw new Error('待办内容不能是空的');
      for (const task of tasks) {
        const item = task.todos.find((t) => t.id === id);
        if (!item) continue;
        item.text = trimmed;
        touch(task.id, Date.now());
        return { ...item };
      }
      throw new Error(`没有这条待办：${id}`);
    },

    async removeTodo(id) {
      for (const task of tasks) {
        const before = task.todos.length;
        task.todos = task.todos.filter((t) => t.id !== id);
        if (task.todos.length !== before) {
          touch(task.id, Date.now());
          return;
        }
      }
      throw new Error(`没有这条待办：${id}`);
    },

    // -------------------------------------------------------------- 资料

    async addTextAttachment(taskId, text) {
      const trimmed = text.trim();
      if (trimmed === '') throw new Error('这条任务存不下去：这一条是空的');
      if (!tasks.some((t) => t.id === taskId)) throw new Error(`没有这条记录：${taskId}`);

      const now = Date.now();
      const att: Attachment = {
        id: newId('att', now),
        taskId,
        kind: 'text',
        text: trimmed,
        fileName: '',
        fileSize: 0,
        createdAt: now,
      };
      tasks = tasks.map((t) =>
        t.id === taskId ? { ...t, attachments: [...t.attachments, att], updatedAt: now } : t,
      );
      return att;
    },

    async addFileAttachment(taskId) {
      if (!tasks.some((t) => t.id === taskId)) throw new Error(`没有这条记录：${taskId}`);

      // 见模块头：真对话框在 Rust 侧开，这里造一条假资料顶上 ——
      // 「示例截图.png」+ 真 PNG 字节，让界面上的图片那一段有得可验
      const now = Date.now();
      const att: Attachment = {
        id: newId('att', now),
        taskId,
        kind: 'file',
        text: '',
        fileName: '示例截图.png',
        fileSize: FAKE_PNG.length,
        createdAt: now,
      };
      tasks = tasks.map((t) =>
        t.id === taskId ? { ...t, attachments: [...t.attachments, att], updatedAt: now } : t,
      );
      return att;
    },

    async updateAttachmentText(id, text) {
      const trimmed = text.trim();
      if (trimmed === '') {
        throw new Error('这条任务存不下去：空的存不下去（要删掉它，用删除）');
      }
      const hit = findAttachment(id);
      if (hit === null) throw new Error(`没有这条记录：${id}`);
      if (hit.att.kind !== 'text') throw new Error('这条任务存不下去：这条资料不是文字，改不了');

      const next: Attachment = { ...hit.att, text: trimmed };
      tasks = tasks.map((t) =>
        t.id === hit.task.id
          ? {
              ...t,
              attachments: t.attachments.map((a) => (a.id === id ? next : a)),
              updatedAt: Date.now(),
            }
          : t,
      );
      return next;
    },

    async removeAttachment(id) {
      const hit = findAttachment(id);
      if (hit === null) return false;

      tasks = tasks.map((t) =>
        t.id === hit.task.id
          ? { ...t, attachments: t.attachments.filter((a) => a.id !== id), updatedAt: Date.now() }
          : t,
      );
      return true;
    },

    async readAttachment(id) {
      const hit = findAttachment(id);
      if (hit === null) throw new Error(`没有这条记录：${id}`);
      if (hit.att.kind !== 'file') {
        throw new Error('这条任务存不下去：这条资料不是文件，读不了');
      }
      // 一份新的拷贝：别让调用方拿着共享的 buffer 去改
      return new Uint8Array(FAKE_PNG).buffer;
    },

    async openAttachment(_id) {
      // 浏览器里没有「系统默认程序」这回事。**不 window.open**（会开新标签页、
      // Playwright 下还可能被拦）—— e2e 验证的是「按钮是活的、不炸」
    },

    async openUrl(_url) {
      // 同上：不真的开窗口。检查放行规则的是 Rust 侧那份（open.rs）
    },
  };
}

/** 只给测试用：把假库清空（e2e 之间互不影响） */
export function __resetTasksForTest(): void {
  tasks = [];
  progress = new Map();
  seq = 0;
}
