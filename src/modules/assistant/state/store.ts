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
import { assistantClient } from '../services';
import type { AssistantKeyStatus } from '../services/types';

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
  /** 一句提示（保存成功之类） */
  notice: string | null;
  /** 一句错误（配置不合法、钥匙串用不了） */
  error: string | null;
}

const CONFIG_KEY = 'provider';
const KEY_NOTICE_MS = 2500;

export class AssistantStore {
  private listeners = new Set<() => void>();
  private state: AssistantState = {
    ready: false,
    config: defaultConfig('anthropic'),
    saved: defaultConfig('anthropic'),
    keyStatus: null,
    savingKey: false,
    notice: null,
    error: null,
  };
  private initPromise: Promise<void> | null = null;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  private shell: ShellApi = { setStatus: () => {}, reportError: () => {} };

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
    try {
      const raw = await this.kv.get<unknown>(CONFIG_KEY);
      if (raw !== null && raw !== undefined) config = coerceConfig(raw);
    } catch (e) {
      // 读配置失败不该让模块打不开：用默认值，把错误说出来
      this.shell.reportError(e);
    }
    this.set({ ready: true, config, saved: config });
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

  // ---------------------------------------------------------------- 编辑

  /** 换提供方：地址和模型跟着换成那一家的默认值。 */
  setKind(kind: ProviderKind): void {
    if (kind === this.state.config.kind) return;
    this.set({ config: defaultConfig(kind), notice: null, error: null });
    // 两家的 key 是分开存的，所以状态得重新问一次
    void this.refreshKeyStatus();
  }

  setBaseUrl(baseUrl: string): void {
    this.set({ config: { ...this.state.config, baseUrl }, notice: null });
  }

  setModel(model: string): void {
    this.set({ config: { ...this.state.config, model }, notice: null });
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

  private flashNotice(text: string): void {
    if (this.noticeTimer !== null) clearTimeout(this.noticeTimer);
    this.set({ notice: text });
    this.noticeTimer = setTimeout(() => {
      this.noticeTimer = null;
      this.set({ notice: null });
    }, KEY_NOTICE_MS);
  }
}

export const assistantStore = new AssistantStore();
