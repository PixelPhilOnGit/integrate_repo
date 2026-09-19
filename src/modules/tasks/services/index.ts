/**
 * 任务模块的服务层入口：按运行环境挑一份实现。
 *
 * 结构和另外几个模块一样（模块加载时决定一次，导出单例）。判定用 `isTauri()`，
 * 读的是 `window.__TAURI_INTERNALS__` —— Tauri 在任何页面脚本之前注入它，
 * 而本模块是被注册表在启动路径上拉起来的，所以此刻求值一定可靠。
 *
 * ⚠️ 构造过程**不能碰平台**：不做 async、不触发动态 import。真正读盘的初始化
 * 放在 store 的 `init()` 里（由 `onActivate` 惰性触发）。
 */

import { isTauri } from '../../../shared/platform/detect';
import { createTauriTasksClient } from './tauri';
import { createWebTasksClient } from './web';
import type { TasksClient } from './types';

export const tasksClient: TasksClient = isTauri()
  ? createTauriTasksClient()
  : createWebTasksClient();
