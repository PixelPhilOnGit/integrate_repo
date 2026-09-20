/**
 * 智能体会话模块的状态。
 *
 * # 它管什么
 *
 * 「关于会话的元数据」：工作目录、会话、分屏布局、状态、集成情况。
 *
 * # 它不管什么
 *
 * **终端字节不经过这里**（和 SSH 模块同一条规矩）：每秒几十次的流走
 * `core/terminalHub.ts`，React 全程看不见 —— 混进来的话，agent 每输出一行
 * 就会把侧栏和状态栏重渲染一遍。
 *
 * # 状态从哪来
 *
 * 五路信号（hook 事件文件、Codex 的 notify、终端 OSC 序列、用户的键盘、
 * 进程退出）全部汇到 `core/status.ts` 那个**纯函数状态机**里，
 * 这个 store 只负责「谁在什么时候喂了它一条什么」。
 * 规则一条都不写在这里 —— 那层是要被单测盖满的，散在这儿就没法审了。
 */

import { attachAgentBus, type AgentBus } from '../../../shared/agentBus';
import { withSecrets } from '../../../shared/platform/secrets';
import { newId } from '../../../shared/ids';
import { platform } from '../../../shared/platform';
import { createKeyValue } from '../../../shared/platform/kv';
import { agentsServices } from '../services';
import { describeError } from '../../../shell/store';
import type { ShellApi } from '../../../shell/types';
import { agentHub } from '../core/terminalHub';
import { parseEventName, signalOf } from '../core/events';
import {
  closePane,
  gridColsFor,
  gridLayout,
  leafPane,
  neighborOf,
  rectsOf,
  replacePane,
  replaceWith,
  setRatio,
  splitPane,
  type Direction,
  type PaneLayout,
  type SplitDir,
  type SplitPath,
} from '../core/layout';
import { createOscScanner, type OscScanner } from '../core/osc';
import { attentionQueue, reduceSignal, type AgentSignal } from '../core/status';
import { withPin } from '../core/workspaces';
import {
  hostKeyOf,
  type RemoteAuthKind,
  remoteOf,
  type RemoteTarget,
  type RemoteTargetPayload,
} from '../core/types';
import {
  MAX_SESSIONS_PER_KIND,
  NO_LAUNCH_ARGS,
  type AgentKind,
  type AgentSession,
  type AgentWorkspace,
  type EnvironmentReport,
  type LaunchArgs,
  type SessionRequest,
} from '../core/types';
import type {
  AgentsServices,
  IntegrationOutcome,
  IntegrationState,
  IntegrationStatus,
  IntegrationTarget,
} from '../services/types';

/**
 * 建会话时先按这个尺寸开 PTY，挂载之后马上会被 `fit()` 修正。
 *
 * 为什么不是等量准了再开：开进程是**建会话的一部分**，那时候终端还没挂到
 * DOM 上，量不到真实尺寸。给一个常见的默认值，比给 1×1 好得多。
 */
const INITIAL_COLS = 80;
const INITIAL_ROWS = 24;

/** 状态事件的轮询间隔。低频、但不是给人看的数字，所以随手取一个 */
const POLL_MS = 1000;

/**
 * 事件时间戳的宽限。见 `drainEvents` 里那段 —— 它挡的是「删不掉被重读」，
 * 但**不能误伤刚写下的文件**（有些文件系统的 mtime 只精确到 2 秒）。
 */
const EVENT_GRACE_MS = 2000;

/**
 * 各 agent 的默认启动命令。
 *
 * v1 只有这三个预设。自定义命令的入口（`createSession` 的 `opts.command`）
 * 和 `AgentKind` 里的 `custom` 是留好的位置，界面上还没暴露 ——
 * 加的时候是一个输入框的事，不用改数据模型。
 */
const DEFAULT_COMMAND: Record<AgentKind, string> = {
  claude: 'claude',
  codex: 'codex',
  shell: '',
  custom: '',
};

/**
 * 「这台机器没见过 / 指纹变了」时等用户拍板的那一次。
 *
 * ⚠️ `sessionId` 要记着：用户点了信任之后**要拿它重试那次连接**——
 * 会话这时候还没起来（进程在远端，我们连都没连上）。
 */
export interface TrustPrompt {
  sessionId: string;
  workspaceId: string;
  algorithm: string;
  fingerprint: string;
  /** 指纹**变了**的时候带上旧的那个（界面上要并排显示）。没见过就是 null */
  expected: string | null;
}

export interface AgentsState {
  ready: boolean;
  workspaces: AgentWorkspace[];
  sessions: AgentSession[];
  /**
   * 一个**窗口**一套分屏布局，按工作目录索引。
   *
   * ⚠️ 不是一份全局布局：用户的心智是「这个项目我摆了四个格子」，切去看另一个
   * 项目不该把那四个格子拆掉。所以侧栏点哪个目录，右边就换它那一套。
   * 目录没有了（或者里面一块都没了）就没有这个键 —— 空对象 = 空窗口。
   */
  layouts: Record<string, PaneLayout>;
  /** 现在显示的是哪个窗口（工作目录）。null = 一个目录都没加 */
  activeWorkspaceId: string | null;
  /**
   * 侧栏里哪些窗口被**展开**了（默认收起）。
   *
   * 放进 state 而不是组件里：切去别的模块再回来，React 会把侧栏整个卸载，
   * 组件里的展开状态就没了 —— 用户会看到自己刚点开的那一行又合上了。
   * （SSH 模块的侧栏是同一个理由。）
   */
  expanded: Record<string, boolean>;
  /**
   * 当前窗口里聚焦的那一块。
   *
   * ⚠️ 只对**当前窗口**有意义：切窗口时它会跟着落到新窗口的第一块上，
   * 否则键盘还指向上一个窗口的某块，用户看到的和键盘指向的不是同一处。
   */
  focusedId: string | null;
  /** 检查器里在看哪个会话。可以和 focused 不同（点侧栏看一眼，不动屏幕） */
  selectedId: string | null;
  /** 事件目录的绝对路径。给检查器显示 */
  /**
   * 首次连一台没见过的远端机器时，等用户拍板的弹窗。
   *
   * 形状和 SSH 模块那个一样（TOFU）：**指纹摆出来让用户核对**，
   * 不点信任就连不上。远端会话的状态检测本来就弱（远端写不了我们的钩子），
   * 这一道是那条路上**唯一**的安全决策，不能省。
   */
  trustPrompt: TrustPrompt | null;
  /**
   * 信任过的机器（`host:port` → 指纹）。
   *
   * ⚠️ **和 SSH 模块那份是两套**：同一台机器，用户先用 SSH 模块连过、
   * 再用这里的远端会话连，会被问两次。v1 接受这个重复 —— 合起来要跨模块
   * 共享一份「已知主机」，那是另一件事（见 HANDOFF）。
   */
  knownHosts: Record<string, string>;
  eventsDir: string | null;
  /** 最近一次收到状态事件的时刻。集成向导用它回答「到底通了没有」 */
  lastEventAt: number | null;
  /**
   * 事件目录读失败的原因。
   *
   * 单独存而不是扔进外壳的错误条：轮询一秒一次，失败一次就弹一条错误条
   * 会把界面刷爆。这里是「安静但看得见」——检查器里显示一行。
   */
  eventsError: string | null;
  /** 集成状态，按目标存。null = 还没查过 */
  integration: Record<IntegrationTarget, IntegrationStatus | null>;
  /** 集成操作进行中（按钮要禁用，避免连点写两次） */
  integrating: boolean;
  /**
   * 环境自检的结果。null = 还没查过。
   *
   * 放在 state 里是因为它是**给人看的**（检查器那一格）：用户 VS Code 里
   * 能跑、窗格里跑不起来的时候，这是唯一能看到「我们这边到底解析出了什么」
   * 的地方。它不是流、也不频繁变，人手级别的东西。
   */
  environment: EnvironmentReport | null;
  /**
   * agent 的启动参数，**全局一份**（见 `LaunchArgs` 的说明）。
   *
   * 存在 state 里而不是每次现读：新建会话时要同步取（`commandFor`），
   * 而「参数改了但新会话没带上」这种偏差是静默的 —— 用户只会觉得
   * 「我明明设过」。
   */
  launchArgs: LaunchArgs;
  /**
   * Windows 上给 claude 用的 Git Bash 路径（`bin\bash.exe`）。
   *
   * **留空 = 让 Rust 那边自己找**（先问注册表、再从 PATH 里的 git.exe 上溯、
   * 再看几个标准位置）。填了就是用户说了算 —— 他机器上的 Git 可能装在
   * 任何地方（比如 `D:\software\git\install\Git`，压根不在 PATH 里），
   * 那种情况下自动找可能扑空，而这个框是那条出路。
   */
  gitBashPath: string;
}

