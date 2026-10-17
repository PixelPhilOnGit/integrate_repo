/**
 * 模块注册表。
 *
 * **加一个模块就是在这里加一行。** 这是"模块化架构成不成立"的检验标准：
 * 如果加模块还要改外壳内部，说明 Module 接口设计错了。
 *
 * 刻意做成静态列表而不是"模块自己调用 registerModule() 注册"：
 * 静态列表让"有哪些模块"一眼可见，也不依赖 import 顺序这种隐式行为。
 */

import { agentsModule } from '../modules/agents';
import { assistantModule } from '../modules/assistant';
import { diagramModule } from '../modules/diagram';
import { devPlaceholderModule } from '../modules/devplaceholder';
import { groupModule } from '../modules/group';
import { knowledgeModule } from '../modules/knowledge';
import { redisModule } from '../modules/redis';
import { requestModule } from '../modules/request';
import { sqlModule } from '../modules/sql';
import { sshModule } from '../modules/ssh';
import { tasksModule } from '../modules/tasks';
import { parseModuleHash } from './moduleHash';
import type { Module } from './types';

export const MODULES: readonly Module[] = [
  diagramModule,
  redisModule,
  sqlModule,
  sshModule,
  agentsModule,
  tasksModule,
  assistantModule,
  // ⚠️ **插在占位模块之前**：注册表顺序 = 图标栏顺序 = Ctrl+数字的顺序，
  // 占位模块是「验证加模块只要一个目录 + 一行」用的，永远该排最后
  // （多窗口那一轮顺手修了 rail 的提示：第 10 个起不再显示不存在的 Ctrl+10）
  requestModule,
  knowledgeModule,
  groupModule,
  devPlaceholderModule,
];

export function moduleById(id: string): Module | undefined {
  return MODULES.find((m) => m.id === id);
}

/**
 * 从 `location.hash` 里读初始模块（多窗口：新窗口靠 `#<module>` 落在指定模块）。
 *
 * 解析在 `moduleHash.ts`（纯的、可单测），这里只做「注册表里真有这个 id 吗」
 * 的校验 —— 认不出来（空的、手改的、拼错的）返回 `null`，调用方回落第一个模块。
 */
export function moduleIdFromHash(hash: string): string | null {
  const id = parseModuleHash(hash);
  if (id === null) return null;
  return moduleById(id) ? id : null;
}
