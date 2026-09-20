/**
 * SSH 模块的状态。
 *
 * # 和前三个模块最大的形状差别：这里是**多会话**，不是「一个档案一个连接」
 *
 * Redis / SQL 的 `runtime` 表按档案 id 索引，一个档案最多一条连接。SSH 一个档案
 * 可以同时开好几个会话（多标签），所以：
 *
 * - **`sessions` 是按会话 id 索引的列表**，档案 id 只是每个会话身上的一个字段；
 * - `runtime` 仍然按**档案**索引 —— 它回答的是「这个档案现在连着没有」，
 *   那是侧栏要显示的东西。两者的粒度不一样，是有意的。
 *
 * # 终端字节**不经过这里**
 *
 * 这个 store 装的是「关于会话的元数据」：状态、退出码、指纹、尺寸。
 * 每秒几十次的字节流走 `core/terminalHub.ts`，React 全程看不见它们 ——
 * 混进来的话，远端每输出一行就会把侧栏和标签栏重渲染一遍。
 */

import { nextAvailableName } from '../../../shared/connections/profiles';
import { newId } from '../../../shared/ids';
import { describeError } from '../../../shell/store';
import type { ShellApi } from '../../../shell/types';
import type { TermMetrics } from '../../../shared/terminal/hub';
import {
  cleanTyped,
  createBlockTracker,
  splitInput,
  stripEscapes,
  type BlockTracker,
  type CommandBlock,
} from '../core/blocks';
import { collapsedLine, contentEnd } from '../core/blocksView';
import { createByteLog, type ByteLog } from '../core/byteLog';
import { findKnownHost, forgetKnownHost, rememberKnownHost } from '../core/knownHosts';
import {
  addressOf,
  hasErrors,
  newProfile,
  sameConnection,
  toAuth,
  validateProfile,
} from '../core/profile';
import { terminalHub } from '../core/terminalHub';
import type {
  KnownHost,
  SshEvent,
  SshProfile,
  SshProfileKind,
  SshRuntime,
  SshSession,
  TrustPrompt,
} from '../core/types';
import { sshServices } from '../services';
import type { LocalClient, SshClient, SshServices } from '../services/types';

/**
 * 建会话时先按这个尺寸开 PTY，挂载之后马上会被 `fit()` 修正。
 *
 * 为什么不是等量准了再开：`request_pty` 是握手的一部分，而那时候终端还没挂到
 * DOM 上，量不到真实尺寸。给一个常见的默认值，比给 1×1 或者干脆不要 PTY 好得多
 * —— 远端 shell 在挂载前的极短时间内会按 80×24 排版。
 */
const INITIAL_COLS = 80;
const INITIAL_ROWS = 24;

/** 没有折叠时的空集合。省掉每次调用都新建一个（色条每帧都要问一次） */
const EMPTY_IDS: ReadonlySet<number> = new Set();

/**
 * 把一行截到终端宽度之内。
 *
 * ⚠️ 折叠摘要**必须是恰好一行**：它是重放时的「占位」，而行号推算假定它占一行。
 * 超宽被终端折成两行的话，从那一条往后所有色条的位置都会差一行
 * （这种错**不报错**，只是看着不对）。
 *
 * 数宽度时先扣掉转义序列 —— 摘要里只有一个 `\x1b[2m`（暗色）和一个
 * `\x1b[0m`（复位），它们不占列。
 */
