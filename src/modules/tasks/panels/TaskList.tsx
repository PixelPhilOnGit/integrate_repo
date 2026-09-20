/**
 * 侧栏：搜索 + 状态筛选 + 任务列表。
 *
 * # 列表这一行显示什么
 *
 * 标题 + 状态点。**不显示描述**：描述是点开之后才读的东西，
 * 塞进列表会让每一行都一样长，扫起来反而慢（这也是数据模型里
 * 标题和描述分开的原因，见 `core/types.ts`）。
 *
 * # 空态分两种，不能混
 *
 * 「一条任务都没有」（还没开始用）和「筛完什么都没有」（搜索词不对）要说
 * 不同的话 —— 前者要引导他去新建，后者要说清楚是筛选把东西挡掉了，
 * 并给一个「清掉筛选」的出口。混成一句「没有任务」的话，用户会以为数据没了。
 */

import type { ReactNode } from 'react';
import { NoMatch, SearchBox } from '../../../shared/ui/SearchBox';
import { archivedCount } from '../core/filter';
import { STATUS_LABEL, STATUS_ORDER } from '../core/types';
import type { TasksState, TasksStore } from '../state/store';

interface Props {
  state: TasksState;
  store: TasksStore;
}

export function TaskList({ state, store }: Props): ReactNode {
  const visible = store.visibleTasks();
  const counts = store.counts();
  const filtering = state.filter.query.trim() !== '' || state.filter.status !== 'all';

  return (
    <div className="rd-panel" data-testid="task-sidebar">
      <div className="rd-panel-head">
        <span>任务</span>
        <span className="rd-spacer" />
        <button
          type="button"
          className="rd-btn"
          data-testid="task-new"
          title="新建一条任务"
          onClick={() => void store.create('新任务', '')}
        >
          新建
        </button>
      </div>

      {state.tasks.length > 0 && (
        <SearchBox
          value={state.filter.query}
          onChange={(q) => store.setQuery(q)}
          testId="task-search"
          placeholder="搜标题、描述、备注"
        />
      )}

      {state.tasks.length > 0 && (
        <div className="rd-task-filters" data-testid="task-filters">
          <FilterChip
            label="全部"
            count={state.tasks.length}
            active={state.filter.status === 'all'}
            testId="task-filter-all"
            onClick={() => store.setStatus('all')}
          />
          {STATUS_ORDER.map((status) => (
            <FilterChip
              key={status}
              label={STATUS_LABEL[status]}
              count={counts[status]}
              active={state.filter.status === status}
              testId={`task-filter-${status}`}
              onClick={() => store.setStatus(status)}
            />
          ))}
          {/* 归档单独一档：它不是第四种状态，是「收起来了的那些」 */}
          {archivedCount(state.tasks) > 0 && (
            <FilterChip
              label="归档"
              count={archivedCount(state.tasks)}
              active={state.filter.status === 'archived'}
              testId="task-filter-archived"
              onClick={() => store.setStatus('archived')}
            />
          )}
        </div>
      )}

      <div className="rd-panel-body">
        {state.error !== null ? (
          <div className="rd-task-error" data-testid="task-error">
            <p className="rd-danger">{state.error}</p>
            <button type="button" className="rd-btn" onClick={() => void store.retry()}>
              重试
            </button>
          </div>
        ) : !state.ready ? (
          <div className="rd-empty">正在读任务库…</div>
        ) : state.tasks.length === 0 ? (
          <div className="rd-empty" data-testid="task-empty">
            还没有任务。点右上角「新建」记一条 —— 想到什么先记下来，别攒在脑子里。
          </div>
        ) : visible.length === 0 ? (
          <div className="rd-task-nomatch">
            <NoMatch testId="task-nomatch" />
            {/* 筛选把东西挡掉了：给一个出口，而不是让用户自己去清搜索框 */}
            {filtering && (
              <button
                type="button"
                className="rd-btn"
                data-testid="task-clear-filter"
                onClick={() => store.clearFilter()}
              >
                清掉筛选
              </button>
            )}
          </div>
        ) : (
          visible.map((task) => (
            <button
              key={task.id}
              type="button"
              className={`rd-task-row is-${task.status}${
                task.id === state.selectedId ? ' is-selected' : ''
              }`}
              data-testid={`task-row-${task.id}`}
              data-task-title={task.title}
              data-task-status={task.status}
              onClick={() => store.select(task.id)}
            >
              <span className={`rd-task-dot is-${task.status}`} aria-hidden="true" />
              <span className="rd-task-row-text">
                <span className="rd-task-title">{task.title}</span>
                {/* 列表里只给状态。**「多久之前」不放这儿**：那要一个相对时间的
                    格式化函数，而它现在住在 agents 模块里 —— 跨模块 import 违反
                    分层（`shared/` 才是它该在的地方，等真有第二个模块需要时再挪）。
                    准确的时间在右边详情里，那边用绝对时间 */}
                <span className="rd-muted rd-task-meta">{STATUS_LABEL[task.status]}</span>
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

function FilterChip({
  label,
  count,
  active,
  testId,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  testId: string;
  onClick: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      className={`rd-task-chip${active ? ' is-active' : ''}`}
      data-testid={testId}
      aria-pressed={active}
      onClick={onClick}
    >
      {label}
      <span className="rd-muted"> {count}</span>
    </button>
  );
}
