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
import { keyBytesOf } from '../core/types';
import type {
  ConnectionProfile,
  ConnectionRuntime,
  DbInfo,
  KeyDetail,
  KeyMeta,
  LogEntry,
  WithoutSeq,
} from '../core/types';
import { redisServices } from '../services';
import type { RedisServices } from '../services/types';

/** 日志最多留多少条。命令台的输出是只增不减的，不封顶迟早把内存吃光 */
const MAX_LOG_ENTRIES = 500;

/**
 * 浏览态。
 *
 * 跟着「当前选中的连接」走：换连接就整个重置。**刻意不做成 per-connection 的字典** ——
 * 那样用户切来切去之后，每个连接都停在自己上次的位置，看起来很聪明，实际很难解释
 * 「我明明选了 db3，怎么现在是 db0」。一次只看一个连接的一个库，简单且不会有歧义。
 */
export interface BrowseState {
  /** 当前在看的库；null 表示还没选 */
  db: number | null;
  pattern: string;
  keys: KeyMeta[];
  /** 下一页的游标；0 表示翻完了 */
  cursor: number;
  loadingKeys: boolean;
  keysError: string | null;
  selected: KeyMeta | null;
  detail: KeyDetail | null;
  loadingDetail: boolean;
}

function emptyBrowse(db: number | null): BrowseState {
  return {
    db,
    pattern: '*',
    keys: [],
    cursor: 0,
    loadingKeys: false,
    keysError: null,
    selected: null,
    detail: null,
    loadingDetail: false,
  };
}

/** 一页取多少个 key。太大的话首次加载会明显卡顿，太小又要翻很多次 */
const KEY_PAGE_SIZE = 200;

