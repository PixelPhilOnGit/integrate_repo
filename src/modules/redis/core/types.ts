/**
 * Redis 模块的数据形状。
 *
 * `RedisReply` / `ServerInfo` 是**前后端的 IPC 契约**，字段名照着 Rust 侧
 * `devtoolkit-redis::Reply` / `ServerInfo` 的 serde 输出写 —— 那边有单元测试
 * 把 JSON 字段名逐个钉死了（`redis/src/reply.rs` 的 `json_contract`），
 * 改字段名两边必须一起动。
 */

import type {
  ConnectionProfileBase,
  ConnectionRuntime as SharedRuntime,
} from '../../../shared/connections/types';

/**
 * 一条命令的回复。
 *
 * `error` 是**一条正常的回复**，不是执行失败 —— 服务器说 `-ERR unknown command`
 * 的时候连接是好的，那句话只是命令的结果，应该内联在日志里。
 * 传输层失败是另一回事，走 `LogEntry` 的 `transport` 分支。
 */
export type RedisReply =
  | { type: 'nil' }
  | { type: 'status'; text: string }
  | { type: 'error'; message: string }
  | { type: 'integer'; value: number }
  | { type: 'bulk'; text: string; binary: boolean; bytes: number }
  | { type: 'array'; items: RedisReply[] }
  | { type: 'map'; entries: [RedisReply, RedisReply][] }
  | { type: 'set'; items: RedisReply[] }
  | { type: 'double'; value: number }
  | { type: 'boolean'; value: boolean }
  | { type: 'verbatim'; format: string; text: string }
  | { type: 'bigNumber'; text: string };

/** 连上之后 Rust 侧回的信息 */
export interface ServerInfo {
  address: string;
  db: number;
  version: string | null;
}

// ---------------------------------------------------------------- 浏览

/** 一个库的概况 */
export interface DbInfo {
  db: number;
  keys: number;
}

/** key 列表里的一项 */
export interface KeyMeta {
  key: string;
  /**
   * 原始字节。**只在 `key` 不是合法 UTF-8 时才出现**（省得每个 key 都带一份）。
   *
   * 查详情时必须用 `keyBytes ?? TextEncoder().encode(key)` —— Redis 的 key 是
   * 二进制安全的，只传 lossy 字符串的话二进制 key 点开就会「不存在」。
   */
  keyBytes?: number[];
  keyType: string;
}

export interface ScanPage {
  cursor: number;
  keys: KeyMeta[];
}

export interface KeyDetail {
  key: string;
  keyBytes?: number[];
  keyType: string;
  /** TTL 秒：`-1` 永不过期，`-2` 键不存在 */
  ttl: number;
  /** 容器里的元素总数；string 没有 */
  size?: number;
  value: RedisReply;
  /** 值被截断了吗（容器元素超过一次取的上限） */
  truncated: boolean;
}

/** 取 key 的原始字节：二进制 key 用后端给的那份，其余按 UTF-8 编码 */
export function keyBytesOf(meta: { key: string; keyBytes?: number[] }): Uint8Array {
  return meta.keyBytes ? new Uint8Array(meta.keyBytes) : new TextEncoder().encode(meta.key);
}

/** 传给服务层的连接参数（只含连上所需的东西，不含名字这种纯 UI 字段） */
export interface ConnectParams {
  id: string;
  host: string;
  port: number;
  db: number;
  username: string;
  password: string;
}

// 通用的连接状态类型在 shared/connections —— Redis / SQL / SSH 三个模块共用一份。
// 这里 re-export 出去，模块内部继续从 './types' 取，调用方不用关心它住在哪。
export type { ConnStatus, WithoutSeq } from '../../../shared/connections/types';

/**
 * redis 的运行时状态 = 通用那份（状态/错误/stale/服务端信息）+ 命令台要的耗时。
 *
 * `server` 的类型参数就是 redis 的 `ServerInfo` —— 共享层不知道长什么样，
 * 由模块决定。
 */
export interface ConnectionRuntime
  extends SharedRuntime<ServerInfo> {
  /** 上一条命令的往返耗时（毫秒） */
  lastElapsedMs: number | null;
}

/**
 * 一条连接档案（会持久化）。
 *
 * ⚠️ 安全边界：`password` 目前以**明文**落在磁盘上。
 * 读写路径已经收拢到 `shared/connections/profiles.ts` 一处
 * （三个连接类模块共用，将来换钥匙串一次覆盖全部），见那里的 TODO(security)。
 */
export interface ConnectionProfile extends ConnectionProfileBase {
  /** Redis 的库号（0–15，可配） */
  db: number;
}

/** 命令台日志里的一行 */
export type LogEntry =
  /** 用户敲的命令（已脱敏） */
  | { kind: 'input'; seq: number; connection: string; text: string }
  /** 命令的回复 */
  | { kind: 'reply'; seq: number; connection: string; reply: RedisReply; elapsedMs: number }
  /** 传输层失败：连不上、断了、超时 */
  | { kind: 'transport'; seq: number; connection: string; message: string }
  /** 纯本地的提示（分词失败之类，根本没发出去） */
  | { kind: 'note'; seq: number; connection: string; message: string };
