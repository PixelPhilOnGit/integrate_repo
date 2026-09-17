/**
 * 服务层入口：按运行环境挑一份实现。
 *
 * 结构和 `shared/platform/index.ts` 一样（模块加载时决定一次，导出单例）。
 * 区别是这个单例**属于 redis 模块**，共享层不认识它。
 *
 * 判定用 `isTauri()`，读的是 `window.__TAURI_INTERNALS__` —— 这个标记由 Tauri 在
 * 任何页面脚本之前注入，而本模块是被 `registry.ts → modules/redis/index.tsx`
 * 在启动路径上拉起来的，所以此刻求值一定可靠。
 *
 * ⚠️ 构造过程**不能碰平台**：这里不做 async、不触发动态 import。
 * 真正要读盘的初始化放在 store 的 `init()` 里（由 `onActivate` 惰性触发）。
 */

import { isTauri } from '../../../shared/platform/detect';
import { createTauriServices } from './tauri';
import { createWebServices } from './web';
import type { RedisServices } from './types';

export const redisServices: RedisServices = isTauri()
  ? createTauriServices()
  : createWebServices();
