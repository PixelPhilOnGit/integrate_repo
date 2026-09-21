/**
 * 助手模块的服务层入口：按运行环境挑一份实现。
 *
 * ⚠️ 构造过程**不能碰平台**：不做 async、不触发动态 import。
 * 真正读盘的初始化放在 store 的 `init()` 里（由 `onActivate` 惰性触发）。
 */

import { isTauri } from '../../../shared/platform/detect';
import { createTauriAssistantClient } from './tauri';
import { createWebAssistantClient } from './web';
import type { AssistantClient } from './types';

export const assistantClient: AssistantClient = isTauri()
  ? createTauriAssistantClient()
  : createWebAssistantClient();
