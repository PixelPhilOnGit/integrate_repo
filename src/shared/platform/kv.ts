/**
 * 键值存储的两个平台实现。
 *
 * 桌面端落在应用配置目录下的一个 json 文件（走 `tauri-plugin-store`），
 * 浏览器版落在 localStorage。**上层只认 `KeyValueStore` 接口**，
 * 不知道自己在哪个平台上。
 *
 * 每个模块用**自己的文件名/存储键** —— 三个模块共用一个文件的话，
 * 任何一方的结构变化都会波及另外两方。
 */

import { isTauri } from '../platform/detect';
import type { KeyValueStore } from './types';

type StoreModule = typeof import('@tauri-apps/plugin-store');
type PluginStore = Awaited<ReturnType<StoreModule['load']>>;

export interface KeyValueLocation {
  /** 桌面端：应用配置目录下的文件名，如 `redis.json` */
  tauriFile: string;
  /** 浏览器端：localStorage 的键，如 `devtoolkit.redis.v1` */
  webKey: string;
}

/** 按运行环境挑一份实现。构造过程**不碰平台**（动态 import 只在真正读写时发生） */
export function createKeyValue(location: KeyValueLocation): KeyValueStore {
  return isTauri()
    ? createTauriKeyValue(location.tauriFile)
    : createWebKeyValue(location.webKey);
}

/**
 * 桌面端：`tauri-plugin-store`。
 *
 * 用**动态 import + Promise 缓存**，不静态 import —— 后者会把 Tauri 的模块打进
 * 浏览器那份产物里，而某些插件在模块顶层就会访问 `__TAURI_INTERNALS__`，
 * 在纯浏览器里直接抛错。
 */
export function createTauriKeyValue(fileName: string): KeyValueStore {
  let storePromise: Promise<PluginStore> | null = null;

  const store = (): Promise<PluginStore> => {
    storePromise ??= import('@tauri-apps/plugin-store').then((m) =>
      m.load(fileName, { autoSave: true }),
    );
    return storePromise;
  };

  return {
    async get<T>(key: string): Promise<T | null> {
      const s = await store();
      const value = await s.get<T>(key);
      return value ?? null;
    },

    async set(key: string, value: unknown): Promise<void> {
      const s = await store();
      await s.set(key, value);
      await s.save();
    },
  };
}

/**
 * 浏览器端：localStorage。
 *
 * 内存里留一份**权威副本**：localStorage 写失败（配额满、隐私模式）时，
 * 至少当前这次会话里的数据还是对的，不会刚存完就读不回来。
 *
 * 状态封在闭包里而不是模块级变量 —— 同一个页面上会同时存在三个模块的实例，
 * 模块级变量会让它们互相串。
 */
export function createWebKeyValue(storageKey: string): KeyValueStore {
  const memory = new Map<string, unknown>();
  let loaded = false;

  const readAll = (): void => {
    if (loaded) return;
    loaded = true;
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return;
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null) {
        for (const [key, value] of Object.entries(parsed)) memory.set(key, value);
      }
    } catch {
      // 存储里的东西坏了就当没有 —— 反正上层还会逐条校验一遍
    }
  };

  const writeAll = (): void => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(memory)));
    } catch {
      // 写不进去就算了：内存里的状态仍然是对的，用户这次会话还能正常用
    }
  };

  return {
    async get<T>(key: string): Promise<T | null> {
      readAll();
      return memory.has(key) ? (memory.get(key) as T) : null;
    },

    async set(key: string, value: unknown): Promise<void> {
      readAll();
      memory.set(key, value);
      writeAll();
    },
  };
}
