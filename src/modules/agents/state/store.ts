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

import { newId } from '../../../shared/ids';
import { platform } from '../../../shared/platform';
import { createKeyValue } from '../../../shared/platform/kv';
import { describeError } from '../../../shell/store';
import type { ShellApi } from '../../../shell/types';
import { agentHub } from '../core/terminalHub';
import { parseEventName, signalOf } from '../core/events';
import {
  closePane,
  leafPane,
  neighborOf,
  rectsOf,
  replacePane,
  setRatio,
  splitPane,
  type Direction,
  type PaneLayout,
  type SplitDir,
  type SplitPath,
} from '../core/layout';
import { createOscScanner, type OscScanner } from '../core/osc';
import { attentionQueue, reduceSignal, type AgentSignal } from '../core/status';
import type { AgentKind, AgentSession, AgentWorkspace } from '../core/types';
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

/** 各 agent 的默认启动命令。用户可以改（会话详情里） */
const DEFAULT_COMMAND: Record<AgentKind, string> = {
  claude: 'claude',
  codex: 'codex',
  shell: '',
  custom: '',
};

export interface AgentsState {
  ready: boolean;
  workspaces: AgentWorkspace[];
  sessions: AgentSession[];
  /** 分屏布局。null = 主区是空的（一个会话都没上屏） */
  layout: PaneLayout | null;
  /** 当前聚焦的那一块显示的是哪个会话。键盘往哪去、分屏从哪分，都看它 */
  focusedId: string | null;
  /** 检查器里在看哪个会话。可以和 focused 不同（点侧栏看一眼，不动屏幕） */
  selectedId: string | null;
  /** 事件目录的绝对路径。给检查器显示 */
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
}

export class AgentsStore {
  private listeners = new Set<() => void>();
  private state: AgentsState = {
    ready: false,
    workspaces: [],
    sessions: [],
    layout: null,
    focusedId: null,
    selectedId: null,
    eventsDir: null,
    lastEventAt: null,
    eventsError: null,
    integration: { claude: null, codex: null },
    integrating: false,
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

  constructor(private services: AgentsServices) {
    // hub 的两个出口接在这里。做成可写字段而不是构造参数，是为了避开
    // store ↔ hub 的循环依赖（hub 不认识 store，store 认识 hub）
    agentHub.onInput = (sessionId, data) => {
      void this.onUserInput(sessionId, data);
    };
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
    this.patch({ workspaces });

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
    this.startPolling();
  }

  private async loadWorkspaces(): Promise<AgentWorkspace[]> {
    const raw = await this.kv.get<unknown>('workspaces');
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
      out.push({ id, path, name: typeof name === 'string' && name !== '' ? name : path });
    }
    return out;
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
            { kind: 'needs-attention', detail: notice.text === '' ? null : notice.text },
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
    agentHub.note(
      sessionId,
      event.code === null ? '（进程已退出）' : `（进程已退出，退出码 ${event.code}）`,
    );
  }

