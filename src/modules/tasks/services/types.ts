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

import type { Task, TaskPatch } from '../core/types';

export interface TasksClient {
  /** 全部任务（最近改过的在前）。Rust 那边排好序 */
  list(): Promise<Task[]>;
  create(title: string, body: string): Promise<Task>;
  update(id: string, patch: TaskPatch): Promise<Task>;
  /** 返回「本来有没有这条」 */
  remove(id: string): Promise<boolean>;
}