export class AgentsStore {
  private listeners = new Set<() => void>();
  private state: AgentsState = {
    ready: false,
    workspaces: [],
    sessions: [],
    layouts: {},
    activeWorkspaceId: null,
    expanded: {},
    focusedId: null,
    selectedId: null,
    eventsDir: null,
    trustPrompt: null,
    knownHosts: {},
    lastEventAt: null,
    eventsError: null,
    integration: { claude: null, codex: null },
    integrating: false,
    environment: null,
    launchArgs: NO_LAUNCH_ARGS,
    gitBashPath: '',
  };
  private initPromise: Promise<void> | null = null;
  /** 外壳能力。默认空实现：store 可能在注入之前就被构造（单测里直接 new） */
  private shell: ShellApi = { setStatus: () => {}, reportError: () => {} };
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * 每个会话一个 OSC 扫描器。
   *
   * **必须按会话分开**：扫描器的状态是「上一条序列攒到哪了」，
   * 两个会话的字节流混在一起会拼出谁也认不出来的东西。
   */
  private scanners = new Map<string, OscScanner>();
  private kv = createKeyValue({ tauriFile: 'agents.json', webKey: 'devtoolkit.agents.v1' });

  /**
   * 会话退出时要通知谁（任务模块用它回写一条进度）。
   *
   * ⚠️ 会话 id 是**运行时**的：这份订阅只在进程活着时有意义，所以它不落库、
   * 重启就清空（见 `shared/agentBus.ts` 那段解释）。
   */
  private exitListeners = new Set<(sessionId: string) => void>();

  /**
   * 「这一次连接允许接受没见过的密钥」—— 用户在弹窗里点过「信任」的那些会话。
   *
   * ⚠️ **一次性、不落盘**：那是「这一下」的授权，不是「这台机器」的。
   * 落盘的话就等于「信任过一台机器之后永远接受任何指纹」—— 那正是 TOFU 要防的。
   * 用完就删（见 `remotePayload`）。
   */
  private acceptedOnce = new Set<string>();

