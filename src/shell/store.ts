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
import { clampPanelWidth, DEFAULT_PANEL_WIDTH } from '../shared/platform/panelWidths';
import { validateScenarioName } from '../shared/platform/scenario';
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
  /**
   * 左右两个侧栏的宽度（按**模块 id** 存）。没拖过的模块不在表里。
   *
   * 为什么按模块存、为什么要夹取，见 `shared/platform/panelWidths.ts` 的头部。
   */
  sideWidths: Record<string, number>;
  inspectorWidths: Record<string, number>;
  /** 当前场景（'' = 默认场景，见 `shared/platform/scenario.ts`） */
  scenario: string;
  /** 用户建过的场景（当前那个也在里面） */
  scenarios: string[];
  /**
   * 检查器**展开**状态（按模块 id 存）。
   * ⚠️ 默认是**折叠**（不在表里 = 关着）—— 用户点名要的：
   * 「最右侧的展示，最起码默认是折叠的」。
   */
  inspectorOpen: Record<string, boolean>;
}

export class ShellStore implements ShellApi {
  private listeners = new Set<() => void>();
  private state: ShellState;
  /** 系统主题的媒体查询。跟随系统时要听它的变化 */
  private media: MediaQueryList | null = null;
  private themeLoaded = false;

  constructor(initialModule: string) {
    this.state = {
      activeModule: initialModule,
      status: null,
      error: null,
      theme: 'system',
      sideWidths: {},
      inspectorWidths: {},
      scenario: '',
      scenarios: [],
      inspectorOpen: {},
    };

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
   * 读回上次的选择（**外观 + 两个侧栏的宽度**）并监听系统主题。
   * 由 `AppShell` 挂载时调一次。
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
      this.set({
        theme,
        sideWidths: prefs.sidePanelWidths,
        inspectorWidths: prefs.inspectorPanelWidths,
        // 场景列表/当前场景也在这里一并读回来（同一次偏好读取）
        scenario: prefs.scenario,
        scenarios: prefs.scenarios,
        inspectorOpen: prefs.inspectorOpen,
      });
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

  // ---------------------------------------------------------------- 侧栏宽度

  /** 这个模块的左侧栏宽度（没拖过就是默认值）。 */
  sideWidth(moduleId: string): number {
    return this.state.sideWidths[moduleId] ?? DEFAULT_PANEL_WIDTH;
  }

  /** 同上，右侧检查器。 */
  inspectorWidth(moduleId: string): number {
    return this.state.inspectorWidths[moduleId] ?? DEFAULT_PANEL_WIDTH;
  }

  /**
   * 记下用户拖出来的宽度。
   *
   * ⚠️ 夹取在这里做（不是只靠界面）：宽度会进 CSS，0 和几千像素**都会存进
   * 偏好**，下次打开还是坏的。见 `panelWidths.ts`。
   *
   * ⚠️ 落盘失败**不报错**（`catch` 掉了）：这是一次拖动，用户要的是宽度变了，
   * 而不是弹一条错误条 —— 大不了下次打开回到默认宽度。
   */
  setSideWidth(moduleId: string, width: number): void {
    const w = clampPanelWidth(width);
    if (this.state.sideWidths[moduleId] === w) return;
    const sideWidths = { ...this.state.sideWidths, [moduleId]: w };
    this.set({ sideWidths });
    void platform.setPrefs({ sidePanelWidths: sideWidths }).catch(() => undefined);
  }

  setInspectorWidth(moduleId: string, width: number): void {
    const w = clampPanelWidth(width);
    if (this.state.inspectorWidths[moduleId] === w) return;
    const inspectorWidths = { ...this.state.inspectorWidths, [moduleId]: w };
    this.set({ inspectorWidths });
    void platform.setPrefs({ inspectorPanelWidths: inspectorWidths }).catch(() => undefined);
  }

  /** 双击分隔条：回到默认宽度（拖坏了有个出口，不用一点点拖回来）。 */
  resetSideWidth(moduleId: string): void {
    const sideWidths = { ...this.state.sideWidths };
    delete sideWidths[moduleId];
    this.set({ sideWidths });
    void platform.setPrefs({ sidePanelWidths: sideWidths }).catch(() => undefined);
  }

  resetInspectorWidth(moduleId: string): void {
    const inspectorWidths = { ...this.state.inspectorWidths };
    delete inspectorWidths[moduleId];
    this.set({ inspectorWidths });
    void platform.setPrefs({ inspectorPanelWidths: inspectorWidths }).catch(() => undefined);
  }

  // ---------------------------------------------------------------- 检查器折叠

  /** 这个模块的检查器开着吗。**默认折叠**（不在表里 = 关着） */
  inspectorOpen(moduleId: string): boolean {
    return this.state.inspectorOpen[moduleId] ?? false;
  }

  setInspectorOpen(moduleId: string, open: boolean): void {
    if (this.inspectorOpen(moduleId) === open) return;
    const inspectorOpen = { ...this.state.inspectorOpen, [moduleId]: open };
    this.set({ inspectorOpen });
    void platform.setPrefs({ inspectorOpen }).catch(() => undefined);
  }

  /**
   * `ShellApi` 那一条：把**当前模块**的检查器露出来。
   *
   * 模块拿到的是本实例（`onActivate(shellStore)`），所以这里不用再传模块 id ——
   * 「当前模块」就是外壳自己知道的那一个。只开不收：模块没有权利把用户的
   * 检查器关掉。
   */
  openInspector(): void {
    this.setInspectorOpen(this.state.activeModule, true);
  }

  // ---------------------------------------------------------------- 场景

  /**
   * 切场景：写偏好 + **整窗重载**。
   *
   * 为什么用重载而不是「通知各 store 重读」：场景换的是**存储命名空间**
   * （每个模块的 kv 在构造时就带上了后缀），逐个 store 去写重读逻辑 =
   * 每个模块都要改一遍、而且漏一个就是「这个模块还停在旧场景的数据上」
   * 这种静悄悄的错。重载是唯一不用逐模块维护的做法。
   *
   * 代价如实告诉用户：本窗口开着的终端/会话会被收掉（重载的孤儿清理那条
   * 既有语义）。别的窗口不受影响（场景是全局偏好，它们各自切到自己为止）。
   */
  async switchScenario(name: string): Promise<void> {
    if (name === this.state.scenario) return;
    const label = name === '' ? '默认' : name;
    const ok = await platform.confirm(
      `切到场景「${label}」？\n\n这个窗口会重新加载，各模块换成这个场景的数据；` +
        '本窗口开着的终端 / 会话会被收掉。别的窗口不受影响。',
      '切换场景'
    );
    if (!ok) return;
    await platform.setPrefs({ scenario: name });
    window.location.reload();
  }

  /** 新建场景并直接切过去（建完即用，别让用户点两下）。返回是否成功。 */
  async createScenario(name: string): Promise<boolean> {
    const err = validateScenarioName(name);
    if (err !== null) {
      this.reportError(err);
      return false;
    }
    if (name === this.state.scenario || this.state.scenarios.includes(name)) {
      this.reportError(`场景「${name}」已经有了`);
      return false;
    }
    const scenarios = [...this.state.scenarios, name].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
    await platform.setPrefs({ scenarios, scenario: name });
    window.location.reload();
    return true;
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
