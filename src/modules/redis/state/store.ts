/**
 * Redis 模块的状态。
 *
 * 照顺序图模块那套来：手写 `subscribe` / `getSnapshot` / `set` 三件套 + 末尾导出单例，
 * 组件用 `useSyncExternalStore` 订阅，外壳能力通过 `attachShell` 注入（默认空实现，
 * 这样单测可以直接 `new` 一个）。
 *
 * 服务层是**构造时注入**的（而不是 import 单例），所以单测能塞一个假 client 进来，
 * 不需要 DOM、不需要 localStorage。生产代码在末尾把真单例装上。
 *
 * # 错误该往哪儿放（一条容易做错的边界）
 *
 * - **命令的服务器错误**（`-ERR unknown command`）→ 一条 `reply` 日志。
 *   它是命令的结果，连接是好的。绝不能弹外壳错误条。
 * - **传输层失败**（连不上、断了、超时）→ 一条 `transport` 日志 + 把该连接标成
 *   `error`。用户正在看命令台，红字就该出现在他看的地方。
 * - **其它意外**（读盘失败之类）→ 才交给 `shell.reportError` 弹错误条。
 */

import { describeError } from '../../../shared/platform/types';
import type { ShellApi } from '../../../shell/types';
import { pushHistory, moveHistory } from '../core/history';
import { hasErrors, newProfile, sameConnection, toConnectParams, validateProfile } from '../core/profile';
import { redactArgs } from '../core/redact';
import { tokenize } from '../core/tokenize';
import type {
  ConnectionProfile,
  ConnectionRuntime,
  LogEntry,
  WithoutSeq,
} from '../core/types';
import { redisServices } from '../services';
import type { RedisServices } from '../services/types';

/** 日志最多留多少条。命令台的输出是只增不减的，不封顶迟早把内存吃光 */
const MAX_LOG_ENTRIES = 500;

export interface RedisState {
  /** 连接档案是否已经从磁盘读回来了 */
  ready: boolean;
  profiles: ConnectionProfile[];
  /** 连接 id → 运行时状态。不持久化，每次启动从 idle 开始 */
  runtime: Record<string, ConnectionRuntime>;
  /**
   * 选中的连接。
   *
   * 一个概念而不是两个：侧栏选中的那一行、Inspector 编辑的那份、命令台发往的
   * 那个连接**是同一个**。分开会立刻产生「侧栏选着 A，命令发给了 B」这种 bug。
   */
  selectedId: string | null;
  log: LogEntry[];
  /** 有一条命令正在飞 —— 输入框要禁用，避免命令交错 */
  running: boolean;
  draft: string;
  history: readonly string[];
  /** 正在翻历史的位置；null 表示没在翻 */
  historyIndex: number | null;
  /**
   * 开始翻历史**之前**用户自己敲的内容，按 ↓ 翻回底部时还给他。
   *
   * 必须单独存一份：翻历史的过程本身就在改 `draft`，等翻到底的时候
   * `draft` 里装的是历史里那一条，原来的草稿早就没了。
   */
  historyDraft: string;
}

export class RedisStore {
  private listeners = new Set<() => void>();
  private state: RedisState;
  private seq = 0;
  private initPromise: Promise<void> | null = null;

  /** 外壳能力。默认空实现：store 可能在注入之前就被构造（单测里直接 new） */
  private shell: ShellApi = { setStatus: () => {}, reportError: () => {} };

  constructor(private services: RedisServices) {
    this.state = {
      ready: false,
      profiles: [],
      runtime: {},
      selectedId: null,
      log: [],
      running: false,
      draft: '',
      history: [],
      historyIndex: null,
      historyDraft: '',
    };
  }

  // ---------------------------------------------------------------- 订阅

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getSnapshot = (): RedisState => this.state;

  attachShell(shell: ShellApi): void {
    this.shell = shell;
  }

  private set(patch: Partial<RedisState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }

  // ---------------------------------------------------------------- 生命周期

