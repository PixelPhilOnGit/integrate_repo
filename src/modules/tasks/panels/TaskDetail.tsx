/**
 * 主区：选中任务的东西 —— 标题、描述、备注。
 *
 * # 为什么保存时机是「失焦」而不是「每敲一个字」
 *
 * 每敲一个字就写一次库 = 打一句话往 SQLite 里灌几十次事务，而且列表会跟着
 * 重排（`updated_at` 变了），**正在打字的这一条会往列表顶上跳** —— 用户眼睁睁
 * 看着自己刚点的那一行在侧栏里乱动。
 *
 * 失焦保存配上「没有保存按钮」是这里最舒服的组合：点别处、切走、关窗口都算
 * 保存（`onBlur` 一定会在这些之前发生）。⚠️ 唯一的例外是**应用被强杀** ——
 * 那时候最后一次编辑没进库，这是接受范围内的代价（比打字时列表乱跳好）。
 *
 * # 标题为什么单独一格、还这么大
 *
 * 它是列表里唯一显示的东西。写得含糊，列表就没法扫 —— 而扫列表是这个模块
 * 最主要的使用方式。
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { formatTime } from '../core/format';
import type { TasksStore } from '../state/store';
import { STATUS_LABEL, type Progress, type Task } from '../core/types';

interface Props {
  task: Task;
  store: TasksStore;
  /** 这一条的进度记录（从早到晚）。由外面读好传进来 —— 组件不自己去取数据 */
  progress: readonly Progress[];
}

/** 新建时的默认标题。详情里拿它判断「这条是刚建出来的，该把光标放标题上」 */
export const DEFAULT_TITLE = '新任务';

export function TaskDetail({ task, store, progress }: Props): ReactNode {
  return (
    <div className="rd-task-board" data-testid="task-detail">
      {/* 一条任务 = 一张卡片。为什么是卡片：任务是**一件件独立的事**，
          卡片把「这一条的开始和结束」画在视觉上 —— 一屏排开的输入框
          看起来像一张表单，而表单会让人以为「要一次填完才能走」 */}
      <div className="rd-task-card" data-testid="task-card">
        <div className="rd-task-card-head">
          <TitleField key={task.id} task={task} store={store} />
          {/* 状态在这儿也写一份（只读）：卡片是「单独看这一条」的地方，
              不该为了看状态再瞟右边 */}
          <span
            className={`rd-task-pill is-${task.status}`}
            data-testid="task-card-status"
          >
            {STATUS_LABEL[task.status]}
          </span>
        </div>

        <Field
          key={`${task.id}-body`}
          label="描述"
          hint="这件事要干什么、做到什么算完"
          value={task.body}
          testId="task-body"
          onSave={(body) => void store.patch(task.id, { body })}
        />

        <Field
          key={`${task.id}-note`}
          label="备注"
          hint="做完之后回填：结论、踩过的坑、下次注意什么"
          value={task.note}
          testId="task-note"
          onSave={(note) => void store.patch(task.id, { note })}
        />

        <ProgressBox task={task} store={store} progress={progress} />
      </div>
    </div>
  );
}

/**
 * 进度记录：一条条带时间戳的「什么时候干了什么」。
 *
 * # 为什么要它（用户的原话：「归档后最后回顾才能知道」）
 *
 * 备注只有一个框，写的是**结论**（最后剩下什么）。而一件事的过程 ——
 * 中间试过什么、哪儿卡住过、怎么绕过去的 —— 恰恰是**回顾时最值钱**的部分，
 * 而它**没法事后补**（一周之后你只记得结论）。
 * 所以这里是**一条条记**：每记一笔自动带时间，读起来就是一条时间线。
 *
 * # 为什么没有「编辑/删除某一条」
 *
 * 它是一份**流水账**：改了就不叫记录了。记错了就在下一条里说清楚
 * （「上一条写错了，其实是……」）—— 这正是流水账该有的样子。
 */
