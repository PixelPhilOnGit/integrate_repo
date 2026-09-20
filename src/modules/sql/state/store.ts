/**
 * SQL 模块的状态。
 *
 * 刻意**没有**把 Redis 那套连接管理抽出来共用 —— 那个抽象目前只有 Redis 一个
 * 真实消费者，现在抽是凭猜测设计。等这份 store 写完，把两份并排对比之后再抽，
 * 那时候的抽象才有依据（这条写在交接文档的「明确不做」里）。
 *
 * # 错误该往哪儿放
 *
 * - **引擎拒绝一条 SQL**（表不存在、语法错）→ 一条带 `error` 的查询结果，
 *   显示在结果区里。绝不能弹外壳错误条。
 * - **传输层失败**（连不上、断了）→ 把该连接标成 `error`，交给界面上报。
 * - **其它意外**（读盘失败之类）→ 才给 `shell.reportError`。
 */

import { describeError } from '../../../shared/platform/types';
import { suggestMongoQuery, suggestSelect } from '../core/query';
import type { ShellApi } from '../../../shell/types';
import {
  applyKindSwitch,
  hasErrors,
  newProfile,
  sameConnection,
  toConnectParams,
  validateProfile,
} from '../core/profile';
import type {
  QueryResult,
  SqlKind,
  SqlProfile,
  SqlRuntime,
  TableInfo,
} from '../core/types';
import { sqlServices } from '../services';
import type { SqlServices } from '../services/types';

/** 主区显示哪一块 */
export type SqlTab = 'result' | 'tables';

export interface SqlState {
  ready: boolean;
  profiles: SqlProfile[];
  runtime: Record<string, SqlRuntime>;
  /** 选中的连接：侧栏那一行、Inspector 编辑的那份、查询发往的那个，是同一个 */
  selectedId: string | null;

  /** 侧栏里哪些连接是展开的 */
  expanded: Record<string, boolean>;
  /** 连接 id → 它的库列表 */
  databases: Record<string, string[]>;
  /** 连接 id → 当前库里的表 */
  tables: Record<string, TableInfo[]>;
  tablesLoading: Record<string, boolean>;

  /** 编辑器里的 SQL */
  editor: string;
  /** 上一次执行的结果 */
  result: QueryResult | null;
  running: boolean;
  /** 执行历史（最近的在最后），上键回溯用 */
  history: readonly string[];
  historyIndex: number | null;
  /** 翻历史之前用户敲的内容，翻回底部时还给他 */
  historyDraft: string;

  tab: SqlTab;
}

export class SqlStore {
  private listeners = new Set<() => void>();
  private state: SqlState;
  private initPromise: Promise<void> | null = null;
  private shell: ShellApi = { setStatus: () => {}, reportError: () => {} };

  constructor(private services: SqlServices) {
    this.state = {
      ready: false,
      profiles: [],
      runtime: {},
      selectedId: null,
      expanded: {},
      databases: {},
      tables: {},
      tablesLoading: {},
      editor: 'SELECT 1',
      result: null,
      running: false,
      history: [],
      historyIndex: null,
      historyDraft: '',
      tab: 'result',
    };
  }

  // ---------------------------------------------------------------- 订阅

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getSnapshot = (): SqlState => this.state;

  attachShell(shell: ShellApi): void {
    this.shell = shell;
  }

  private set(patch: Partial<SqlState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }

  // ---------------------------------------------------------------- 生命周期

  /** 幂等：`onActivate` 每次切模块都会调，不挡住的话用户每切一次就丢一次结果 */
  init(): Promise<void> {
    this.initPromise ??= this.doInit();
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    try {
      const profiles = await this.services.profiles.load();
      const runtime: Record<string, SqlRuntime> = {};
      for (const profile of profiles) runtime[profile.id] = idleRuntime();

      this.set({
        ready: true,
        profiles,
        runtime,
        selectedId: profiles[0]?.id ?? null,
      });
    } catch (e) {
      this.initPromise = null; // 允许下次重试
      this.set({ ready: true });
      this.shell.reportError(e);
    }
  }

  // ---------------------------------------------------------------- 档案

  private findProfile(id: string): SqlProfile | undefined {
    return this.state.profiles.find((p) => p.id === id);
  }

  selectedProfile(): SqlProfile | null {
    return this.state.selectedId === null
      ? null
      : (this.findProfile(this.state.selectedId) ?? null);
  }

  select(id: string | null): void {
    const changed = this.state.selectedId !== id;
    this.set({ selectedId: id, ...(changed ? { result: null } : {}) });
    if (changed && id !== null) void this.expandAndLoad(id);
  }

