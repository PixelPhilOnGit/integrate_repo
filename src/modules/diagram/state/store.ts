/**
 * 应用状态。
 *
 * 刻意做成**单个** store：切换文件时必须原子地重置文档、撤销栈、选中项、脏标记、
 * 视口 —— 拆成多个 store 的话，任何一次忘记同步都会产生"打开新文件后还能撤销到
 * 上一个文件的内容"这类难查的 bug。
 *
 * 对外通过 useSyncExternalStore 暴露：getSnapshot 只在状态真正变化时才换引用，
 * 否则 React 会陷入无限重渲染。
 */

import type { Doc, Id, Message, Note, Participant, Theme } from '../core/model';
import type { Rect } from '../../../shared/geometry';
import { History } from '../../../shared/history';
import * as cmd from '../core/commands';
import { createNewDoc } from '../core/samples';
import { parseDoc, serializeDoc, titleFromFileName } from '../core/schema';
import { platform } from '../../../shared/platform';
import type { FileNode } from '../../../shared/platform/types';
import { findTreeNode } from '../../../shared/platform/types';
import type { ShellApi } from '../../../shell/types';
import { basename, dirname, stripExt } from '../../../shared/platform/path';
// 状态/视图模型的类型住在 ../types：视图组件不该为了拿一个类型就 import store，
// 否则 store 一改内部结构，视图层就跟着编译报错，哪怕它根本不关心那个字段。
import type { AppState, EditTarget, PendingMessage, Selection, Viewport } from '../types';

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 4;
/** 适应窗口时四周留出的空隙（屏幕像素） */
export const FIT_PADDING = 32;

const AUTOSAVE_DELAY = 900;

export class AppStore {
  private history: History<Doc>;
  private listeners = new Set<() => void>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private state: AppState;

  /**
   * 鼠标在画布上的最后落点（文档坐标）。
   *
   * 刻意**不放进 state**：这个值每次指针移动都变，进 state 会让整棵树每帧重渲染。
   * 只在「新建注释时没有选中项可参照」的情况下当兜底位置用。
   */
  lastPointer: { x: number; y: number } | null = null;

  /**
   * 外壳能力。由模块入口在 onActivate 时注入。
   *
   * 默认是空实现而不是 null：store 可能在注入之前就被构造（比如单元测试里
   * 直接 new），那时候往里报状态不该炸。
   *
   * 刻意用注入而不是 import 外壳 —— 模块不该依赖外壳的具体实现。
   */
  private shell: ShellApi = { setStatus: () => {}, reportError: () => {} };

  attachShell(shell: ShellApi): void {
    this.shell = shell;
  }

  constructor() {
    const doc = createNewDoc('未命名');
    this.history = new History<Doc>(doc);
    this.state = {
      ready: false,
      busy: false,
      doc,
      selection: { type: 'none' },
      editing: null,
      pendingMessage: null,
      dirty: false,
      canUndo: false,
      canRedo: false,
      viewport: { zoom: 1, panX: 0, panY: 0 },
      workspaceRoot: null,
      tree: [],
      treeSelection: null,
      currentPath: null,
    };
  }

  // ---------------------------------------------------------------- 订阅

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getSnapshot = (): AppState => this.state;

  private set(patch: Partial<AppState>): void {
    this.state = {
      ...this.state,
      ...patch,
      canUndo: this.history.canUndo,
      canRedo: this.history.canRedo,
    };
    for (const fn of this.listeners) fn();
  }

  private syncDoc(extra: Partial<AppState> = {}): void {
    this.set({ doc: this.history.value, ...extra });
  }

  /** 统一的失败出口：清掉忙碌标记，把错误交给外壳显示 */
  private fail(e: unknown): void {
    this.set({ busy: false });
    this.shell.reportError(e);
  }

  /** 供界面层上报错误（导出失败、IPC 异常等） */
  reportError(e: unknown): void {
    this.fail(e);
  }

  setStatus(status: string | null): void {
    this.shell.setStatus(status);
  }

  // ---------------------------------------------------------------- 启动

