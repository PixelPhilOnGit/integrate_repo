/**
 * 顺序图**纯展示层**用到的两个类型。
 *
 * 它们原来住在 `modules/diagram/types.ts`，但 `Diagram.tsx`（现在在 `shared/`）
 * 要拿它们，而 `shared/` 不许反向 import 模块 —— 所以搬到这里。
 * 模块的 `types.ts` 会 re-export 一份，调用方不用改。
 */

import type { Id, MessageKind } from './model';

/** 画布上当前选中的东西。`none` 是显式状态，不是 `null` —— 调用方不必判空 */
export type Selection =
  | { type: 'none' }
  | { type: 'participant'; id: Id }
  | { type: 'message'; id: Id }
  | { type: 'activation'; id: Id }
  | { type: 'note'; id: Id };

/** 拖拽画消息时的实时预览（还没落到文档里） */
export interface PendingMessage {
  from: Id;
  to: Id;
  y: number;
  kind: MessageKind;
}
