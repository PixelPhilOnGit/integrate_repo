/**
 * 助手模块自己的状态。
 *
 * 两大块：**模型配置**（可以有好几份，用哪一份）和**对话**。
 *
 * 几条和别的模块一致的规矩：
 *
 * * `attachShell` 用**空实现**兜底 —— store 可能在注入之前就被构造（单测里直接 new）
 * * `init()` **幂等**，切走再切回来不会把用户正在改的东西重置掉
 * * 落盘用 `createKeyValue`（桌面端走 SQLite，浏览器端走 localStorage），
 *   **key 本身不走这里** —— 它在系统钥匙串里，而且只写不读
 *
 * # 配置是「改了就存」，没有保存按钮
 *
 * 原来有 `config`（编辑中）/ `saved`（已落盘）两份 + `isDirty()` 逐字段比。
 * 有了**列表**之后那套不能要了：在 A 上改半截、点侧栏切到 B —— 那半截要么
 * 被静默丢掉（最糟），要么得弹「有未保存的修改」（烦）。
 * 现在只有一份真身（`profiles` 里那条），「眼前那份 = 发出去那份 = 存着那份」。
 */

import type { ShellApi } from '../../../shell/types';
import { platform } from '../../../shared/platform';
import { createKeyValue } from '../../../shared/platform/kv';
import type { KeyValueStore } from '../../../shared/platform/kv';
import {
  LEGACY_CONFIG_KEY,
  SELECTED_KEY,
  configOf,
  defaultConfig,
  defaultProfile,
  isLegacyProfile,
  profileFromLegacy,
  selectedProfile,
  validateConfig,
} from '../core/config';
import type { ProviderKind, ProviderProfile } from '../core/config';
import { reduceChat } from '../core/chat';
import type { ChatMessage, PendingApproval } from '../core/chat';
import { assistantClient } from '../services';
import { createAssistantProfileStore } from '../services/profiles';
import type {
  ApprovalDecision,
  AssistantEvent,
  AssistantKeyStatus,
  AssistantClient,
  ConnectionReport,
} from '../services/types';
import type { ProfileStore } from '../../../shared/connections/types';

// 对话那部分的类型定义在 `core/chat.ts` 里（和那个纯函数的 reducer 放一起）。
// 这里 re-export 一份 —— 界面照旧从 store 这边拿，不用知道它住在哪儿。
export type { ChatMessage, PendingApproval, ToolTrace } from '../core/chat';

export interface AssistantState {
  /** 初始化跑完没有 */
  ready: boolean;
  /** 配置名单（照连接档案：整个数组存一个键）。 */
  profiles: ProviderProfile[];
  /** 现在用的是哪一份。 */
  selectedId: string | null;
  /** **选中那份**的 key 配到什么程度了 */
  keyStatus: AssistantKeyStatus | null;
  /** 正在存 key */
  savingKey: boolean;
  /**
   * 「测试连接」的结果（`null` = 还没测过）。
   *
   * ⚠️ 配置一改就清掉 —— 留着的话，用户改完地址看到上一次的「通了」，
   * 会以为新的这套也通了。
   */
  test: ConnectionReport | null;
  /** 正在测。 */
  testing: boolean;
  /** 一句提示（保存成功之类） */
  notice: string | null;
  /** 一句错误（配置不合法、钥匙串用不了） */
  error: string | null;

  // -------------------------------------------------------------- 对话
  /** 在哪个目录里干活（绝对路径）。**没选就不能发消息**。 */
  workspace: string | null;
  /** 上下文策略（`ContextStrategy::as_str` 的短名）。 */
  strategy: string;
  /** 消息流。 */
  messages: ChatMessage[];
  /** 正在跑。 */
  running: boolean;
  /** 这次 run 的编号（取消要用）。 */
  runId: number | null;
  /** 正在等用户点确认的那条审批。 */
  pending: PendingApproval | null;
}

const WORKSPACE_KEY = 'workspace';
const KEY_NOTICE_MS = 2500;

/** 本地消息 id 的计数器。 */
let messageSeq = 0;
const newMessageId = (): string => `m${++messageSeq}`;

/**
 * 一个新的会话标识。
 *
 * 只要在**这一台机器、这个应用的一次运行里**不撞就够了 —— Rust 那边拿它当
 * 「哪份历史」的键（见 `AssistantRuntime::histories`），不做任何安全判断。
 */
