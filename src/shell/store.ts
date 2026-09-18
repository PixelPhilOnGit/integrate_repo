/**
 * 外壳状态。
 *
 * 刻意**只有三样东西**：当前模块、状态栏文字、错误。
 * 工作区、文件树、文档这些都属于具体模块 —— 外壳不认识它们。
 *
 * 和模块的 store 互不引用：模块通过构造时注入的 ShellApi 往外说话，
 * 外壳不知道任何模块的存在（只认注册表里的 Module 接口）。
 */

import { platform } from '../shared/platform';
import { applyTheme, parseThemeChoice, resolveTheme, systemPrefersDark, type ThemeChoice } from './theme';
import type { ShellApi } from './types';

export interface ShellState {
  /** 当前模块 id */
  activeModule: string;
  status: string | null;
  error: string | null;
  /**
   * 外观：用户**选的那一档**（不是屏幕上生效的那个）。
   *
   * 界面上的勾选状态看它 —— 选了「跟随系统」就得显示勾在「跟随系统」上，
   * 而不是勾在当下解析出来的「深色」上。
   */
  theme: ThemeChoice;
}

export class ShellStore implements ShellApi {
  private listeners = new Set<() => void>();
  private state: ShellState;
  /** 系统主题的媒体查询。跟随系统时要听它的变化 */
  private media: MediaQueryList | null = null;
  private themeLoaded = false;

  constructor(initialModule: string) {
    this.state = { activeModule: initialModule, status: null, error: null, theme: 'system' };

    // **默认值在这里就应用**，不等读盘：它要在 React 渲染之前生效，
    // 否则系统是深色的用户会先看到一帧白底再跳成黑的。
    // 读回来的选择是异步的（要过 IPC / localStorage），那时候再覆盖一次
    applyTheme(resolveTheme('system', systemPrefersDark()));
  }

  // ---------------------------------------------------------------- 订阅

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getSnapshot = (): ShellState => this.state;

  private set(patch: Partial<ShellState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }

  // ---------------------------------------------------------------- ShellApi

  setStatus = (msg: string | null): void => {
    this.set({ status: msg });
  };

  reportError = (e: unknown): void => {
    this.set({ error: describeError(e) });
  };

  clearError = (): void => {
    this.set({ error: null });
  };

  // ---------------------------------------------------------------- 模块切换

  activate(id: string): void {
    if (this.state.activeModule === id) return;
    // 切模块时清掉上一个模块留下的状态文字，否则会挂着一条不相干的消息
    this.set({ activeModule: id, status: null, error: null });
  }

  // ---------------------------------------------------------------- 外观

  /**
   * 读回上次的选择并监听系统主题。由 `AppShell` 挂载时调一次。
   *
   * 重复调用只跑一次：它订阅了一个媒体查询，跑两次会挂上两个监听。
   */
  async initTheme(): Promise<void> {
    if (this.themeLoaded) return;
    this.themeLoaded = true;

    // 系统主题变了要跟着变 —— 但**只在「跟随系统」那一档**。
    // 用户明确选了深色的时候系统切到浅色，界面必须纹丝不动：
    // 他刚刚才做的那个选择，被系统设置悄悄改掉是最让人恼火的一类 bug
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      this.media = window.matchMedia('(prefers-color-scheme: dark)');
      this.media.addEventListener('change', () => this.applyCurrentTheme());
    }

    try {
      const prefs = await platform.getPrefs();
      const theme = parseThemeChoice(prefs.theme);
      this.set({ theme });
      this.applyCurrentTheme();
    } catch {
      // 读不到就用默认值（构造时已经应用过了）。这里不弹错误条：
      // 外观读不出来不该在界面上留一条红色的东西
    }
  }

  setTheme(choice: ThemeChoice): void {
    if (this.state.theme === choice) return;
    this.set({ theme: choice });
    this.applyCurrentTheme();
    // 存的是**选择**不是解析结果，见 theme.ts 头部那段
    void platform.setPrefs({ theme: choice }).catch(() => undefined);
  }

  private applyCurrentTheme(): void {
    applyTheme(resolveTheme(this.state.theme, systemPrefersDark()));
  }
}

/** 把任意抛出物转成可读的中文提示 */
export function describeError(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}