/** 取 key 的值时最多取多少个元素。一个百万字段的 hash 全拉过来能把界面打爆 */
const KEY_VALUE_LIMIT = 200;

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

  // ---------------------------------------------------------------- 浏览

  /** 侧栏里哪些连接是展开的 */
  expanded: Record<string, boolean>;
  /** 连接 id → 它的库列表（展开时加载） */
  keyspace: Record<string, DbInfo[]>;
  keyspaceLoading: Record<string, boolean>;
  /** 主区显示哪个页签 */
  tab: 'browse' | 'console';
  browse: BrowseState;

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
      expanded: {},
      keyspace: {},
      keyspaceLoading: {},
      tab: 'browse',
      browse: emptyBrowse(null),
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

  /**
   * 选中一个连接。
   *
   * 换连接会重置浏览态 —— 每个连接停在自己上次的位置看着聪明，实际很难解释
   * 「我明明选了 db3，怎么现在是 db0」。已经连上的话顺手把它的库和 key 拉出来，
   * 这样切过去就能直接看到东西。
   */
  select(id: string | null): void {
    const changed = this.state.selectedId !== id;
    this.set({
      selectedId: id,
      ...(changed ? { browse: emptyBrowse(null) } : {}),
    });

    if (changed && id !== null) void this.expandAndLoad(id);
  }

  /** 展开一个连接并（如果已连接）加载它的库和默认库的 key */
  private async expandAndLoad(id: string): Promise<void> {
    if (this.state.expanded[id] !== true) {
      this.set({ expanded: { ...this.state.expanded, [id]: true } });
    }

    const profile = this.findProfile(id);
    if (!profile || this.state.runtime[id]?.status !== 'connected') return;

    // 库列表和默认库的 key **互不依赖**（库列表看的是所有库，和当前选中的库无关），
    // 并行拉 —— 串行的话首屏要多等一个完整的往返
    if (this.state.keyspace[id] === undefined) {
      await Promise.all([this.loadKeyspace(id), this.openDb(id, profile.db)]);
    } else {
      await this.openDb(id, profile.db);
    }
  }

  /** 新建一个连接档案，自动选中，并把名字去重。返回它的 id */
  async createProfile(): Promise<string> {
    const profile = newProfile(this.state.profiles);
    const profiles = [...this.state.profiles, profile];

    this.set({
      profiles,
      runtime: { ...this.state.runtime, [profile.id]: idleRuntime() },
      selectedId: profile.id,
      // 新建同时会改变选中项，所以浏览态也要重置 —— 和 select() 一样。
      // 漏了这条的话，点了「新建」之后主区还显示着上一个连接的 key
      browse: emptyBrowse(null),
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
    const keyspace = { ...this.state.keyspace };
    const expanded = { ...this.state.expanded };
    delete runtime[id];
    delete keyspace[id];
    delete expanded[id];

    this.set({
      profiles,
      runtime,
      keyspace,
      expanded,
      selectedId: this.state.selectedId === id ? (profiles[0]?.id ?? null) : this.state.selectedId,
      ...(this.state.selectedId === id ? { browse: emptyBrowse(null) } : {}),
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

      // 连上就把库列表和默认库的 key 拉出来。浏览式界面的要点就是
      // 「连上就看得到东西」—— 让用户再点一下才显示等于没做这个界面。
      if (this.state.selectedId === id) {
        await this.expandAndLoad(id);
      }
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

    // 库列表和 key 都失效了，清掉 —— 否则断开之后侧栏还挂着一份「已连接时的样子」
    const keyspace = { ...this.state.keyspace };
    delete keyspace[id];
    this.set({
      keyspace,
      ...(this.state.selectedId === id ? { browse: emptyBrowse(null) } : {}),
    });

    if (profile) {
      this.append({ kind: 'note', connection: profile.name, message: '已断开' });
    }
  }

  private patchRuntime(id: string, patch: Partial<ConnectionRuntime>): void {
    const current = this.state.runtime[id] ?? idleRuntime();
    this.set({ runtime: { ...this.state.runtime, [id]: { ...current, ...patch } } });
  }

  // ---------------------------------------------------------------- 浏览

  setTab(tab: 'browse' | 'console'): void {
    this.set({ tab });
  }

  /** 展开/折叠侧栏里的一个连接。首次展开时把它的库列表拉出来 */
  async toggleExpanded(id: string): Promise<void> {
    const next = !this.state.expanded[id];
    this.set({ expanded: { ...this.state.expanded, [id]: next } });

    if (next && this.state.keyspace[id] === undefined) {
      await this.loadKeyspace(id);
    }
  }

  /**
   * 拉取库列表。
   *
   * 用 `keyspace` 的「有没有值」判断加载过没有（`undefined` = 没加载过，
   * 空数组 = 加载过但真的没有库）—— 不能用 `!keyspace[id]`，那样空数组会被当成
   * 没加载过，于是每次展开都重新请求一遍。
   */
  async loadKeyspace(id: string): Promise<void> {
    if (this.state.runtime[id]?.status !== 'connected') return;

    this.set({ keyspaceLoading: { ...this.state.keyspaceLoading, [id]: true } });
    try {
      const dbs = await this.services.client.keyspace(id);
      this.set({ keyspace: { ...this.state.keyspace, [id]: dbs } });
    } catch (e) {
      // 库列表拿不到不影响命令台能用，走状态栏提示而不是弹错误条
      this.shell.setStatus(`读取库列表失败：${describeError(e)}`);
    } finally {
      this.set({ keyspaceLoading: { ...this.state.keyspaceLoading, [id]: false } });
    }
  }

  /** 切到某个库并加载它的 key —— 浏览界面的主入口 */
  async openDb(id: string, db: number): Promise<void> {
    if (this.state.runtime[id]?.status !== 'connected') return;

    // 换库时把过滤条件留着（用户多半想在新库里找同样的东西），其余全重置
    const pattern = this.state.browse.pattern;

    try {
      await this.services.client.select(id, db);
    } catch (e) {
      this.set({ browse: { ...emptyBrowse(db), keysError: describeError(e) } });
      return;
    }

    this.set({ browse: { ...emptyBrowse(db), pattern } });
    await this.loadMoreKeys();
  }

  setPattern(pattern: string): void {
    this.set({ browse: { ...this.state.browse, pattern } });
  }

  /** 按当前过滤条件从头加载（改了 pattern、或者手动刷新时） */
  async reloadKeys(): Promise<void> {
    this.set({
      browse: { ...this.state.browse, keys: [], cursor: 0, selected: null, detail: null },
    });
    await this.loadMoreKeys();
  }

  /** 加载下一页，追加到列表末尾 */
  async loadMoreKeys(): Promise<void> {
    const id = this.state.selectedId;
    const { db, pattern, cursor, loadingKeys, keys } = this.state.browse;
    if (id === null || db === null || loadingKeys) return;
    // 已经翻完了就别再发请求（第一页除外：那时候 keys 和 cursor 都是空的）
    if (keys.length > 0 && cursor === 0) return;

    this.set({ browse: { ...this.state.browse, loadingKeys: true, keysError: null } });

    try {
      const page = await this.services.client.scan(id, pattern, cursor, KEY_PAGE_SIZE);
      const current = this.state.browse;

      // 中途换了连接、库或过滤条件的话，这批结果作废 ——
      // 否则会把上一个库的 key 追加到当前列表里，看起来像见了鬼
      if (this.state.selectedId !== id || current.db !== db || current.pattern !== pattern) return;

      this.set({
        browse: {
          ...current,
          keys: [...current.keys, ...page.keys],
          cursor: page.cursor,
          loadingKeys: false,
        },
      });
    } catch (e) {
      this.set({
        browse: { ...this.state.browse, loadingKeys: false, keysError: describeError(e) },
      });
    }
  }

  /** 选中一个 key 并取它的详情 */
  async selectKey(meta: KeyMeta | null): Promise<void> {
    const id = this.state.selectedId;

    if (id === null || meta === null) {
      this.set({ browse: { ...this.state.browse, selected: null, detail: null } });
      return;
    }

    this.set({
      browse: { ...this.state.browse, selected: meta, detail: null, loadingDetail: true },
    });

    try {
      // 把列表里已经拿到的类型作为提示传下去 —— 有它后端能把
      // 「TTL + 值 + 总数」压进一个管道，少一次往返
      const detail = await this.services.client.keyDetail(
        id,
        keyBytesOf(meta),
        KEY_VALUE_LIMIT,
        meta.keyType,
      );
      // 期间用户可能又点了别的 key —— 只认最后那一次的结果
      if (this.state.selectedId !== id || this.state.browse.selected?.key !== meta.key) return;
      this.set({ browse: { ...this.state.browse, detail, loadingDetail: false } });
    } catch (e) {
      if (this.state.selectedId !== id) return;
      this.set({
        browse: { ...this.state.browse, loadingDetail: false, keysError: describeError(e) },
      });
    }
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

      // 连接没了，库列表和 key 也都不作数了
      const keyspace = { ...this.state.keyspace };
      delete keyspace[profile.id];
      this.set({
        keyspace,
        ...(this.state.selectedId === profile.id ? { browse: emptyBrowse(null) } : {}),
      });
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
