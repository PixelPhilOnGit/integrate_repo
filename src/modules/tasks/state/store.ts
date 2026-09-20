/**
 * 任务模块的状态。
 *
 * # 它管什么
 *
 * 任务列表 + 当前的筛选条件 + 选中了哪一条。**没有终端字节那类流式东西** ——
 * 任务的更新频率是人手级别的，所以这一层就是普通的 store：改一次、通知一次、
 * 界面重渲染一次。
 *
 * # 为什么每次改完都重新读一遍
 *
 * 增删改之后不把返回值拼进本地列表，而是**重新 `list()` 一遍**。理由是「谁先谁后」
 * 只有一个答案：列表的顺序是 SQL 按 `updated_at` 排的，本地拼的话就得在这里
 * 再实现一遍同样的排序，两边迟早不一致。任务量级是几千条以内，多一趟往返换
 * 「界面上看到的顺序就是库里的顺序」，值。
 *
 * # 筛选条件也在这里
 *
 * 因为侧栏的搜索框、状态筛选、主区的列表是三个组件 —— 条件放本地 state 的话
 * 它们得靠 props 一层层传，而且模块切走再回来就丢了。
 */

import { agentBus } from '../../../shared/agentBus';
import { describeError } from '../../../shell/store';
import type { ShellApi } from '../../../shell/types';
import { countByStatus, filterTasks, EMPTY_FILTER, type StatusFilter, type TaskFilter } from '../core/filter';
import type { Progress, Task, TaskPatch, TaskStatus } from '../core/types';
import { tasksClient } from '../services';

export interface TasksState {
  /** 第一次读盘完了没有 */
  ready: boolean;
  /** 全部任务（最近改过的在前，顺序由 SQL 决定） */
  tasks: Task[];
  filter: TaskFilter;
  /** 右侧详情面板在看哪一条。null = 没选 */
  selectedId: string | null;
  /**
   * **选中那条**的进度记录（从早到晚）。
   *
   * 只装当前这一条的：列表页不需要它，而翻每条任务都读一遍全量的进度
   * 是白花往返。换选中的时候重新读一次就够。
   */
  progress: Progress[];
  /**
   * 读/写库失败的原因。
   *
   * 单独存一份而不是只丢给外壳错误条：任务库打不开是**这个模块整体不可用**，
   * 用户需要看到一句解释 + 一个重试按钮，而不是一条一闪而过的横幅。
   */
  error: string | null;
}

export class TasksStore {
  private listeners = new Set<() => void>();
  /**
   * 「这个会话在办哪条任务」—— **只在内存里**，不落库。
   *
   * 会话 id 是运行时的（关掉、重启就没了），存进数据库只会让后人以为它有意义。
   * 见 [`TasksStore.dispatchTo`]。
   */
  private dispatched = new Map<string, string>();
  private state: TasksState = {
    ready: false,
    tasks: [],
    filter: EMPTY_FILTER,
    selectedId: null,
    progress: [],
    error: null,
  };
  private initPromise: Promise<void> | null = null;
  /** 外壳能力。默认空实现：store 可能在注入之前就被构造（单测里直接 new） */
  private shell: ShellApi = { setStatus: () => {}, reportError: () => {} };

