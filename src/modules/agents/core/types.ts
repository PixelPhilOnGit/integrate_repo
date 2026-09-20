/**
 * 智能体会话模块的数据形状。
 *
 * # 三层
 *
 * ```
 * 工作目录 (AgentWorkspace)   一个本地文件夹，比如 D:\work\api
 *   └── 会话 (AgentSession)   这个目录里跑着的一个 agent 进程，可以有多个
 *         └── 分屏 (Pane)     主区里的一块屏幕，显示某个会话
 * ```
 *
 * 会话数可以多于分屏数 —— **侧栏负责导航，主区是舞台**。所以分屏布局
 * （`PaneLayout`）是**独立于会话列表**的一份数据，见 `core/layout.ts`。
 *
 * ⚠️ 会话和图是**两回事**：会话是**运行时的进程**，应用退出就没了；
 * 布局可以持久化（下次启动恢复同一套分屏），但进程状态不能。
 */

/** 会话在跑什么。决定默认启动命令和图标 */
export type AgentKind = 'claude' | 'codex' | 'shell' | 'custom';

/**
 * 会话状态。
 *
 * 这是整个模块的核心 —— 用户开这个模块就是为了不用逐个窗口去看。
 *
 * - `starting` —— 进程刚起来，还没收到任何信号
 * - `idle`     —— 活着，但没在干活，也没在等（比如刚敲完 Ctrl+C）
 * - `working`  —— 正在干活，别打扰
 * - `waiting`  —— **需要你介入**：等授权、等你回答、或者闲在那儿等输入
 * - `done`     —— 这一回合干完了，结果等你去看
 * - `exited`   —— 进程没了（终态，之后什么信号都不改它）
 */
export type SessionStatus = 'starting' | 'idle' | 'working' | 'waiting' | 'done' | 'exited';

/** 需要用户介入的那一个。单独抽出来是因为「谁在等我」问得太频繁了 */
export const WAITING: SessionStatus = 'waiting';

export interface AgentWorkspace {
  id: string;
  /** 本地目录的绝对路径 */
  path: string;
  /** 展示名。默认取目录名，用户可改 */
  name: string;
}

/** 一次状态变化。用来在检查器里给用户看「这个会话刚才在干什么」 */
export interface StatusChange {
  status: SessionStatus;
  /** 毫秒时间戳 */
  at: number;
  /** 一句话说明，没有就是 null */
  detail: string | null;
}

export interface AgentSession {
  id: string;
  workspaceId: string;
  /** 展示名。默认是「claude #1」这种，用户可改 */
  title: string;
  kind: AgentKind;
  /**
   * 起来之后送进 shell 的那条命令。
   *
   * ⚠️ **不是 PTY 的 argv** —— pane 里起的永远是一个正常的 shell，
   * 这条命令是作为「初始输入」敲进去的。理由见 `services/types.ts` 头部：
   * Windows 上 npm 装的 CLI 直接 spawn 很容易找不到，而且 agent 退出之后
   * 你还应该剩一个能用的 shell。
   */
  command: string;
  status: SessionStatus;
  /** 进入当前状态的时刻。列表里「正在工作 12s」就是拿它算的 */
  statusAt: number;
  /** 当前状态的一句话说明（「等待授权：Bash」这种），没有就是 null */
  statusDetail: string | null;
  /** 进程退出码。没退出就是 null */
  exitCode: number | null;
  /** 最近几次状态变化，新的在前。给检查器看 */
  history: StatusChange[];
  /**
   * 用户最近一次**明确表示「我知道了」**的时刻。
   *
   * 队列的规则：`waiting` 且 `ackAt < statusAt`（也就是你在它进入等待**之前**
   * 表示的已知晓）才算「还没处理」。这样它再次进入等待时会自动回到队列里，
   * 不需要谁去重置什么标记。
   */
  ackAt: number | null;
  /**
   * 预留：把会话隔离到独立 git worktree 时的分支/目录。
   *
   * v1 不做（用户明确推迟），但字段先留着 —— 到时候是给它赋值，
   * 不是重新设计 `AgentSession`。
   */
  worktree: string | null;
}

