/**
 * 任务模块的数据形状。
 *
 * # 为什么只有四个字段
 *
 * 标题、描述、状态、备注 —— 是用户明确要的粒度。**字段少才好用**：优先级、
 * 截止日期、标签这些东西是「用起来之后发现自己需要」的，到时候加一列很容易
 * （Rust 那边有 `user_version` 那套迁移），但一开始就摊开七八个字段，填的人
 * 会先被劝退。
 *
 * 标题和描述的区别是刻意留的：标题是**扫列表时看的**（一屏十几条），
 * 描述是**点开之后才读的**（这件事到底要干什么、验收标准是什么）。
 * 合成一个字段的话，列表要么挤成一团，要么每条都长得一样。
 */

/** 任务的状态。**就三档** —— 和 Rust 侧 `TaskStatus` 一一对应 */
export type TaskStatus = 'todo' | 'doing' | 'done';

export interface Task {
  id: string;
  title: string;
  /** 这件事到底要干什么 */
  body: string;
  /** 做完之后回填的：结论、踩过的坑、下次注意什么 */
  note: string;
  status: TaskStatus;
  /** 毫秒时间戳（和 `Date.now()` 同一个刻度，Rust 那边也是） */
  createdAt: number;
  updatedAt: number;
  /** 什么时候标成「完成」的。没完成就是 null */
  doneAt: number | null;
}

/**
 * 改哪些字段。**没提到的字段不动** —— 和「改成空串」是两件事。
 *
 * 契约和 Rust 侧的 `TaskPatch` 对齐（那边字段是 `Option<T>`，`null`/缺失 = 不动）。
 */
export interface TaskPatch {
  title?: string;
  body?: string;
  note?: string;
  status?: TaskStatus;
}

/** 界面上只该通过这里拿文案 */
export const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: '待办',
  doing: '进行中',
  done: '已完成',
};

/** 筛选器和按钮的顺序都用它，免得三处各写一遍顺序不一样 */
export const STATUS_ORDER: readonly TaskStatus[] = ['todo', 'doing', 'done'];