  async createProfile(kind: SqlKind = 'postgres'): Promise<string> {
    const profile = newProfile(this.state.profiles, kind);
    const profiles = [...this.state.profiles, profile];

    this.set({
      profiles,
      runtime: { ...this.state.runtime, [profile.id]: idleRuntime() },
      selectedId: profile.id,
      result: null,
    });
    await this.persist(profiles);
    return profile.id;
  }

  async updateProfile(id: string, patch: Partial<SqlProfile>): Promise<void> {
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

  /** 切换引擎（MySQL ↔ PostgreSQL），顺带把用户没动过的默认值跟着换 */
  async switchKind(id: string, kind: SqlKind): Promise<void> {
    const current = this.findProfile(id);
    if (!current || current.kind === kind) return;
    await this.updateProfile(id, applyKindSwitch(current, kind));
  }

  async deleteProfile(id: string): Promise<void> {
    const profile = this.findProfile(id);
    if (!profile) return;

    if (this.state.runtime[id]?.status === 'connected') {
      await this.disconnect(id);
    }

    const profiles = this.state.profiles.filter((p) => p.id !== id);
    const runtime = { ...this.state.runtime };
    const databases = { ...this.state.databases };
    const tables = { ...this.state.tables };
    const expanded = { ...this.state.expanded };
    for (const map of [runtime, databases, tables, expanded]) delete map[id];

    this.set({
      profiles,
      runtime,
      databases,
      tables,
      expanded,
      selectedId:
        this.state.selectedId === id ? (profiles[0]?.id ?? null) : this.state.selectedId,
      ...(this.state.selectedId === id ? { result: null } : {}),
    });
    await this.persist(profiles);
  }

  private async persist(profiles: SqlProfile[]): Promise<void> {
    try {
      await this.services.profiles.save(profiles);
    } catch (e) {
      this.shell.reportError(new Error(`连接档案保存失败：${describeError(e)}`));
    }
  }

  canConnect(profile: SqlProfile): boolean {
    return !hasErrors(validateProfile(profile));
  }

  // ---------------------------------------------------------------- 连接

  async connect(id: string): Promise<void> {
    const profile = this.findProfile(id);
    if (!profile) return;

    const errors = validateProfile(profile);
    if (hasErrors(errors)) {
      this.patchRuntime(id, {
        status: 'error',
        error: Object.values(errors)[0] ?? '连接参数不合法',
      });
      return;
    }

    this.patchRuntime(id, { status: 'connecting', error: null });

    try {
      const info = await this.services.client.connect(toConnectParams(profile));
      this.patchRuntime(id, { status: 'connected', error: null, server: info, stale: false });

      // 连上就把库和表拉出来 —— 「连上就看得到东西」是这个界面的要点
      if (this.state.selectedId === id) {
        await this.expandAndLoad(id);
      }
    } catch (e) {
      this.patchRuntime(id, { status: 'error', error: describeError(e), server: null });
    }
  }

  async disconnect(id: string): Promise<void> {
    try {
      await this.services.client.disconnect(id);
    } catch (e) {
      // 断不开也得把本地状态清掉，否则界面会永远显示「已连接」
      this.shell.reportError(e);
    }
    this.patchRuntime(id, { status: 'idle', error: null, server: null, stale: false });
    this.clearMetadata(id);
  }

  private patchRuntime(id: string, patch: Partial<SqlRuntime>): void {
    const current = this.state.runtime[id] ?? idleRuntime();
    this.set({ runtime: { ...this.state.runtime, [id]: { ...current, ...patch } } });
  }

  private clearMetadata(id: string): void {
    const databases = { ...this.state.databases };
    const tables = { ...this.state.tables };
    delete databases[id];
    delete tables[id];
    this.set({ databases, tables });
  }

  // ---------------------------------------------------------------- 元数据

  async toggleExpanded(id: string): Promise<void> {
    const next = !this.state.expanded[id];
    this.set({ expanded: { ...this.state.expanded, [id]: next } });
    if (next) await this.expandAndLoad(id);
  }

  /** 拉库列表和当前库的表。已经加载过的连接直接展开，不重复请求 */
  private async expandAndLoad(id: string): Promise<void> {
    if (this.state.expanded[id] !== true) {
      this.set({ expanded: { ...this.state.expanded, [id]: true } });
    }

    if (this.state.runtime[id]?.status !== 'connected') return;
    // 用「有没有值」判断加载过没有：`undefined` 是没加载过，空数组是加载过但真的没有
    if (this.state.databases[id] !== undefined) return;

    this.set({ tablesLoading: { ...this.state.tablesLoading, [id]: true } });
    try {
      const [databases, tables] = await Promise.all([
        this.services.client.databases(id),
        this.services.client.tables(id),
      ]);
      this.set({
        databases: { ...this.state.databases, [id]: databases },
        tables: { ...this.state.tables, [id]: tables },
      });
    } catch (e) {
      // 元数据拿不到不影响写 SQL，走状态栏提示而不是弹错误条
      this.shell.setStatus(`读取库/表失败：${describeError(e)}`);
    } finally {
      this.set({ tablesLoading: { ...this.state.tablesLoading, [id]: false } });
    }
  }

  /** 换库并重新加载表列表 */
  async useDatabase(id: string, database: string): Promise<void> {
    if (this.state.runtime[id]?.status !== 'connected') return;

    const previous = this.state.databases[id] ?? [];
    try {
      const info = await this.services.client.useDatabase(id, database);
      this.patchRuntime(id, { server: info });

      const tables = await this.services.client.tables(id);
      this.set({
        tables: { ...this.state.tables, [id]: tables },
        databases: { ...this.state.databases, [id]: previous },
        result: this.state.selectedId === id ? null : this.state.result,
      });
    } catch (e) {
      this.shell.reportError(new Error(`切换库失败：${describeError(e)}`));
    }
  }

  /**
   * 点侧栏里的一张表 → 在编辑器里生成一句查询。
   *
   * ⚠️ **带 schema、带引号**：真机上报过 `relation "account_api" does not exist`
   * —— 表在非 `public` 的 schema 里，而那会儿生成的是裸表名，PostgreSQL 解析
   * 裸名字只看 `search_path`，必然找不到。规则和理由都在 `core/query.ts`。
   */
  insertTableQuery(table: TableInfo): void {
    const profile = this.selectedProfile();
    if (profile === null) return;
    this.set({
      // Mongo 那边点一个集合填的是 **JSON 查询**（它没有 SQL）—— 分流在这儿做，
      // 因为「点侧栏一行」这个动作两边是一样的
      editor:
        profile.kind === 'mongodb'
          ? suggestMongoQuery(table.name)
          : suggestSelect(profile.kind, profile.database, table.schema, table.name),
      tab: 'result',
    });
  }

  // ---------------------------------------------------------------- 编辑器

  setEditor(text: string): void {
    this.set({ editor: text, historyIndex: null });
  }

  setTab(tab: SqlTab): void {
    this.set({ tab });
  }

  historyPrev(): void {
    const entering = this.state.historyIndex === null;
    const index = entering
      ? this.state.history.length - 1
      : Math.max(0, (this.state.historyIndex ?? 0) - 1);
    if (this.state.history.length === 0) return;

    const value = this.state.history[index];
    if (value === undefined) return;

    this.set({
      historyIndex: index,
      editor: value,
      ...(entering ? { historyDraft: this.state.editor } : {}),
    });
  }

  historyNext(): void {
    if (this.state.historyIndex === null) return;

    const next = this.state.historyIndex + 1;
    if (next >= this.state.history.length) {
      this.set({ historyIndex: null, editor: this.state.historyDraft });
      return;
    }

    const value = this.state.history[next];
    if (value !== undefined) this.set({ historyIndex: next, editor: value });
  }

  // ---------------------------------------------------------------- 执行

  /** 执行编辑器里的 SQL。**串行**：上一次还在飞的时候不再发 */
  async run(): Promise<void> {
    const profile = this.selectedProfile();
    const sql = this.state.editor.trim();
    if (!profile || sql === '' || this.state.running) return;

    const id = profile.id;
    this.set({
      running: true,
      result: null,
      tab: 'result',
      history: pushHistory(this.state.history, sql),
      historyIndex: null,
    });

    try {
      const result = await this.services.client.query(id, sql);
      // 期间用户可能切走了连接 —— 只认最后那一次的结果
      if (this.state.selectedId !== id) return;
      this.set({ result });
    } catch (e) {
      if (this.state.selectedId !== id) return;
      const message = describeError(e);

      // 传输层失败：连接已经坏了，标出来并清掉元数据
      this.patchRuntime(id, { status: 'error', error: message, server: null });
      this.clearMetadata(id);
      this.set({
        result: {
          columns: [],
          rows: [],
          affected: null,
          truncated: false,
          elapsedMs: 0,
          error: message,
        },
      });
    } finally {
      this.set({ running: false });
    }
  }
}

function idleRuntime(): SqlRuntime {
  return { status: 'idle', error: null, stale: false, server: null };
}

const MAX_HISTORY = 200;

/** 记一条历史；连续重复的不记，空白的不记 */
function pushHistory(history: readonly string[], sql: string): string[] {
  const entry = sql.trim();
  if (entry === '' || history[history.length - 1] === entry) return history as string[];
  const next = [...history, entry];
  return next.length > MAX_HISTORY ? next.slice(next.length - MAX_HISTORY) : next;
}

/** 生产用的单例 */
export const sqlStore = new SqlStore(sqlServices);
