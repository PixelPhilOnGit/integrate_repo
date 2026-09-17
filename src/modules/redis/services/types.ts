/**
 * Redis 模块的服务层契约。
 *
 * 为什么模块要有自己的一套服务层，而不是塞进 `shared/platform`：
 *
 * 1. 平台层的 `Platform` 接口是**所有模块共用**的，它只该认识「文件操作」这种
 *    谁都可能用到的东西。Redis 是具体模块的能力，放进去等于让共享层认识具体模块。
 * 2. 平台层没有、也不该有通用的 `invoke` 逃生舱 —— 有了它，任何模块都能绕过
 *    抽象直接捅后端，那层抽象就白做了。
 * 3. 浏览器版必须能用（e2e 全靠它），所以每个模块自己带 tauri / web 两份实现。
 */

import type {
  ConnectParams,
  ConnectionProfile,
  RedisReply,
  ServerInfo,
} from '../core/types';

/** 连上一个 Redis 并执行命令。三个实现：tauri（真后端）、web（内存假实现）、测试里的假对象 */
export interface RedisClient {
  /** 建立连接。失败时 reject，错误信息已经是可以直接显示的中文 */
  connect(params: ConnectParams): Promise<ServerInfo>;
  /** 断开。幂等：没连过也不报错 */
  disconnect(id: string): Promise<void>;
  /**
   * 执行一条命令。
   *
   * **传输层失败才 reject**（连不上、断了、超时）。服务器返回的错误
   * （`-ERR unknown command`）是 `resolve` 出来的一条 `{type:'error'}` 回复 ——
   * 它是命令的结果，不是执行失败，前端把它内联显示在日志里。
   */
  exec(id: string, args: readonly string[]): Promise<RedisReply>;
}

/**
 * 一个极小的键值存储，用来落盘连接档案。
 *
 * 单独抽出来是因为「存哪儿」在两个平台上完全不同（桌面端走
 * `tauri-plugin-store`，浏览器走 localStorage），而「存什么」是一样的 ——
 * 后者（也就是密码的处理方式）只该写一遍，见 `credentials.ts`。
 */
export interface KeyValueStore {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
}

export interface ProfileStore {
  load(): Promise<ConnectionProfile[]>;
  save(profiles: readonly ConnectionProfile[]): Promise<void>;
}

export interface RedisServices {
  client: RedisClient;
  profiles: ProfileStore;
}
