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

/**
 * 用户自己建的分组（「生产」「测试」「某某项目」那类）。
 *
 * ⚠️ **只有一层，不做嵌套** —— 2026-09-20 和用户确认过。理由：连接总数通常是
 * 几十条，一层分组 + 搜索就够了；嵌套要带出递归渲染、折叠状态、把组拖进自己
 * 子树这类边界，现在不值这个复杂度。真要嵌套，加个 `parentId` 就能长出来。
 *
 * ⚠️ 别和 SQL 模块那个「按引擎分的层」混起来：那是**系统给的**种类
 * （pg / mysql / mongo / ck），这个是**用户自己分的**。两个维度，侧栏里
 * 引擎在上、分组在下（也是和用户确认过的顺序）。
 */
export interface ConnectionGroup {
  id: string;
  name: string;
}

/** 所有连接档案都有的字段。各模块在这基础上加自己的（db / database / 认证方式……） */
export interface ConnectionProfileBase {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  /**
   * 属于哪个分组。不存在 / 指向一个已经没有的组 = **未分组**（新建的连接都是）。
   *
   * ⚠️ 那个「指向不存在的组也算未分组」不是为了容错，是**故意留的余地**：
   * 删组时成员自然落回未分组那堆，不需要先要求用户把连接搬走。
   * （删组时我们**还是会顺手清一遍** `groupId`，但那只是让数据干净 ——
   * 渲染的正确性不依赖它。）
   */
  groupId?: string;
  /**
   * ⚠️ 明文密码，见 `profiles.ts` 的 TODO(security)。
   * 三个模块共用这一份读写路径，将来换系统钥匙串时一次覆盖全部。
   */
  password: string;
}
