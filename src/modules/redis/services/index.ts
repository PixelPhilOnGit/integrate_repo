/**
 * Redis 模块的服务层入口：按运行环境挑一份实现，并接上共享的档案存储。
 *
 * 结构和 `shared/platform/index.ts` 一样（模块加载时决定一次，导出单例），
 * 区别是这个单例**属于 redis 模块**，共享层不认识它。
 *
 * 判定用 `isTauri()`，读的是 `window.__TAURI_INTERNALS__` —— 这个标记由 Tauri 在
 * 任何页面脚本之前注入，而本模块是被 `registry.ts → modules/redis/index.tsx`
 * 在启动路径上拉起来的，所以此刻求值一定可靠。
 *
 * ⚠️ 构造过程**不能碰平台**：这里不做 async、不触发动态 import。
 * 真正要读盘的初始化放在 store 的 `init()` 里（由 `onActivate` 惰性触发）。
 */

import { createGroupStore } from '../../../shared/connections/groups';
import { createKeyValue } from '../../../shared/platform/kv';
import { isTauri } from '../../../shared/platform/detect';
import { createRedisProfileStore } from './profiles';
import { createTauriRedisClient } from './tauri';
import { createWebRedisClient } from './web';
import type { RedisServices } from './types';

// 各模块用各自的文件/存储键：共用一个的话，任何一方的结构变化都会波及另外两方
const kv = createKeyValue({
  tauriFile: 'redis.json',
  webKey: 'devtoolkit.redis.v1',
});

export const redisServices: RedisServices = {
  client: isTauri() ? createTauriRedisClient() : createWebRedisClient(),
  profiles: createRedisProfileStore(kv),
  // 分组和连接档案**共用这一份 kv、不同的键**（见 shared/connections/groups.ts）
  groups: createGroupStore(kv),
};
