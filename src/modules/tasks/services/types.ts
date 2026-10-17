/**
 * 任务模块的服务层契约。
 *
 * 两份实现：`tauri.ts` 走真的 SQLite（Rust 侧），`web.ts` 是内存假实现 ——
 * 浏览器版（也就是 Playwright 唯一能驱动的那一版）靠它跑完整条链路。
 *
 * ⚠️ **假实现要「够真」**：id 生成、`updated_at` 的推进、patch 的语义（没提到
 * 的字段不动）都要和 Rust 那边**一模一样**。图省事写一套自己的语义，e2e 就会
 * 在假实现上通过、到真机上全是 bug —— 这是这个仓库反复踩过的坑。
 */

import type { Attachment, Progress, Task, TaskPatch, TodoItem } from '../core/types';

export interface TasksClient {
  /** 全部任务（最近改过的在前，资料/待办内嵌在里面）。Rust 那边排好序 */
  list(): Promise<Task[]>;
  create(title: string, body: string): Promise<Task>;
  update(id: string, patch: TaskPatch): Promise<Task>;
  /** 返回「本来有没有这条」 */
  remove(id: string): Promise<boolean>;
  /** 一条任务的进度，从早到晚 */
  progressOf(taskId: string): Promise<Progress[]>;
  /** 记一笔进度（时间由后端给） */
  addProgress(taskId: string, text: string): Promise<Progress>;

  // ---------------------------------------------------------------- 待办项

  /** 加一条待办（空文字会被后端拒） */
  addTodo(taskId: string, text: string): Promise<TodoItem>;
  /** 勾/取消勾（取消会把 doneAt 清回去） */
  setTodoDone(id: string, done: boolean): Promise<TodoItem>;
  /** 改一条待办的文字 */
  updateTodoText(id: string, text: string): Promise<TodoItem>;
  /** 删一条待办 */
  removeTodo(id: string): Promise<void>;

  // ---------------------------------------------------------------- 资料

  /** 加一条文字资料 */
  addTextAttachment(taskId: string, text: string): Promise<Attachment>;
  /**
   * 挂一个文件。
   *
   * **桌面端这里会弹系统对话框**（在 Rust 侧开，见 `task_commands.rs` 的模块头）
   * —— 所以这个调用可能悬着很久，返回 `null` 是**用户取消**，不是错误。
   */
  addFileAttachment(taskId: string): Promise<Attachment | null>;
  /** 改一条文字资料的内容 */
  updateAttachmentText(id: string, text: string): Promise<Attachment>;
  /** 删一条资料（文件资料连盘上那份一起删）。返回「本来有没有」 */
  removeAttachment(id: string): Promise<boolean>;
  /**
   * 读一条文件资料的字节（缩略图 / 应用内大图用）。
   * 太大的文件后端会拒（32 MiB 上限）—— 那是明确报错，不是返回半截。
   */
  readAttachment(id: string): Promise<ArrayBuffer>;
  /** 用系统默认程序打开一条文件资料 */
  openAttachment(id: string): Promise<void>;
  /** 用系统浏览器打开一个链接（资料文字里点出来的）。只放行 http/https */
  openUrl(url: string): Promise<void>;
}