  constructor(private services: AgentsServices) {
    // hub 的两个出口接在这里。做成可写字段而不是构造参数，是为了避开
    // store ↔ hub 的循环依赖（hub 不认识 store，store 认识 hub）
    agentHub.onInput = (sessionId, data) => {
      void this.onUserInput(sessionId, data);
    };

    // 把自己的能力挂到那个中立槽位上，别的模块（任务）就能「把一件事交给某个会话」。
    // 接口在 `shared/agentBus.ts`：**只定义类型，不 import 任何模块**，
    // 所以外壳和共享层依然不认识智能体会话。
    attachAgentBus(this.asBus());
    agentHub.onResize = (sessionId, cols, rows) => {
      void this.services.client.resize(sessionId, cols, rows);
    };
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getSnapshot = (): AgentsState => this.state;

  attachShell(shell: ShellApi): void {
    this.shell = shell;
  }

  private patch(patch: Partial<AgentsState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }

  // ------------------------------------------------------------ 生命周期

  /**
   * 惰性初始化。由 `onActivate` 触发，重复调用只会真正跑一次。
   *
   * 里面有一件**必须做**的事：`closeAll()`。webview 一刷新，前端就认不得
   * Rust 侧还活着的那些会话了 —— 用户在新界面上看不见也关不掉它们，
   * 而它们还在后台跑着、烧着 token。启动时收一遍等于把孤儿收干净。
   */
  init(): Promise<void> {
    this.initPromise ??= this.doInit();
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    // 先读工作目录：会话要按它分组显示
    const workspaces = await this.loadWorkspaces();
    // 启动参数也一起读：**新建会话时要用它拼命令**，晚读一步就可能漏掉
    const launchArgs = await this.loadLaunchArgs();
    const gitBashPath = await this.loadGitBashPath();
    // 信任过的机器（远端会话用）。读不出来就当空 —— 大不了重连时再核对一次指纹
    const knownHosts = await this.loadKnownHosts();
    this.patch({
      workspaces,
      launchArgs,
      gitBashPath,
      knownHosts,
      // 起来就显示第一个窗口：一个目录都没有的话就是空的
      activeWorkspaceId: workspaces[0]?.id ?? null,
    });

    // 再收孤儿。**和读盘的顺序不能反**：先读盘的话，中间这段时间从界面上
    // 看是一切正常的，但后台还挂着上一次的会话
    await this.services.client.closeAll().catch(() => undefined);

    let eventsDir: string | null = null;
    try {
      eventsDir = await this.services.client.eventsDir();
    } catch {
      // 拿不到路径不影响用，只是「集成」那张卡片上会显示未知
    }

    this.patch({ ready: true, eventsDir });

    // 顺便把两边的集成状态查一遍：检查器上那张卡片一开始就该是有内容的，
    // 而不是「未知」——用户看到「未知」只会以为是坏的
    await Promise.all([this.refreshIntegration('claude'), this.refreshIntegration('codex')]);

    this.startPolling();
  }

  /**
   * 工作目录的读写 —— **外面套了钥匙串**。
   *
   * ⚠️ 远端工作目录里带着那台机器的**密码 / 私钥口令**（见 `core/types.ts` 的
   * `remoteOf`），它们不该躺在键值表里。声明的就是那几个字段；
   * 本机目录一个都没有，于是那一层对它是完全透明的。
   *
   * 和连接档案走的是**同一套机制**（`shared/platform/secrets.ts` 的
   * `withSecrets`）：没有钥匙串的机器上退回老路、迁移是「写进去成功了才删」。
   */
  private readonly workspaceStore = withSecrets<AgentWorkspace>(
    {
      load: async () => this.sanitizeWorkspaces(await this.kv.get<unknown>('workspaces')),
      save: async (rows) => {
        await this.kv.set('workspaces', rows);
      },
    },
    'agents',
    ['remotePassword', 'remotePassphrase'],
  );

  /** 把存储里的不可信数据整形成 `AgentWorkspace[]`（纯函数，钥匙串那层在外面） */
  private sanitizeWorkspaces(raw: unknown): AgentWorkspace[] {
    if (!Array.isArray(raw)) return [];

    // 按不可信输入处理：手改过的、旧版本的都要能读，
    // 读不出来的那一条丢掉而不是让整份作废
    const out: AgentWorkspace[] = [];
    for (const item of raw) {
      if (typeof item !== 'object' || item === null) continue;
      const w = item as Record<string, unknown>;
      const id = w['id'];
      const path = w['path'];
      const name = w['name'];
      if (typeof id !== 'string' || id === '') continue;
      if (typeof path !== 'string' || path === '') continue;
      const str = (k: string): string | undefined => {
        const v = w[k];
        return typeof v === 'string' && v !== '' ? v : undefined;
      };
      out.push({
        id,
        path,
        name: typeof name === 'string' && name !== '' ? name : path,
        // ⚠️ 只认**真正的 `true`** —— 存储里的东西不可信，`"false"` / `1` 这种
        // 都不该让一个目录莫名其妙排到最上面
        ...(w['pinned'] === true ? { pinned: true } : {}),
        // 远端那几个字段：**空的不写进去**（本机目录不该带着一堆空字段）
        ...(str('remoteHost') === undefined ? {} : { remoteHost: str('remoteHost') }),
        ...(typeof w['remotePort'] === 'number' ? { remotePort: w['remotePort'] } : {}),
        ...(str('remoteUsername') === undefined ? {} : { remoteUsername: str('remoteUsername') }),
        ...(w['remoteAuthKind'] === 'password' || w['remoteAuthKind'] === 'key'
          ? { remoteAuthKind: w['remoteAuthKind'] }
          : {}),
        ...(str('remotePrivateKeyPath') === undefined
          ? {}
          : { remotePrivateKeyPath: str('remotePrivateKeyPath') }),
        // ⚠️ 这两个是**敏感字段**，钥匙串那层会把它们摘掉再存；
        // 读的时候它会填回来（没有钥匙串时就从键值表里读）—— 这里只管形状
        ...(str('remotePassword') === undefined
          ? {}
          : { remotePassword: str('remotePassword') }),
        ...(str('remotePassphrase') === undefined
          ? {}
          : { remotePassphrase: str('remotePassphrase') }),
      });
    }
    // ⚠️ 这里**不排序**：数组顺序永远是「用户添加的顺序」，置顶只在画的时候拎一下
    // （排序写回数组的话，取消置顶就再也回不到原位了 —— 见 `toggleWorkspacePin`）
    return out;
  }

  /** 读回工作目录（整形 + 钥匙串那一层，见 `workspaceStore`） */
  private async loadWorkspaces(): Promise<AgentWorkspace[]> {
    return this.workspaceStore.load();
  }

  /**
   * 读信任过的机器指纹。
   *
   * ⚠️ **读不出来就当空**（而不是报错）：那意味着下次连远端会重新问一遍指纹 ——
   * 一次多出来的确认，比「远端会话整个用不了」轻得多。
   */
  private async loadKnownHosts(): Promise<Record<string, string>> {
    const raw = await this.kv.get<unknown>('knownHosts');
    if (typeof raw !== 'object' || raw === null) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === 'string' && v !== '') out[k] = v;
    }
    return out;
  }

  /** 读 Git Bash 路径（就一个字符串，读不出来就当没填） */
  private async loadGitBashPath(): Promise<string> {
    const raw = await this.kv.get<unknown>('git_bash');
    return typeof raw === 'string' ? raw : '';
  }

  /**
   * 改 Git Bash 路径。**只影响之后新建的会话** —— 已经在跑的进程改不了。
   *
   * 留空是**合法值**（= 让 Rust 自己找），所以这里不校验「必须存在」：
   * 路径对不对由 Rust 那边开窗格时验证（它会看文件在不在），错了的表现是
   * claude 报它自己那句错，用户回来改这个框就行。
   */
  setGitBashPath(path: string): void {
    const trimmed = path.trim();
    this.patch({ gitBashPath: trimmed });
    void this.kv.set('git_bash', trimmed).catch(() => undefined);
  }

  /** 读启动参数。**按不可信输入处理**：手改过的、旧版本的都要能读 */
  private async loadLaunchArgs(): Promise<LaunchArgs> {
    const raw = await this.kv.get<unknown>('launch_args');
    if (typeof raw !== 'object' || raw === null) return NO_LAUNCH_ARGS;

    const obj = raw as Record<string, unknown>;
    const pick = (key: keyof LaunchArgs): string => {
      const value = obj[key];
      return typeof value === 'string' ? value : '';
    };
    return { claude: pick('claude'), codex: pick('codex') };
  }

  /**
   * 改启动参数。**只影响之后新建的会话** —— 已经在跑的进程改不了它的命令行
   * （那是操作系统的事，不是我们的），所以界面上要写清楚这一点。
   */
  setLaunchArgs(next: LaunchArgs): void {
    const cleaned: LaunchArgs = { claude: next.claude.trim(), codex: next.codex.trim() };
    this.patch({ launchArgs: cleaned });
    void this.kv.set('launch_args', cleaned).catch(() => undefined);
  }

  /**
   * 某个类型的会话该起什么命令：默认命令 + 该类型的启动参数。
   *
   * 拼接是**空格加原样追加**（见 `LaunchArgs` 的说明）。普通终端和自定义类型
   * 直接返回默认值 —— 前者本来就只起一个 shell，拼出来仍是空串，
   * 「`command === ''` = 只起 shell」那条判断不会被破坏。
   */
  commandFor(kind: AgentKind): string {
    const base = DEFAULT_COMMAND[kind];
    if (kind !== 'claude' && kind !== 'codex') return base;
    const args = this.state.launchArgs[kind].trim();
    return args === '' ? base : `${base} ${args}`;
  }

  /**
   * 开始轮询状态事件。
   *
   * **初始化和「是不是当前模块」无关**：用户切到别的模块去画图的时候，
   * 正是最需要知道「有 agent 在等我」的时候。
   */
  private startPolling(): void {
    if (this.pollTimer !== null) return;
    this.pollTimer = setInterval(() => {
      void this.drainEvents();
    }, POLL_MS);
  }

  /** 停止轮询。只给测试用 —— 真实运行时它该活到进程结束 */
  stopPolling(): void {
    if (this.pollTimer === null) return;
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  // ------------------------------------------------------------ 事件管道

  /**
   * 取走事件目录里攒下的状态事件，喂给状态机。
   *
   * 这条路上有三道关，缺一道界面就会被外部程序牵着走：
   * 1. `parseEventName` —— 文件名形状不对的（目录里的杂物）直接丢掉
   * 2. **会话 id 必须对得上一个活着的会话** —— 这是防伪造那道；
   *    文件名是我们自己生成的随机 id，外面想蒙一个得先猜中那串随机数
   *
   * 过了这三道的按**时间顺序逐条**应用。
   *
   * ⚠️ 曾经这里是「同一个会话只留最新那条」（为了避开没开机时攒下的一堆事件）。
   * 那个写法有个真实的漏洞：`working` 紧接着 `waiting` 这一对会被压成一条
   * `waiting`，于是「它离开过等待又回来了」这个事实就没了 —— 而用户确认过的
   * 会话正要靠这个事实**再次**提醒他。状态机本身就会吃掉重复的信号
   * （返回同一个对象），所以逐条应用既不会多记流水账，也不会丢信息。
   */
  async drainEvents(): Promise<void> {
    let files;
    try {
      files = await this.services.client.takeEvents();
    } catch (e) {
      this.patch({ eventsError: describeError(e) });
      return;
    }
    if (this.state.eventsError !== null) this.patch({ eventsError: null });
    if (files.length === 0) return;

    const parsed = files
      .map((f) => parseEventName(f.name, f.at))
      .filter((e) => e !== null)
      .filter((e) => this.sessionById(e.paneId) !== null);

    let latest: number | null = null;
    // 目录的列举顺序没有保证（Windows 上尤其是），自己排一遍
    for (const event of [...parsed].sort((a, b) => a.at - b.at)) {
      const session = this.sessionById(event.paneId);
      if (session === null) continue;

      // ⚠️ **比当前状态还早的事件丢掉。**
      //
      // Rust 那边「取走即删」在删不掉的时候（Windows 上文件被别的进程占着）
      // **不会回滚**，宁可下次重读一遍 —— 那条重读带着**旧的 mtime**。
      // 不挡的话它会把状态改回旧值：比如会话已经跑了十分钟，一条十秒前的
      // 「在等你」被重读一次，状态点就倒回去了。
      //
      // 留 2 秒的宽限是因为**文件系统的 mtime 精度不一样**：NTFS 是 100ns，
      // 而 exFAT/FAT32 只有 2 秒。放一个刚写下的文件却因为「mtime 比刚刚那次
      // 按键早 1.4 秒」被丢掉，是比重复应用更糟的错 —— 提醒会凭空消失。
      if (event.at + EVENT_GRACE_MS < session.statusAt) continue;

      this.applySignal(event.paneId, signalOf(event), event.at);
      latest = latest === null ? event.at : Math.max(latest, event.at);
    }
    if (latest !== null) this.patch({ lastEventAt: latest });
  }

  /** 一条信号 → 状态机 → 写回。没变化时一个字都不动（状态机返回同一个对象） */
  private applySignal(sessionId: string, signal: AgentSignal, at: number): void {
    const session = this.sessionById(sessionId);
    if (session === null) return;
    const next = reduceSignal(session, signal, at);
    if (next === session) return;
    this.patch({
      sessions: this.state.sessions.map((s) => (s.id === sessionId ? next : s)),
    });
  }

  // ------------------------------------------------------------ 进程事件

  /** 进程推上来的东西：字节，或者退出 */
  private onPtyEvent(sessionId: string, event: { kind: 'data'; bytes: Uint8Array } | { kind: 'exit'; code: number | null }): void {
    if (event.kind === 'data') {
      // 先扫 OSC，再把**原封不动**的字节喂给终端。
      // ⚠️ 扫描器一个字节都不吃掉：OSC 里还有设标题、超链接这些东西（见 core/osc.ts）
      const scanner = this.scanners.get(sessionId);
      if (scanner !== undefined) {
        for (const notice of scanner.feed(event.bytes)) {
          this.applySignal(
            sessionId,
            // 通知里没带文字时**不传说明**（而不是传 null）：状态机那边
            // 「没带」和「明确没有」是两回事，前者不该抹掉已有的说明
            { kind: 'needs-attention', detail: notice.text === '' ? undefined : notice.text },
            Date.now(),
          );
        }
      }
      agentHub.feed(sessionId, event.bytes);
      return;
    }

    // 退出是**一条结果**，不是执行失败 —— 终端里显示出来就行，不弹错误条
    this.applySignal(sessionId, { kind: 'exited', code: event.code }, Date.now());
    this.scanners.delete(sessionId);

    // 告诉订阅者（任务模块据此往那条任务的进度里回写一笔）
    for (const cb of this.exitListeners) cb(sessionId);
    agentHub.note(
      sessionId,
      event.code === null ? '（进程已退出）' : `（进程已退出，退出码 ${event.code}）`,
    );
  }

  /**
   * 对外（别的模块）暴露的那一点点能力 —— 见 `shared/agentBus.ts`。
   *
   * **刻意做得窄**：别处要的只是「有哪些会话能接活」和「把一句话送进去」，
   * 分屏、状态机、事件目录那些它一个都用不上，也就不该看见。
   */
  private asBus(): AgentBus {
    return {
      list: () =>
        this.state.sessions
          // 已经结束的不算：把任务派给一个死掉的会话是纯粹的坑
          .filter((s) => s.status !== 'exited')
          .map((s) => ({
            sessionId: s.id,
            title: s.title,
            workspace: this.workspaceById(s.workspaceId)?.name ?? '（未知目录）',
            kind: s.kind,
          })),

      send: (sessionId, text) => {
        const session = this.state.sessions.find((s) => s.id === sessionId);
        if (session === undefined || session.status === 'exited') return false;

        // ⚠️ **末尾补一个回车**：送进去的是「一句话」，不是半行按键。
        // 不补的话它就一直躺在提示符上，用户还得自己去按一下 —— 而派任务
        // 这个动作的语义就是「让它开始干」。
        const bytes = new TextEncoder().encode(`${text}\r`);
        void this.services.client.write(sessionId, bytes).catch(() => undefined);

        // 当成用户敲的：它确实要开始干活了，状态点该从「空闲」变「正在工作」
        this.applySignal(sessionId, { kind: 'user-typed' }, Date.now());
        return true;
      },

      onExit: (cb) => {
        this.exitListeners.add(cb);
        return () => {
          this.exitListeners.delete(cb);
        };
      },
    };
  }

  /** 用户在窗格里敲了键 */
  private async onUserInput(sessionId: string, data: Uint8Array): Promise<void> {
    // 1. **先记「用户敲了键」，再发给进程。** 顺序反了会出错：
    //
    //    进程收到这一下之后可能立刻回话（按 Enter 之后它往往马上就输出，
    //    而输出里可能带着终端通知序列）。如果先 `await` 写、再记这条信号，
    //    那条信号就落在了进程回话**之后** —— 于是刚收到的「需要你」当场被
    //    改回「正在工作」，通知里那句话也被抹掉。
    //    （这个 bug 是 e2e 抓到的，单测里因为假客户端的 write 不吐字节而漏掉了。）
    //
    //    用户的动作是**唯一**能推翻状态的依据（其余全靠猜，见 core/status.ts）。
    //    只要往这个窗格里敲了键，就当他已经在处理了 —— 包括用方向键选
    //    权限菜单里的选项
    this.applySignal(sessionId, { kind: 'user-typed' }, Date.now());

    // 2. Ctrl+C 单独报一次：Claude Code 的 Stop hook 在用户打断时**不触发**，
    //    不补这一下，状态会永远卡在「正在工作」
    if (data.includes(0x03)) {
      this.applySignal(sessionId, { kind: 'user-interrupted' }, Date.now());
    }

    // 3. 最后才发给进程。失败就忽略：用户正在打字时对面退出是很正常的事
    await this.services.client.write(sessionId, data).catch(() => undefined);
  }

  // ------------------------------------------------------------ 工作目录

  /** 弹目录选择框，加一个工作目录。用户取消就什么都不做 */
  async addWorkspace(): Promise<string | null> {
    const path = await platform.pickWorkspace();
    if (path === null) return null;

    // 同一个目录不重复加（Windows 上路径不区分大小写，比较时统一小写）
    const exists = this.state.workspaces.find(
      (w) => w.path.toLowerCase() === path.toLowerCase(),
    );
    if (exists !== undefined) {
      this.shell.setStatus('这个目录已经在列表里了');
      return exists.id;
    }

    const workspace: AgentWorkspace = { id: newId('ws'), path, name: baseName(path) };
    this.patch({
      workspaces: [...this.state.workspaces, workspace],
      // 新加的目录直接切过去：用户刚选完文件夹，下一步就是往里开会话
      activeWorkspaceId: workspace.id,
    });
    this.persistWorkspaces();
    return workspace.id;
  }

  /**
   * 加一个**远端**工作目录（一台机器 + 那台机器上的一个目录）。
   *
   * ⚠️ 密码和私钥口令进系统钥匙串（`workspaceStore` 声明了那两个字段），
   * 不只是「不写日志」那种程度的处理。
   */
  async addRemoteWorkspace(input: {
    host: string;
    port: number;
    username: string;
    authKind: RemoteAuthKind;
    password: string;
    privateKeyPath: string;
    passphrase: string;
    path: string;
    name: string;
  }): Promise<string> {
    // 同一台机器的同一个目录不重复加（三样都一样才算同一个）
    const exists = this.state.workspaces.find(
      (w) =>
        w.remoteHost === input.host && w.remotePort === input.port && w.path === input.path,
    );
    if (exists !== undefined) {
      this.shell.setStatus('这个目录已经在列表里了');
      return exists.id;
    }

    const workspace: AgentWorkspace = {
      id: newId('ws'),
      path: input.path,
      name: input.name !== '' ? input.name : `${input.host}:${baseName(input.path)}`,
      remoteHost: input.host,
      remotePort: input.port,
      remoteUsername: input.username,
      remoteAuthKind: input.authKind,
      // 空的不写进去（本机那几个字段就是一个都不写）
      ...(input.password === '' ? {} : { remotePassword: input.password }),
      ...(input.privateKeyPath === '' ? {} : { remotePrivateKeyPath: input.privateKeyPath }),
      ...(input.passphrase === '' ? {} : { remotePassphrase: input.passphrase }),
    };

    this.patch({
      workspaces: [...this.state.workspaces, workspace],
      // 新加的目录直接切过去（和本机那条路一样）
      activeWorkspaceId: workspace.id,
    });
    this.persistWorkspaces();
    return workspace.id;
  }

  /**
   * 删掉一个工作目录。
   *
   * **连同它下面的会话一起关掉**：目录都不在列表里了，那些会话就没有地方
   * 可以显示，留着只会在后台烧 token。所以先确认。
   */
  async removeWorkspace(workspaceId: string): Promise<void> {
    const workspace = this.workspaceById(workspaceId);
    if (workspace === null) return;

    const mine = this.state.sessions.filter((s) => s.workspaceId === workspaceId);
    if (mine.length > 0) {
      const ok = await platform.confirm(
        `「${workspace.name}」下面还有 ${mine.length} 个会话，删掉目录会一并关掉它们。继续？`,
        '删除工作目录',
      );
      if (!ok) return;
    }

    for (const session of mine) await this.closeSession(session.id);

    // 窗口本身也要收掉：布局、以及「现在显示的是哪一个」
    const layouts = { ...this.state.layouts };
    delete layouts[workspaceId];
    const rest = this.state.workspaces.filter((w) => w.id !== workspaceId);

    this.patch({
      workspaces: rest,
      layouts,
      activeWorkspaceId:
        this.state.activeWorkspaceId === workspaceId
          ? (rest[0]?.id ?? null)
          : this.state.activeWorkspaceId,
      focusedId:
        this.state.activeWorkspaceId === workspaceId ? null : this.state.focusedId,
    });
    this.persistWorkspaces();
  }

  /**
   * 关掉一个窗口（工作目录）里的**全部会话**，目录留着。
   *
   * 和 [`removeWorkspace`] 的差别就在这句：那个连目录一起删，这个只收子窗口。
   * 有会话在跑就先问一句 —— 一次关掉四个跑着的 agent 值得拦一下，而且是
   * **不可逆**的（那些会话里的上下文就没了）。
   */
  async closeWorkspaceSessions(workspaceId: string): Promise<number> {
    const mine = this.state.sessions.filter((s) => s.workspaceId === workspaceId);
    if (mine.length === 0) return 0;

    const running = mine.filter((s) => s.status !== 'exited').length;
    if (running > 0) {
      const name = this.workspaceById(workspaceId)?.name ?? '这个目录';
      const ok = await platform.confirm(
        `「${name}」里有 ${running} 个会话还在跑，全部关掉？`,
        '关闭全部会话',
      );
      if (!ok) return 0;
    }

    for (const session of mine) await this.closeSession(session.id);
    return mine.length;
  }

  /** 侧栏里展开/收起一个窗口（看清楚它里面有哪些会话） */
  toggleExpanded(workspaceId: string): void {
    const expanded = { ...this.state.expanded };
    if (expanded[workspaceId] === true) delete expanded[workspaceId];
    else expanded[workspaceId] = true;
    this.patch({ expanded });
  }

  renameWorkspace(workspaceId: string, name: string): void {
    const trimmed = name.trim();
    if (trimmed === '') return;
    this.patch({
      workspaces: this.state.workspaces.map((w) =>
        w.id === workspaceId ? { ...w, name: trimmed } : w,
      ),
    });
    this.persistWorkspaces();
  }

  /**
   * 置顶 / 取消置顶一个工作目录。
   *
   * ⚠️ **只改显示顺序**：`activeWorkspaceId`（当前打开的是哪个窗口）一个字节都不动 ——
   * 用户置顶某个项目只是想让它在列表里靠上，不是想切过去。
   *
   * ⚠️ **数组本身不重排**（`sortWorkspaces` 只在渲染时用）：一开始是重排之后
   * 写回 state 的，结果「取消置顶」回不到原位 —— 那时候数组已经是 `[beta, alpha]`
   * 了，稳定排序保持原序，于是 beta 赖着不走。e2e 一跑就撞出来了。
   * 数组顺序永远是**用户添加的顺序**，置顶只是画的时候拎一下。
   */
  toggleWorkspacePin(workspaceId: string): void {
    this.patch({
      workspaces: this.state.workspaces.map((w) =>
        w.id === workspaceId ? withPin(w, w.pinned !== true) : w,
      ),
    });
    this.persistWorkspaces();
  }

  private workspaceById(id: string): AgentWorkspace | null {
    return this.state.workspaces.find((w) => w.id === id) ?? null;
  }

  private persistWorkspaces(): void {
    // 存不下去不该让界面崩（和以前一样静静算了）—— 上面那些字段里
    // 没有一样是「丢了就出事」的，而这里也没法给用户一个有用的提示
    void this.workspaceStore.save(this.state.workspaces).catch(() => undefined);
  }

  // ------------------------------------------------------------ 会话

  /**
   * 新建一个会话并让它上屏。
   *
   * `split` 给了就往那个方向分屏（新会话在新的一半），没给就**替换当前聚焦
   * 的那一块** —— 用户刚建的会话应该立刻出现在眼前，而不是悄悄躺在侧栏里。
   */
  async createSession(
    workspaceId: string,
    kind: AgentKind,
    /**
     * `place: false` = **建好但先别上屏**，由调用方决定怎么摆。
     * 只有 [`createMany`] 用它：一批会话要一次摆成网格，中间不能一格格地抖。
     */
    opts: { command?: string; split?: SplitDir; place?: boolean } = {},
  ): Promise<string | null> {
    // ⚠️ 必须先初始化：**事件目录的路径在 init 里才拿到**，而它会作为
    // `DEVTOOLKIT_EVENT_DIR` 注入到进程里。少了它，这个会话的状态检测
    // 从一开始就是坏的，而且是**静默**坏的 —— 界面上永远显示「空闲」，
    // 用户根本不知道自己去哪个设置里找原因
    await this.init();

    const workspace = this.workspaceById(workspaceId);
    if (workspace === null) return null;

    const session: AgentSession = {
      id: newId('pane'),
      workspaceId,
      title: this.nextTitle(workspaceId, kind),
      kind,
      command: opts.command ?? this.commandFor(kind),
      status: 'starting',
      statusAt: Date.now(),
      statusDetail: null,
      exitCode: null,
      history: [],
      ackAt: null,
      worktree: null,
    };

    // ⚠️ **终端必须先建好，再让会话进 state。**
    //
    // 会话一进 state，React 立刻就把它那一格渲染出来，而那一格的 effect 会去
    // hub 里找这个会话的终端 —— 找不到的话 `attach` 会**静默地什么都不做**
    // （它按「会话可能已经被关掉了」处理），于是终端永远留在屏幕外：
    // 侧栏状态、退出码、快照全都正常，只有画面是空的。
    // （这一条是 e2e 抓出来的：store 的单测里 hub 是替身，attach 的空操作看不出来。）
    try {
      await agentHub.create(session.id, INITIAL_COLS, INITIAL_ROWS);
    } catch (e) {
      this.shell.reportError(e);
      return null;
    }
    this.scanners.set(session.id, createOscScanner());

    this.patch({ sessions: [...this.state.sessions, session] });
    if (opts.place !== false) {
      this.putOnScreen(session.id, opts.split ?? null);
    }

    try {
      await this.spawn(session, workspace);
    } catch (e) {
      // 进程没起来：会话留在侧栏（显示已退出），用户能看到原因并重试，
      // 而不是「点了新建什么都没发生」。
      //
      // ⚠️ 原因要和 exited **一起**报：exited 是终态，之后再喂什么都改不了它，
      // 分两次报的话原因会被丢掉，用户只看到一个「已退出」和一句无从下手的话
      this.applySignal(
        session.id,
        { kind: 'exited', code: null, detail: `起不来：${describeError(e)}` },
        Date.now(),
      );
    }
    return session.id;
  }

  /**
   * 一次新建一批会话并摆成网格（对话框里「2 个 claude + 1 个终端」那种）。
   *
   * # 为什么先全建好、最后才一次上屏
   *
   * 一个个 `createSession` 直接上屏的话，每建一个都会动一次布局：第一个替换掉
   * 当前那一格，第二个再从它旁边分出去……中间那几帧是**看得见的抖动**，焦点还
   * 在乱跳。所以让 `createSession` 先别上屏（`place: false`），建完统一摆。
   *
   * 某一格起不来不会拖垮整批：`createSession` 里会把失败的那个留成「已退出」
   * 的会话（侧栏能看到原因），成功的那几个照常摆出来。
   */
  async createMany(workspaceId: string, wants: readonly SessionRequest[]): Promise<number> {
    const kinds: AgentKind[] = [];
    for (const want of wants) {
      // 夹一道：界面上每类最多 9 个，但这里是公开入口 —— 手改过的持久化数据、
      // 将来别的调用方都可能塞更大的数进来
      const count = Math.max(0, Math.min(Math.floor(want.count), MAX_SESSIONS_PER_KIND));
      for (let i = 0; i < count; i += 1) kinds.push(want.kind);
    }
    if (kinds.length === 0) return 0;

    const created: string[] = [];
    for (const kind of kinds) {
      const id = await this.createSession(workspaceId, kind, { place: false });
      if (id !== null) created.push(id);
    }
    if (created.length === 0) return 0;

    this.putGridOnScreen(created, gridColsFor(created.length));
    return created.length;
  }

  /**
   * 起进程。终端这时候已经在 hub 里了（见 `createSession` 里那段顺序说明）。
   *
   * **两条路**：工作目录是本机的就走本机 pty（默认，也是这一版之前唯一的形态）；
   * 配了远端就 SSH 到那台机器上起。
   *
   * ⚠️ 远端那条路**可能开不成** —— 主机密钥没见过、或者变了。那不是异常，
   * 是**要用户拍板的分支**（进程在别的机器上，我们连都没连上）：
   * 记一个 `trustPrompt` 让界面弹窗，用户点了信任再重试。
   */
  private async spawn(session: AgentSession, workspace: AgentWorkspace): Promise<void> {
    const eventsDir = this.state.eventsDir ?? '';
    const remote = remoteOf(workspace);

    const outcome = await this.services.client.open({
      id: session.id,
      cwd: workspace.path,
      // null = 平台默认 shell。刻意**不在这里选 Git Bash / PowerShell**：
      // 那是用户环境的事，先让平台的默认值跑起来，需要再做成可配置
      shell: null,
      command: session.command,
      cols: INITIAL_COLS,
      rows: INITIAL_ROWS,
      // 远端目标（本机那条路是 undefined，Rust 那边 `Option` 收到 None）
      ...(remote === null ? {} : { remote: this.remotePayload(remote, session.id) }),
      // 状态检测整条链路挂在这两个变量上：agent 继承它们，它拉起来的
      // hook 进程再继承一次（见 services/types.ts 的 env 那段）
      env: {
        DEVTOOLKIT_PANE_ID: session.id,
        DEVTOOLKIT_EVENT_DIR: eventsDir,
        // 填了才传：留空时**不要**传一个空串过去 —— Rust 那边「有值」和
        // 「空值」是两件事（空的会被当成没设，但显式传空更容易让人误会）
        ...(this.state.gitBashPath === ''
          ? {}
          : { CLAUDE_CODE_GIT_BASH_PATH: this.state.gitBashPath }),
      },
      onEvent: (event) => this.onPtyEvent(session.id, event),
    });

    if (outcome.kind !== 'ready') {
      // 主机密钥的事。⚠️ **不能发 `started`** —— 远端那边连都没连上，
      // 那个会话根本没起来。用户点完信任会重试这一次（见 `trustHost`）
      this.patch({
        trustPrompt: {
          sessionId: session.id,
          workspaceId: workspace.id,
          algorithm: outcome.kind === 'hostKeyUnknown' ? outcome.algorithm : '',
          fingerprint: outcome.kind === 'hostKeyUnknown' ? outcome.fingerprint : outcome.actual,
          expected: outcome.kind === 'hostKeyMismatch' ? outcome.expected : null,
        },
      });
      return;
    }

    this.applySignal(session.id, { kind: 'started' }, Date.now());
  }

  /**
   * 拼给 Rust 的远端目标。
   *
   * ⚠️ **密码和私钥口令在这里是明文的**：它们是从系统钥匙串里刚取出来的
   * （`workspaces` 那份存储走 `withSecrets`），要交给 Rust 去连。
   * 落盘那条路上它们进钥匙串 —— 这一层只是过一下手。
   */
  private remotePayload(remote: RemoteTarget, sessionId: string): RemoteTargetPayload {
    return {
      host: remote.host,
      port: remote.port,
      username: remote.username,
      authKind: remote.authKind,
      password: remote.password,
      privateKeyPath: remote.privateKeyPath,
      passphrase: remote.passphrase,
      // 信任过的指纹（没见过就是 null —— Rust 那边据此回 hostKeyUnknown）
      expectedFingerprint: this.state.knownHosts[hostKeyOf(remote)] ?? null,
      // ⚠️ 「这次就当它是对的」**只对用户刚点过信任的那一次为 true**：
      // 它是「这一下」的授权，不是「这台机器」的。所以放在一个一次性的集合里、
      // 不落盘 —— 落盘的话就等于「信任过一台机器之后永远接受任何指纹」✗
      acceptNewHostKey: this.acceptedOnce.delete(sessionId),
    };
  }

  /** 用户在那个弹窗里点了「信任」：**记下指纹、然后重试那次连接** */
  async trustHost(): Promise<void> {
    const prompt = this.state.trustPrompt;
    if (prompt === null) return;

    const workspace = this.workspaceById(prompt.workspaceId);
    const remote = workspace === null ? null : remoteOf(workspace);
    if (workspace === null || remote === null) {
      this.patch({ trustPrompt: null });
      return;
    }

    const knownHosts = { ...this.state.knownHosts, [hostKeyOf(remote)]: prompt.fingerprint };
    this.patch({ knownHosts, trustPrompt: null });
    this.persistKnownHosts(knownHosts);

    // 这一次连接允许接受新密钥 —— 用户刚拍过板了
    this.acceptedOnce.add(prompt.sessionId);
    const session = this.state.sessions.find((s) => s.id === prompt.sessionId);
    if (session !== undefined) await this.spawn(session, workspace);
  }

  /** 用户点了「取消」：把那次没起来的会话收掉，别在侧栏里留一个空壳 */
  dismissTrust(): void {
    const prompt = this.state.trustPrompt;
    this.patch({ trustPrompt: null });
    if (prompt !== null) void this.closeSession(prompt.sessionId);
  }

  /** 忘掉一台机器的指纹（下次连它要重新核对一遍） */
  forgetHost(host: string, port: number): void {
    const knownHosts = { ...this.state.knownHosts };
    delete knownHosts[`${host}:${port}`];
    this.patch({ knownHosts });
    this.persistKnownHosts(knownHosts);
  }

  private persistKnownHosts(knownHosts: Record<string, string>): void {
    void this.kv.set('knownHosts', knownHosts).catch(() => undefined);
  }

  /** 关掉一个会话：杀进程 + 从布局里摘掉 + 释放终端 */
  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessionById(sessionId);
    if (session === null) return;

    await this.services.client.close(sessionId).catch(() => undefined);

    // 布局改动打在**会话自己那个窗口**上：关掉别的窗口里的会话时，
    // 当前显示的那一套不该动
    const workspaceId = session.workspaceId;
    const current = this.layoutOf(workspaceId);
    const layout = current === null ? null : closePane(current, sessionId);
    const remaining = this.state.sessions.filter((s) => s.id !== sessionId);

    this.setLayout(workspaceId, layout, {
      sessions: remaining,
      focusedId: this.focusedAfterChange(sessionId, layout),
      selectedId: this.state.selectedId === sessionId ? null : this.state.selectedId,
    });
    this.scanners.delete(sessionId);
    agentHub.dispose(sessionId);
  }

  /** 会话被关掉/下屏之后，焦点该去哪 */
  private focusedAfterChange(goneId: string, layout: PaneLayout | null): string | null {
    if (this.state.focusedId !== goneId) return this.state.focusedId;
    if (layout === null) return null;
    const first = firstPane(layout);
    return first;
  }

  /** 「我知道了」。队列里就看不到它了，直到它**再次**进入等待 */
  acknowledge(sessionId: string): void {
    this.patch({
      sessions: this.state.sessions.map((s) =>
        s.id === sessionId ? { ...s, ackAt: Date.now() } : s,
      ),
    });
  }

  private sessionById(id: string): AgentSession | null {
    return this.state.sessions.find((s) => s.id === id) ?? null;
  }

  /** 「claude #2」这种。同一个工作目录下按类型数序号 */
  private nextTitle(workspaceId: string, kind: AgentKind): string {
    const same = this.state.sessions.filter(
      (s) => s.workspaceId === workspaceId && s.kind === kind,
    ).length;
    const base = kind === 'claude' ? 'claude' : kind === 'codex' ? 'codex' : '终端';
    return `${base} #${same + 1}`;
  }

  // ------------------------------------------------------------ 窗口与分屏

  /** 某个窗口（工作目录）的布局。null = 这个窗口里一块都没有 */
  layoutOf(workspaceId: string | null): PaneLayout | null {
    if (workspaceId === null) return null;
    return this.state.layouts[workspaceId] ?? null;
  }

  /** 现在显示的那一套布局 */
  activeLayout(): PaneLayout | null {
    return this.layoutOf(this.state.activeWorkspaceId);
  }

  /**
   * 切窗口：侧栏点一个工作目录走的就是这儿。
   *
   * 焦点跟着落到新窗口的第一块上 —— 不落的话键盘还指向上一个窗口里那块，
   * 打进去的字会跑到看不见的地方。
   */
  setActiveWorkspace(workspaceId: string | null): void {
    if (workspaceId === this.state.activeWorkspaceId) return;

    const layout = this.layoutOf(workspaceId);
    const first = layout === null ? null : firstPane(layout);
    this.patch({
      activeWorkspaceId: workspaceId,
      focusedId: first,
      // 检查器跟着切到新窗口里的东西；新窗口是空的话就保持原样（用户可能
      // 正在看上一个窗口里某个会话的详情）
      selectedId: first ?? this.state.selectedId,
    });
  }

  /** 改某个窗口的布局。`null` = 这个窗口空了（把键删掉，而不是留个 null） */
  private setLayout(
    workspaceId: string,
    next: PaneLayout | null,
    extra: Partial<AgentsState> = {},
  ): void {
    const layouts = { ...this.state.layouts };
    if (next === null) delete layouts[workspaceId];
    else layouts[workspaceId] = next;
    this.patch({ layouts, ...extra });
  }

  /**
   * 在这个窗口里挑一块下手（替换 / 分屏的目标）。
   *
   * 优先用当前聚焦的那块，但它可能已经不在布局里了（刚被关掉，而这次调用是
   * 上一帧的按钮触发的），或者这个窗口根本不是当前显示的那个 —— 那就退到
   * 第一块上，别让「上屏」变成一次静默的空操作。
   */
  private targetPaneIn(workspaceId: string, layout: PaneLayout): string {
    const focused = this.state.activeWorkspaceId === workspaceId ? this.state.focusedId : null;
    return focused !== null && paneOf(layout, focused) ? focused : firstPane(layout);
  }

  /**
   * 把一个会话摆到**它自己那个窗口**里，并把那个窗口切到前面。
   *
   * `split` 给了就切一块出去，没给就**替换**目标那一块的内容。
   */
  putOnScreen(sessionId: string, split: SplitDir | null): void {
    const session = this.sessionById(sessionId);
    if (session === null) return;

    const workspaceId = session.workspaceId;
    // 会话是用户刚建的（或者刚点着要看的）—— 那个窗口必须显示出来
    const show = {
      activeWorkspaceId: workspaceId,
      focusedId: sessionId,
      selectedId: sessionId,
    };

    const layout = this.layoutOf(workspaceId);
    if (layout === null) {
      this.setLayout(workspaceId, leafPane(sessionId), show);
      return;
    }

    const target = this.targetPaneIn(workspaceId, layout);
    // 分屏时新的一块永远在右边/下边 —— 界面上按钮写的就是「向右/向下分屏」
    const next =
      split === null
        ? replacePane(layout, target, sessionId)
        : splitPane(layout, target, split, sessionId, false);
    this.setLayout(workspaceId, next, show);
  }

  /**
   * 把一组会话一次摆成网格，**替换那个窗口里选中的一块**。
   *
   * 和 [`putOnScreen`] 的分工：那个一次摆一个（新建一个、从旁边分一个），
   * 这个一次摆一片。用「替换」而不是「追加」是因为一次建一批的语义就是
   * 「这一格拿来放它们」—— 窗口里别处用户摆好的东西不该被动。
   */
  putGridOnScreen(sessionIds: readonly string[], cols: number): void {
    const grid = gridLayout(sessionIds, cols);
    const first = sessionIds[0];
    if (grid === null || first === undefined) return;

    const session = this.sessionById(first);
    if (session === null) return;

    const workspaceId = session.workspaceId;
    const show = { activeWorkspaceId: workspaceId, focusedId: first, selectedId: first };

    const layout = this.layoutOf(workspaceId);
    if (layout === null) {
      this.setLayout(workspaceId, grid, show);
      return;
    }

    const target = this.targetPaneIn(workspaceId, layout);
    this.setLayout(workspaceId, replaceWith(layout, target, grid), show);
  }

  /** 分屏并且**新起一个会话**（这是「向右分屏」按钮的默认行为） */
  async splitWithNewSession(dir: SplitDir): Promise<void> {
    const focused = this.state.focusedId === null ? null : this.sessionById(this.state.focusedId);
    if (focused === null) {
      // 当前窗口里什么都没有：分屏没有意义，直接开一个
      const activeId = this.state.activeWorkspaceId;
      const workspace =
        this.state.workspaces.find((w) => w.id === activeId) ?? this.state.workspaces[0];
      if (workspace !== undefined) await this.createSession(workspace.id, 'claude');
      return;
    }
    await this.createSession(focused.workspaceId, focused.kind, { split: dir });
  }

  /** 把一块从布局里摘掉。**会话不杀**，只是不在屏幕上了 */
  closePaneFor(sessionId: string): void {
    const session = this.sessionById(sessionId);
    if (session === null) return;

    const current = this.layoutOf(session.workspaceId);
    if (current === null) return;

    const layout = closePane(current, sessionId);
    this.setLayout(session.workspaceId, layout, {
      focusedId: this.focusedAfterChange(sessionId, layout),
    });
  }

  focusSession(sessionId: string): void {
    if (this.sessionById(sessionId) === null) return;
    this.patch({ focusedId: sessionId, selectedId: sessionId });
  }

  selectSession(sessionId: string | null): void {
    this.patch({ selectedId: sessionId });
  }

  /** 拖分隔条。比例由 `core/layout.ts` 夹住。分隔条只属于当前窗口 */
  resize(path: SplitPath, ratio: number): void {
    const workspaceId = this.state.activeWorkspaceId;
    const layout = this.activeLayout();
    if (workspaceId === null || layout === null) return;
    this.setLayout(workspaceId, setRatio(layout, path, ratio));
  }

  /** 方向键在窗格之间移动焦点 */
  focusDirection(dir: Direction): void {
    const layout = this.activeLayout();
    const focusedId = this.state.focusedId;
    if (layout === null || focusedId === null) return;
    const next = neighborOf(rectsOf(layout), focusedId, dir);
    if (next !== null) this.focusSession(next);
  }

  /**
   * 跳到最近一个「需要你」的会话（cmux 那个 `Cmd+Shift+U`）。
   *
   * 队列里等得最久的排最前面，所以「最近一个」指的是**你欠得最久的那个**。
   */
  jumpToAttention(): boolean {
    const head = attentionQueue(this.state.sessions)[0];
    if (head === undefined) {
      this.shell.setStatus('没有在等你的会话');
      return false;
    }
    this.jumpTo(head.id);
    return true;
  }

  /**
   * 跳到某个会话：不在屏幕上就摆到聚焦的那一块，然后**标记为已知晓**——
   * 跳过去这个动作本身就是「我看到了」。
   */
  jumpTo(sessionId: string): void {
    const session = this.sessionById(sessionId);
    if (session === null) return;

    // 「在屏幕上」要按**它自己那个窗口**算：别的窗口里摆着它，不等于这个窗口
    // 看得见（切过去才对）
    if (!paneOf(this.layoutOf(session.workspaceId), sessionId)) {
      this.putOnScreen(sessionId, null);
    } else {
      this.setActiveWorkspace(session.workspaceId);
      this.focusSession(sessionId);
    }
    this.acknowledge(sessionId);
  }

  // ------------------------------------------------------------ 集成

  /**
   * 环境自检：问一次 Rust「你眼里的 claude / git / bash 各是哪个文件」。
   *
   * 失败不弹错误条（它本来就是排查用的，查不到也是一种结果）——
   * 记进 state 让检查器显示。
   */
  async refreshEnvironment(): Promise<void> {
    try {
      const environment = await this.services.probe.probe();
      this.patch({ environment });
    } catch {
      this.patch({ environment: null });
    }
  }

  async refreshIntegration(target: IntegrationTarget): Promise<void> {
    try {
      const status = await this.services.integration.status(target);
      this.patch({ integration: { ...this.state.integration, [target]: status } });
    } catch (e) {
      this.shell.reportError(e);
    }
  }

  async applyIntegration(target: IntegrationTarget): Promise<void> {
    await this.integrationAction(() => this.services.integration.apply(target));
  }

  async revertIntegration(target: IntegrationTarget): Promise<void> {
    await this.integrationAction(() => this.services.integration.revert(target));
  }

  private async integrationAction(run: () => Promise<IntegrationOutcome>): Promise<void> {
    if (this.state.integrating) return;
    this.patch({ integrating: true });
    try {
      const outcome = await run();
      const status = await this.services.integration.status(outcome.target);
      this.patch({ integration: { ...this.state.integration, [outcome.target]: status } });
      this.shell.setStatus('配置已更新。新开的会话才会生效 —— 已经在跑的那些不会。');
    } catch (e) {
      this.shell.reportError(e);
    } finally {
      this.patch({ integrating: false });
    }
  }

  /** 界面文案：集成状态 → 一句话 */
  integrationLabel(target: IntegrationTarget): string {
    const status = this.state.integration[target];
    if (status === null) return '未知';
    return INTEGRATION_LABEL[status.state];
  }
}