  async init(): Promise<void> {
    try {
      const prefs = await platform.getPrefs();
      const root = prefs.lastWorkspace;
      if (root) {
        await this.openWorkspace(root, { silent: true });
        // 直接打开树里的第一张图，省掉一步点击
        const first = firstDiagramIn(this.state.tree);
        if (first) await this.openFile(first);
      }
    } catch {
      // 上次的工作区已经不存在了（目录被删/被移动）是正常情况，静默忽略
    } finally {
      this.set({ ready: true });
    }
  }

  // ---------------------------------------------------------------- 工作区

  async pickWorkspace(): Promise<void> {
    try {
      const root = await platform.pickWorkspace();
      if (!root) return;
      await this.openWorkspace(root);
    } catch (e) {
      this.fail(e);
    }
  }

  async openWorkspace(root: string, opts: { silent?: boolean } = {}): Promise<void> {
    this.set({ busy: true });
    try {
      const tree = await platform.listTree(root);
      const prefs = await platform.getPrefs();
      const recent = [root, ...prefs.recentWorkspaces.filter((r) => r !== root)].slice(0, 8);
      await platform.setPrefs({ lastWorkspace: root, recentWorkspaces: recent });
      this.set({ workspaceRoot: root, tree, busy: false });
      if (!opts.silent) this.setStatus(`已打开工作区 ${root}`);
    } catch (e) {
      this.fail(e);
    }
  }

  async refreshTree(): Promise<void> {
    const root = this.state.workspaceRoot;
    if (!root) return;
    try {
      this.set({ tree: await platform.listTree(root) });
    } catch (e) {
      this.fail(e);
    }
  }

  // ---------------------------------------------------------------- 文件树选中

  selectTreeEntry(path: string | null): void {
    this.set({ treeSelection: path });
  }

  /**
   * 「新建图 / 新建文件夹」该建到哪个目录。
   *
   * 跟着文件树的选中走：选中目录就建在里面，选中文件就建在它旁边，
   * 什么都没选才建在工作区根目录。
   *
   * 之前工具栏写死传 `''`（根目录），所以不管你在树里选了哪个文件夹，
   * 新建的图全堆在根上 —— 用户会觉得"树是平的、目录根本没用"。
   */
  creationDir(): string {
    const sel = this.state.treeSelection;
    if (!sel) return '';
    const node = findTreeNode(this.state.tree, sel);
    return node?.kind === 'dir' ? sel : dirname(sel);
  }

  // ---------------------------------------------------------------- 文件

  async openFile(path: string): Promise<void> {
    const root = this.state.workspaceRoot;
    if (!root) return;
    this.set({ busy: true });
    try {
      // 切文件前把未保存的改动落盘，避免静默丢失
      await this.flushSave();
      const text = await platform.readText(root, path);
      const doc = parseDoc(text, titleFromFileName(basename(path)));
      this.history.reset(doc);
      this.set({
        doc,
        selection: { type: 'none' },
        editing: null,
        dirty: false,
        currentPath: path,
        busy: false,
        viewport: { zoom: 1, panX: 0, panY: 0 },
      });
    } catch (e) {
      this.fail(e);
    }
  }

  async newDiagram(dir = '', name = '未命名'): Promise<void> {
    const root = this.state.workspaceRoot;
    if (!root) {
      this.shell.reportError('请先选择一个工作区目录');
      return;
    }
    try {
      await this.flushSave();
      const path = await platform.createDiagram(root, dir, name);
      // createDiagram 只建一个**空文件占位** —— 文档格式是前端的领域，后端不猜内容。
      // 所以初始 JSON 必须在这里写入：紧接着的 openFile 会解析文件内容，
      // 空文件解析必然失败（JSON.parse('') 抛异常），用户看到的就是"建了但打不开"。
      await platform.writeText(root, path, serializeDoc(createNewDoc(titleFromFileName(basename(path)))));
      await this.refreshTree();
      await this.openFile(path);
      this.set({ treeSelection: path });
      this.setStatus(`已新建 ${basename(path)}`);
    } catch (e) {
      this.fail(e);
    }
  }

  async newFolder(dir = '', name = '新建文件夹'): Promise<void> {
    const root = this.state.workspaceRoot;
    if (!root) {
      this.shell.reportError('请先选择一个工作区目录');
      return;
    }
    try {
      const path = await platform.createFolder(root, dir, name);
      await this.refreshTree();
      // 建完选中它，这样紧接着点「新建图」就会建进这个新目录
      this.set({ treeSelection: path });
      this.setStatus(`已新建文件夹 ${name}`);
    } catch (e) {
      this.fail(e);
    }
  }

