/**
 * Redis 模块的服务层契约。
 *
 * `KeyValueStore` / `ProfileStore` / `ConnStatus` 这些通用的东西已经搬到
 * `shared/connections/`（三个连接类模块共用）。这里只剩 Redis 专属的那部分。
 *
 * 为什么模块要有自己的一套服务层，而不是塞进 `shared/platform`：
 * 那个接口是所有模块共用的，只该认识「文件操作」这类谁都可能用到的东西；
 * 网络连接是具体模块的能力。另外平台层刻意没有通用的 `invoke` 逃生舱 ——
 * 有了它，任何模块都能绕过抽象直接捅后端，那层抽象就白做了。
 */

import type { ConnectionGroup, ProfileStore } from '../../../shared/connections/types';
import type {
  ConnectParams,
  ConnectionProfile,
  DbInfo,
  KeyDetail,
  RedisReply,
  ScanPage,
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

  // ---- 浏览式界面用的四个查询。和上面三个是两条路：
  //      exec 是「用户敲什么发什么」，这几个是「界面为了渲染自己需要的结构」 ----

  /** 库列表（含每个库的 key 数）。空库也会列出来 */
  keyspace(id: string): Promise<DbInfo[]>;
  /** 切到另一个库。`SELECT` 是连接级的 */
  select(id: string, db: number): Promise<void>;
  /** 扫一页 key。`cursor` 传 0 开始，返回的 `cursor` 为 0 表示翻完了 */
  scan(id: string, pattern: string, cursor: number, count: number): Promise<ScanPage>;
  /**
   * 一个 key 的类型、TTL 和值。
   *
   * `key` 用**原始字节**而不是字符串：Redis 的 key 是二进制安全的，
   * 用 `keyBytesOf()` 从 `KeyMeta` 取（见 `core/types.ts`）。
   *
   * `knownType` 是从 key 列表里带过来的类型提示 —— 有它就能少一次往返。
   * 传错也没关系，后端会发现并自动退回慢路径。
   */
  keyDetail(
    id: string,
    key: Uint8Array,
    limit: number,
    knownType?: string,
  ): Promise<KeyDetail>;
}

export interface RedisServices {
  client: RedisClient;
  profiles: ProfileStore<ConnectionProfile>;
  /** 用户自己建的分组（连接列表那一层）。形状和规则在 `shared/connections/groups.ts` */
  groups: ProfileStore<ConnectionGroup>;
}
