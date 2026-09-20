/**
 * SSH 模块的数据形状。
 *
 * `SshOpenOutcome` / `TerminalEvent` 是**前后端的 IPC 契约**，字段名照着 Rust 侧
 * `devtoolkit-ssh` 的 serde 输出写（两边的 tag 都是 `kind` + camelCase）。
 */

import type {
  ConnectionProfileBase,
  ConnectionRuntime as BaseRuntime,
} from '../../../shared/connections/types';

/**
 * 这个连接是**远端**还是**本地**。
 *
 * 用户的原话：「偶尔还是要用本地 ps、cmd 的」。本地终端不是另一种协议 ——
 * 它就是「换个地方起 shell」，所以它和 SSH 共用**同一套会话模型**（标签栏、
 * 命令块、色条、复制粘贴全都复用），差别只在字节从哪来。
 */
export type SshProfileKind = 'ssh' | 'local';

/** 认证方式。密码走基类那个 `password` 字段，私钥走下面两个 */
export type SshAuthKind = 'password' | 'key';

export interface SshProfile extends ConnectionProfileBase {
  /**
   * `ssh` = 连远端；`local` = 在本机起一个 shell。
   *
   * ⚠️ **旧档案没有这个字段** —— 读进来一律当 `ssh`（见 `services/profiles.ts`）。
   * 加字段时默认值选错的代价是「用户所有连接突然指着本地」，
   * 那比多一条迁移代码严重得多。
   */
  kind: SshProfileKind;
  /**
   * 本地终端用哪个 shell。**空串 = 平台默认**（Windows 上 `pwsh` → `powershell`
   * → `cmd` 探测，Unix 上 `$SHELL` → `/bin/sh`）。
   *
   * 选项目前是 Windows 导向的（用户就是在那儿要的 cmd / PowerShell）。
   * 在 macOS / Linux 上留空即可 —— 填了别的名字会得到一句「起不来」的明确报错。
   */
  localShell: string;
  authKind: SshAuthKind;
  /**
   * 私钥文件路径。
   *
   * 刻意**只在桌面端有意义** —— 浏览器版读不到本地文件，所以假实现直接无视它。
   * 不为此在界面上做分支：用户在浏览器里看到的是一个能连上的假服务器，
   * 路径填什么都不影响，而假装它「不支持」比无视它更让人困惑。
   */
  privateKeyPath: string;
  /**
   * 私钥口令。
   *
   * ⚠️ 和密码一样是**明文存储**，见 `shared/connections/profiles.ts` 的
   * TODO(security)。加一个字段不会让问题变严重，但也没让它变轻 ——
   * 将来换钥匙串时它是**第四个**要搬的字段。
   */
  passphrase: string;
}

/** SSH 的运行时状态。泛型必须显式指定，否则 `runtime.server.fingerprint` 访问不过 */
export type SshRuntime = BaseRuntime<SshServerInfo>;

/** 连上之后后端回的信息。`fingerprint` 是这个连接**实际握手用的**那把主机密钥 */
export interface SshServerInfo {
  address: string;
  username: string;
  fingerprint: string;
  algorithm: string;
}

/**
 * 认证参数。
 *
 * 和 `SshProfile` 的扁平字段不同，这里做成判别联合 —— 因为**凭据只该有一个来源**：
 * 密码认证时只传密码，私钥认证时只传路径和口令。扁平的形状会让「密码认证时
 * 那个 privateKeyPath 是什么」变成一个没有答案的问题。
 */
export type SshAuth =
  | { kind: 'password'; password: string }
  | { kind: 'key'; privateKeyPath: string; passphrase: string };

/** 传给服务层的连接参数 */
export interface SshConnectParams {
  id: string;
  host: string;
  port: number;
  username: string;
  auth: SshAuth;
  /** 终端类型，会作为 `TERM` 报给远端。默认 `xterm-256color` */
  term: string;
  cols: number;
  rows: number;
  /**
   * 已经信任的指纹（SHA256 形式，含 `SHA256:` 前缀）。没连过就是 null。
   *
   * 它由**前端**持有并持久化，Rust 侧只是拿它来比对 —— 和「连接档案归前端、
   * Rust 只存活连接」是同一条分工。
   */
  expectedFingerprint: string | null;
  /**
   * 接受一把没见过的主机密钥。
   *
   * **只有用户在 TOFU 弹窗里点了「信任并继续」才会是 true。**
   * Rust 侧的默认行为是拒绝一切（russh 的 `check_server_key` 默认就返回 false），
   * 所以「静默接受任何主机密钥」这个状态在代码里不存在，不是靠约定避免的。
   */
  acceptNewHostKey: boolean;
}

/**
 * `ssh_open` 的结局。
 *
 * ⚠️ **主机密钥的两种拒绝走的是 `Ok`，不是 `Err`** —— 这是有意的，两个理由：
 *
 * 1. 前端要**区分**「没见过这把密钥」「密钥变了」「认证失败」，而 `Err` 那条路上
 *    只有字符串（`shared/platform/invoke.ts` 会把任何非字符串的 reject 变成
 *    `String(e)`，结构化信息到不了）。判别联合必须走 `Ok` 才能活着过来。
 * 2. 这本来就是仓库的既有教条：**服务器侧的结局是结果，不是故障**。
 *    「这台机器的密钥变了」是一次成功的往返得出的结论，不是连接坏了。
 *
 * `Err` 只留给前端拿到就只想显示出来的失败：连不上、握手超时、认证被拒。
 */
