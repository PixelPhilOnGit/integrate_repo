/**
 * 连接类模块共用的类型。
 *
 * 什么算「连接类模块」：要连一个远端服务、要存带凭据的连接档案、要有
 * 「连上/断开/连接中」这套状态机 —— 目前是 Redis / SQL / SSH 三个。
 *
 * 它们和顺序图那种模块完全不同：顺序图操作的是工作区里的文件，
 * 而这几个操作的是网络连接。所以共享的东西放在这里，
 * **刻意不塞进 `shared/platform/`** —— 那里管的是文件、系统对话框、偏好设置，
 * 和网络连接没有关系，混进去会让那层的职责变模糊。
 */

/**
 * 一个极小的键值存储。
 *
 * 只做「取/存」，不做「列表/删除」—— 连接档案永远是整个数组一起存的，
 * 拆成细粒度的增删改反而会引入中间状态。
 */
export interface KeyValueStore {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
}

/** 连接档案的持久化。实现见 `profiles.ts` */
export interface ProfileStore<P> {
  load(): Promise<P[]>;
  save(profiles: readonly P[]): Promise<void>;
}

export type ConnStatus = 'idle' | 'connecting' | 'connected' | 'error';

/**
 * 一个连接的运行时状态（不持久化，每次启动从 idle 开始）。
 *
 * `Info` 是各模块连上之后拿到的服务端信息（Redis 是版本号，SQL 是版本+库名，
 * SSH 是主机密钥指纹……），形状由模块自己定。
 */
export interface ConnectionRuntime<Info = unknown> {
  status: ConnStatus;
  /** 上一次失败的原因，成功时清空 */
  error: string | null;
  /**
   * 连上之后又改了连接参数 —— 新参数要重连才生效。
   *
   * 刻意**不自动重连**：用户正在操作的时候连接被换掉，比多一步点击更烦人。
   */
  stale: boolean;
  server: Info | null;
}

/**
 * 分布式 `Omit`。
 *
 * 直接写 `Omit<联合类型, 'seq'>` 是错的：`Omit` 作用在联合类型上时会把各分支的
 * **独有字段全部丢掉**，只剩下公共字段，于是 `{kind:'note', message}` 这种字面量
 * 一个都通不过。写成条件类型让它逐分支分配。
 *
 * 任何「带 seq 的联合日志类型」都要用它，所以放这儿。
 */
export type WithoutSeq<T> = T extends unknown ? Omit<T, 'seq'> : never;

/** 所有连接档案都有的字段。各模块在这基础上加自己的（db / database / 认证方式……） */
export interface ConnectionProfileBase {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  /**
   * ⚠️ 明文密码，见 `profiles.ts` 的 TODO(security)。
   * 三个模块共用这一份读写路径，将来换系统钥匙串时一次覆盖全部。
   */
  password: string;
}
