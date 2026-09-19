/**
 * 智能体会话模块的服务层契约。
 *
 * 和 SSH 一样是**推**的：`open` 只是把进程开起来，之后字节源源不断地来，
 * 所以它收一个 `onEvent` 回调而不是返回结果。
 *
 * # 和 SSH 最不一样的一点：那个 shell 是我们自己起的
 *
 * SSH 连的是别人的机器，命令和路径都是远端的事。这个模块起的是**本机进程**，
 * 所以有几件 SSH 那边不用操心的事：
 * - **工作目录**（用户选的，会话就得在那儿跑）
 * - **环境变量**（我们要往里塞自己的两个：会话 id 和事件目录，
 *   状态检测全靠 hook 继承它们）
 * - **启动的是 shell，不是 agent 本身**：命令是「起来之后送进去的一行输入」。
 *   理由在 `core/types.ts` 的 `command` 字段上写着（Windows 上 npm 装的 CLI
 *   直接 spawn 很容易找不到；而且 agent 退出后用户该剩一个能用的 shell）
 */

import type { EnvironmentReport } from '../core/types';

/** 开一个会话需要的全部输入 */
export interface PtyOpenRequest {
  /** 会话 id。同时会作为 `DEVTOOLKIT_PANE_ID` 注入进去 */
  id: string;
  /** 在哪个目录里跑 */
  cwd: string;
  /**
   * 用哪个 shell。`null` = 平台默认
   * （Windows：pwsh → powershell → cmd 依次探测；macOS/Linux：`$SHELL` → /bin/sh）
   */
  shell: string | null;
  /** 起来之后送进 shell 的那条命令。空串 = 只起一个 shell */
  command: string;
  cols: number;
  rows: number;
  /**
   * 要注入的环境变量。
   *
   * ⚠️ 目前是 `DEVTOOLKIT_PANE_ID` 和 `DEVTOOLKIT_EVENT_DIR` 两个 ——
   * **状态检测整条链路都挂在这两个变量上**：agent 进程继承它们，
   * 它拉起来的 hook 进程再继承一次，hook 脚本靠它们知道「往哪写、替谁写」。
   * 少了任何一个，hook 脚本都会静默退出（这是刻意的，见包装脚本的说明）。
   */
  env: Record<string, string>;
  /**
   * 会话流。**在 `open` 返回之前就可能开始收到事件**（快的时候提示符会在
   * promise 决议之前就画出来），所以调用方必须在调 `open` **之前**把终端实例
   * 建好 —— 和 SSH 那条完全一样。
   */
  onEvent: (event: PtyEvent) => void;
}

/** 本地进程的字节流事件。和 `SshEvent` 形状一样，但**刻意不复用** —— 两个模块各改各的 */
export type PtyEvent =
  | { kind: 'data'; bytes: Uint8Array }
  | { kind: 'exit'; code: number | null };

/** 事件目录里一个还没解析的文件。解析在 `core/events.ts`，这边只管搬运 */
export interface EventFile {
  name: string;
  /** 文件的 mtime（毫秒） */
  at: number;
}

export interface AgentsClient {
  /**
   * 起一个会话。
   *
   * reject 表示**进程没起来**（目录不存在、shell 找不到），
   * `message` 是能直接显示给用户的中文。
   *
   * ⚠️ 和 SSH 一样：**每次调用都必须是一次独立的新通道**，
   * 通道对象跨调用复用会让后续事件石沉大海（见 `shared/platform/invoke.ts`）。
   */
  open(request: PtyOpenRequest): Promise<void>;

  /** 往会话里发键盘输入。**调用顺序就是到达顺序**（由实现用一条 promise 链兑现） */
  write(id: string, data: Uint8Array): Promise<void>;

  /** 尺寸变了。尺寸要先用 `shared/terminal/fit.ts` 夹过 */
  resize(id: string, cols: number, rows: number): Promise<void>;

  /** 关掉一个会话（连同它的整棵子进程树）。幂等 */
  close(id: string): Promise<void>;

  /** 收掉所有会话。给「前端重新加载了」兜底，`init()` 里调一次 */
  closeAll(): Promise<void>;

  /**
   * 取走攒下的状态事件。
   *
   * **取走即删除**：一个事件只用一次。应用没开着的时候事件会攒在目录里，
   * 下次启动一口气读到 —— 那时候对应的会话早就没了，调用方会按
   * 「id 对不上」丢掉它们（见 `core/events.ts` 的防伪造那段）。
   */
  takeEvents(): Promise<EventFile[]>;

  /** 事件目录的绝对路径。界面上要显示它（用户排查问题时第一个要看的东西） */
  eventsDir(): Promise<string>;
}

/** 要往哪个程序的配置里装状态检测 */
export type IntegrationTarget = 'claude' | 'codex';

/**
 * 集成状态。
 *
 * 五个都要能显示，别把 `missing` 和 `absent` 合并 —— 用户看到的文案完全不同
 * （「还没建过配置」vs「配置在，但状态检测没开」）。
 */
export type IntegrationState =
  /** 配置文件不存在 */
  | 'missing'
  /** 文件在，但没有我们的条目 */
  | 'absent'
  /** 我们的条目在，内容和我们写下去的一致 */
  | 'installed'
  /** 我们的条目在，但被用户改过 */
  | 'modified'
  /** 文件在，但不是我们能安全改的形状（不是合法 JSON/TOML）—— 拒绝写入 */
  | 'unusable';

export interface IntegrationStatus {
  target: IntegrationTarget;
  /** 配置文件的绝对路径 */
  path: string;
  state: IntegrationState;
  /** 可读的「会改成什么样」，直接显示给用户看。`unusable` 时是原因 */
  preview: string;
}

export interface IntegrationOutcome {
  target: IntegrationTarget;
  path: string;
  /** 备份文件的路径。没备份（原来就没有这个文件）就是 null */
  backupPath: string | null;
  preview: string;
}

/**
 * 写用户的配置文件。
 *
 * ⚠️ **路径不由这里决定**：接口上只有 `target` 这个枚举，具体写哪个文件
 * 完全由 Rust 侧算出来（用户主目录下的两个固定位置）。
 * 和「选目录/选文件让 Rust 自己弹对话框」是同一条规矩 ——
 * 凡是能碰用户主目录的路径，都不该有机会从 JS 那边传进来。
 */
export interface IntegrationClient {
  status(target: IntegrationTarget): Promise<IntegrationStatus>;
  apply(target: IntegrationTarget): Promise<IntegrationOutcome>;
  revert(target: IntegrationTarget): Promise<IntegrationOutcome>;
}

export interface AgentsServices {
  client: AgentsClient;
  integration: IntegrationClient;
  /** 环境自检（见 [`EnvironmentProbe`]）。单独一路：它不是「会话」那件事 */
  probe: EnvironmentProbe;
}

/**
 * 环境自检那一格用的（见 `core/types.ts` 的 `EnvironmentReport`）。
 *
 * 单独一个接口而不是塞进 `AgentsClient`：它不是「会话」那一路的东西，
 * 而且浏览器版给的是一个**诚实的假报告**（`shell` 是 `/bin/sh`、其余全是 null）——
 * 界面在浏览器里也画得出来，只是内容说明「这儿没有 Windows 那些东西」。
 */
export interface EnvironmentProbe {
  probe(): Promise<EnvironmentReport>;
}
