/**
 * 连接树上的拖拽：**载荷的编解码 + 「能不能落在这儿」的判断**。
 *
 * 交互（抓手、高亮、落下）在 `useConnectionDrag` 里，这一层是纯的 —— 三棵树
 * 共用同一套语义，而且「不能把目录拖进自己的子树」必须和 `moveGroupIn` 的
 * 守卫同口径，放在纯函数里单测钉得住。
 */

import { descendantIds } from './groups';
import type { ConnectionGroup } from './types';

/** 拖的是什么：`profile` = 连接行；`group` = 目录头 */
export interface DragPayload {
  kind: 'profile' | 'group';
  id: string;
}

/**
 * 载荷在 `dataTransfer` 里用的自定义 MIME。
 *
 * 用自定义类型而不是只走 `text/plain`：**外面拖进来的文本**（比如从编辑器拖
 * 一段字到侧栏上）不该被当成树里的移动。同时也往 `text/plain` 放一份 ——
 * 个别环境（以及测试里合成的 DataTransfer）只认标准类型。
 */
export const DRAG_MIME = 'application/x-rd-conn';

export function encodeDragPayload(payload: DragPayload): string {
  return JSON.stringify(payload);
}

/** 反解载荷。**外面来的东西一律不可信**：形状不对就给 null，别猜 */
export function parseDragPayload(raw: string): DragPayload | null {
  if (raw === '') return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return null;
    const { kind, id } = value as { kind?: unknown; id?: unknown };
    if ((kind !== 'profile' && kind !== 'group') || typeof id !== 'string' || id === '') {
      return null;
    }
    return { kind, id };
  } catch {
    return null;
  }
}

/**
 * 这个载荷能不能落进 `targetId` 那个目录（`null` = 面板空白处，也就是顶层/未分组）。
 *
 * 唯一的否决条件是**把目录拖进自己或自己的子树** —— 那是环。这里拦一道是为了
 * 让界面不亮高亮、显示「禁止」光标；权威守卫仍在 `moveGroupIn` 那边，
 * 两头都拦才叫防线。
 */
export function canDropInto(
  payload: DragPayload | null,
  groups: readonly ConnectionGroup[],
  targetId: string | null,
): boolean {
  if (payload === null) return false; // 没在拖（外面拖进来的东西不认）
  if (targetId === null) return true; // 空白处/顶层什么都能落（原地不动就是 no-op）
  if (payload.kind !== 'group') return true; // 连接放哪儿都行
  if (payload.id === targetId) return false;
  return !descendantIds(groups, payload.id).has(targetId);
}