const newSessionId = (): string =>
  `s${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export class AssistantStore {
  private listeners = new Set<() => void>();
  private state: AssistantState = {
    ready: false,
    profiles: [],
    selectedId: null,
    keyStatus: null,
    savingKey: false,
    test: null,
    testing: false,
    notice: null,
    error: null,
    workspace: null,
    strategy: 'full',
    messages: [],
    running: false,
    runId: null,
    pending: null,
  };
  private initPromise: Promise<void> | null = null;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  private shell: ShellApi = { setStatus: () => {}, reportError: () => {} };

  /**
   * 正在累积的那条助手消息的 id。
   *
   * `null` = 下一段文字该新起一条。在 `iteration` 的时候置回 `null` ——
   * 一次 run 有好几轮，每轮各说各的，糊成一条读起来分不清哪句是哪轮的。
   *
   * ⚠️ 它和 `state` 分开放，是因为**它不该触发重渲染** ——
   * 它变的时候界面不用动，动的是消息数组。
   */
  private openMessageId: string | null = null;

  /**
   * 当前会话的标识。
   *
   * ⚠️ 它决定「模型记不记得上一句」—— 历史在 Rust 那边按它分份存。
   * 「清空对话」换一个新的：那是「从零开始」的唯一表达方式。
   */
  private sessionId = newSessionId();

  private kv: KeyValueStore;
  private client: AssistantClient;
  private profileStore: ProfileStore<ProviderProfile>;

  /**
   * 两个依赖都可以注入 —— 单测里塞假的 KV 和假的 client 就不必碰 localStorage
   * 和平台层（照 `AgentsStore` 的 `constructor(services)`）。
   * 两个默认值都**不碰平台**（`createKeyValue` 只是个包装），所以构造过程
   * 依然可以在模块被 import 的那一刻跑。
   */
  constructor(
    client: AssistantClient = assistantClient,
    kv: KeyValueStore = createKeyValue({
      tauriFile: 'assistant.json',
      webKey: 'devtoolkit.assistant.v1',
    }),
  ) {
    this.client = client;
    this.kv = kv;
    this.profileStore = createAssistantProfileStore(kv);
  }

  attachShell(shell: ShellApi): void {
    this.shell = shell;
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getSnapshot = (): AssistantState => this.state;

  private set(patch: Partial<AssistantState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }

  /** 惰性初始化。幂等。 */
  init(): Promise<void> {
    this.initPromise ??= this.load();
    return this.initPromise;
  }

  /**
   * 读盘 + **升级迁移**。
   *
   * 迁移的顺序是有讲究的（见下面每一步的注释）：**先写名单、成功之后才消费
   * 旧键** —— 反过来的话，「写名单失败」就变成「用户配置丢了」。
   */
  private async load(): Promise<void> {
    let profiles: ProviderProfile[] = [];
    let selectedId: string | null = null;
    let workspace: string | null = null;

    try {
      profiles = await this.profileStore.load();

      if (profiles.length === 0) {
        // 名单是空的：要么是全新安装，要么是**从旧版升上来的**（旧版把那一份
        // 裸配置存在另一个键里）。
        const legacy = await this.kv.get<unknown>(LEGACY_CONFIG_KEY);
        const adopted = profileFromLegacy(legacy);
        profiles = [adopted ?? defaultProfile([])];

        // ⚠️ **先写名单。** 这一步失败会抛出去，旧键一个字没动 ——
        // 下次启动从头再来一遍，用户什么都没丢。
        await this.profileStore.save(profiles);

        // ⚠️ 名单写成了**才**消费旧键。这里失败没有副作用：
        // 名单已经非空，下次不会再采纳它（旧键就成个孤儿，不伤任何事）。
        if (adopted !== null) {
          await this.kv.set(LEGACY_CONFIG_KEY, null);
        }
      }

      const savedSelected = await this.kv.get<unknown>(SELECTED_KEY);
      selectedId =
        typeof savedSelected === 'string' && profiles.some((p) => p.id === savedSelected)
          ? savedSelected
          : (profiles[0]?.id ?? null);

      const savedWorkspace = await this.kv.get<unknown>(WORKSPACE_KEY);
      if (typeof savedWorkspace === 'string' && savedWorkspace !== '') {
        workspace = savedWorkspace;
      }
    } catch (e) {
      // 读配置失败不该让模块打不开：兜一份默认的，把错误说出来
      this.shell.reportError(e);
      if (profiles.length === 0) {
        profiles = [defaultProfile([])];
        selectedId = profiles[0]?.id ?? null;
      }
    }

    this.set({ ready: true, profiles, selectedId, workspace });
    await this.refreshKeyStatus();
  }

  /**
   * 重新问一次**选中那份**的 key 状态。
   *
   * ⚠️ 顺带做一件升级的事：从旧版迁过来的那一份如果**还没有 key**，那把 key
   * 可能还在老条目（`api_key:<提供方>`）里躺着 —— 这里再试一次搬迁。
   *
   * **刻意不落任何「搬过了」的标记**：重试条件从「现在还没有 key」推导，
   * 于是「搬到一半崩了」「钥匙串当时锁着」都能在下次自动自愈，直到成功为止。
   * 搬迁本身是幂等的（`plan_key_move`）。
   */
  async refreshKeyStatus(): Promise<void> {
    const profile = this.selected();
    if (profile === null) {
      this.set({ keyStatus: null });
      return;
    }

    const id = profile.id;
    try {
      let status = await this.client.keyStatus(id);
      if (!status.configured && isLegacyProfile(profile)) {
        await this.client.migrateApiKey(profile.kind, id);
        status = await this.client.keyStatus(id);
      }
      // ⚠️ 问的过程中用户可能切到别份了 —— 那次答案不该写进现在这份的状态里
      if (this.state.selectedId !== id) return;
      this.set({ keyStatus: status });
    } catch (e) {
      this.set({ keyStatus: null });
      this.shell.reportError(e);
    }
  }

  // ---------------------------------------------------------------- 测试连接

  /**
   * 试一下**正在编辑的这份**配置通不通。
   *
   * ⚠️ 用的是 `config`（编辑中的那份），不是 `saved` —— 用户点这个按钮，
   * 想知道的就是「我刚填的这组参数行不行」。
   *
   * ⚠️ 它是**一次往返、直接返回结果**的（不走 `Channel`）：用户卡住的时候，
   * 「界面收不到事件」和「网络根本不通」是两回事，而走 `Channel` 的话
   * 这两种会表现成同一个样子（都卡着、都不报错）。
   */
  async testConnection(): Promise<void> {
    const problem = this.configProblem();
    if (problem !== null) {
      // 参数本身就不合法，没必要发请求 —— 文案就是那条问题本身。
      this.set({ test: { ok: false, millis: 0, message: problem, reply: '' } });
      return;
    }

    const profile = this.selected();
    if (profile === null) return;

    this.set({ testing: true, test: null });
    try {
      // 一次往返，而且**不走 Channel**（理由见 `services/types.ts`）。
      // `configOf` 只取那三个字段 —— id 单独传，它只用来定位钥匙串条目。
      const report = await this.client.testConnection(configOf(profile), profile.id);
      this.set({ test: report });
    } catch (e) {
      this.set({
        test: { ok: false, millis: 0, message: describeError(e), reply: '' },
      });
    } finally {
      this.set({ testing: false });
    }
  }

  // ---------------------------------------------------------------- 配置名单

  /** 现在用的那一份（`null` = 一份都没有）。 */
  selected(): ProviderProfile | null {
    return selectedProfile(this.state);
  }

  /** 按 id 找一份。 */
  profileById(id: string): ProviderProfile | null {
    return this.state.profiles.find((p) => p.id === id) ?? null;
  }

  /**
   * 新建一份配置，自动选中。名字自动去重（「新建配置」「新建配置 2」……）——
   * 侧栏里两条同名的话，用户分不清哪条是哪条。
   */
  async createProfile(kind: ProviderKind = 'anthropic'): Promise<string> {
    const profile = defaultProfile(this.state.profiles, kind);
    const profiles = [...this.state.profiles, profile];
    this.set({
      profiles,
      selectedId: profile.id,
      keyStatus: null,
      test: null,
      error: null,
    });
    await this.persist(profiles);
    void this.kv.set(SELECTED_KEY, profile.id).catch(() => undefined);
    // key 是**按配置**存的，所以新那份的状态必须单独问一次
    await this.refreshKeyStatus();
    return profile.id;
  }

  /** 换一份用。 */
  select(id: string | null): void {
    if (id === this.state.selectedId) return;
    // ⚠️ 一并清掉 key 状态和测试结果：它们说的都是**上一份**，
    // 留着的话用户会看着 A 的「已配置」去发 B 的消息。
    this.set({ selectedId: id, keyStatus: null, test: null, notice: null, error: null });
    void this.kv.set(SELECTED_KEY, id).catch(() => undefined);
    void this.refreshKeyStatus();
  }

  /**
   * 改一份配置。**改了就存**（没有保存按钮 —— 理由见文件头那段）。
   *
   * ⚠️ 换提供方时地址和模型会跟着换成那一家的默认值。这**不是**
   * `applyKindSwitch` 那种「只改用户没动过的」：那三个字段是绑在一起的，
   * 「Anthropic 的地址 + openai 的模型名」不是一个有意义的组合。
   *
   * ⚠️ **换提供方不影响这一份的 key** —— 条目挂在配置 id 上，不挂在提供方上。
   * 这是刻意的（用户建了一份、填了 key、后来换了家，不该让他重填）。
   */
  async updateProfile(
    id: string,
    patch: Partial<Omit<ProviderProfile, 'id'>>,
  ): Promise<void> {
    const current = this.profileById(id);
    if (current === null) return;

    const next: ProviderProfile = { ...current, ...patch, id: current.id };
    if (patch.kind !== undefined && patch.kind !== current.kind) {
      next.baseUrl = patch.baseUrl ?? defaultConfig(patch.kind).baseUrl;
      next.model = patch.model ?? defaultConfig(patch.kind).model;
    }

    const profiles = this.state.profiles.map((p) => (p.id === id ? next : p));
    // ⚠️ 配置一改，上一次那个「通了」就不再代表现在这套了
    this.set({ profiles, test: null, notice: null, error: null });
    await this.persist(profiles);
  }

  /**
   * 删一份配置。
   *
   * ⚠️ **连着钥匙串里那条一起删** —— id 随机生成、永不复用，留着就是纯垃圾。
   * 但那不可逆，所以配过 key 的时候先问一句。
   *
   * ⚠️ **先落盘、后删钥匙串**：反过来的话，落盘失败就成了「配置还在、key 没了」。
   */
  async deleteProfile(id: string): Promise<void> {
    const profile = this.profileById(id);
    if (profile === null) return;

    // 配过才问：没配过就没什么可丢的，多一次确认只是烦
    let hasKey = false;
    try {
      hasKey = (await this.client.keyStatus(id)).configured;
    } catch {
      // 问不出来就当没有（钥匙串用不了时本来就存不住）
    }
    if (hasKey) {
      const ok = await platform.confirm(
        `「${profile.name}」已经配了 API key，删掉这份配置会连钥匙串里那把一起删。继续？`,
        '删除配置',
      );
      if (!ok) return;
    }

    const profiles = this.state.profiles.filter((p) => p.id !== id);
    // 删的是选中的那份 → 落到第一条（和 redis 的 deleteProfile 同一个口径）
    const selectedId =
      this.state.selectedId === id ? (profiles[0]?.id ?? null) : this.state.selectedId;

    this.set({ profiles, selectedId, keyStatus: null, test: null, error: null });
    await this.persist(profiles);

    // 落盘成功了才动钥匙串。空串 = 删（幂等：本来就没有也算成功）
    try {
      await this.client.setApiKey(id, '');
    } catch (e) {
      this.shell.reportError(e);
    }
    if (selectedId !== null) await this.refreshKeyStatus();
  }

  /** 配置本身有没有问题（界面在输入框下面显示它）。 */
  configProblem(): string | null {
    const profile = this.selected();
    return profile === null
      ? '还没有模型配置 —— 在左边点「新建」加一份'
      : validateConfig(profile);
  }

  /** 整份名单落盘。 */
  private async persist(profiles: readonly ProviderProfile[]): Promise<void> {
    try {
      await this.profileStore.save(profiles);
    } catch (e) {
      this.set({ error: '保存失败' });
      this.shell.reportError(e);
    }
  }

  // ---------------------------------------------------------------- API key

  /**
   * 存一把 key。
   *
   * ⚠️ 「没配过」和「用不了」是两件事（见 `services/types.ts`）：
   * 钥匙串不可用时这里**不静默失败** —— 要明确说出来，
   * 否则用户会以为存上了。
   */
  async saveApiKey(key: string): Promise<void> {
    const profile = this.selected();
    if (profile === null) {
      this.set({ error: '还没有模型配置 —— 在左边点「新建」加一份' });
      return;
    }
    const trimmed = key.trim();
    if (trimmed === '') {
      this.set({ error: 'key 是空的' });
      return;
    }
    this.set({ savingKey: true, error: null });
    try {
      await this.client.setApiKey(profile.id, trimmed);

      // ⚠️ 用户自己填了之后，老条目（`api_key:<提供方>`）就再也没人读了 ——
      // 顺手让搬迁再跑一次：这回走的是 `JustDelete` 分支（目标非空 → 只删来源），
      // **不会**覆盖刚填的这把。失败无所谓，它只是个清理。
      if (isLegacyProfile(profile)) {
        await this.client.migrateApiKey(profile.kind, profile.id).catch(() => undefined);
      }

      await this.refreshKeyStatus();
      this.flashNotice('key 已存进系统钥匙串');
    } catch (e) {
      this.set({ error: '存 key 失败' });
      this.shell.reportError(e);
    } finally {
      this.set({ savingKey: false });
    }
  }

  /** 删掉**这一份配置**的 key。 */
  async clearApiKey(): Promise<void> {
    const profile = this.selected();
    if (profile === null) return;

    this.set({ savingKey: true, error: null });
    try {
      await this.client.setApiKey(profile.id, '');
      await this.refreshKeyStatus();
      this.flashNotice('key 已删除');
    } catch (e) {
      this.set({ error: '删除失败' });
      this.shell.reportError(e);
    } finally {
      this.set({ savingKey: false });
    }
  }

  // ---------------------------------------------------------------- 对话

  /** 换工作目录（`null` = 还没选）。顺便记到 KV 里，下次打开还在。 */
  setWorkspace(workspace: string | null): void {
    this.set({ workspace, error: null });
    void this.kv.set(WORKSPACE_KEY, workspace).catch(() => undefined);
  }

  /** 换上下文策略（短名，见 `ContextStrategy::as_str`）。 */
  setStrategy(strategy: string): void {
    this.set({ strategy });
  }

  /**
   * 清空消息流。
   *
   * ⚠️ **不碰正在跑的 run** —— 那只停不干净（界面空了，钱还在烧）。
   * 界面上这个按钮在跑的时候是禁用的。
   */
  clearChat(): void {
    this.openMessageId = null;
    // ⚠️ **换一个 session，并且通知 Rust 那边把旧的忘掉。**
    // 只清屏幕的话，界面上空了、模型还记得 —— 下一句它会接着说上一句的事，
    // 那比不清更让人困惑。
    const previous = this.sessionId;
    this.sessionId = newSessionId();
    void this.client.clearSession(previous).catch(() => undefined);
    this.set({ messages: [], error: null });
  }

  /** 现在能不能发（界面拿它禁用输入框）。 */
  canSend(): boolean {
    return (
      this.state.ready &&
      !this.state.running &&
      this.state.workspace !== null &&
      this.configProblem() === null &&
      this.state.keyStatus?.configured === true
    );
  }

  /** 发一句话，跑一次。 */
  async send(prompt: string): Promise<void> {
    const text = prompt.trim();
    if (text === '' || this.state.running) return;

    const workspace = this.state.workspace;
    if (workspace === null) {
      this.set({ error: '先选一个工作目录 —— 助手要有个地方干活。' });
      return;
    }
    const problem = this.configProblem();
    if (problem !== null) {
      this.set({ error: problem });
      return;
    }
    if (!this.state.keyStatus?.configured) {
      this.set({ error: '还没配 API key —— 在上面那栏里填一把。' });
      return;
    }

    // ⚠️ **在 await 之前把配置抓在手里**：起跑之后用户切到别的份也不影响这一句
    //（配置是「改了就存」，所以抓的这一份就是当时眼前那份）。
    const profile = this.selected();
    if (profile === null) {
      this.set({ error: '还没有模型配置 —— 在右边「模型」面板里加一份。' });
      return;
    }

    // 用户那句先上去 —— 界面立刻有反应，不用等网络。
    this.openMessageId = null;
    this.appendMessage({ id: newMessageId(), role: 'user', text, tools: [] });
    this.set({ running: true, error: null, pending: null });

    try {
      const run = await this.client.send({
        session: this.sessionId,
        workspace,
        prompt: text,
        // `config` 是 IPC 那三个字段的契约，`profileId` 只用来定位钥匙串条目
        config: configOf(profile),
        profileId: profile.id,
        strategy: this.state.strategy,
        onEvent: (event) => this.onEvent(event),
      });
      this.set({ runId: run });
    } catch (e) {
      // 起跑就失败（工作区打不开、key 没了、配置不合法）——
      // 这时候 **不会有任何事件**，所以收尾要自己做。
      this.set({ running: false, runId: null, pending: null });
      this.set({ error: describeError(e) });
      this.shell.reportError(e);
    }
  }

  /** 回答挂在眼前的审批。 */
  async approve(decision: ApprovalDecision): Promise<void> {
    const pending = this.state.pending;
    if (pending === null) return;

    // 先把弹层收掉：用户已经点了，后端就算说「这条没了」也不该再弹回来。
    // （后端返回 `false` 是个**契约**，不是错误 —— 见 `services/types.ts`。）
    this.set({ pending: null });
    try {
      await this.client.approve(pending.key.run, pending.key.call, decision);
    } catch (e) {
      this.shell.reportError(e);
    }
  }

  /** 停止这次 run。 */
  async cancel(): Promise<void> {
    const run = this.state.runId;
    if (run === null) return;

    // 乐观更新：界面立刻停住，不等 Rust 那条 `finished` 绕一圈回来。
    // 那条到了之后走的是同一个分支，幂等。
    this.set({ running: false, runId: null, pending: null });
    try {
      await this.client.cancel(run);
    } catch (e) {
      this.shell.reportError(e);
    }
  }

  // ---------------------------------------------------------------- 事件

  /**
   * 把内核推上来的一条事件吃进状态里。
   *
   * 真正干活的是 `core/chat.ts` 里那个纯函数 —— 这里只负责把它需要的那几个
   * 字段拼出来、再把结果写回 state。这么切是为了让「事件 → 消息列表」那段逻辑
   * 能脱开 store 单测（并行工具调用配错对那类问题，跑界面是看不出来的）。
   *
   * ⚠️ `runId` 在这里**不动**：它只在起跑和收尾时变。尤其是 `finished`
   * 不要顺手清掉它 —— 取消那条路要靠「`finished` 到了但 `runId` 还没清」
   * 这类状态分辨，而 `cancel()` 已经是乐观更新了，两边一起写会打架。
   */
  private onEvent(event: AssistantEvent): void {
    const chat = reduceChat(
      {
        messages: this.state.messages,
        openId: this.openMessageId,
        pending: this.state.pending,
        running: this.state.running,
      },
      event,
      newMessageId,
    );

    this.openMessageId = chat.openId;
    const done = event.kind === 'finished';
    this.set({
      messages: chat.messages,
      pending: chat.pending,
      running: chat.running,
      // 跑完（或被停）之后这次 run 就没有编号了。
      runId: done ? null : this.state.runId,
    });
  }

  private appendMessage(message: ChatMessage): void {
    this.set({ messages: [...this.state.messages, message] });
  }

  private flashNotice(text: string): void {
    if (this.noticeTimer !== null) clearTimeout(this.noticeTimer);
    this.set({ notice: text });
    this.noticeTimer = setTimeout(() => {
      this.noticeTimer = null;
      this.set({ notice: null });
    }, KEY_NOTICE_MS);
  }
}

/**
 * 把 reject 出来的东西变成一句能显示的话。
 *
 * `shared/platform/invoke.ts` 已经保证非字符串的 reject 会被 `String()` 一道，
 * 所以这里主要是兜住别的调用路径（假实现抛的 Error）。
 */
function describeError(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message;
  return String(e);
}

export const assistantStore = new AssistantStore();
