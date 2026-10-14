/**
 * 桌面端的任务客户端：走 Rust 的命令（真 SQLite）。
 *
 * 每个命令都是**一次往返、拿到就返回**，没有 Channel —— 任务列表是人手级别的
 * 变化，不需要流式。Rust 那边每个命令都丢在 blocking 线程池里跑（SQLite 是
 * 同步的，读盘时不该占着 tokio 的工作线程）。
 *
 * 两个例外值得知道一下：
 * * `addFileAttachment`：**系统对话框在 Rust 侧开**（理由见 `task_commands.rs`
 *   的模块头），所以这一趟可能悬着很久 —— 用户在挑文件。返回 `null` = 取消。
 * * `readAttachment`：回的是一段原始字节（`ipc::Response`），不是 JSON。
 */

import { invoke } from '@tauri-apps/api/core';
import type { Attachment, Progress, Task, TaskPatch } from '../core/types';
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

    // -------------------------------------------------------------- 资料

    async addTextAttachment(taskId, text) {
      return invoke<Attachment>('tasks_add_text_attachment', { taskId, text });
    },

    async addFileAttachment(taskId) {
      // 前端只说「给这条任务挂个文件」—— 路径从头到尾不过 IPC（见模块头）
      return invoke<Attachment | null>('tasks_add_file_attachment', { taskId });
    },

    async updateAttachmentText(id, text) {
      return invoke<Attachment>('tasks_update_attachment_text', { id, text });
    },

    async removeAttachment(id) {
      return invoke<boolean>('tasks_delete_attachment', { id });
    },

    async readAttachment(id) {
      const data = await invoke<ArrayBuffer | number[]>('tasks_attachment_read', { id });
      // 正路是 ArrayBuffer（原始字节）；个别平台会退回「数字数组」的编码 ——
      // 归一化一下，别让那条路在真机上变成另一副样子
      return data instanceof ArrayBuffer ? data : new Uint8Array(data).buffer;
    },

    async openAttachment(id) {
      await invoke('tasks_open_attachment', { id });
    },

    async openUrl(url) {
      await invoke('open_url', { url });
    },
  };
}
