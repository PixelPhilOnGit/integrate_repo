/**
 * id 生成。
 *
 * 正常情况下带一个随机 session 前缀，保证不同文档、不同会话之间不会撞 id
 * （从磁盘加载的文档会带来它们自己的 id）。
 * 测试里用 __resetIdsForTest 固定 session 和计数器，让断言可预期。
 */

let counter = 0;
let session = Math.random().toString(36).slice(2, 10);

export function newId(prefix: string): string {
  counter += 1;
  return `${prefix}_${session}${counter.toString(36)}`;
}

/** 仅供测试：固定 session 并清零计数器 */
export function __resetIdsForTest(seed = 'test'): void {
  session = seed;
  counter = 0;
}