  async renameEntry(path: string, newName: string): Promise<void> {
    const root = this.state.workspaceRoot;
    if (!root) return;
    try {
      const next = await platform.rename(root, path, newName);
      await this.refreshTree();
      // 改的是当前打开的文件，同步一下路径和标题
      if (this.state.currentPath === path) {
        const doc = cmd.setDocTitle(this.history.value, stripExt(basename(next)));
        this.history.reset(doc);
        this.set({ currentPath: next, doc, dirty: false });
      }
      this.setStatus(`已重命名为 ${basename(next)}`);
    } catch (e) {
      this.fail(e);
    }
  }

  async deleteEntry(path: string): Promise<void> {
    const root = this.state.workspaceRoot;
    if (!root) return;
    try {
      // 删的是当前文件：先取消待保存的定时器，否则刚删完又被写回去
      if (this.state.currentPath === path) {
        this.cancelPendingSave();
        this.history.reset(createNewDoc('未命名'));
        this.set({ doc: this.history.value, currentPath: null, dirty: false, selection: { type: 'none' } });
      }
      await platform.remove(root, path);
      await this.refreshTree();
      this.setStatus(`已删除 ${basename(path)}`);
    } catch (e) {
      this.fail(e);
    }
  }

  async moveEntry(path: string, newDir: string): Promise<void> {
    const root = this.state.workspaceRoot;
    if (!root) return;
    try {
      const next = await platform.move(root, path, newDir);
      await this.refreshTree();
      if (this.state.currentPath === path) this.set({ currentPath: next });
      this.setStatus(`已移动到 ${newDir || '根目录'}`);
    } catch (e) {
      this.fail(e);
    }
  }

  // ---------------------------------------------------------------- 保存

  private cancelPendingSave(): void {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
  }

  /** 立即把未保存的改动写盘（如果有） */
  async flushSave(): Promise<void> {
    this.cancelPendingSave();
    if (this.state.dirty) await this.save();
  }