export type SshOpenOutcome =
  | {
      kind: 'ready';
      address: string;
      username: string;
      fingerprint: string;
      algorithm: string;
    }
  | {
      kind: 'hostKeyUnknown';
      host: string;
      port: number;
      algorithm: string;
      fingerprint: string;
    }
  | {
      kind: 'hostKeyMismatch';
      host: string;
      port: number;
      algorithm: string;
      /** 我们信任的那把 */
      expected: string;
      /** 服务器这次报的 */
      actual: string;
    };

/**
 * 会话流里推上来的事件 —— **IPC 契约**，字段名照着 Rust 侧 `devtoolkit-ssh`
 * 的 serde 输出写。
 *
 * `data` 里的字节是 **base64**。不直接传字符串：SSH 的数据边界会从中间切断
 * 多字节 UTF-8 字符，提前按字符串解码会把中文变成一串 U+FFFD，而且原始字节
 * 一旦丢了就恢复不回来。xterm 收 `Uint8Array` 能自己处理跨块的半个字符。
 */
export type TerminalEvent =
  | { kind: 'data'; bytes: string }
  | {
      kind: 'exit';
      /** 远端 shell 的退出码。连接断掉这类非正常结束是 null */
      code: number | null;
      /** 结束原因，直接显示给用户 */
      reason: string;
    };

/**
 * 解码之后的会话事件 —— 应用层用的形状。
 *
 * 和 `TerminalEvent` 分成两个类型，是为了让 **base64 停在服务层**：
 * 它是 IPC 的编码细节，store、TerminalHub、面板都不该知道有这回事。
 * 两个服务实现（tauri 解 base64、web 本来就是字节）各转一次，上层只认字节。
 */
export type SshEvent =
  | { kind: 'data'; bytes: Uint8Array }
  | { kind: 'exit'; code: number | null; reason: string };

// ------------------------------------------------------------------ 会话

export type SessionStatus = 'starting' | 'open' | 'closed';

/**
 * 一个打开的终端会话（= 一个标签页）。
 *
 * ⚠️ **这里没有终端内容。** 终端字节走 `TerminalHub`，不进 store ——
 * 每秒几十次的字节更新如果每次都过 `set()`，侧栏和标签栏会跟着一起重渲染。
 * store 只装「关于会话的元数据」这种人手级别的信息。
 *
 * `id` 是**会话 id 而不是档案 id**：一个档案可以同时开好几个会话（多条 TCP
 * 连接）。这是有意的 —— 一条连接卡住不会冻结另一条，代价是同一个档案会有
 * 多个远端登录。
 */
export interface SshSession {
  id: string;
  profileId: string;
  /** 标签上显示的名字 */
  title: string;
  status: SessionStatus;
  /** 远端 shell 的退出码。还在跑 / 非正常结束都是 null */
  exitCode: number | null;
  /** 结束原因。正常的 `exit 0` 也会有（「已退出」），因为那是个结果不是错误 */
  endedReason: string | null;
  /** 这次会话实际握手用的指纹 */
  fingerprint: string;
  /** 打开时用的尺寸，回放/重建终端时要用 */
  cols: number;
  rows: number;
}

// ------------------------------------------------------------------ 主机密钥

/**
 * 一条已知主机记录。
 *
 * 键是 **host + port**：同一台机器在 22 和 2222 上是两个不同的信任对象，
 * 只按 host 存会让「A 机器的 2222 端口」和「A 机器的 22 端口」互相冒充。
 */
export interface KnownHost {
  host: string;
  port: number;
  algorithm: string;
  /** `SHA256:` 开头的 base64（无填充），和 `ssh-keyscan` 的输出形式一致 */
  fingerprint: string;
  /** ISO 时间，只用于展示 */
  addedAt: string;
}

/** 首次连接一台没见过的机器时，等用户拍板的那个弹窗 */
export interface TrustPrompt {
  profileId: string;
  host: string;
  port: number;
  algorithm: string;
  /** 服务器这次报的指纹，等用户拿它和服务器管理员给的值对一下 */
  fingerprint: string;
}

/** 默认终端类型。`xterm-256color` 是 xterm.js 能正确渲染的上限 */
export const DEFAULT_TERM = 'xterm-256color';

/** SSH 默认端口 */
export const DEFAULT_SSH_PORT = 22;

/** 认证方式的中文名 */
export const AUTH_LABEL: Record<SshAuthKind, string> = {
  password: '密码',
  key: '私钥文件',
};

/** 连接种类的中文名 */
export const KIND_LABEL: Record<SshProfileKind, string> = {
  ssh: 'SSH 连接',
  local: '本地终端',
};

/**
 * 本地终端能选的 shell。**空串是「平台默认」**（推荐，也是默认值）。
 *
 * 后面几条是 Windows 上的：`pwsh`（PowerShell 7）不一定装了，`powershell`
 * （5.1）系统自带，`cmd` 永远在。名字交给 Rust 那边的 portable-pty 去 PATH 里找，
 * 它自己会补 `PATHEXT`。
 */
export const LOCAL_SHELLS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: '平台默认（推荐）' },
  { value: 'pwsh', label: 'PowerShell 7（pwsh）' },
  { value: 'powershell', label: 'Windows PowerShell' },
  { value: 'cmd', label: 'cmd' },
];