  /**
   * 从磁盘读回连接档案。**幂等** —— `onActivate` 每次切模块都会调，
   * 不挡住的话用户每切一次模块，命令台的输出和连接状态就被重置一次。
   */
  init(): Promise<void> {
    this.initPromise ??= this.doInit();
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    try {
      const profiles = await this.services.profiles.load();
      const runtime: Record<string, ConnectionRuntime> = {};
      for (const profile of profiles) runtime[profile.id] = idleRuntime();

      this.set({
        ready: true,
        profiles,
        runtime,
        selectedId: profiles[0]?.id ?? null,
      });
    } catch (e) {
      // 读盘失败允许重试（下次切回来再试一次），但别把 ready 永远卡在 false
      this.initPromise = null;
      this.set({ ready: true });
      this.shell.reportError(e);
    }
  }

  // ---------------------------------------------------------------- 档案

  private findProfile(id: string): ConnectionProfile | undefined {
    return this.state.profiles.find((p) => p.id === id);
  }

  /** 当前选中的连接档案（命令台和 Inspector 的目标） */
  selectedProfile(): ConnectionProfile | null {
    return this.state.selectedId === null ? null : (this.findProfile(this.state.selectedId) ?? null);
  }

  select(id: string | null): void {
    this.set({ selectedId: id });
  }

  /** 新建一个连接档案，自动选中，并把名字去重。返回它的 id */
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

  /**
   * 改一份档案。
   *
   * 已经连上的连接如果被改了连接参数，标 `stale` 而不是自动重连 ——
   * 用户正在命令台上敲东西的时候连接被换掉，比多提示一句、让他自己点一下更烦人。
   */
  async updateProfile(id: string, patch: Partial<ConnectionProfile>): Promise<void> {
    const current = this.findProfile(id);
    if (!current) return;

    const next = { ...current, ...patch };
    const profiles = this.state.profiles.map((p) => (p.id === id ? next : p));

    const runtime = { ...this.state.runtime };
    const existing = runtime[id];
    if (existing && existing.status === 'connected' && !sameConnection(current, next)) {
      runtime[id] = { ...existing, stale: true };
    }

    this.set({ profiles, runtime });
    await this.persist(profiles);
  }

  async deleteProfile(id: string): Promise<void> {
    const profile = this.findProfile(id);
    if (!profile) return;

    // 先把连接断掉，别留下一个后端还挂着的孤儿连接
    if (this.state.runtime[id]?.status === 'connected') {
      await this.disconnect(id);
    }

    const profiles = this.state.profiles.filter((p) => p.id !== id);
    const runtime = { ...this.state.runtime };
    delete runtime[id];

    this.set({
      profiles,
      runtime,
      selectedId: this.state.selectedId === id ? (profiles[0]?.id ?? null) : this.state.selectedId,
    });
    await this.persist(profiles);
  }

  private async persist(profiles: ConnectionProfile[]): Promise<void> {
    try {
      await this.services.profiles.save(profiles);
    } catch (e) {
      // 存盘失败不该让界面崩，但必须让用户知道 —— 下次启动这些改动会没
      this.shell.reportError(new Error(`连接档案保存失败：${describeError(e)}`));
    }
  }

  /** 这份档案现在能不能连（用来禁用「连接」按钮） */
  canConnect(profile: ConnectionProfile): boolean {
    return !hasErrors(validateProfile(profile));
  }

  // ---------------------------------------------------------------- 连接

  async connect(id: string): Promise<void> {
    const profile = this.findProfile(id);
    if (!profile) return;

    const errors = validateProfile(profile);
    if (hasErrors(errors)) {
      this.patchRuntime(id, { status: 'error', error: Object.values(errors)[0] ?? '连接参数不合法' });
      return;
    }

    this.patchRuntime(id, { status: 'connecting', error: null });

    try {
      const info = await this.services.client.connect(toConnectParams(profile));
      this.patchRuntime(id, {
        status: 'connected',
        error: null,
        server: info,
        stale: false,
        lastElapsedMs: null,
      });
      this.append({
        kind: 'note',
        connection: profile.name,
        message: `已连接 ${info.address}${info.version ? `（Redis ${info.version}）` : ''}`,
      });
    } catch (e) {
      this.patchRuntime(id, { status: 'error', error: describeError(e), server: null });
    }
  }