function clampLine(text: string, cols: number): string {
  const visible = text.replace(/\x1b\[[0-9;]*m/g, '');
  if (visible.length <= cols) return text;
  // 截断时把复位码补回去，免得后面所有输出都跟着变成暗色
  return `${text.slice(0, Math.max(0, cols - 1))}…\x1b[0m`;
}

/**
 * 折叠前要求「输出停多久」。
 *
 * 250ms 是「人已经看不出在动」的量级：比它长会让折叠感觉迟钝，比它短则可能
 * 撞上一条正在慢慢吐输出的命令 —— 那样重放出来的内容和行号立刻就对不上，
 * 而且是**静默地**对不上。
 */
const REDRAW_QUIET_MS = 250;

export interface SshState {
  ready: boolean;
  profiles: SshProfile[];
  /** 按**档案** id 索引：这个档案现在连着没有 */
  runtime: Record<string, SshRuntime>;
  selectedId: string | null;
  /** 打开的会话，顺序就是标签顺序 */
  sessions: SshSession[];
  activeSessionId: string | null;
  /** 侧栏里哪些连接是展开的（展开就列出它的会话） */
  expanded: Record<string, boolean>;
  /** 首次连接一台没见过的机器时，等用户拍板的弹窗 */
  trustPrompt: TrustPrompt | null;
  knownHosts: KnownHost[];
  /**
   * 每个档案最近一次「指纹变了」的详情。
   *
   * 单独存而不是塞进 `runtime.error` 的字符串里：界面要把**新旧两个指纹
   * 并排**给用户看，而字符串拼出来的东西没法再拆开。
   */
  mismatch: Record<string, { expected: string; actual: string; algorithm: string }>;
}

export function idleRuntime(): SshRuntime {
  return { status: 'idle', error: null, stale: false, server: null };
}

export class SshStore {
  private listeners = new Set<() => void>();
  /**
   * 每个会话一份「命令块」的记录。
   *
   * ⚠️ **不进 state**：它每秒都在变（输出一字节就更新一次时间戳），进了 state
   * 就等于让侧栏和标签栏跟着远端刷屏 —— 和字节流不进 store 是同一条理由。
   * 界面那边按 hub 的视口事件直接来读（见 `panels/TerminalPane.tsx`）。
   */
  private blocks = new Map<string, BlockTracker>();
  /**
   * 每个会话一份原始字节日志。**只给折叠用**（重放要它），平时没人读。
   *
   * 它有上限（见 `byteLog`）：超了就不再攒并置起标记，折叠按钮据此关掉 ——
   * 宁可不能折，也不要折到一半内容对不上。
   */
  private logs = new Map<string, ByteLog>();
  /** 哪些块被折起来了（按会话） */
  private folded = new Map<string, Set<number>>();
  /**
   * 每一块**展开时占几行**（按会话）。折叠时记下来，展开时用它算 delta。
   *
   * ⚠️ **不能现算**：展开的那一刻这一块正折着，量出来是 1 行 —— 拿它当"展开后
   * 的高度"就得到 `delta = 1 - 1 = 0`，于是它后面那些块永远挪不回去
   * （真机上就是这个现象：折叠之后再展开，色条位置全错）。
   */
  private expandedLines = new Map<string, Map<number, number>>();
  /**
   * 这一轮里用户敲进去的**原始按键**，回车时清掉。
   *
   * 只在一种情况下用得上：回车那一刻终端缓冲区里**还没有回显**（链路慢、
   * 或者远端根本没回显）。那时候它是唯一的退路 —— 见 `readCommand`。
   */
  private typed = new Map<string, string>();
  private state: SshState = {
    ready: false,
    profiles: [],
    runtime: {},
    selectedId: null,
    sessions: [],
    activeSessionId: null,
    expanded: {},
    trustPrompt: null,
    knownHosts: [],
    mismatch: {},
  };
  private initPromise: Promise<void> | null = null;
  /** 外壳能力。默认空实现：store 可能在注入之前就被构造（单测里直接 new） */
  private shell: ShellApi = { setStatus: () => {}, reportError: () => {} };

  constructor(private services: SshServices) {
    // hub 的两个出口接在这里。做成可写字段而不是构造参数，是为了避开
    // store ↔ hub 的循环依赖（hub 不认识 store，store 认识 hub）
    terminalHub.onInput = (sessionId, data) => {
      // ⚠️ 顺序要紧：**先记账再发**。发出去之后远端可能马上就回输出，
      // 而那些输出要用到刚记下的起点
      this.recordInput(sessionId, data);
      void this.writeTo(sessionId, data);
    };
    terminalHub.onResize = (sessionId, cols, rows) => {
      void this.resizeTo(sessionId, cols, rows);
    };
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getSnapshot = (): SshState => this.state;

  attachShell(shell: ShellApi): void {
    this.shell = shell;
  }

  private set(patch: Partial<SshState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }

  // ---------------------------------------------------------------- 初始化

  init(): Promise<void> {
    this.initPromise ??= this.doInit();
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    try {
      const [profiles, knownHosts] = await Promise.all([
        this.services.profiles.load(),
        this.services.knownHosts.load(),
      ]);

      const runtime: Record<string, SshRuntime> = {};
      for (const profile of profiles) {
        runtime[profile.id] = idleRuntime();
      }

      this.set({
        ready: true,
        profiles,
        runtime,
        knownHosts,
        selectedId: profiles[0]?.id ?? null,
      });

      // 把 Rust 侧可能还挂着的**孤儿会话**收掉。
      //
      // webview 一刷新（开发时的热更新、用户按 Ctrl+R），前端这边的回调 id
      // 全没了，但 Rust 侧的会话还活着 —— 用户在新界面上看不见也关不掉它们，
      // 而远端那边还挂着一个登录着的 shell 和一个 PTY。
      // 这是 redis/sql「同 id 重连即替换」那个兜底的对应物：
      // 那两个模块只要重连就能自愈，会话这种东西没有「重连」可言，只能主动收。
      // ⚠️ **两份表都要收**：本地终端那张是独立的一份（见 local_commands.rs），
      // 只收 SSH 那份的话，刷新页面之后会留下一堆用户看不见、关不掉的本地 shell
      await Promise.all([
        this.services.client.closeAll(),
        this.services.local.closeAll(),
      ]);
    } catch (e) {
      this.initPromise = null; // 允许下次重试
      this.set({ ready: true });
      this.shell.reportError(e);
    }
  }

  // ---------------------------------------------------------------- 派生

  selectedProfile(): SshProfile | null {
    const id = this.state.selectedId;
    return id === null ? null : (this.state.profiles.find((p) => p.id === id) ?? null);
  }

  profileById(id: string): SshProfile | null {
    return this.state.profiles.find((p) => p.id === id) ?? null;
  }

  sessionById(id: string): SshSession | null {
    return this.state.sessions.find((s) => s.id === id) ?? null;
  }

  /** 某个档案下的会话，按打开顺序 */
  sessionsOf(profileId: string): SshSession[] {
    return this.state.sessions.filter((s) => s.profileId === profileId);
  }

  /**
   * 侧栏那个状态点的状态。
   *
   * **从会话列表推出来**，不另存一份 —— 两份真相迟早对不上，
   * 而「连着没有」这件事的真相就是「有没有活着的会话」。
   */
  statusOf(profileId: string): SshRuntime['status'] {
    const sessions = this.sessionsOf(profileId);
    if (sessions.some((s) => s.status === 'open')) return 'connected';
    if (sessions.some((s) => s.status === 'starting')) return 'connecting';
    // 出错的不留会话（见 `failSession`），所以这里看 runtime
    return this.state.runtime[profileId]?.status === 'error' ? 'error' : 'idle';
  }

  canConnect(profile: SshProfile): boolean {
    return !hasErrors(validateProfile(profile));
  }

  /**
   * 这个会话该走哪条 client —— **按它所属档案的种类**。
   *
   * ⚠️ 所有「按会话」的操作（写、resize、关）都必须经过这里。
   * 一开始它们一律调 `services.client.*`，结果是本地终端**收不到键盘输入**
   * （输入全发给了 SSH 那套，而它那边没有这个会话 id，静默丢弃）——
   * 终端起来了、提示符也在，就是打不进字。这条是 e2e 抓出来的。
   */
  private clientFor(sessionId: string): SshClient | LocalClient {
    const session = this.sessionById(sessionId);
    if (session === null) return this.services.client;
    const profile = this.profileById(session.profileId);
    return profile?.kind === 'local' ? this.services.local : this.services.client;
  }

  // ---------------------------------------------------------------- 档案

  /**
   * 新建一个连接档案。
   *
   * `kind` 默认 `ssh` —— 原来那个「新建」按钮的行为**一个字都不变**
   * （本地终端走它自己的按钮，见 `ConnectionTree`）。
   */
  async createProfile(kind: SshProfileKind = 'ssh'): Promise<string> {
    const profile = newProfile(this.state.profiles, kind);
    const profiles = [...this.state.profiles, profile];
    this.set({
      profiles,
      runtime: { ...this.state.runtime, [profile.id]: idleRuntime() },
      selectedId: profile.id,
    });
    await this.persist(profiles);
    return profile.id;
  }

  async updateProfile(id: string, patch: Partial<SshProfile>): Promise<void> {
    const current = this.profileById(id);
    if (current === null) return;

    const next = { ...current, ...patch };
    const profiles = this.state.profiles.map((p) => (p.id === id ? next : p));

    // 参数变了就标记「要重连才生效」——**但不自动重连**。
    // 用户正在终端里敲东西的时候连接被换掉，比多一步点击烦人得多
    const runtime = { ...this.state.runtime };
    const existing = runtime[id];
    if (existing && !sameConnection(current, next)) {
      const live = this.sessionsOf(id).some((s) => s.status === 'open');
      if (live) runtime[id] = { ...existing, stale: true };
    }

    // 参数改了，上次那条「指纹变了」的提示就不再对应当前配置了
    const mismatch = { ...this.state.mismatch };
    delete mismatch[id];

    this.set({ profiles, runtime, mismatch });
    await this.persist(profiles);
  }

  async deleteProfile(id: string): Promise<void> {
    // 先把它名下的会话全关掉，不然会留下一堆看不见的终端
    for (const session of this.sessionsOf(id)) {
      await this.closeSession(session.id);
    }

    const profiles = this.state.profiles.filter((p) => p.id !== id);
    const runtime = { ...this.state.runtime };
    delete runtime[id];
    const expanded = { ...this.state.expanded };
    delete expanded[id];
    const mismatch = { ...this.state.mismatch };
    delete mismatch[id];

    this.set({
      profiles,
      runtime,
      expanded,
      mismatch,
      selectedId: this.state.profiles.find((p) => p.id !== id)?.id ?? null,
    });
    await this.persist(profiles);
  }

  select(id: string | null): void {
    this.set({ selectedId: id });
  }

  private async persist(profiles: readonly SshProfile[]): Promise<void> {
    try {
      await this.services.profiles.save(profiles);
    } catch (e) {
      // 存不下去（磁盘满、权限）不该让界面崩掉，但要说一声 ——
      // 用户得知道这次的改动不会留到下次启动
      this.shell.reportError(e);
    }
  }

  // ---------------------------------------------------------------- 主机密钥

  hostKeyFor(profile: SshProfile): KnownHost | null {
    return findKnownHost(this.state.knownHosts, profile.host, profile.port);
  }

  /** 忘掉一台机器的信任记录。「密钥变了」之后用户确认服务器确实重装过就走这条 */
  async forgetHost(host: string, port: number): Promise<void> {
    const knownHosts = forgetKnownHost(this.state.knownHosts, host, port);
    this.set({ knownHosts });
    try {
      await this.services.knownHosts.save(knownHosts);
    } catch (e) {
      this.shell.reportError(e);
    }
  }

  private async rememberHost(entry: KnownHost): Promise<void> {
    const knownHosts = rememberKnownHost(
      this.state.knownHosts,
      entry,
      new Date().toISOString(),
    );
    this.set({ knownHosts });
    try {
      await this.services.knownHosts.save(knownHosts);
    } catch (e) {
      this.shell.reportError(e);
    }
  }

  // ---------------------------------------------------------------- 会话

  /** 给一个档案开一个新会话（新标签） */
  async connect(profileId: string): Promise<void> {
    const profile = this.profileById(profileId);
    if (profile === null) return;

    const errors = validateProfile(profile);
    if (hasErrors(errors)) {
      this.patchRuntime(profileId, {
        status: 'error',
        error: Object.values(errors)[0] ?? '连接参数不合法',
      });
      return;
    }

    const sessionId = newId('term');
    const title = this.titleFor(profile);

    // ⚠️ 顺序要紧：**终端先建好，再发 open**。
    //
    // 反过来（先 open 再建终端）的话，快到本地回环上横幅会在 `open` 的 promise
    // 决议之前就到达，那时候还没有终端接得住它 —— 就得再写一套「先攒着」
    // 的缓冲，而那套缓冲本身又是一个竞态来源。
    await terminalHub.create(sessionId, INITIAL_COLS, INITIAL_ROWS);
    // 命令块的记录跟着终端一起生、一起灭：它读的缓冲区就是刚建好的这一个
    this.blocks.set(sessionId, createBlockTracker());
    this.logs.set(sessionId, createByteLog());
    this.folded.delete(sessionId);

    const session: SshSession = {
      id: sessionId,
      profileId,
      title,
      status: 'starting',
      exitCode: null,
      endedReason: null,
      fingerprint: '',
      cols: INITIAL_COLS,
      rows: INITIAL_ROWS,
    };

    this.set({
      sessions: [...this.state.sessions, session],
      activeSessionId: sessionId,
      expanded: { ...this.state.expanded, [profileId]: true },
    });

    await this.attempt(sessionId, profile, false);
  }

  /**
   * 真正发一次 `open`。
   *
   * `acceptNew` 只有**用户在 TOFU 弹窗里点了信任**之后才会是 true ——
   * 这是「静默接受任何主机密钥」不存在于代码里的那一道保证在前端的另一半
   * （另一半是 Rust 侧 `check_server_key` 默认拒绝一切）。
   */
  private async attempt(
    sessionId: string,
    profile: SshProfile,
    acceptNew: boolean,
  ): Promise<void> {
    // ⚠️ 本地终端**在信任那套之前就分叉**：它没有主机密钥、没有凭据、
    // 也没有「这台机器没见过」这回事 —— 那台机器就是用户自己这台。
    // 让它走下面那条路的话，会平白多一个「要不要信任」的弹窗。
    if (profile.kind === 'local') {
      await this.openLocal(sessionId, profile);
      return;
    }

    const known = this.hostKeyFor(profile);

    try {
      const outcome = await this.services.client.open({
        id: sessionId,
        host: profile.host.trim(),
        port: profile.port,
        username: profile.username.trim(),
        auth: toAuth(profile),
        term: 'xterm-256color',
        cols: this.sessionById(sessionId)?.cols ?? INITIAL_COLS,
        rows: this.sessionById(sessionId)?.rows ?? INITIAL_ROWS,
        expectedFingerprint: known?.fingerprint ?? null,
        acceptNewHostKey: acceptNew,
        onEvent: (event) => this.onEvent(sessionId, event),
      });

      switch (outcome.kind) {
        case 'ready': {
          // 首次信任的那一次要把指纹记下来。已经有的那次不用重写
          if (known === null) {
            await this.rememberHost({
              host: profile.host,
              port: profile.port,
              algorithm: outcome.algorithm,
              fingerprint: outcome.fingerprint,
              addedAt: '',
            });
          }

          this.patchSession(sessionId, {
            status: 'open',
            fingerprint: outcome.fingerprint,
          });
          this.patchRuntime(profile.id, {
            status: 'connected',
            error: null,
            stale: false,
            server: {
              address: outcome.address,
              username: outcome.username,
              fingerprint: outcome.fingerprint,
              algorithm: outcome.algorithm,
            },
          });
          this.shell.setStatus(null);
          break;
        }

        case 'hostKeyUnknown': {
          // 会话留着（状态还是 starting），终端也留着 —— 用户点了信任之后
          // 就在同一个标签里接着连，不用再开一个
          this.set({
            trustPrompt: {
              profileId: profile.id,
              host: outcome.host,
              port: outcome.port,
              algorithm: outcome.algorithm,
              fingerprint: outcome.fingerprint,
            },
          });
          break;
        }

        case 'hostKeyMismatch': {
          // ⚠️ **硬停。** 这里没有「就这样继续」的路径 ——
          // 指纹变了可能是服务器重装，也可能是有人在中间，协议上分不出来。
          // 用户确认是前者之后，去「忘记这台主机」再连。
          this.discardSession(sessionId);
          this.patchRuntime(profile.id, {
            status: 'error',
            error: `主机密钥和上次不一样了（${outcome.expected} → ${outcome.actual}）`,
            server: null,
          });
          this.set({
            mismatch: {
              ...this.state.mismatch,
              [profile.id]: {
                expected: outcome.expected,
                actual: outcome.actual,
                algorithm: outcome.algorithm,
              },
            },
          });
          break;
        }
      }
    } catch (e) {
      // 传输层失败：连不上、超时、认证被拒。这些前端拿到就只想显示出来
      const message = describeError(e);
      this.discardSession(sessionId);
      this.patchRuntime(profile.id, { status: 'error', error: message, server: null });
    }
  }

  /**
   * 开一个本地终端。
   *
   * 和远端那条路的差别全在「没有中间结局」：本地 shell 要么起来（`ready`），
   * 要么抛错（shell 名写错了、没装）。所以这里没有 TOFU、没有指纹，
   * 失败了就是一句明确的错误。
   */
  private async openLocal(sessionId: string, profile: SshProfile): Promise<void> {
    try {
      await this.services.local.open({
        id: sessionId,
        shell: profile.localShell,
        cols: this.sessionById(sessionId)?.cols ?? INITIAL_COLS,
        rows: this.sessionById(sessionId)?.rows ?? INITIAL_ROWS,
        onEvent: (event) => this.onEvent(sessionId, event),
      });

      this.patchSession(sessionId, { status: 'open', fingerprint: '' });
      // `server` 那几个字段对本地终端是空的（没有指纹、没有算法）——
      // 界面上按 kind 决定显示什么，见 ConnectionForm
      this.patchRuntime(profile.id, {
        status: 'connected',
        error: null,
        stale: false,
        server: {
          address: addressOf(profile),
          username: '',
          fingerprint: '',
          algorithm: '',
        },
      });
      this.shell.setStatus(null);
    } catch (e) {
      const message = describeError(e);
      this.discardSession(sessionId);
      this.patchRuntime(profile.id, { status: 'error', error: message, server: null });
    }
  }

  /** 用户在 TOFU 弹窗里点了「信任并继续」 */
  async trustAndReconnect(): Promise<void> {
    const prompt = this.state.trustPrompt;
    if (prompt === null) return;

    const profile = this.profileById(prompt.profileId);
    this.set({ trustPrompt: null });
    if (profile === null) return;

    // **先把指纹记下来再重连**：反过来的话，重连成功但写盘失败，
    // 下次启动又要问一遍，而用户会以为自己已经信任过了
    await this.rememberHost({
      host: prompt.host,
      port: prompt.port,
      algorithm: prompt.algorithm,
      fingerprint: prompt.fingerprint,
      addedAt: '',
    });

    const session = this.sessionsOf(profile.id).find((s) => s.status === 'starting');
    if (session === undefined) {
      // 会话在弹窗期间被关掉了（用户点了别的标签又关了这个），
      // 那就当作「重新连一次」
      await this.connect(profile.id);
      return;
    }

    await this.attempt(session.id, profile, true);
  }

  dismissTrustPrompt(): void {
    const prompt = this.state.trustPrompt;
    if (prompt === null) return;

    // 取消信任 = 这次连接没成，把那个半死不活的会话收掉
    const session = this.sessionsOf(prompt.profileId).find((s) => s.status === 'starting');
    this.set({ trustPrompt: null });
    if (session) this.discardSession(session.id);
  }

  /** 用户在「密钥变了」的提示里点了「忘记这台主机」 */
  async forgetAndReconnect(profileId: string): Promise<void> {
    const profile = this.profileById(profileId);
    if (profile === null) return;

    await this.forgetHost(profile.host, profile.port);
    const mismatch = { ...this.state.mismatch };
    delete mismatch[profileId];
    this.set({ mismatch });
    this.patchRuntime(profileId, { status: 'idle', error: null, server: null });

    await this.connect(profileId);
  }

  /** 关掉一个会话。**用户自己关的，所以由这里把状态改掉** */
  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessionById(sessionId);
    if (session === null) return;

    try {
      // ⚠️ 走 `clientFor`：本地终端那条是**另一份实现**（关错了的话
      // 本地 shell 会一直挂着 —— 用户看不见也关不掉）
      await this.clientFor(sessionId).close(sessionId);
    } catch {
      // 关不掉也要把本地状态清掉 —— 用户点了关闭，界面就该关掉。
      // 远端那边真出问题的话下次重连时会被 `closeAll` 收掉
    }

    this.discardSession(sessionId);
  }

  setActiveSession(sessionId: string | null): void {
    this.set({ activeSessionId: sessionId });
  }

  toggleExpanded(profileId: string): void {
    this.set({
      expanded: { ...this.state.expanded, [profileId]: !this.state.expanded[profileId] },
    });
  }

  /** 会话流里来的事件。只有「远端自己结束」才会走到这里（用户关的走 closeSession） */
  private onEvent(sessionId: string, event: SshEvent): void {
    switch (event.kind) {
      case 'data': {
        const at = Date.now();
        // 先记两笔再喂给终端：块的「最后一字节输出」说的就是此刻，
        // 而字节日志是折叠要用的原料
        this.blocks.get(sessionId)?.output(at);
        this.logs.get(sessionId)?.append(event.bytes, at);
        terminalHub.feed(sessionId, event.bytes);
        break;
      }

      case 'exit': {
        const session = this.sessionById(sessionId);
        if (session === null) return;

        this.patchSession(sessionId, {
          status: 'closed',
          exitCode: event.code,
          endedReason: event.reason,
        });

        // 「远端正常退出」是个**结果**，不是故障 —— 内联写在终端里就好，
        // 不弹外壳错误条。判反了的话，敲一个 `exit` 就会弹一条红色横幅
        terminalHub.note(sessionId, formatExit(event.code, event.reason));
        break;
      }
    }
  }

  /** 写键盘输入。会话没了就静静地算了（用户正在打字时对面退出是很正常的事） */
  async writeTo(sessionId: string, data: Uint8Array): Promise<void> {
    const session = this.sessionById(sessionId);
    if (session === null || session.status !== 'open') return;
    try {
      await this.clientFor(sessionId).write(sessionId, data);
    } catch {
      // 见上：不弹错误条
    }
  }

  private async resizeTo(sessionId: string, cols: number, rows: number): Promise<void> {
    const session = this.sessionById(sessionId);
    if (session === null) return;

    this.patchSession(sessionId, { cols, rows });
    if (session.status !== 'open') return;

    try {
      await this.clientFor(sessionId).resize(sessionId, cols, rows);
    } catch {
      // resize 失败不值得打断用户
    }
  }

  // ------------------------------------------------------------ 命令块

  /** 某个会话现在的命令块（新的在后）。没有就是空数组 */
  blocksOf(sessionId: string): readonly CommandBlock[] {
    return this.blocks.get(sessionId)?.blocks() ?? [];
  }

  /**
   * 一条命令 + 它的输出 —— 色条上点一下复制的东西。
   *
   * 从**终端缓冲区**里读，而不是从某份存下来的字节重建：用户看见的是什么，
   * 复制出去的就是什么。起点用块的 `col`（≈ 提示符的终点），所以提示符不会被
   * 复制进去；终点是下一条命令那一行（不含），所以两块之间不会重叠。
   */
  blockText(sessionId: string, blockId: number): string {
    const tracker = this.blocks.get(sessionId);
    const metrics = terminalHub.metrics(sessionId);
    if (tracker === undefined || metrics === null) return '';

    const blocks = tracker.blocks();
    const index = blocks.findIndex((b) => b.id === blockId);
    const block = blocks[index];
    if (block === undefined) return '';

    const endLine = blocks[index + 1]?.line ?? metrics.lines;
    const body = (
      terminalHub.textBetween(
        sessionId,
        { line: block.line, col: block.col },
        { line: endLine, col: 0 },
      ) ?? ''
    ).trimEnd();

    // 读不出东西（回显还没回来）时至少把命令本身交出去
    return body.trim() === '' ? block.command : body;
  }

  /** 哪些块被折起来了。色条据此换个样子（折起来的要看得出来） */
  foldedBlocks(sessionId: string): ReadonlySet<number> {
    return this.folded.get(sessionId) ?? EMPTY_IDS;
  }

  /** 折叠现在能不能用（日志没溢出、没有全屏程序、输出停了） */
  canFold(sessionId: string): boolean {
    const log = this.logs.get(sessionId);
    return log !== undefined && !log.overflowed() && this.quietEnough(sessionId, log);
  }

  /**
   * 折叠 / 展开一块。返回有没有真的动过。
   *
   * # 它做的事就是「重放一遍」
   *
   * xterm 的缓冲区删不掉中间几行，所以折叠只能是：把开头那段 + 每一块的字节
   * 按顺序重放一遍，折起来的那块换成一行摘要（见 `core/byteLog.ts` 头部）。
   *
   * # 三道闸，缺一个都不干
   *
   * 1. **日志溢出了不干** —— 没有完整字节就重放不出原样，宁可不能折
   * 2. **输出没停不干** —— 重放到一半又插进来几行，内容和行号就全对不上了
   * 3. **全屏程序在跑不干**（`redraw` 里还有一道）—— 那画面不是「一段段输出」
   *
   * 三种情况都只是「这次没动」，不报错：用户双击一下没反应，看起来就像
   * 「还不能折」，而不是弹一条看不懂的错误。
   */
  toggleBlockFold(sessionId: string, blockId: number): boolean {
    const log = this.logs.get(sessionId);
    const tracker = this.blocks.get(sessionId);
    const metrics = terminalHub.metrics(sessionId);
    if (log === undefined || tracker === undefined || metrics === null) return false;
    if (log.overflowed() || !this.quietEnough(sessionId, log)) return false;

    const blocks = tracker.blocks();
    const index = blocks.findIndex((b) => b.id === blockId);
    const block = blocks[index];
    if (block === undefined) return false;

    const set = new Set(this.folded.get(sessionId) ?? []);
    const collapse = !set.has(blockId);

    // 这一块现在占几行（到下一块的起点；最后一块到**内容末尾** ——
    // 不是缓冲区末尾，那边永远有 rows 行空的，见 `contentEnd`）
    const endLine = blocks[index + 1]?.line ?? contentEnd(metrics);
    const currentLines = Math.max(1, endLine - block.line);

    const sizes = this.expandedLines.get(sessionId) ?? new Map<number, number>();
    let newLines: number;
    if (collapse) {
      // 折叠：**记下它展开时占几行**，展开时要用
      sizes.set(blockId, currentLines);
      newLines = 1; // 折起来只剩一行摘要
    } else {
      // 展开：用折起来之前记下的那个高度。记不到（比如换了会话、或者块是
      // 别处折的）就退回「按现在的行数还原」—— 那种情况下还原得不准，
      // 但总比不动强
      newLines = sizes.get(blockId) ?? currentLines;
      sizes.delete(blockId);
    }
    this.expandedLines.set(sessionId, sizes);
    const delta = newLines - currentLines;

    const plan: Array<{ bytes: Uint8Array } | { text: string }> = [
      { bytes: log.preamble() },
    ];
    for (const b of blocks) {
      const folded = b.id === blockId ? collapse : set.has(b.id);
      plan.push(
        folded
          ? // ⚠️ 摘要要**截到一行之内**：超宽会被终端折成两行，而下面的行号
            // 推算假定「折起来就占一行」—— 对不上就是从这一行开始的
            { text: `${clampLine(collapsedLine(b), metrics.cols)}\r\n` }
          : { bytes: log.block(b.id) },
      );
    }

    if (!terminalHub.redraw(sessionId, plan)) return false;

    if (collapse) set.add(blockId);
    else set.delete(blockId);
    this.folded.set(sessionId, set);

    // 行号重算：这一块之后的所有块整体挪 delta 行（前面那些没动）
    if (delta !== 0) {
      const moved = new Map<number, number>();
      for (let i = index + 1; i < blocks.length; i += 1) {
        const later = blocks[i];
        if (later !== undefined) moved.set(later.id, later.line + delta);
      }
      tracker.remap(moved);
    }
    return true;
  }

  /**
   * 现在适合重放吗：**输出已经停了**，而且没有全屏程序。
   *
   * 250ms 这个数是「人已经看不出在动」的量级：比它长会让折叠感觉迟钝，
   * 比它短则可能撞上一条正在慢慢吐输出的命令（那样重放出来的内容和行号
   * 立刻就对不上了，而且是静默地不对）。
   */
  private quietEnough(sessionId: string, log: ByteLog): boolean {
    const metrics = terminalHub.metrics(sessionId);
    if (metrics === null || metrics.alt) return false;
    const last = log.lastOutputAt();
    return last === null || Date.now() - last >= REDRAW_QUIET_MS;
  }

  /**
   * 把用户敲的键记进命令块模型里。
   *
   * ⚠️ **只记账，不拦**：字节照旧发出去（见 `writeTo`）。块边界是从同一条流上
   * 「旁听」出来的 —— 和智能体会话那边用 OSC 扫描器听状态是同一个路子，
   * 用户按的每一个键都变得更有用，而终端的行为一点没变。
   */
  private recordInput(sessionId: string, data: Uint8Array): void {
    const tracker = this.blocks.get(sessionId);
    if (tracker === undefined) return;

    const metrics = terminalHub.metrics(sessionId);
    // ① 量不到（会话刚建、还没挂上）就算了：宁可漏一块，也不要记一个假位置
    // ② 全屏程序里（vim、htop、top）敲的键不是命令。alt 屏幕里那画面本来也
    //    不是「一段段输出」，切出来的块没有意义
    if (metrics === null || metrics.alt) return;

    const text = new TextDecoder().decode(data);
    const now = Date.now();

    // Ctrl+C 作废这一轮：shell 会在新的一行重新打提示符，起点不能还记着上一行
    if (text.includes('\x03')) {
      tracker.cancel();
      this.typed.delete(sessionId);
      return;
    }

    const { text: typed, submit } = splitInput(stripEscapes(text));

    if (!submit) {
      tracker.begin(metrics.cursorLine, metrics.cursorCol, now);
      this.typed.set(sessionId, (this.typed.get(sessionId) ?? '') + typed);
      return;
    }

    const pending = this.typed.get(sessionId) ?? '';
    this.typed.delete(sessionId);
    const command = this.readCommand(sessionId, metrics, typed + pending);

    const created = tracker.submit(command, metrics.cursorLine, metrics.cursorCol, now);
    // 立了块就把日志分段（空命令返回 null，那种情况字节继续留在上一段里，
    // 而上一段的末尾正是「下一条命令那一行」—— 两边对得上）
    if (created !== null) this.logs.get(sessionId)?.startBlock(created.id);
  }

  /**
   * 读命令原文：**从用户敲第一个键的位置读到光标**。
   *
   * 为什么不从按键还原：行编辑在远端 —— Tab 补全、↑ 历史、Ctrl+R 搜索，
   * 我们这边只看得见一串控制序列。而从缓冲区读，拿到的就是屏幕上**真实的**
   * 那一行（补全过的、从历史里取出来的都在里面）。
   *
   * 退路：回显还没回来（链路慢）或者远端压根不回显时，缓冲区里那一行是空的，
   * 那就回到用户敲的原始按键上 —— 不完美（退格、Tab 补不出来），但比一个
   * 空命令好，而且**只有这种情况下才用**。
   */
  private readCommand(sessionId: string, metrics: TermMetrics, typed: string): string {
    const tracker = this.blocks.get(sessionId);
    const from = tracker?.start() ?? null;
    if (from !== null) {
      const text = terminalHub.textBetween(
        sessionId,
        from,
        { line: metrics.cursorLine, col: metrics.cursorCol },
      );
      const command = (text ?? '').trim();
      if (command !== '') return command;
    }
    return cleanTyped(typed);
  }

  // ---------------------------------------------------------------- 内部

  private patchSession(sessionId: string, patch: Partial<SshSession>): void {
    this.set({
      sessions: this.state.sessions.map((s) =>
        s.id === sessionId ? { ...s, ...patch } : s,
      ),
    });
  }

  /**
   * 一个连接失败的会话不留着。
   *
   * 留着的话标签栏会攒下一堆「已结束」的假标签 —— 那些会话从来没连上过，
   * 里面一个字都没有，用户看着只会困惑。错误信息在 Inspector 里，
   * 那才是它该在的地方（和 redis/sql 把连接错误放 Inspector 是一致的）。
   */
  private discardSession(sessionId: string): void {
    terminalHub.dispose(sessionId);
    this.blocks.delete(sessionId);
    this.typed.delete(sessionId);
    this.logs.delete(sessionId);
    this.folded.delete(sessionId);
    this.expandedLines.delete(sessionId);
    const sessions = this.state.sessions.filter((s) => s.id !== sessionId);
    this.set({
      sessions,
      activeSessionId:
        this.state.activeSessionId === sessionId
          ? (sessions[sessions.length - 1]?.id ?? null)
          : this.state.activeSessionId,
    });
  }

  private patchRuntime(profileId: string, patch: Partial<SshRuntime>): void {
    const current = this.state.runtime[profileId] ?? idleRuntime();
    this.set({
      runtime: { ...this.state.runtime, [profileId]: { ...current, ...patch } },
    });
  }

  private titleFor(profile: SshProfile): string {
    // 本地终端的标题用连接名（`本地` / 用户改过的名字）—— `user@host` 那两个
    // 字段对它没有意义，拼出来会是 `@` 这种谁也看不懂的东西
    const base =
      profile.kind === 'local'
        ? profile.name.trim() === ''
          ? '本地终端'
          : profile.name.trim()
        : `${profile.username.trim()}@${profile.host.trim()}`;
    return nextAvailableName(
      this.state.sessions.map((s) => s.title),
      base,
    );
  }
}

/** 退出时写在终端里的那一行。中文，因为它是说给用户听的，不是程序输出 */
export function formatExit(code: number | null, reason: string): string {
  return code === null ? `[${reason}]` : `[${reason}：退出码 ${code}]`;
}

/** 模块级单例。UI 从这里订阅，`index.tsx` 的 `onActivate` 负责注入外壳 */
export const sshStore = new SshStore(sshServices);