/** 模块级单例。UI 从这里订阅，`index.tsx` 的 `onActivate` 负责注入外壳 */
export const agentsStore = new AgentsStore(agentsServices);

const INTEGRATION_LABEL: Record<IntegrationState, string> = {
  missing: '未启用',
  absent: '未启用',
  installed: '已启用',
  modified: '已启用（被改过）',
  unusable: '配置文件读不了',
};

/** 布局里第一条（递归下去最左上的那个）。用来给焦点找个落脚点 */
function firstPane(layout: PaneLayout): string {
  let node = layout;
  while (node.kind === 'split') node = node.a;
  return node.sessionId;
}

/** 这个会话在屏幕上吗 */
function paneOf(layout: PaneLayout | null, sessionId: string): boolean {
  if (layout === null) return false;
  if (layout.kind === 'leaf') return layout.sessionId === sessionId;
  return paneOf(layout.a, sessionId) || paneOf(layout.b, sessionId);
}

/**
 * 从路径里取最后一段当名字。
 *
 * 两种分隔符都要认：Windows 上用户给的路径是 `D:\work\api`，
 * 而从浏览器/测试里来的可能是正斜杠。
 */
function baseName(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/').filter((p) => p !== '');
  return parts.length === 0 ? path : (parts[parts.length - 1] ?? path);
}
