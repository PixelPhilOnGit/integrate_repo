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
import { agentBus } from '../../../shared/agentBus';
import { ContextMenu, type MenuItem } from '../../../shared/ui/ContextMenu';
import { platform } from '../../../shared/platform';
import { formatTime } from '../core/format';
import { STATUS_LABEL, STATUS_ORDER, type Task } from '../core/types';
import type { TasksStore } from '../state/store';

interface Props {
  task: Task;
  store: TasksStore;
}

export function TaskInspector({ task, store }: Props): ReactNode {
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);

  /**
   * 「派给某个会话…」—— **点的时候才去问有哪些会话**，不提前读。
   *
   * 两个原因：会话列表是**运行时**的（开着才会有），提前读就得订阅会话模块的
   * 状态变化（那是跨模块的耦合，见 `shared/agentBus.ts` 那段）；
   * 而且用户点这一下的时候，他要的就是「此刻能派的那些」。
   */
  const openDispatch = (x: number, y: number): void => {
    const targets = agentBus.list();
    setMenu({
      x,
      y,
      items:
        targets.length === 0
          ? [
              {
                label: '现在没有开着的会话',
                disabled: true,
                onSelect: () => {},
              },
            ]
          : targets.map((t) => ({
              // 工作目录比标题有用：标题只是 `claude #1` 这种编号，
              // 而用户认的是「哪个项目」
              label: `${t.title} · ${t.workspace}`,
              onSelect: () => void store.dispatchTo(task.id, t.sessionId),
            })),
    });
  };

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
          <h4 className="rd-task-section-title">交给会话</h4>
          <button
            type="button"
            className="rd-btn"
            data-testid="task-dispatch"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              openDispatch(r.left, r.bottom + 2);
            }}
          >
            派给某个会话…
          </button>
          <p className="rd-hint rd-muted">
            把标题和描述送进那个会话（就当是你自己敲的），并在进度里记一笔。
            会话结束时还会再记一笔 —— 但**不会替你改状态**：干成没干成只有你知道。
          </p>
        </div>

        <div className="rd-task-section">
          <h4 className="rd-task-section-title">收拾</h4>
          <button
            type="button"
            className="rd-btn"
            data-testid="task-archive"
            onClick={() => void store.patch(task.id, { archived: !task.archived })}
          >
            {task.archived ? '取消归档' : '归档（从列表里收起来）'}
          </button>
          <p className="rd-hint rd-muted">
            {task.archived
              ? '它现在只在左侧的「归档」那一档里。取消归档就回到常规列表。'
              : '归档不删东西：它只是从常规列表里收起来，去左侧「归档」那一档还能看到（进度记录都在）。'}
          </p>
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

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      )}
    </div>
  );
}


