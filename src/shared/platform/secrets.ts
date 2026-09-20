/**
 * 系统钥匙串：连接密码的归宿。
 *
 * 在这之前，三个连接模块（Redis / 数据库 / SSH）的密码都是**明文**存在键值表里
 * （见 `shared/connections/profiles.ts` 一直挂着的 `TODO(security)`）。
 * 现在它们走操作系统的凭据存储：Windows 的凭据管理器、macOS 的钥匙串、
 * Linux 的 Secret Service。
 *
 * # 桌面端和浏览器版**不是同一件事**
 *
 * - **桌面端**：真的读写系统钥匙串。
 * - **浏览器版**：**没有钥匙串**，[`available`] 恒为 `false`。于是上面的
 *   `profiles.ts` 自动退回「密码存在 localStorage 里」那条老路 —— 和它现在的
 *   行为一模一样。e2e 跑的就是这条路。
 *
 * ⚠️ **`available()` 是这一层的核心接口，不是补充**：服务器和 headless 机器上
 * 压根没有钥匙串，那些环境里应用**照样得能用**。所以「用不了」不是错误，
 * 是一个**正常的分支**，调用方要顺着它退回老路 —— 但**不能静默**：界面上得
 * 说一句「这台机器上没有钥匙串，密码仍然存在本地文件里」，否则用户以为
 * 密码已经进钥匙串了。
 *
 * # 接口是批量的
 *
 * 一个模块几十条连接，一条一个 IPC 往返的话，切一次模块要等一串来回。
 * Rust 那边也照这个形状做的（`secret_commands.rs`）。
 */

import { isTauri } from './detect';
import { invoke } from './invoke';

export interface SecretsStore {
  /**
   * 这台机器上有没有可用的钥匙串。
   *
   * **返回 false 不是失败** —— 是「这里没有这个东西」，调用方该退回老路。
   */
  available(): Promise<boolean>;
  /** 一次读一批。**只包含真的存过的那些**（没存过的这里就没有，当空密码） */
  load(module: string, ids: readonly string[]): Promise<Record<string, string>>;
  /**
   * 一次写一批。空密码 = 删掉那一条。
   *
   * 返回**写完之后钥匙串还能不能用** —— 途中它可能整个掉线（桌面会话锁了）。
   */
  store(module: string, entries: ReadonlyArray<{ id: string; secret: string }>): Promise<boolean>;
}

/** Rust 侧 `secret_load` 的返回形状（和 `secret_commands.rs` 里的 `SecretsLoad` 对齐） */
interface SecretsLoad {
  available: boolean;
  secrets: Record<string, string>;
}

/**
 * 桌面端：真的系统钥匙串。
 *
 * 三个命令都是 `invoke`，**不做任何缓存**：钥匙串的状态会变（桌面会话锁上、
 * 服务重启），缓存「可用」会在它掉线之后继续往一个死掉的地方写。
 * 一次探测就是一个 IPC，比写丢密码便宜得多。
 */
function createTauriSecrets(): SecretsStore {
  return {
    async available(): Promise<boolean> {
      try {
        return await invoke<boolean>('secret_available');
      } catch {
        // 连命令都调不通（老版本后端、命令没注册）：当没有钥匙串处理 ——
        // 退回老路总比让用户连不上自己的库强
        return false;
      }
    },

    async load(module: string, ids: readonly string[]): Promise<Record<string, string>> {
      if (ids.length === 0) return {};
      try {
        const result = await invoke<SecretsLoad>('secret_load', { module, ids: [...ids] });
        return result.secrets;
      } catch {
        // 读不出来时**当作没存过**：界面上会显示空密码，用户重填一次即可。
        // 比让整个连接列表打不开强（那条路见 profiles.ts 的「坏记录不连坐」）
        return {};
      }
    },

    async store(
      module: string,
      entries: ReadonlyArray<{ id: string; secret: string }>,
    ): Promise<boolean> {
      if (entries.length === 0) return true;
      try {
        return await invoke<boolean>('secret_store', {
          module,
          entries: entries.map((e) => ({ id: e.id, secret: e.secret })),
        });
      } catch {
        return false;
      }
    },
  };
}

/**
 * 浏览器版：**没有钥匙串**。
 *
 * 不是「还没实现」—— 浏览器里就不存在这东西。恒返回 `false` 让上层自动
 * 退回 localStorage 那条路（那是浏览器版一直以来的行为，用户和 e2e 都按它来的）。
 */
function createWebSecrets(): SecretsStore {
  return {
    async available(): Promise<boolean> {
      return false;
    },
    async load(): Promise<Record<string, string>> {
      return {};
    },
    async store(): Promise<boolean> {
      return false;
    },
  };
}

/** 按运行环境挑一份实现。构造过程不碰平台（和 `kv.ts` 一样） */
export function createSecrets(): SecretsStore {
  return isTauri() ? createTauriSecrets() : createWebSecrets();
}
