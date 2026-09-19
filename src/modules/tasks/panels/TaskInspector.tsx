/**
 * 右侧检查器：状态、时间、删除。
 *
 * # 为什么状态在检查器而不在主区
 *
 * 主区是**写东西的地方**（标题、描述、备注），检查器是**关于这条任务的元信息**。
 * 状态虽然也是「改」的一种，但它是三选一的开关，混在正文编辑区里会让那一屏
 * 显得很吵 —— 而且它**经常要在没点开的情况下看**（切到哪一条都能一眼看到
 * 它现在是什么状态）。
 *
 * # 删除为什么在这儿、还带确认
 *
 * 任务是一次性的记录，删了就没了（不像连接档案，删了重加一遍就行）。
 * 低频、不可逆 —— 这正是「边缘位置 + 二次确认」该有的样子。
 */

import { useState, type ReactNode } from 'react';
import { platform } from '../../../shared/platform';
import { STATUS_LABEL, STATUS_ORDER, type Task } from '../core/types';
import type { TasksStore } from '../state/store';

interface Props {
  task: Task;
  store: TasksStore;
}

export function TaskInspector({ task, store }: Props): ReactNode {
  const [busy, setBusy] = useState(false);

  const remove = async (): Promise<void> => {
    const ok = await platform.confirm(
      `删掉「${task.title}」？删了就找不回来了。`,
      '删除任务',
    );
    if (!ok) return;

    setBusy(true);
    try {
      await store.remove(task.id);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rd-panel" data-testid="task-inspector">
      <div className="rd-panel-body">
        <div className="rd-task-section">
          <h4 className="rd-task-section-title">状态</h4>
          <div className="rd-task-status-row" data-testid="task-status-row">
            {STATUS_ORDER.map((status) => (
              <button
                key={status}
                type="button"
                className={`rd-task-chip${task.status === status ? ' is-active' : ''}`}
                data-testid={`task-set-${status}`}
                aria-pressed={task.status === status}
                onClick={() => void store.patch(task.id, { status })}
              >
                {STATUS_LABEL[status]}
              </button>
            ))}
          </div>
          {task.status === 'done' && task.doneAt !== null && (
            <p className="rd-hint rd-muted" data-testid="task-done-at">
              完成于 {formatTime(task.doneAt)}
            </p>
          )}
        </div>

        <div className="rd-task-section">
          <h4 className="rd-task-section-title">时间</h4>
          <dl className="rd-task-times">
            <dt>建立</dt>
            <dd data-testid="task-created-at">{formatTime(task.createdAt)}</dd>
            <dt>最后改动</dt>
            <dd>{formatTime(task.updatedAt)}</dd>
          </dl>
        </div>

        <div className="rd-task-section">
          <button
            type="button"
            className="rd-btn rd-danger"
            data-testid="task-delete"
            disabled={busy}
            onClick={() => void remove()}
          >
            删除这条任务
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * 绝对时间。
 *
 * ⚠️ 这里**刻意不用**「N 分钟前」那种相对时间：那个函数住在 agents 模块里
 * （跨模块 import 违反分层），而且「这条任务是什么时候建的」问的是**确切时刻**，
 * 相对时间反而要用户自己换算。
 */
function formatTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
