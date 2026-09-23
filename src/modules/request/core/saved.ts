/**
 * 「保存下来的请求」这块的纯逻辑。
 *
 * 和历史的区别：**历史自动记、保存手动起名**。所以这里的规矩都围着名字转：
 * 同名就是同一个请求（再存一次是覆盖，不是又长一条）。
 */

import { newId } from '../../../shared/ids';
import { cloneDraft, readDraft } from './draft';
import type { RequestDraft, SavedRequest } from './types';

/**
 * 存一条。**同名的直接覆盖**（保留原来的 id 和时间位置）。
 *
 * 为什么按名字覆盖：用户改完一个请求再点「保存」，期望的是「更新它」，
 * 而不是「多出一条一模一样的」。要另存一份的话，改个名字就是了 ——
 * 那个动作的含义没有歧义。
 */
export function upsertSaved(
  list: SavedRequest[],
  name: string,
  draft: RequestDraft,
  now: number,
): SavedRequest[] {
  const trimmed = name.trim();
  const existing = list.find((s) => s.name === trimmed);
  const entry: SavedRequest = {
    id: existing?.id ?? newId('s'),
    name: trimmed,
    savedAt: now,
    // ⚠️ 深拷一份：直接引用草稿对象的话，用户接着在编辑器里改，
    // 保存下来那份会**跟着变**（而它看起来是"存住了"的）
    draft: cloneDraft(draft),
  };
  if (existing !== undefined) {
    return list.map((s) => (s.id === entry.id ? entry : s));
  }
  return [entry, ...list];
}

export function removeSaved(list: SavedRequest[], id: string): SavedRequest[] {
  return list.filter((s) => s.id !== id);
}

/** 从键值库里读回来（校验见 `draft.ts` 的 `readDraft`）。 */
export function parseSaved(raw: unknown): SavedRequest[] {
  if (!Array.isArray(raw)) return [];
  const out: SavedRequest[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const o = item as Record<string, unknown>;
    const draft = readDraft(o['draft']);
    const name = typeof o['name'] === 'string' ? o['name'] : '';
    if (draft === null || name.trim() === '') continue;
    out.push({
      id: typeof o['id'] === 'string' && o['id'] !== '' ? o['id'] : newId('s'),
      name,
      savedAt: typeof o['savedAt'] === 'number' ? o['savedAt'] : 0,
      draft,
    });
  }
  return out;
}
