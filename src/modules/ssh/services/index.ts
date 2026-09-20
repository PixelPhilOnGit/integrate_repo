/**
 * SSH 模块的服务层入口：按运行环境挑一份实现，并接上共享的档案存储。
 *
 * 结构和 `shared/platform/index.ts`、以及 redis/sql 的同名文件一样
 * （模块加载时决定一次，导出单例），区别是这个单例**属于 ssh 模块**。
 *
 * 判定用 `isTauri()`，读的是 `window.__TAURI_INTERNALS__`。
 *
 * ⚠️ 构造过程**不能碰平台**：这里不做 async、不触发动态 import。
 * 真正要读盘的初始化放在 store 的 `init()` 里（由 `onActivate` 惰性触发）。
 */

import { createKeyValue } from '../../../shared/platform/kv';
import { isTauri } from '../../../shared/platform/detect';
import { createGroupStore } from '../../../shared/connections/groups';
import { createTauriLocalClient, createWebLocalClient } from './local';
import { createKnownHostStore, createSshProfileStore } from './profiles';
import { createTauriSshClient } from './tauri';
import { createWebSshClient } from './web';
import type { SshServices } from './types';

// 各模块用各自的文件/存储键：共用一个的话，任何一方的结构变化都会波及另外几方。
// 档案和已知主机放在**同一个文件的不同键**里 —— 生命周期一致（都是这个模块的
// 用户数据），但结构完全不同，混在一个键里整形会互相牵连。
const kv = createKeyValue({
  tauriFile: 'ssh.json',
  webKey: 'devtoolkit.ssh.v1',
});

export const sshServices: SshServices = {
  client: isTauri() ? createTauriSshClient() : createWebSshClient(),
  local: isTauri() ? createTauriLocalClient() : createWebLocalClient(),
  profiles: createSshProfileStore(kv),
  knownHosts: createKnownHostStore(kv),
  // 分组和档案、已知主机**共用这一份 kv、三个不同的键** —— 各自的生命周期一致
  // （都是这个模块的用户数据），但结构完全不同，混在一个键里整形会互相牵连
  groups: createGroupStore(kv),
};
