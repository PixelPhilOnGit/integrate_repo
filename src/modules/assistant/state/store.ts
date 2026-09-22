/**
 * 助手模块自己的状态。
 *
 * 现在装的只有**配置**（用哪家模型、key 配没配）。会话和消息流是后面的事 ——
 * 但配置得先能用：没有它，后面所有东西连不上模型。
 *
 * 几条和别的模块一致的规矩：
 *
 * * `attachShell` 用**空实现**兜底 —— store 可能在注入之前就被构造（单测里直接 new）
 * * `init()` **幂等**，切走再切回来不会把用户正在改的东西重置掉
 * * 落盘用 `createKeyValue`（桌面端走 SQLite，浏览器端走 localStorage），
 *   **key 本身不走这里** —— 它在系统钥匙串里，而且只写不读
 */

import type { ShellApi } from '../../../shell/types';
import { createKeyValue } from '../../../shared/platform/kv';
import { coerceConfig, defaultConfig, validateConfig } from '../core/config';
import type { ProviderConfig, ProviderKind } from '../core/config';
import { reduceChat } from '../core/chat';
import type { ChatMessage, PendingApproval } from '../core/chat';
import { assistantClient } from '../services';
import type {
  ApprovalDecision,
  AssistantEvent,
  AssistantKeyStatus,
  ConnectionReport,
} from '../services/types';

// 对话那部分的类型定义在 `core/chat.ts` 里（和那个纯函数的 reducer 放一起）。
// 这里 re-export 一份 —— 界面照旧从 store 这边拿，不用知道它住在哪儿。
export type { ChatMessage, PendingApproval, ToolTrace } from '../core/chat';

export interface AssistantState {
  /** 初始化跑完没有 */
  ready: boolean;
  /** 界面上正在编辑的那份 */
  config: ProviderConfig;
  /** 已经落到 KV 里的那份（用来算「有没有改过」） */
  saved: ProviderConfig;
  /** key 配到什么程度了 */
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

const CONFIG_KEY = 'provider';
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
    config: defaultConfig('anthropic'),
    saved: defaultConfig('anthropic'),
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

  private kv = createKeyValue({
    tauriFile: 'assistant.json',
    webKey: 'devtoolkit.assistant.v1',
  });

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

  private async load(): Promise<void> {
    let config = defaultConfig('anthropic');
    let workspace: string | null = null;
    try {
      const raw = await this.kv.get<unknown>(CONFIG_KEY);
      if (raw !== null && raw !== undefined) config = coerceConfig(raw);
      const savedWorkspace = await this.kv.get<unknown>(WORKSPACE_KEY);
      if (typeof savedWorkspace === 'string' && savedWorkspace !== '') {
        workspace = savedWorkspace;
      }
    } catch (e) {
      // 读配置失败不该让模块打不开：用默认值，把错误说出来
      this.shell.reportError(e);
    }
    this.set({ ready: true, config, saved: config, workspace });
    await this.refreshKeyStatus();
  }

  /** 重新问一次 key 的状态。 */
  async refreshKeyStatus(): Promise<void> {
    try {
      const keyStatus = await assistantClient.keyStatus(this.state.config.kind);
      this.set({ keyStatus });
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

    this.set({ testing: true, test: null });
    try {
      const report = await assistantClient.testConnection(this.state.config);
      this.set({ test: report });
    } catch (e) {
      this.set({
        test: { ok: false, millis: 0, message: describeError(e), reply: '' },
      });
    } finally {
      this.set({ testing: false });
    }
  }

  // ---------------------------------------------------------------- 编辑

  /** 换提供方：地址和模型跟着换成那一家的默认值。 */
  setKind(kind: ProviderKind): void {
    if (kind === this.state.config.kind) return;
    // `test: null` —— 换了一家之后，上一次的「通了」不再代表任何事。
    this.set({ config: defaultConfig(kind), notice: null, error: null, test: null });
    // 两家的 key 是分开存的，所以状态得重新问一次
    void this.refreshKeyStatus();
  }

  setBaseUrl(baseUrl: string): void {
    this.set({
      config: { ...this.state.config, baseUrl },
      notice: null,
      test: null,
    });
  }

  setModel(model: string): void {
    this.set({
      config: { ...this.state.config, model },
      notice: null,
      test: null,
    });
  }

  /** 有没改过（没改就不用给「保存」按钮亮起来）。 */
  isDirty(): boolean {
    const { config, saved } = this.state;
    return (
      config.kind !== saved.kind ||
      config.baseUrl !== saved.baseUrl ||
      config.model !== saved.model
    );
  }

  /** 配置本身有没有问题（界面在输入框下面显示它）。 */
  configProblem(): string | null {
    return validateConfig(this.state.config);
  }

  /** 保存配置。**先校验再落盘** —— 存一份发不出请求的配置没有意义。 */
  async saveConfig(): Promise<void> {
    const problem = this.configProblem();
    if (problem !== null) {
      this.set({ error: problem });
      return;
    }
    const config: ProviderConfig = {
      kind: this.state.config.kind,
      baseUrl: this.state.config.baseUrl.trim(),
      model: this.state.config.model.trim(),
    };
    try {
      await this.kv.set(CONFIG_KEY, config);
      this.set({ config, saved: config, error: null });
      this.flashNotice('已保存');
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
    const trimmed = key.trim();
    if (trimmed === '') {
      this.set({ error: 'key 是空的' });
      return;
    }
    this.set({ savingKey: true, error: null });
    try {
      await assistantClient.setApiKey(this.state.config.kind, trimmed);
      await this.refreshKeyStatus();
      this.flashNotice('key 已存进系统钥匙串');
    } catch (e) {
      this.set({ error: '存 key 失败' });
      this.shell.reportError(e);
    } finally {
      this.set({ savingKey: false });
    }
  }

  /** 删掉这个提供方的 key。 */
  async clearApiKey(): Promise<void> {
    this.set({ savingKey: true, error: null });
    try {
      await assistantClient.setApiKey(this.state.config.kind, '');
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
    void assistantClient.clearSession(previous).catch(() => undefined);
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

    // 用户那句先上去 —— 界面立刻有反应，不用等网络。
    this.openMessageId = null;
    this.appendMessage({ id: newMessageId(), role: 'user', text, tools: [] });
    this.set({ running: true, error: null, pending: null });

    try {
      const run = await assistantClient.send({
        session: this.sessionId,
        workspace,
        prompt: text,
        // ⚠️ 用**已经保存**的那份配置，不是正在编辑的那份 ——
        // 用户改了一半还没点保存，不该影响这一句。
        config: this.state.saved,
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
      await assistantClient.approve(pending.key.run, pending.key.call, decision);
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
      await assistantClient.cancel(run);
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
