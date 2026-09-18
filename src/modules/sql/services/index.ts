/**
 * SQL 模块的服务层入口：按运行环境挑一份实现，并接上共享的档案存储。
 *
 * 结构和 redis 那边一样（模块加载时决定一次，导出单例）。
 * 判定用 `isTauri()`，读的是 Tauri 在任何页面脚本之前注入的
 * `window.__TAURI_INTERNALS__`。
 *
 * ⚠️ 构造过程**不能碰平台**：不做 async、不触发动态 import。
 * 要读盘的初始化放在 store 的 `init()` 里（由 `onActivate` 惰性触发）。
 */

import { createKeyValue } from '../../../shared/platform/kv';
import { isTauri } from '../../../shared/platform/detect';
import { createSqlProfileStore } from './profiles';
import { createTauriSqlClient } from './tauri';
import { createWebSqlClient } from './web';
import type { SqlServices } from './types';

// 各模块用各自的文件/存储键：共用一个的话，任何一方的结构变化都会波及另外两方
const kv = createKeyValue({
  tauriFile: 'sql.json',
  webKey: 'devtoolkit.sql.v1',
});

export const sqlServices: SqlServices = {
  client: isTauri() ? createTauriSqlClient() : createWebSqlClient(),
  profiles: createSqlProfileStore(kv),
};