  constructor() {
    // 订上「会话结束了」那条通知（派出去的任务要往进度里回写一笔）。
    // 放在构造函数而不是 `init()` 里：`init()` 是幂等的、而且可能压根不被调用
    // （用户没点进任务模块），而这件事和读盘没关系。
    this.watchAgents();
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

  getSnapshot = (): TasksState => this.state;

  private set(patch: Partial<TasksState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }

  /** 惰性初始化：切到本模块时由 `onActivate` 调。幂等 */
  init(): Promise<void> {
    this.initPromise ??= this.reload();
    return this.initPromise;
  }

  /** 重新从库里读一遍。失败就记下来（界面显示「任务库打不开」+ 重试） */
  private async reload(): Promise<void> {
    try {
      const tasks = await tasksClient.list();
      this.set({ ready: true, tasks, error: null });
    } catch (e) {
      // 起不来也要让界面能用（显示错误 + 重试），所以 ready 照样置起来
      this.set({ ready: true, error: describeError(e) });
      this.shell.reportError(e);
    }
  }

  /** 重试（错误提示上那个按钮） */
  async retry(): Promise<void> {
    this.set({ error: null });
    await this.reload();
  }

  // ---------------------------------------------------------------- 派生

  /** 按当前筛选条件该显示的任务 */
  visibleTasks(): Task[] {
    return filterTasks(this.state.tasks, this.state.filter);
  }

  counts(): Record<TaskStatus, number> {
    return countByStatus(this.state.tasks);
  }

  // ---------------------------------------------------------------- 筛选

  setQuery(query: string): void {
    this.set({ filter: { ...this.state.filter, query } });
  }

  setStatus(status: StatusFilter): void {
    this.set({ filter: { ...this.state.filter, status } });
  }

  clearFilter(): void {
    this.set({ filter: EMPTY_FILTER });
  }

  /** 选中一条（顺便把它的进度读出来 —— 详情卡片里要显示时间线） */
  select(id: string | null): void {
    this.set({ selectedId: id, progress: [] });
    if (id === null) return;
    void this.loadProgress(id);
  }

  private async loadProgress(taskId: string): Promise<void> {
    try {
      const progress = await tasksClient.progressOf(taskId);
      // 读回来的时候用户可能已经切走了 —— 那就别把它塞进界面上
      if (this.state.selectedId === taskId) this.set({ progress });
    } catch (e) {
      this.shell.reportError(e);
    }
  }

  /** 给当前选中那条记一笔进度（时间由后端给） */
  async addProgress(text: string): Promise<void> {
    const id = this.state.selectedId;
    if (id === null) return;
    try {
      await tasksClient.addProgress(id, text);
      await this.loadProgress(id);
      // 记一笔会顶起 updated_at（列表按它排）—— 重新读一遍让顺序对上
      await this.reload();
    } catch (e) {
      this.shell.reportError(e);
    }
  }

  /**
   * **把一条任务交给某个 agent 会话去干**（用户说的「任务接 agent」）。
   *
   * 干三件事：把任务内容送进那个会话（当成用户敲的）、记下「这个会话在办哪条
   * 任务」、往任务的进度里落一笔。返回 `false` = 那个会话已经不在了。
   *
   * ⚠️ **这份「会话 → 任务」的映射只活在内存里，不落库。**
   * 会话 id 是运行时的（关掉、重启就没了），存进数据库只会让后人以为它有意义。
   * 会话没了，那条关联也就没什么可回写的了。
   */
  async dispatchTo(taskId: string, sessionId: string): Promise<boolean> {
    const task = this.state.tasks.find((t) => t.id === taskId);
    if (task === undefined) return false;

    const target = agentBus.list().find((t) => t.sessionId === sessionId);
    if (target === undefined) return false;

    // 送进去的是**一段能直接开干的提示**，不是一句「去干这个活」——
    // 会话那头是个 agent，它需要的是内容本身
    const prompt =
      task.body.trim() === '' ? `任务：${task.title}` : `任务：${task.title}\n\n${task.body.trim()}`;
    if (!agentBus.send(sessionId, prompt)) return false;

    this.dispatched.set(sessionId, taskId);
    // 进度记的是**过程**（这条任务经历过什么），所以这里写事实不是结论
    await this.addProgressTo(
      taskId,
      `已派给 ${target.kind} 会话「${target.title}」（${target.workspace}）`,
    );
    return true;
  }

  /**
   * 会话结束时回写一笔。
   *
   * ⚠️ **只写「结束了」这个事实，不猜结果。** 我们只知道那个进程没了 ——
   * 干成没干成、要不要接着做，只有用户自己知道。所以这里刻意不去改任务状态，
   * 只是往进度里留一条线索（「它什么时候停的」正是回顾时最缺的那种信息）。
   */
  private watchAgents(): void {
    agentBus.onExit((sessionId) => {
      const taskId = this.dispatched.get(sessionId);
      if (taskId === undefined) return; // 这个会话不是从任务派出去的
      this.dispatched.delete(sessionId);
      void this.addProgressTo(taskId, '派出去的那个会话已经结束了');
    });
  }

  /** 往**指定**任务的进度里记一笔（`addProgress` 只管当前选中那条） */
  private async addProgressTo(taskId: string, text: string): Promise<void> {
    try {
      await tasksClient.addProgress(taskId, text);
      // 选中那条的话，顺手把界面上的进度也刷新一下
      if (this.state.selectedId === taskId) await this.loadProgress(taskId);
      await this.reload();
    } catch (e) {
      this.shell.reportError(e);
    }
  }

  // ---------------------------------------------------------------- 增删改

  /** 新建。建完**自动选中它** —— 用户下一步一定是想把描述补上 */
  async create(title: string, body: string): Promise<Task | null> {
    try {
      const task = await tasksClient.create(title, body);
      await this.reload();
      this.set({ selectedId: task.id });
      return task;
    } catch (e) {
      this.shell.reportError(e);
      return null;
    }
  }

  async patch(id: string, patch: TaskPatch): Promise<void> {
    try {
      await tasksClient.update(id, patch);
      await this.reload();
    } catch (e) {
      this.shell.reportError(e);
    }
  }

  /** 删一条。删掉的是当前选中那条的话，把选中也清掉（面板不能指着空气） */
  async remove(id: string): Promise<void> {
    try {
      await tasksClient.remove(id);
      if (this.state.selectedId === id) this.set({ selectedId: null });
      await this.reload();
    } catch (e) {
      this.shell.reportError(e);
    }
  }
}

export const tasksStore = new TasksStore();
