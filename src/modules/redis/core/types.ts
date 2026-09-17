/**
 * Redis 模块的数据形状。
 *
 * `RedisReply` / `ServerInfo` 是**前后端的 IPC 契约**，字段名照着 Rust 侧
 * `devtoolkit-redis::Reply` / `ServerInfo` 的 serde 输出写 —— 那边有单元测试
 * 把 JSON 字段名逐个钉死了（`redis/src/reply.rs` 的 `json_contract`），
 * 改字段名两边必须一起动。
 */

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

/** 传给服务层的连接参数（只含连上所需的东西，不含名字这种纯 UI 字段） */
export interface ConnectParams {
  id: string;
  host: string;
  port: number;
  db: number;
  username: string;
  password: string;
}

export type ConnStatus = 'idle' | 'connecting' | 'connected' | 'error';

/** 一个连接的运行时状态（不持久化，每次启动从 idle 开始） */
export interface ConnectionRuntime {
  status: ConnStatus;
  /** 上一次失败的原因，成功时清空 */
  error: string | null;
  /**
   * 连上之后又改了连接参数 —— 新参数要重连才生效。
   * 不自动重连：用户正在命令台上敲东西的时候连接被换掉，比多一步点击更烦人。
   */
  stale: boolean;
  server: ServerInfo | null;
  /** 上一条命令的往返耗时（毫秒） */
  lastElapsedMs: number | null;
}

/**
 * 一条连接档案（会持久化）。
 *
 * ⚠️ 安全边界：`password` 目前以**明文**落在磁盘上，
 * 读写只发生在 `services/credentials.ts` 一处。见那里的 TODO(security)。
 */
export interface ConnectionProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  db: number;
  username: string;
  password: string;
}

/**
 * 分布式 `Omit`。
 *
 * 直接写 `Omit<LogEntry, 'seq'>` 是错的：`Omit` 作用在联合类型上时会把各分支的
 * **独有字段全部丢掉**，只剩下公共字段（kind/connection），于是 `{kind:'note',
 * message}` 这种字面量一个都通不过。写成条件类型让它逐分支分配。
 */
export type WithoutSeq<T> = T extends unknown ? Omit<T, 'seq'> : never;

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
