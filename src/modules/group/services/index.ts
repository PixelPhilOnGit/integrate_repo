/**
 * 群组模块的服务层入口：按运行环境挑一份实现。
 *
 * ⚠️ 构造过程**不能碰平台**：不做 async、不触发动态 import。
 * 真正读库的初始化放在 store 的 `init()` 里（由 `onActivate` 惰性触发）。
 */

import { isTauri } from '../../../shared/platform/detect';
import { createTauriGroupClient } from './tauri';
import { createWebGroupClient } from './web';
import type { GroupClient } from './types';

export const groupClient: GroupClient = isTauri()
  ? createTauriGroupClient()
  : createWebGroupClient();
