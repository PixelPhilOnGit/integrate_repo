/**
 * 桌面端实现：走 Rust command + `tauri-plugin-store`。
 *
 * 和 `shared/platform/tauri.ts` 一个路子：所有 Tauri 模块都用**动态 import + 缓存**，
 * 静态 import 会把它们打进浏览器产物里，而某些插件在模块顶层就访问
 * `__TAURI_INTERNALS__`，在纯浏览器里直接抛错。
 */

import { invoke } from '../../../shared/platform/invoke';
import type { RedisReply, ServerInfo } from '../core/types';
import { createProfileStore } from './credentials';
import type { KeyValueStore, RedisClient, RedisServices } from './types';

type StoreModule = typeof import('@tauri-apps/plugin-store');
type PluginStore = Awaited<ReturnType<StoreModule['load']>>;

let storePromise: Promise<PluginStore> | null = null;

function store(): Promise<PluginStore> {
  if (!storePromise) {
    storePromise = import('@tauri-apps/plugin-store').then((m) =>
      // 单独一个 redis.json：连接档案和工作区偏好（prefs.json）是两码事，
      // 混在一个文件里迟早会因为某一方的结构变化互相影响。
      m.load('redis.json', { autoSave: true }),
    );
  }
  return storePromise;
}

/**
 * 连接档案落在应用配置目录下的 `redis.json`。
 *
 * 密码是**明文**的 —— 见 `credentials.ts` 的 TODO(security)，
 * 那里是全程序唯一读写它的地方。
 */
const kv: KeyValueStore = {
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

const client: RedisClient = {
  async connect(params): Promise<ServerInfo> {
    return invoke<ServerInfo>('redis_connect', {
      id: params.id,
      config: {
        host: params.host,
        port: params.port,
        db: params.db,
        username: params.username,
        password: params.password,
      },
    });
  },

  async disconnect(id: string): Promise<void> {
    await invoke<void>('redis_disconnect', { id });
  },

  async exec(id: string, args: readonly string[]): Promise<RedisReply> {
    // 展开成普通数组：readonly 数组过不了 IPC，而且 serde 要的是 Vec<String>
    return invoke<RedisReply>('redis_exec', { id, args: [...args] });
  },
};

export function createTauriServices(): RedisServices {
  return {
    client,
    profiles: createProfileStore(kv),
  };
}