/** 状态的中文名。界面上只该通过这里拿文案 */
export const STATUS_LABEL: Record<SessionStatus, string> = {
  starting: '启动中',
  idle: '空闲',
  working: '正在工作',
  waiting: '需要你',
  done: '已完成',
  exited: '已退出',
};

/** agent 类型的中文名 */
export const KIND_LABEL: Record<AgentKind, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  shell: '终端',
  custom: '自定义',
};

/**
 * agent 的启动参数。**全局一份**，所有工作目录共用（用户明确要的这个粒度）。
 *
 * 只给 claude / codex 两个 —— 普通终端没有「参数」这回事（它的命令是空的，
 * 参数没处加）。`custom` 同理，它连默认命令都还没有。
 *
 * ⚠️ 值是**原样追加到启动命令后面**的，不过任何解析、不切词：
 * `--dangerously-skip-permissions` 这种就是一整串照抄。所以这里也不做校验 ——
 * 参数合不合法是 CLI 自己的事，它报的错比我们猜得准。
 */
export interface LaunchArgs {
  claude: string;
  codex: string;
}

export const NO_LAUNCH_ARGS: LaunchArgs = { claude: '', codex: '' };

/**
 * 「建几个什么类型的会话」—— 新建对话框和 store 之间那一条约定。
 *
 * 是数组而不是 `Record<AgentKind, number>`：**顺序有意义**（网格按这个顺序铺，
 * 用户填的顺序就是他希望看到的顺序），而且将来只加一种类型时不用动结构。
 */
export interface SessionRequest {
  kind: AgentKind;
  count: number;
}

/**
 * 一次新建里**每类**会话的上限：对话框里是输入框的 `max`，store 里是保险。
 *
 * 每个会话都是一个真进程，一次开几十个不是笔误就是手改过的数据。
 */
export const MAX_SESSIONS_PER_KIND = 9;

/**
 * IPC 契约：Rust 侧 `agent_open` 那条通道推上来的消息。
 *
 * 字段名**照着 Rust 的 serde 输出写**（tag 是 `kind` + camelCase），
 * 不是照着 Rust 的结构体名字翻译的 —— HANDOFF 里那个只有真机能抓到的 bug
 * （`rename_all` 不改变体内部字段名）就是两边各写各的字段名导致的。
 * Rust 那边配了 `contract` 测试，拿这里会发出去的 JSON 字面量反序列化。
 *
 * 终端字节走 base64：Rust 的 `Vec<u8>` 过 serde_json 会变成数字数组
 * （每个字节三四个字符），也不能按字符串传 —— 数据边界会切断多字节 UTF-8。
 */
export type PtyChannelEvent =
  | { kind: 'data'; bytes: string }
  | { kind: 'exit'; code: number | null };

/**
 * 环境自检的结果（Rust 侧 `probe_environment` 原样传过来）。
 *
 * # 它是干什么的
 *
 * 真机上出过一次：用户 VS Code 的终端里 `claude` 好好的，我们窗格里报
 * 「找不到 git-bash」—— 同一个 claude、同一台机器，**差别只在环境**，
 * 而环境是不可见的。有了这个，用户点一下就看见**我们**解析出了什么，
 * 和他的终端一比就知道差在哪。
 */
export interface EnvironmentReport {
  /** 起窗格时用的 shell */
  shell: string;
  /** 子进程拿到的那份 PATH 有几条 */
  pathCount: number;
  /** PATH 的前几条（整串太长，界面上放不下） */
  pathHead: string[];
  /** `claude.cmd` / `claude.exe` 解析到哪。null = PATH 里找不到 */
  claude: string | null;
  git: string | null;
  /** 我们替 claude 找的 bash。**null 就是「窗格里跑不起来」的原因** */
  bash: string | null;
  /**
   * PATH 上第一个 `bash.exe`。
   *
   * ⚠️ Windows 上大概率是 `C:\Windows\System32\bash.exe` —— **那是 WSL 的**，
   * 不是 Git Bash，claude 也不认它。单独列出来是因为「claude 说找不到 bash」
   * 的常见原因就是它（真机上就是这么栽的）。
   */
  bashOnPath: string | null;
  /** `CLAUDE_CODE_GIT_BASH_PATH` 当前的值 */
  gitBashSetting: string | null;
}