  /** 用户在窗格里敲了键 */
  private async onUserInput(sessionId: string, data: Uint8Array): Promise<void> {
    // 1. 发给进程。失败就忽略：用户正在打字时对面退出是很正常的事
    await this.services.client.write(sessionId, data).catch(() => undefined);

    // 2. 用户的动作是**唯一**能推翻状态的依据（其余全靠猜，见 core/status.ts）。
    //    只要往这个窗格里敲了键，就当他已经在处理了 —— 包括用方向键选
    //    权限菜单里的选项
    this.applySignal(sessionId, { kind: 'user-typed' }, Date.now());

    // 3. Ctrl+C 单独报一次：Claude Code 的 Stop hook 在用户打断时**不触发**，
    //    不补这一下，状态会永远卡在「正在工作」
    if (data.includes(0x03)) {
      this.applySignal(sessionId, { kind: 'user-interrupted' }, Date.now());
    }
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
    this.patch({ workspaces: [...this.state.workspaces, workspace] });
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
    this.patch({ workspaces: this.state.workspaces.filter((w) => w.id !== workspaceId) });
    this.persistWorkspaces();
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

  private workspaceById(id: string): AgentWorkspace | null {
    return this.state.workspaces.find((w) => w.id === id) ?? null;
  }

  private persistWorkspaces(): void {
    void this.kv.set('workspaces', this.state.workspaces).catch(() => undefined);
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
    opts: { command?: string; split?: SplitDir } = {},
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
      command: opts.command ?? DEFAULT_COMMAND[kind],
      status: 'starting',
      statusAt: Date.now(),
      statusDetail: null,
      exitCode: null,
      history: [],
      ackAt: null,
      worktree: null,
    };

    this.patch({ sessions: [...this.state.sessions, session] });
    this.putOnScreen(session.id, opts.split ?? null);

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

  private async spawn(session: AgentSession, workspace: AgentWorkspace): Promise<void> {
    // ⚠️ 顺序要紧：终端必须**先建好**，因为 open 一返回事件就可能开始到达
    await agentHub.create(session.id, INITIAL_COLS, INITIAL_ROWS);
    this.scanners.set(session.id, createOscScanner());

    const eventsDir = this.state.eventsDir ?? '';
    await this.services.client.open({
      id: session.id,
      cwd: workspace.path,
      // null = 平台默认 shell。刻意**不在这里选 Git Bash / PowerShell**：
      // 那是用户环境的事，先让平台的默认值跑起来，需要再做成可配置
      shell: null,
      command: session.command,
      cols: INITIAL_COLS,
      rows: INITIAL_ROWS,
      // 状态检测整条链路挂在这两个变量上：agent 继承它们，它拉起来的
      // hook 进程再继承一次（见 services/types.ts 的 env 那段）
      env: {
        DEVTOOLKIT_PANE_ID: session.id,
        DEVTOOLKIT_EVENT_DIR: eventsDir,
      },
      onEvent: (event) => this.onPtyEvent(session.id, event),
    });

    this.applySignal(session.id, { kind: 'started' }, Date.now());
  }

  /** 关掉一个会话：杀进程 + 从布局里摘掉 + 释放终端 */
  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessionById(sessionId);
    if (session === null) return;

    await this.services.client.close(sessionId).catch(() => undefined);

    const layout = this.state.layout === null ? null : closePane(this.state.layout, sessionId);
    const remaining = this.state.sessions.filter((s) => s.id !== sessionId);

    this.patch({
      sessions: remaining,
      layout,
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

  renameSession(sessionId: string, title: string): void {
    const trimmed = title.trim();
    if (trimmed === '') return;
    this.patch({
      sessions: this.state.sessions.map((s) =>
        s.id === sessionId ? { ...s, title: trimmed } : s,
      ),
    });
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

  // ------------------------------------------------------------ 分屏

  /**
   * 把一个会话摆到屏幕上。
   *
   * `split` 给了就切当前聚焦的那块，没给就**替换**聚焦那块的内容。
   */
  putOnScreen(sessionId: string, split: SplitDir | null): void {
    const { layout, focusedId } = this.state;

    if (layout === null || focusedId === null) {
      this.patch({ layout: leafPane(sessionId), focusedId: sessionId, selectedId: sessionId });
      return;
    }
    if (split === null) {
      // 聚焦的那块可能已经不在布局里了（比如它刚被关掉，而这次调用是上一帧
      // 的按钮触发的）。那就退到第一块上，别让「上屏」变成一个静默的空操作
      const target = paneOf(layout, focusedId) ? focusedId : firstPane(layout);
      this.patch({
        layout: replacePane(layout, target, sessionId),
        focusedId: sessionId,
        selectedId: sessionId,
      });
      return;
    }

    // 分屏时新的一块永远在右边/下边 —— 界面上按钮写的就是「向右/向下分屏」
    this.patch({
      layout: splitPane(layout, focusedId, split, sessionId, false),
      focusedId: sessionId,
      selectedId: sessionId,
    });
  }

  /** 分屏并且**新起一个会话**（这是「向右分屏」按钮的默认行为） */
  async splitWithNewSession(dir: SplitDir): Promise<void> {
    const focused = this.state.focusedId === null ? null : this.sessionById(this.state.focusedId);
    if (focused === null) {
      // 屏幕上什么都没有：分屏没有意义，直接开一个
      const workspace = this.state.workspaces[0];
      if (workspace !== undefined) await this.createSession(workspace.id, 'claude');
      return;
    }
    await this.createSession(focused.workspaceId, focused.kind, { split: dir });
  }

  /** 把一块从布局里摘掉。**会话不杀**，只是不在屏幕上了 */
  closePaneFor(sessionId: string): void {
    if (this.state.layout === null) return;
    const layout = closePane(this.state.layout, sessionId);
    this.patch({ layout, focusedId: this.focusedAfterChange(sessionId, layout) });
  }

  focusSession(sessionId: string): void {
    if (this.sessionById(sessionId) === null) return;
    this.patch({ focusedId: sessionId, selectedId: sessionId });
  }

  selectSession(sessionId: string | null): void {
    this.patch({ selectedId: sessionId });
  }

  /** 拖分隔条。比例由 `core/layout.ts` 夹住 */
  resize(path: SplitPath, ratio: number): void {
    if (this.state.layout === null) return;
    this.patch({ layout: setRatio(this.state.layout, path, ratio) });
  }

  /** 方向键在窗格之间移动焦点 */
  focusDirection(dir: Direction): void {
    const { layout, focusedId } = this.state;
    if (layout === null || focusedId === null) return;
    const next = neighborOf(rectsOf(layout), focusedId, dir);
    if (next !== null) this.focusSession(next);
  }

  /**
   * 跳到最近一个「需要你」的会话（cmux 那个 `Cmd+Shift+U`）。
   *
   * 不在屏幕上就把它摆到聚焦的那一块上，然后**标记为已知晓** ——
   * 跳过去这个动作本身就是「我看到了」。
   */
  jumpToAttention(): boolean {
    const head = attentionQueue(this.state.sessions)[0];
    if (head === undefined) {
      this.shell.setStatus('没有在等你的会话');
      return false;
    }
    if (!paneOf(this.state.layout, head.id)) this.putOnScreen(head.id, null);
    else this.focusSession(head.id);
    this.acknowledge(head.id);
    return true;
  }

  // ------------------------------------------------------------ 集成

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
