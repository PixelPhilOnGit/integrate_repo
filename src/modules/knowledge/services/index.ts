/**
 * 知识库的服务层：按运行环境挑实现（和 tasks / agents 一个套路）。
 *
 * 桌面端 → Rust 命令；浏览器版 → 内存假实现（e2e 唯一能驱动的版本，
 * 语义和 Rust 逐条对齐，见 `web.ts` 的头注释）。
 */

import { isTauri } from '../../../shared/platform/detect';
import { createTauriKnowledgeClient } from './tauri';
import { createWebKnowledgeClient } from './web';
import type { KnowledgeClient } from './types';

export interface KnowledgeServices {
  client: KnowledgeClient;
}

export const knowledgeServices: KnowledgeServices = {
  client: isTauri() ? createTauriKnowledgeClient() : createWebKnowledgeClient(),
};
