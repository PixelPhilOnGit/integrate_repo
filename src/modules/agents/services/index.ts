/**
 * 智能体会话模块的服务层入口：按运行环境挑一份实现。
 *
 * 结构和 ssh / redis / sql 那几个同名文件一样（模块加载时决定一次，导出单例），
 * 判定用 `isTauri()`，读的是 `window.__TAURI_INTERNALS__`。
 *
 * ⚠️ 构造过程**不能碰平台**：这里不做 async、不触发动态 import。
 * 真正要读盘的初始化放在 store 的 `init()` 里（由 `onActivate` 惰性触发）。
 */

import { isTauri } from '../../../shared/platform/detect';
import { createTauriIntegrationClient, createWebIntegrationClient } from './integrate';
import { createTauriAgentsClient } from './tauri';
import type { AgentsServices } from './types';
import { createWebAgentsClient } from './web';

export const agentsServices: AgentsServices = isTauri()
  ? {
      client: createTauriAgentsClient(),
      integration: createTauriIntegrationClient(),
    }
  : {
      client: createWebAgentsClient(),
      integration: createWebIntegrationClient(),
    };
