/**
 * 命令历史（上下键回溯）。
 *
 * 纯函数：历史数组和「当前翻到第几条」都是传进来的，函数只算下一个状态。
 * 这样 store 里不用为它维护任何隐藏状态，测试也能直接穷举边界。
 *
 * `index === null` 表示**没有在翻历史**（输入框里是用户自己敲的东西）。
 * 一直按 ↓ 翻过最新一条之后会回到 `null`，并把用户原本的草稿还回来 ——
 * 这是 shell 的手感，别让用户按下键就永久丢掉没敲完的半行命令。
 */

export const MAX_HISTORY = 200;

/**
 * 记一条命令。
 *
 * 连续重复的不重复记（连按两次回车跑同一条命令很常见），空白的不记。
 */
export function pushHistory(history: readonly string[], input: string): string[] {
  const entry = input.trim();
  if (entry === '') return history as string[];
  if (history[history.length - 1] === entry) return history as string[];

  const next = [...history, entry];
  return next.length > MAX_HISTORY ? next.slice(next.length - MAX_HISTORY) : next;
}

export interface HistoryMove {
  /** 新的历史位置；null 表示回到草稿 */
  index: number | null;
  /** 应该填进输入框的文字 */
  value: string;
}

/**
 * 上下键导航。
 *
 * @param direction `prev` 是 ↑（往回翻），`next` 是 ↓（往新翻）
 * @param draft 用户翻历史之前输入框里的内容，↓ 翻到底时还给他
 * @returns 无事可做时返回 null（历史为空，或者本来就没在翻却按了 ↓）
 */
export function moveHistory(
  history: readonly string[],
  index: number | null,
  direction: 'prev' | 'next',
  draft: string,
): HistoryMove | null {
  if (history.length === 0) return null;

  if (direction === 'prev') {
    // 第一次按 ↑ 从最新一条开始
    const target = index === null ? history.length - 1 : Math.max(0, index - 1);
    const value = history[target];
    // target 一定落在 [0, length) 里，这个判断只是为了让类型收窄
    if (value === undefined) return null;
    return { index: target, value };
  }

  // 没在翻历史时按 ↓ 没有意义，别把草稿吃掉
  if (index === null) return null;

  const target = index + 1;
  if (target >= history.length) return { index: null, value: draft };

  const value = history[target];
  if (value === undefined) return null;
  return { index: target, value };
}
