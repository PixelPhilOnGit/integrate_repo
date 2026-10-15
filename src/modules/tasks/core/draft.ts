/**
 * 「刚建出来、还没动过」的空任务，以及默认标题。
 *
 * 2026-10-15 体验评审：新建是**即落库**的 —— 连点两下就是两条空「新任务」，
 * Esc 也撤不掉（只有你知道那条是手滑建出来的）。这个判断给两处用：
 *
 *   - 侧栏「新建」：已有一条这样的任务时**选中它**，而不是再建一条；
 *   - 标题框的 Esc：这样一条任务被放弃时直接删掉（Apple Notes 那种）。
 *
 * ⚠️ 只看列表数据里拿得到的字段（标题 / 描述 / 资料）。进度记录不跟着列表
 * 回来 —— 「有进度但空标题」的边界情况选择**不算空**：宁可多留一条，
 * 也不误删用户真写过东西的任务。
 */
import type { Task } from './types';

/** 新建时的默认标题。它同时是「还没起名」的信号，改文案前先看上面那段 */
export const DEFAULT_TITLE = '新任务';

export function isFreshDraft(task: Task): boolean {
  return (
    task.title === DEFAULT_TITLE &&
    task.body === '' &&
    task.attachments.length === 0 &&
    task.status === 'todo' &&
    !task.archived
  );
}
