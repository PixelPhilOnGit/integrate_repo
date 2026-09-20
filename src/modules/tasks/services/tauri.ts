/**
 * 桌面端的任务客户端：走 Rust 的命令（真 SQLite）。
 *
 * 每个命令都是**一次往返、拿到就返回**，没有 Channel —— 任务列表是人手级别的
 * 变化，不需要流式。Rust 那边每个命令都丢在 blocking 线程池里跑（SQLite 是
 * 同步的，读盘时不该占着 tokio 的工作线程）。
 */

import { invoke } from '@tauri-apps/api/core';
import type { Progress, Task, TaskPatch } from '../core/types';
import type { TasksClient } from './types';

export function createTauriTasksClient(): TasksClient {
  return {
    async list() {
      return invoke<Task[]>('tasks_list');
    },

    async create(title, body) {
      return invoke<Task>('tasks_create', { title, body });
    },

    async update(id, patch: TaskPatch) {
      return invoke<Task>('tasks_update', { id, patch });
    },

    async remove(id) {
      return invoke<boolean>('tasks_delete', { id });
    },

    async progressOf(taskId) {
      return invoke<Progress[]>('tasks_progress', { taskId });
    },

    async addProgress(taskId, text) {
      return invoke<Progress>('tasks_add_progress', { taskId, text });
    },
  };
}
