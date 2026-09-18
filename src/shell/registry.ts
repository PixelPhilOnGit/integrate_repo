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
import { diagramModule } from '../modules/diagram';
import { devPlaceholderModule } from '../modules/devplaceholder';
import { redisModule } from '../modules/redis';
import { sqlModule } from '../modules/sql';
import { sshModule } from '../modules/ssh';
import type { Module } from './types';

export const MODULES: readonly Module[] = [
  diagramModule,
  redisModule,
  sqlModule,
  sshModule,
  agentsModule,
  devPlaceholderModule,
];

export function moduleById(id: string): Module | undefined {
  return MODULES.find((m) => m.id === id);
}
