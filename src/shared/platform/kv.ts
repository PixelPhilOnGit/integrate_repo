/**
 * 键值存储的平台实现。
 *
 * 桌面端落在**一个 SQLite 文件**（`app_data_dir/devtoolkit.db`，见 Rust 侧的
 * `devtoolkit-store`），浏览器版落在 localStorage。**上层只认 `KeyValueStore`
 * 接口**，不知道自己在哪个平台上。
 *
 * # 为什么从「一个模块一个 JSON」换成 SQLite
 *
 * 用户的原话：「这些渐渐转到 sqlite 中去吧」。原来那个 JSON 整体读写的形状，
 * 每加一个查询维度（按种类筛、搜索、排序）都得在内存里重写一遍，而且
 * **两个窗口同时写会丢数据**（各自读一份、改一处、整体覆盖）。这一层先换底、
 * **接口一个字不改** —— 把连接档案拆成真正的表是下一步的事。
 *
 * # ⚠️ 搬迁：老的 JSON 第一次读时导进来，**失败就退回老实现**
 *
 * 那些文件里装的是用户的真实数据（连接档案、主机指纹、工作目录）。搬迁失败
 * （文件坏了、权限不对）时**绝不能让用户打不开自己的东西** —— 所以这里退回
 * `tauri-plugin-store` 那条老路，这次会话照常用老数据，下次启动再试一次。
 *
 * 每个模块用**自己的模块名**（= 老文件的文件名）—— 共用一个名字的话，任何一方
 * 的结构变化都会波及另外几方。
 */

import { isTauri } from './detect';
import { invoke } from './invoke';
import { scenarioSuffix } from './scenario';

/**
 * 一个极小的键值存储。
 *
 * 只做「取/存」，不做「列表/删除」—— 各模块存的都是**整个数组一起存的**东西
 * （连接档案、工作目录列表），拆成细粒度的增删改反而会引入中间状态。
 *
 * 接口和实现放在同一个文件里：这一层的实现有四个（SQLite / plugin-store /
 * localStorage，以及 SQLite 那个内部退路），但它们对上层是同一件事 ——
 * 调用方看到的永远只有这一份接口。
 */
export interface KeyValueStore {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
}

type StoreModule = typeof import('@tauri-apps/plugin-store');
type PluginStore = Awaited<ReturnType<StoreModule['load']>>;

export interface KeyValueLocation {
  /** 桌面端：应用配置目录下的文件名，如 `redis.json` */
  tauriFile: string;
  /** 浏览器端：localStorage 的键，如 `devtoolkit.redis.v1` */
  webKey: string;
  /**
   * 要不要跟着**场景**分卷（默认要，见 `scenario.ts` 的规则）。
   * 传 `false` 的只有「软件本身的设置」那类（助手的配置）——
   * 那是跟着人走的，不是跟着团队走的。
   */
  scoped?: boolean;
}

/**
 * 按运行环境挑一份实现。构造过程**不碰平台**（动态 import 只在真正读写时发生）。
 *
 * ⚠️ **场景后缀推迟到第一次真正读写时才解析**（`resolve()` 里），不在构造时。
 * 原因：模块是在 import 链上被急切求值的（registry 静态导入所有模块 →
 * 各 services 的模块级 `createKeyValue(...)` 在**页面启动的最早一刻**就跑了），
 * 而场景要等组合根异步读回偏好才知道 —— 构造时解析的话后缀永远是空串，
 * 切了场景也照样读写默认那份（e2e 抓的：切到团队A 还看得见默认的连接）。
 *
 * 一次页面生命周期内场景是固定的（切换 = 整窗重载），所以「第一次读写」
 * 那一刻解析出来的值就是对的。
 */
export function createKeyValue(location: KeyValueLocation): KeyValueStore {
  let impl: KeyValueStore | null = null;
  const resolve = (): KeyValueStore => {
    if (impl !== null) return impl;
    // 场景后缀：默认场景是空串（老数据零迁移）；'redis' → 'redis@团队1'
    const suffix = location.scoped === false ? '' : scenarioSuffix();
    impl = isTauri()
      ? createSqliteKeyValue(moduleOf(location.tauriFile) + suffix)
      : createWebKeyValue(location.webKey + suffix);
    return impl;
  };

  return {
    async get<T>(key: string): Promise<T | null> {
      return resolve().get<T>(key);
    },
    async set(key: string, value: unknown): Promise<void> {
      return resolve().set(key, value);
    },
  };
}

/** `redis.json` → `redis`（模块名就是老文件的文件名，搬迁靠它对上） */
export function moduleOf(fileName: string): string {
  return fileName.replace(/\.json$/, '');
}

/**
 * 桌面端：SQLite（`devtoolkit.db`）。**第一次读写时才开库**（构造过程不碰平台）。
 *
 * 开库时 Rust 那边会顺手把老的 `<模块>.json` 搬进来（幂等）。**搬不动就退回
 * `tauri-plugin-store`** —— 见文件头部那段。
 */
export function createSqliteKeyValue(module: string): KeyValueStore {
  const fallback = createTauriKeyValue(`${module}.json`);
  let impl: KeyValueStore | null = null;

  const resolve = async (): Promise<KeyValueStore> => {
    if (impl !== null) return impl;
    try {
      await invoke<void>('kv_open', { module });
      impl = {
        async get<T>(key: string): Promise<T | null> {
          const raw = await invoke<string | null>('kv_get', { module, key });
          if (raw === null || raw === undefined) return null;
          // 存的是 JSON 文本（Rust 那边不认识任何模块的结构，那是模块自己的事）
          return JSON.parse(raw) as T;
        },
        async set(key: string, value: unknown): Promise<void> {
          await invoke<void>('kv_set', { module, key, value: JSON.stringify(value) });
        },
      };
    } catch {
      // ⚠️ 搬迁失败：这次会话用老实现，**下次启动再试**（老文件没被动过）
      impl = fallback;
    }
    return impl;
  };

  return {
    async get<T>(key: string): Promise<T | null> {
      return (await resolve()).get<T>(key);
    },
    async set(key: string, value: unknown): Promise<void> {
      return (await resolve()).set(key, value);
    },
  };
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
