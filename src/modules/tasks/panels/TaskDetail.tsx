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
import type { TasksStore } from '../state/store';
import { STATUS_LABEL, type Task } from '../core/types';

interface Props {
  task: Task;
  store: TasksStore;
}

/** 新建时的默认标题。详情里拿它判断「这条是刚建出来的，该把光标放标题上」 */
export const DEFAULT_TITLE = '新任务';

export function TaskDetail({ task, store }: Props): ReactNode {
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
      </div>
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
