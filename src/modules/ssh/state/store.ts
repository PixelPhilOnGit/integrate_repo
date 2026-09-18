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
import { findKnownHost, forgetKnownHost, rememberKnownHost } from '../core/knownHosts';
import {
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
  SshRuntime,
  SshSession,
  TrustPrompt,
} from '../core/types';
import { sshServices } from '../services';
import type { SshServices } from '../services/types';

/**
 * 建会话时先按这个尺寸开 PTY，挂载之后马上会被 `fit()` 修正。
 *
 * 为什么不是等量准了再开：`request_pty` 是握手的一部分，而那时候终端还没挂到
 * DOM 上，量不到真实尺寸。给一个常见的默认值，比给 1×1 或者干脆不要 PTY 好得多
 * —— 远端 shell 在挂载前的极短时间内会按 80×24 排版。
 */
const INITIAL_COLS = 80;
const INITIAL_ROWS = 24;

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
      await this.services.client.closeAll();
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

  // ---------------------------------------------------------------- 档案

  async createProfile(): Promise<string> {
    const profile = newProfile(this.state.profiles);
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
      await this.services.client.close(sessionId);
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
      case 'data':
        terminalHub.feed(sessionId, event.bytes);
        break;

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
      await this.services.client.write(sessionId, data);
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
      await this.services.client.resize(sessionId, cols, rows);
    } catch {
      // resize 失败不值得打断用户
    }
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
    const base = `${profile.username.trim()}@${profile.host.trim()}`;
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
