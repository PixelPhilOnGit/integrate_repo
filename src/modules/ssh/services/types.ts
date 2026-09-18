/**
 * SSH 模块的服务层契约。
 *
 * 和 Redis / SQL 一样，模块自带一份服务层（接口 + tauri 实现 + 浏览器实现），
 * 共享的只有 `shared/connections/` 里那点通用的东西。
 *
 * # 和前两个模块最不一样的地方：这个接口是**推**的
 *
 * Redis 的 `exec` 是「发一条命令、等一个结果」。SSH 的 `open` 只是**把会话开起来**，
 * 之后远端会源源不断地吐字节上来 —— 所以 `open` 收一个 `onEvent` 回调，
 * 而不是返回结果。`write` / `resize` / `close` 是三条独立的命令，
 * 它们不回结果（回了也没人关心），失败要么是「会话已经没了」这种可以忽略的，
 * 要么已经通过事件流报出来了。
 */

import type { ProfileStore } from '../../../shared/connections/types';
import type {
  KnownHost,
  SshAuth,
  SshEvent,
  SshOpenOutcome,
  SshProfile,
} from '../core/types';

/** 开一个会话需要的全部输入 */
export interface SshOpenRequest {
  /** **会话** id，不是档案 id。一个档案可以同时开好几个会话 */
  id: string;
  host: string;
  port: number;
  username: string;
  auth: SshAuth;
  term: string;
  cols: number;
  rows: number;
  /** 已经信任的指纹，没见过就是 null */
  expectedFingerprint: string | null;
  /** 只有用户明确点了「信任并继续」才是 true */
  acceptNewHostKey: boolean;
  /**
   * 会话流。**在 `open` 返回之前就可能开始收到事件**（连接快的时候，
   * 横幅和提示符会在 `open` 的 promise 决议之前就到了）。
   *
   * 所以调用方必须在**调 `open` 之前**就准备好接住它们 ——
   * 会话对象和终端实例要提前建好，不能等 `open` 回来再建。
   *
   * 收到的是**解码后的** `SshEvent`（字节已经是 `Uint8Array`），
   * base64 那些 IPC 细节由两个服务实现各自处理掉。
   */
  onEvent: (event: SshEvent) => void;
}

export interface SshClient {
  /**
   * 建立会话。
   *
   * **返回的三种 `kind` 都要处理**，其中 `hostKeyUnknown` / `hostKeyMismatch`
   * 是「往返做完了但会话没开起来」，不是失败。判据是 `kind === 'ready'`。
   *
   * ⚠️ **reject 只表示传输层失败**（连不上、超时、认证被拒），
   * 而且 reject 出来的是一个 `Error`，`message` 就是可以直接显示的中文。
   *
   * ⚠️ **每次调用都必须是独立的一次尝试。** Tauri 实现里每次 `open` 都会新建
   * 一个 IPC 通道，而通道在 Rust 侧被丢弃时会把前端那个回调**注销**掉 ——
   * 复用同一个通道对象的话，第二次的消息会全部石沉大海（终端一片空白、
   * 也不报错）。这条约束写在接口上，是因为它没法在实现里兜住。
   */
  open(request: SshOpenRequest): Promise<SshOpenOutcome>;

  /**
   * 往会话里发键盘输入。
   *
   * **调用顺序就是到达顺序**。Tauri 那边每次 `write` 是独立的 invoke，
   * 不串行化的话两次未 await 的调用到达顺序不保证 —— 打字会乱序成 `sl`。
   * web 实现是进程内的，天然有序，所以这条保证由 tauri 实现用一条 promise 链兑现。
   *
   * 会话已经没了不算错误：用户正在打字时对面退出了是很正常的事，
   * 不该弹错误条（顶多终端里已经显示了「已退出」）。
   */
  write(id: string, data: Uint8Array): Promise<void>;

  /** 告诉远端窗口大小变了。尺寸要先用 `core/fit.ts` 夹过 */
  resize(id: string, cols: number, rows: number): Promise<void>;

  /** 关掉一个会话。幂等 */
  close(id: string): Promise<void>;

  /**
   * 收掉**所有**会话。
   *
   * 给「前端重新加载了」兜底：webview 一刷新，前端认不得 Rust 侧还活着的那些
   * 会话了，用户在新界面上看不见也关不掉它们，而远端那边还挂着登录着的 shell。
   * `init()` 里调一次，等于把孤儿收干净。
   */
  closeAll(): Promise<void>;
}

export interface SshServices {
  client: SshClient;
  profiles: ProfileStore<SshProfile>;
  /** 已知主机的信任记录。和档案走同一条持久化路径 */
  knownHosts: ProfileStore<KnownHost>;
}
