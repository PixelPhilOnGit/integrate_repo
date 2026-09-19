/**
 * 任务模块的各个槽位。
 *
 * 外壳只认 `Module` 接口，它把这些组件填进去：
 *   Sidebar（左） / Main（中） / Inspector（右） / StatusItems（状态栏右侧）
 *
 * 分工和另外几个模块一致：**侧栏导航、主区干活、检查器看细节**。
 * 这里没有 Toolbar（工具都在侧栏顶部，不需要横跨一条）。
 *
 * 任务没有终端、没有连接，所以这一层**没有任何生命周期要管** ——
 * 档位全在 store 里，组件只负责画。
 */

import { useSyncExternalStore, type ReactNode } from 'react';
import { openCount } from './core/filter';
import { STATUS_LABEL } from './core/types';
import { TaskDetail, TaskEmptyMain } from './panels/TaskDetail';
import { TaskInspector } from './panels/TaskInspector';
import { TaskList } from './panels/TaskList';
import { tasksStore } from './state/store';

/** 订阅模块自己的 store。外壳不掺和模块的状态 */
function useTasks() {
  return useSyncExternalStore(tasksStore.subscribe, tasksStore.getSnapshot);
}

export function TasksSidebar(): ReactNode {
  return <TaskList state={useTasks()} store={tasksStore} />;
}

export function TasksMain(): ReactNode {
  // ⚠️ **必须走 `useTasks()` 订阅**：直接 `tasksStore.selected()` 读一次的话，
  // 建完/删完任务这里不会重渲染（列表跟着变、主区还停在旧内容上）。
  // 这条是 e2e 抓出来的。
  const state = useTasks();
  // 选中的 id 指向的任务可能已经没了（刚被删掉）—— `find` 的结果是 null，
  // 那就落到空态
  const task = state.tasks.find((t) => t.id === state.selectedId) ?? null;
  return task === null ? (
    <TaskEmptyMain />
  ) : (
    // `key` 让换任务时整块重建：受控输入的草稿状态不能跨任务残留
    <TaskDetail key={task.id} task={task} store={tasksStore} />
  );
}

export function TasksInspector(): ReactNode {
  const state = useTasks();
  const task = state.tasks.find((t) => t.id === state.selectedId) ?? null;
  return task === null ? (
    <div className="rd-panel">
      <div className="rd-panel-body">
        <div className="rd-empty">点左边一条任务，这里显示它的状态和时间</div>
      </div>
    </div>
  ) : (
    <TaskInspector key={task.id} task={task} store={tasksStore} />
  );
}

/** 状态栏右侧：还没做完的有几条 */
export function TasksStatusItems(): ReactNode {
  const state = useTasks();
  const counts = state.tasks.reduce<Record<string, number>>((acc, t) => {
    acc[t.status] = (acc[t.status] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <span className="rd-status-item" data-testid="tasks-status">
      {STATUS_LABEL.todo} {counts['todo'] ?? 0} · {STATUS_LABEL.doing} {counts['doing'] ?? 0}
    </span>
  );
}

/**
 * 图标栏上的角标：**还没做完的有几条**。
 *
 * 和智能体会话那个角标同一个用途（用户在别的模块里时唯一的提醒），但口径不同：
 * 那个数的是「现在有事找你」，这个数的是「还有多少事没做完」——
 * 前者是急事，后者是欠账。
 *
 * 一条都没有就整个不画（`null`）：角标挂在图标上，一直亮着就会被无视。
 */
export function TasksBadge(): ReactNode {
  const state = useTasks();
  const open = openCount(state.tasks);
  if (open === 0) return null;

  return (
    <span className="rd-module-badge" data-testid="tasks-badge" aria-label={`${open} 条任务没做完`}>
      {open > 9 ? '9+' : open}
    </span>
  );
}