function ProgressBox({
  task,
  store,
  progress,
}: {
  task: Task;
  store: TasksStore;
  progress: readonly Progress[];
}): ReactNode {
  const [draft, setDraft] = useState('');

  const submit = (): void => {
    const text = draft.trim();
    if (text === '') return;
    setDraft('');
    void store.addProgress(text);
  };

  return (
    <div className="rd-task-field">
      <span className="rd-task-field-head">
        <span className="rd-task-field-label">进度</span>
        <span className="rd-muted rd-task-field-hint">
          随手记一笔：刚干了什么、卡在哪。归档之后回头看的就靠它
        </span>
      </span>

      <div className="rd-task-progress-add">
        <input
          type="text"
          data-testid="task-progress-input"
          placeholder="刚干了什么 / 卡在哪 / 换了什么思路"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
        />
        <button
          type="button"
          className="rd-btn"
          data-testid="task-progress-add"
          disabled={draft.trim() === ''}
          onClick={submit}
        >
          记一笔
        </button>
      </div>

      {progress.length === 0 ? (
        <p className="rd-hint rd-muted" data-testid="task-progress-empty">
          还没有记录。这条时间线是你自己的事后回顾用的，别人看不到。
        </p>
      ) : (
        <ul className="rd-task-progress-list" data-testid="task-progress-list">
          {progress.map((entry) => (
            <li key={entry.id} className="rd-task-progress-item" data-testid={`task-progress-${entry.id}`}>
              <span className="rd-mono rd-muted rd-task-progress-time">{formatTime(entry.at)}</span>
              <span className="rd-task-progress-text">{entry.text}</span>
            </li>
          ))}
        </ul>
      )}
      {/* task 只是用来触发重建的（换任务时草稿要清掉） */}
      <span hidden>{task.id}</span>
    </div>
  );
}

/**
 * 标题那一格。
 *
 * 用 `key={task.id}` 让**换任务时组件重建** —— 否则受控输入会把上一条的内容
 * 留在框里（React 会复用同一个 DOM 节点），而「详情里显示的是别的任务」
 * 是最容易让人改错东西的一类 bug。
 */
function TitleField({ task, store }: { task: Task; store: TasksStore }): ReactNode {
  const [value, setValue] = useState(task.title);
  const ref = useRef<HTMLInputElement>(null);

  // 刚建出来的任务（标题还是默认那个）把光标放这儿：用户下一步一定是给它起名
  useEffect(() => {
    if (task.title === DEFAULT_TITLE) {
      ref.current?.focus();
      ref.current?.select();
    }
  }, [task.title]);

  const save = (): void => {
    const trimmed = value.trim();
    if (trimmed === '' || trimmed === task.title) {
      setValue(task.title); // 空标题不收，也不让框里留着空白
      return;
    }
    void store.patch(task.id, { title: trimmed });
  };

  return (
    <input
      ref={ref}
      type="text"
      className="rd-task-title-input"
      data-testid="task-title"
      aria-label="任务标题"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        // 回车就存（标题是单行，回车没有别的含义）
        if (e.key === 'Enter') e.currentTarget.blur();
      }}
    />
  );
}

/** 描述 / 备注共用一格：多行、失焦保存、上面一行标题和小字说明 */
function Field({
  label,
  hint,
  value,
  testId,
  onSave,
}: {
  label: string;
  hint: string;
  value: string;
  testId: string;
  onSave: (next: string) => void;
}): ReactNode {
  const [draft, setDraft] = useState(value);

  const save = (): void => {
    if (draft !== value) onSave(draft);
  };

  return (
    <label className="rd-task-field">
      <span className="rd-task-field-head">
        <span className="rd-task-field-label">{label}</span>
        <span className="rd-muted rd-task-field-hint">{hint}</span>
      </span>
      <textarea
        className="rd-task-textarea"
        data-testid={testId}
        value={draft}
        placeholder="（空）"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
      />
    </label>
  );
}

/** 主区空态：没选中任何任务时说清楚该干什么 */
export function TaskEmptyMain(): ReactNode {
  return (
    <div className="rd-empty rd-task-empty-main" data-testid="task-empty-main">
      左边点一条任务看它的内容；或者点「新建」记一条。
    </div>
  );
}
