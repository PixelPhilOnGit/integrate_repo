/**
 * 任务模块的数据形状。
 *
 * # 字段不多，但「资料」是一列
 *
 * 标题、描述、状态、资料 —— 是用户明确要的粒度。**字段少才好用**：优先级、
 * 截止日期、标签这些东西是「用起来之后发现自己需要」的，到时候加一列很容易
 * （Rust 那边有 `user_version` 那套迁移），但一开始就摊开七八个字段，填的人
 * 会先被劝退。
 *
 * 资料（attachments）是从早先那个**单框备注**长出来的：备注实际有很多形态
 * （一段结论、一份文档、一张截图），而且不止一条 —— 所以是一条条挂在任务
 * 下面，每条要么是文字（直接敲）、要么是文件（从盘上拷进应用数据目录的，
 * 见 Rust 侧 `TaskStore::add_file`）。
 *
 * 标题和描述的区别是刻意留的：标题是**扫列表时看的**（一屏十几条），
 * 描述是**点开之后才读的**（这件事到底要干什么、验收标准是什么）。
 * 合成一个字段的话，列表要么挤成一团，要么每条都长得一样。
 */

/** 任务的状态。**就三档** —— 和 Rust 侧 `TaskStatus` 一一对应 */
export type TaskStatus = 'todo' | 'doing' | 'done';

/** 资料的形态。**就两种** —— 和 Rust 侧 `AttachmentKind` 一一对应 */
export type AttachmentKind = 'text' | 'file';

/**
 * 一条资料：一段文字，或者一个文件。
 *
 * 两个形态共用一个结构体（不是判别联合）：字段就这几个，**不适用的字段是
 * 空串/0**（和 Rust 侧一致）—— 界面按 `kind` 分岔的地方本来也不会去看另一边。
 */
export interface Attachment {
  id: string;
  taskId: string;
  kind: AttachmentKind;
  /** `kind='text'` 时是内容；`'file'` 时是空串 */
  text: string;
  /** `kind='file'` 时是（清洗过的）原名；`'text'` 时是空串 */
  fileName: string;
  /** `kind='file'` 时的字节数；`'text'` 时是 0 */
  fileSize: number;
  /** 毫秒时间戳（和 `Date.now()` 同一个刻度） */
  createdAt: number;
}

export interface Task {
  id: string;
  title: string;
  /** 这件事到底要干什么 */
  body: string;
  status: TaskStatus;
  /** 毫秒时间戳（和 `Date.now()` 同一个刻度，Rust 那边也是） */
  createdAt: number;
  updatedAt: number;
  /** 什么时候标成「完成」的。没完成就是 null */
  doneAt: number | null;
  /**
   * 归档。
   *
   * **和状态是两件事**：状态说「做没做完」，归档说「还要不要摆在眼前」。
   * 归档之后默认不在列表里（有「归档」那一档专门看），但**一条都不删** ——
   * 回顾「上次那件事是怎么解决的」全靠它们。
   */
  archived: boolean;
  /**
   * 这条任务挂着的资料（文字 / 文件），按加入的先后排。
   *
   * **跟着任务一起从 `list()` 回来**：搜索要搜得到资料里的文字和文件名
   * （「上次那件事是为什么挂的」就写在某条资料里），而筛选是在这份已加载的
   * 列表上做的 —— 不同步带上就搜不着。
   */
  attachments: Attachment[];
}

/** 一条进度记录：什么时候干了什么。回顾时读的就是它 */
export interface Progress {
  id: string;
  taskId: string;
  /** 毫秒时间戳。**不给用户改** —— 那是这条记录的意义所在 */
  at: number;
  text: string;
}

/**
 * 改哪些字段。**没提到的字段不动** —— 和「改成空串」是两件事。
 *
 * 契约和 Rust 侧的 `TaskPatch` 对齐（那边字段是 `Option<T>`，`null`/缺失 = 不动）。
 */
export interface TaskPatch {
  title?: string;
  body?: string;
  status?: TaskStatus;
  archived?: boolean;
}

/** 界面上只该通过这里拿文案 */
export const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: '待办',
  doing: '进行中',
  done: '已完成',
};

/** 筛选器和按钮的顺序都用它，免得三处各写一遍顺序不一样 */
export const STATUS_ORDER: readonly TaskStatus[] = ['todo', 'doing', 'done'];
