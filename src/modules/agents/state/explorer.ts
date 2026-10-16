/**
 * 文件浏览器（检查器「文件」标签）的状态：独立的小 store。
 *
 * # 为什么不并进 AgentsStore
 *
 * `AgentsState` 的每个消费者都把整份快照读走（SessionForm / WorkspaceTree /
 * SplitView / StatusItems），往里加七八个文件浏览的字段会牵动一圈 props 面。
 * 这些状态只有检查器的两个组件在订阅，自己一份刚刚好。
 *
 * # 和 AgentsStore 的联动是**订阅推导**的，不是散在各动作里
 *
 * 「点会话 → 切回会话标签」这条联动要走**所有**改 `selectedId` 的路径：
 * 侧栏行、需要你队列、`jumpTo`、`putOnScreen`、`putGridOnScreen`、关格……
 * 挨个去挂迟早漏一条（症状：键盘跳过去了，人还留在「文件」标签上，像跳转失败）。
 * 所以这里订阅 agentsStore，在**变化的推导处**统一处理。依赖方向是单向的：
 * 这个文件 import agentsStore，反过来没有。
 *
 * # 竞态闸门
 *
 * 列目录/读预览都是异步的，切换工作目录或连点刷新时会有「旧请求晚回来」。
 * 每次 bind/refresh 使 generation +1，异步回调落地前先对号 —— 过期结果一律丢弃。
 * （同 `AgentsStore` 里会话代次的思路。）
 */

import { platform } from '../../../shared/platform';
import { describeError } from '../../../shared/platform/types';
import type { DirEntry } from '../../../shared/platform/types';
import { remoteOf } from '../core/types';
import { previewToState, type PreviewState } from '../core/explorer';
import { agentsStore, type AgentsState } from './store';

export type ExplorerTab = 'session' | 'files';

/** 一个工作目录一套浏览状态（切走再切回不丢） */
interface WorkspaceFiles {
  expanded: Set<string>;
  /** rel（'' = 根不在里面）→ 该目录的子项。根单独放 rootEntries */
  cache: Map<string, DirEntry[]>;
  rootEntries: DirEntry[];
  rootLoading: boolean;
  selected: string | null;
  preview: PreviewState;
}

export interface ExplorerSnapshot {
  tab: ExplorerTab;
  workspaceId: string | null;
  /** 展示用（远端目录放名字而不是路径，因为路径在**那台机器上**） */
  workspacePath: string;
  /** 远端工作目录：文件浏览器是诚实空态（见 FileExplorer 空态文案） */
  remote: boolean;
  rootLoading: boolean;
  /** 列目录类失败的提示（根列不出来/展开失败/打开失败），内联显示在面板底部。
   *  ⚠️ **不进外壳错误条**：文件没了、目录没了是浏览时的正常变化 */
  listError: string | null;
  rootEntries: readonly DirEntry[];
  expanded: ReadonlySet<string>;
  cache: ReadonlyMap<string, readonly DirEntry[]>;
  selected: string | null;
  preview: PreviewState;
}

const EMPTY_SET: ReadonlySet<string> = new Set();
const EMPTY_MAP: ReadonlyMap<string, readonly DirEntry[]> = new Map();

function emptyFiles(): WorkspaceFiles {
  return {
    expanded: new Set(),
    cache: new Map(),
    rootEntries: [],
    rootLoading: false,
    selected: null,
    preview: { kind: 'empty' },
  };
}

export class ExplorerStore {
  private listeners = new Set<() => void>();
  /** 每个工作目录一套（按 workspaceId 索引，内存不落盘 —— layouts 也不落盘） */
  private files = new Map<string, WorkspaceFiles>();
  private tab: ExplorerTab = 'session';
  private workspaceId: string | null = null;
  private workspacePath = '';
  private remote = false;
  private listError: string | null = null;
  private snapshot: ExplorerSnapshot;
  private generation = 0;

  constructor() {
    const initial = agentsStore.getSnapshot();
    // 先定快照再 bind（bind 里会 publish，那条路也依赖 snapshot 已就位）
    this.snapshot = this.build();
    this.bind(initial);

    let prevWs = initial.activeWorkspaceId;
    let prevSelected = initial.selectedId;
    agentsStore.subscribe(() => {
      const now = agentsStore.getSnapshot();
      if (now.activeWorkspaceId !== prevWs) {
        prevWs = now.activeWorkspaceId;
        this.bind(now);
      }
      if (now.selectedId !== prevSelected) {
        prevSelected = now.selectedId;
        // 「点会话」的意图就是看它 —— 不管从哪条路径来的
        if (this.tab !== 'session') this.setTab('session');
      }
    });
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): ExplorerSnapshot => this.snapshot;

  /** 切标签。切到「文件」时顺手重列一遍（「切过去看眼 agent 干了啥」要的是新） */
  setTab = (tab: ExplorerTab): void => {
    if (this.tab === tab) return;
    this.tab = tab;
    if (tab === 'files') {
      this.refresh();
    } else {
      this.publish();
    }
  };

  /** 刷新：重列根 + 已展开目录 + 重读预览。也用于「切到文件标签」和 bind 之后 */
  refresh = (): void => {
    const id = this.workspaceId;
    if (id === null || this.remote) {
      this.publish();
      return;
    }
    const view = this.filesOf(id);
    const gen = ++this.generation;
    // 只有「从来没列出过」才显示 loading —— 刷新时让旧内容留在屏幕上（不然闪一下白）
    view.rootLoading = view.rootEntries.length === 0;
    this.listError = null;
    this.publish();
    void this.loadAll(id, gen);
  };