  async disconnect(id: string): Promise<void> {
    const profile = this.findProfile(id);
    try {
      await this.services.client.disconnect(id);
    } catch (e) {
      // 断不开也得把本地状态清掉，否则界面会永远显示「已连接」
      this.shell.reportError(e);
    }
    this.patchRuntime(id, { status: 'idle', error: null, server: null, stale: false });

    if (profile) {
      this.append({ kind: 'note', connection: profile.name, message: '已断开' });
    }
  }

  private patchRuntime(id: string, patch: Partial<ConnectionRuntime>): void {
    const current = this.state.runtime[id] ?? idleRuntime();
    this.set({ runtime: { ...this.state.runtime, [id]: { ...current, ...patch } } });
  }

  // ---------------------------------------------------------------- 命令台

  setDraft(draft: string): void {
    // 用户一动手打字就退出历史浏览状态
    this.set({ draft, historyIndex: null });
  }

  /** ↑：往回翻历史 */
  historyPrev(): void {
    // 第一次按 ↑ 的时候，把用户自己敲的内容存起来，等翻回底部还给他
    const entering = this.state.historyIndex === null;
    const fallback = entering ? this.state.draft : this.state.historyDraft;

    const move = moveHistory(this.state.history, this.state.historyIndex, 'prev', fallback);
    if (!move) return;

    this.set({
      historyIndex: move.index,
      draft: move.value,
      ...(entering ? { historyDraft: this.state.draft } : {}),
    });
  }

  /** ↓：往新翻；翻过最新一条就回到原来没敲完的草稿 */
  historyNext(): void {
    const move = moveHistory(this.state.history, this.state.historyIndex, 'next', this.state.historyDraft);
    if (move) this.set({ historyIndex: move.index, draft: move.value });
  }

  clearLog(): void {
    this.set({ log: [] });
  }

  /**
   * 执行一条命令行。
   *
   * 串行执行（`running` 期间拒绝新的）：和 redis-cli 的手感一致，也免了
   * 「两条命令的输出交错在一起」这种看起来像 bug 的显示。
   */
  async runCommand(text: string): Promise<void> {
    const profile = this.selectedProfile();
    if (!profile || this.state.running) return;

    const input = text.trim();
    if (input === '') return;

    const parsed = tokenize(input);
    if (!parsed.ok) {
      // 根本没发出去，只记一条本地提示
      this.append({
        kind: 'note',
        connection: profile.name,
        message: `命令没发出去：${parsed.reason}`,
      });
      return;
    }
    if (parsed.tokens.length === 0) return;

    this.set({
      draft: '',
      history: pushHistory(this.state.history, input),
      historyIndex: null,
      running: true,
    });
    // 回显要脱敏：`AUTH mypassword` 不该把密码写进日志
    this.append({ kind: 'input', connection: profile.name, text: redactArgs(parsed.tokens) });

    const started = Date.now();
    try {
      const reply = await this.services.client.exec(profile.id, parsed.tokens);
      const elapsedMs = Date.now() - started;

      // 服务器错误也是 reply —— 连接是好的，只是命令没成功
      this.append({ kind: 'reply', connection: profile.name, reply, elapsedMs });
      this.patchRuntime(profile.id, { lastElapsedMs: elapsedMs });
    } catch (e) {
      const message = describeError(e);
      this.append({ kind: 'transport', connection: profile.name, message });
      // 传输层失败：后端那边已经把这条连接摘掉了，本地也得跟上，
      // 否则界面会一直显示「已连接」而每条命令都失败
      this.patchRuntime(profile.id, { status: 'error', error: message, server: null });
    } finally {
      this.set({ running: false });
    }
  }

  private append(entry: WithoutSeq<LogEntry>): void {
    this.seq += 1;
    const next = [...this.state.log, { ...entry, seq: this.seq } as LogEntry];
    this.set({
      log: next.length > MAX_LOG_ENTRIES ? next.slice(next.length - MAX_LOG_ENTRIES) : next,
    });
  }
}

function idleRuntime(): ConnectionRuntime {
  return {
    status: 'idle',
    error: null,
    stale: false,
    server: null,
    lastElapsedMs: null,
  };
}

/** 生产用的单例，接在真服务层上 */
export const redisStore = new RedisStore(redisServices);