  private scheduleSave(): void {
    this.cancelPendingSave();
    if (!this.state.currentPath) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.save();
    }, AUTOSAVE_DELAY);
  }

  async save(): Promise<void> {
    const { workspaceRoot: root, currentPath } = this.state;
    if (!root || !currentPath) return;
    try {
      await platform.writeText(root, currentPath, serializeDoc(this.history.value));
      this.set({ dirty: false });
      this.setStatus(`已保存 ${basename(currentPath)}`);
    } catch (e) {
      this.fail(e);
    }
  }

  // ---------------------------------------------------------------- 文档变更

  /** 离散操作：改完直接进撤销栈，并触发自动保存 */
  private commit(next: Doc): void {
    this.history.apply(next);
    this.syncDoc({ dirty: true });
    this.scheduleSave();
  }

  /** 开始拖拽：过程中不入撤销栈 */
  beginDrag(): void {
    this.history.beginDrag();
  }

  /** 拖拽中的实时预览 */
  preview(next: Doc): void {
    this.history.preview(next);
    this.syncDoc({ dirty: true });
  }

  /** 松手：整段拖拽只记一次撤销 */
  endDrag(): void {
    const depthBefore = this.history.undoDepth;
    this.history.endDrag();
    // 只有真的产生了历史记录（即拖拽确实改变了文档）才标脏并触发保存
    if (this.history.undoDepth !== depthBefore) {
      this.syncDoc({ dirty: true });
      this.scheduleSave();
    } else {
      this.syncDoc();
    }
  }

  cancelDrag(): void {
    this.history.cancelDrag();
    this.syncDoc();
  }

  undo(): void {
    this.history.undo();
    this.cancelPendingSave();
    this.syncDoc({ dirty: true });
    this.scheduleSave();
  }

  redo(): void {
    this.history.redo();
    this.cancelPendingSave();
    this.syncDoc({ dirty: true });
    this.scheduleSave();
  }

  // ---------------------------------------------------------------- 编辑命令

  addParticipant(kind: cmd.AddParticipantOptions['kind'] = 'object'): void {
    const { doc, id } = cmd.addParticipant(this.history.value, { kind });
    this.commit(doc);
    this.set({ selection: { type: 'participant', id }, editing: null });
  }

  /**
   * 把界面上的选中状态翻译成 core 能理解的焦点。
   * 注释和激活条不参与决定"下一条消息从谁发给谁"，所以一律当作没有焦点。
   */
  private focusOf(selection: Selection): cmd.Focus {
    if (selection.type === 'participant') return { kind: 'participant', id: selection.id };
    if (selection.type === 'message') return { kind: 'message', id: selection.id };
    return { kind: 'none' };
  }

  addMessage(kind: cmd.AddMessageOptions['kind']): void {
    const doc = this.history.value;
    const { selection } = this.state;
    const ends = cmd.resolveEndpoints(doc, this.focusOf(selection), kind);
    if (!ends) {
      this.shell.reportError('请先添加至少一个参与者');
      return;
    }

    const opts = { kind, from: ends.from, to: ends.to };
    // 选中了某条消息 → 插到它后面并把它之后的整体下移；否则追加到图末
    const r =
      selection.type === 'message'
        ? cmd.insertMessageAfter(doc, selection.id, opts)
        : cmd.addMessage(doc, { ...opts, y: cmd.nextMessageY(doc) });

    this.commit(r.doc);
    this.set({ selection: { type: 'message', id: r.id }, editing: null });
  }

  addNote(): void {
    const doc = this.history.value;
    const place = cmd.notePlacement(doc, this.focusOf(this.state.selection), this.lastPointer);
    const r = cmd.addNote(doc, place);
    this.commit(r.doc);
    this.set({ selection: { type: 'note', id: r.id }, editing: { type: 'note', id: r.id } });
  }

  /**
   * 在指定参与者上加一条自调用消息。
   *
   * 和 addMessage 分开是因为语义不同：那个跟随"当前选中"的上下文，
   * 这个是右键菜单明确指定了要加在谁身上。
   */
  addSelfMessage(participantId: Id): void {
    const doc = this.history.value;
    const r = cmd.addMessage(doc, {
      kind: 'self',
      from: participantId,
      to: participantId,
      y: cmd.nextMessageY(doc),
    });
    this.commit(r.doc);
    this.set({ selection: { type: 'message', id: r.id }, editing: null });
  }

  // ---------------------------------------------------------------- 拖拽画消息

  /**
   * 拖拽画消息的实时预览。
   * 每次指针移动都会调，所以只动这一小块状态，不碰文档也不进撤销栈。
   */
  setPendingMessage(pending: PendingMessage | null): void {
    this.set({ pendingMessage: pending });
  }

  /** 松手：把预览落成真正的消息 */
  commitPendingMessage(): void {
    const pending = this.state.pendingMessage;
    if (!pending) return;
    this.set({ pendingMessage: null });

    const r = cmd.insertMessageAtY(this.history.value, pending.y, {
      kind: pending.kind,
      from: pending.from,
      to: pending.to,
    });
    this.commit(r.doc);
    // 画完自动选中：紧接着通常就要改文字或改类型
    this.set({ selection: { type: 'message', id: r.id }, editing: null });
  }

  cancelPendingMessage(): void {
    if (this.state.pendingMessage) this.set({ pendingMessage: null });
  }

  // ---------------------------------------------------------------- 激活条

  /** 把激活条的终点吸附到 y 附近的消息上（拖下边缘松开时调） */
  truncateActivation(activationId: Id, y: number): void {
    this.commit(cmd.setActivationEndAtY(this.history.value, activationId, y));
  }

  /** 在指定消息处断开激活条，并在其后新开一段 */
  splitActivation(activationId: Id, atMessageId: Id): void {
    this.commit(cmd.splitActivation(this.history.value, activationId, atMessageId));
  }

  updateParticipant(id: Id, patch: Partial<Omit<Participant, 'id'>>): void {
    this.commit(cmd.updateParticipant(this.history.value, id, patch));
  }

  updateMessage(id: Id, patch: Partial<Omit<Message, 'id'>>): void {
    this.commit(cmd.updateMessage(this.history.value, id, patch));
  }

  updateNote(id: Id, patch: Partial<Omit<Note, 'id'>>): void {
    this.commit(cmd.updateNote(this.history.value, id, patch));
  }

  deleteSelection(): void {
    const { doc, selection } = this.state;
    switch (selection.type) {
      case 'participant':
        this.commit(cmd.removeParticipant(doc, selection.id));
        break;
      case 'message':
        this.commit(cmd.removeMessage(doc, selection.id));
        break;
      case 'activation':
        this.commit(cmd.removeActivation(doc, selection.id));
        break;
      case 'note':
        this.commit(cmd.removeNote(doc, selection.id));
        break;
      default:
        return;
    }
    this.set({ selection: { type: 'none' }, editing: null });
  }

  toggleActivation(participantId: Id, messageId: Id): void {
    this.commit(cmd.toggleActivation(this.history.value, participantId, messageId));
  }

  distributeParticipants(): void {
    this.commit(cmd.distributeParticipants(this.history.value));
  }

  distributeMessages(): void {
    this.commit(cmd.distributeMessages(this.history.value));
  }

  setTheme(theme: Theme): void {
    this.commit(cmd.setDocTheme(this.history.value, theme));
  }

  patchTheme(patch: Partial<Theme>): void {
    this.commit(cmd.patchDocTheme(this.history.value, patch));
  }

  setTitle(title: string): void {
    this.commit(cmd.setDocTitle(this.history.value, title));
  }

  // ---------------------------------------------------------------- 选择与视图

  select(selection: Selection): void {
    this.set({ selection, editing: null });
  }

  startEditing(target: EditTarget): void {
    this.set({ editing: target, selection: { type: target.type, id: target.id } });
  }

  stopEditing(): void {
    this.set({ editing: null });
  }

  setViewport(v: Partial<Viewport>): void {
    const cur = this.state.viewport;
    const zoom = clamp(v.zoom ?? cur.zoom, MIN_ZOOM, MAX_ZOOM);
    this.set({ viewport: { zoom, panX: v.panX ?? cur.panX, panY: v.panY ?? cur.panY } });
  }

  /** 以某个屏幕点为锚点缩放，保证该点下方的图内容不动 */
  zoomAt(factor: number, viewX: number, viewY: number): void {
    const { zoom, panX, panY } = this.state.viewport;
    const next = clamp(zoom * factor, MIN_ZOOM, MAX_ZOOM);
    if (next === zoom) return;
    // 该点在文档坐标系里的位置
    const docX = panX + viewX / zoom;
    const docY = panY + viewY / zoom;
    this.set({
      viewport: { zoom: next, panX: docX - viewX / next, panY: docY - viewY / next },
    });
  }

  /**
   * 把整张图缩放到刚好装进视口。
   *
   * 上限刻意压到 1.25 倍：小图放大会显得很蠢，而且用户紧接着就要手动缩回去。
   */
  fitTo(viewWidth: number, viewHeight: number, bounds: Rect): void {
    if (bounds.width <= 0 || bounds.height <= 0 || viewWidth <= 0 || viewHeight <= 0) return;
    const pad = FIT_PADDING;
    const zoom = clamp(
      Math.min(
        (viewWidth - pad * 2) / bounds.width,
        (viewHeight - pad * 2) / bounds.height,
      ),
      MIN_ZOOM,
      1.25,
    );
    this.set({
      viewport: {
        zoom,
        // 让内容左上角落在 (pad, pad) 处
        panX: bounds.x - pad / zoom,
        panY: bounds.y - pad / zoom,
      },
    });
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * 找目录树里的第一张图。
 * 先扫完当前层的所有文件再进子目录 —— 否则树里排在前面的空文件夹
 * 或归档目录会抢先，用户打开工作区看到的是一张无关的旧图。
 */
function firstDiagramIn(nodes: readonly FileNode[]): string | null {
  for (const n of nodes) {
    if (n.kind === 'file') return n.path;
  }
  for (const n of nodes) {
    if (n.children) {
      const found = firstDiagramIn(n.children);
      if (found) return found;
    }
  }
  return null;
}

/** 顺序图模块自己的 store。外壳有它自己的 ShellStore，两者互不引用 */
export const diagramStore = new AppStore();