  /** 展开/折叠目录。展开时**重新列**该目录（新鲜度：收起再打开 = 一次刷新） */
  toggleDir = (rel: string): void => {
    const id = this.workspaceId;
    if (id === null || this.remote) return;
    const view = this.filesOf(id);
    if (view.expanded.has(rel)) {
      view.expanded.delete(rel);
      this.publish();
      return;
    }
    view.expanded.add(rel);
    view.cache.delete(rel);
    this.publish();
    const gen = this.generation;
    void this.loadDir(id, rel, gen);
  };

  /** 选中一个文件并把预览读出来（重读一次同样的也是允许的，比如文件被改过） */
  selectFile = (rel: string): void => {
    const id = this.workspaceId;
    if (id === null || this.remote) return;
    const view = this.filesOf(id);
    view.selected = rel;
    view.preview = { kind: 'loading' };
    this.publish();
    const gen = this.generation;
    void this.loadPreview(id, rel, gen);
  };

  /** 「用系统程序打开」。浏览器版调用方不会走到这里（菜单项不渲染） */
  openWithSystem = (rel: string): void => {
    const id = this.workspaceId;
    if (id === null || this.remote) return;
    void platform.openPath(this.pathOf(id), rel).catch((e: unknown) => {
      this.listError = describeError(e);
      this.publish();
    });
  };

  // ---------------------------------------------------------------- 内部

  private build(): ExplorerSnapshot {
    const id = this.workspaceId;
    const view = id === null ? null : (this.files.get(id) ?? null);
    return {
      tab: this.tab,
      workspaceId: id,
      workspacePath: this.workspacePath,
      remote: this.remote,
      rootLoading: view?.rootLoading ?? false,
      listError: this.listError,
      rootEntries: view?.rootEntries ?? [],
      expanded: view?.expanded ?? EMPTY_SET,
      cache: view?.cache ?? EMPTY_MAP,
      selected: view?.selected ?? null,
      preview: view?.preview ?? { kind: 'empty' },
    };
  }

  private publish(): void {
    this.snapshot = this.build();
    for (const fn of this.listeners) fn();
  }

  private filesOf(id: string): WorkspaceFiles {
    let view = this.files.get(id);
    if (!view) {
      view = emptyFiles();
      this.files.set(id, view);
    }
    return view;
  }

  private pathOf(id: string): string {
    return agentsStore.getSnapshot().workspaces.find((w) => w.id === id)?.path ?? '';
  }

  /** 切到（或正在）某个工作目录时的状态切换。由订阅推导调用 */
  private bind(s: AgentsState): void {
    const ws = s.workspaces.find((w) => w.id === s.activeWorkspaceId) ?? null;
    this.workspaceId = ws?.id ?? null;
    // ⚠️ remoteOf 返回的是 RemoteTarget | null（判据是 remoteHost 非空串，
    // 见 core/types.ts），不是布尔 —— 这里要的是「是不是远端」这个事实
    this.remote = ws !== null && remoteOf(ws) !== null;
    // 远端目录展示名字：它的 path 是**那台机器上的路径**，摆出来只会误导
    //（core/types.ts 的原话：「别拿去喂 fs」）
    this.workspacePath = ws === null ? '' : this.remote ? ws.name : ws.path;
    this.listError = null;
    // 换目录 = 上一批在飞的异步结果全部作废
    this.generation += 1;
    if (this.tab === 'files') {
      this.refresh();
    } else {
      this.publish();
    }
  }

  private async loadAll(id: string, gen: number): Promise<void> {
    const view = this.filesOf(id);
    const root = this.pathOf(id);
    try {
      const entries = await platform.listDir(root, '');
      if (gen !== this.generation) return;
      view.rootEntries = entries;
      view.rootLoading = false;
      this.publish();

      // 已展开的目录重列；消失了的从展开集合和缓存里请出去（静默，不报错 ——
      // 那是浏览时的正常变化）
      for (const rel of [...view.expanded]) {
        try {
          const children = await platform.listDir(root, rel);
          if (gen !== this.generation) return;
          view.cache.set(rel, children);
        } catch {
          if (gen !== this.generation) return;
          view.expanded.delete(rel);
          view.cache.delete(rel);
        }
      }

      if (view.selected !== null) {
        await this.loadPreview(id, view.selected, gen);
        if (gen !== this.generation) return;
      }
      this.publish();
    } catch (e) {
      if (gen !== this.generation) return;
      view.rootLoading = false;
      this.listError = describeError(e);
      this.publish();
    }
  }

  private async loadDir(id: string, rel: string, gen: number): Promise<void> {
    const view = this.filesOf(id);
    try {
      const children = await platform.listDir(this.pathOf(id), rel);
      if (gen !== this.generation) return;
      view.cache.set(rel, children);
      this.publish();
    } catch (e) {
      if (gen !== this.generation) return;
      // 打不开就折回去（比如权限、被删），把原因说在面板底部
      view.expanded.delete(rel);
      view.cache.delete(rel);
      this.listError = describeError(e);
      this.publish();
    }
  }

  private async loadPreview(id: string, rel: string, gen: number): Promise<void> {
    const view = this.filesOf(id);
    try {
      const preview = await platform.readPreview(this.pathOf(id), rel);
      if (gen !== this.generation || view.selected !== rel) return;
      view.preview = previewToState(preview);
    } catch (e) {
      if (gen !== this.generation || view.selected !== rel) return;
      view.preview = { kind: 'error', message: describeError(e) };
    }
    this.publish();
  }
}

export const explorerStore = new ExplorerStore();
