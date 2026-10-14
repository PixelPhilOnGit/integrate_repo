/**
 * 连接树的拖拽状态机（三个侧栏共用）：抓手起拖 → 目录/空白落下的全过程。
 *
 * # 为什么不是整行 draggable
 *
 * `draggable=true` 的元素里，文字在 Chromium 里**选不中** —— 而这个仓当年
 * 专门删过 `user-select: none`，就是为了让主机名能复制（`styles.css` 里
 * 记着这件事）。所以拖拽的起点是一个**悬停露出的抓手**（`.rd-conn-drag`）：
 * 抓手 draggable，`setDragImage` 让鬼影还是整行。
 *
 * # 为什么 `dragover` 时要另存一份拖拽状态
 *
 * 原生 DnD 在 `dragover` 阶段**读不到 `dataTransfer` 的内容**（只有类型列表
 * 可见）。所以「能不能落这儿」只能拿 `dragstart` 那一刻记下的载荷来判断 ——
 * 这也是几乎所有原生 DnD 实现都绕不开的一步。
 */

import { useState, type DragEvent } from 'react';
import {
  canDropInto,
  DRAG_MIME,
  encodeDragPayload,
  parseDragPayload,
  type DragPayload,
} from './dnd';
import type { ConnectionGroup } from './types';

/** 面板空白处那个落点（= 顶层/未分组）。用空串当哨兵：`null` 已经被「没在拖」占了 */
export const ROOT_TARGET = '';

/** 挂在抓手上（`ConnectionRow` / `ConnectionGroupRow` 的 `dragHandle` 原样铺开） */
export interface DragHandleProps {
  draggable: true;
  onDragStart: (e: DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
}

/** 挂在落下区上（目录的整块区域、或者面板空白） */
export interface DropZoneProps {
  onDragOver: (e: DragEvent<HTMLElement>) => void;
  onDragLeave: (e: DragEvent<HTMLElement>) => void;
  onDrop: (e: DragEvent<HTMLElement>) => void;
}

export interface ConnectionDrag {
  /** 正在拖的东西（不在拖就是 null）。行/目录头拿它画「原位置淡一点」 */
  dragging: DragPayload | null;
  /** 正悬停着的落点：目录 id，或者 [`ROOT_TARGET`]（面板空白），没悬停是 null */
  dropTargetId: string | null;
  handleProps: (payload: DragPayload) => DragHandleProps;
  /** 落在哪个目录里（`null` = 面板空白 = 顶层/未分组） */
  zoneProps: (targetId: string | null) => DropZoneProps;
}

export function useConnectionDrag(opts: {
  groups: readonly ConnectionGroup[];
  /** 把连接放进目录（`null` = 移出到未分组） */
  moveProfile: (id: string, groupId: string | null) => void;
  /** 把目录挪到另一个目录下（`null` = 顶层） */
  moveGroup: (id: string, parentId: string | null) => void;
}): ConnectionDrag {
  const [dragging, setDragging] = useState<DragPayload | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);

  const handleProps = (payload: DragPayload): DragHandleProps => ({
    draggable: true,
    onDragStart: (e) => {
      e.stopPropagation();
      const encoded = encodeDragPayload(payload);
      e.dataTransfer.setData(DRAG_MIME, encoded);
      e.dataTransfer.setData('text/plain', encoded);
      e.dataTransfer.effectAllowed = 'move';
      // 鬼影用整行而不是那个小抓手 —— 拖的时候要看得出来在拖哪一条
      const row = (e.currentTarget as HTMLElement).closest('.rd-conn-row, .rd-conn-group-head');
      if (row !== null) e.dataTransfer.setDragImage(row, 12, 12);
      setDragging(payload);
    },
    onDragEnd: () => {
      setDragging(null);
      setDropTargetId(null);
    },
  });

  const zoneProps = (targetId: string | null): DropZoneProps => ({
    onDragOver: (e) => {
      // 不让落在空处的载荷：不 preventDefault，浏览器自己画「禁止」光标
      if (!canDropInto(dragging, opts.groups, targetId)) return;
      e.preventDefault();
      e.stopPropagation(); // 里面那层说了算，别让外层的目录/空白再抢
      e.dataTransfer.dropEffect = 'move';
      const id = targetId ?? ROOT_TARGET;
      if (dropTargetId !== id) setDropTargetId(id);
    },
    onDragLeave: (e) => {
      // ⚠️ dragleave 在**进入自己的子元素**时也会冒上来一次 —— 不看 relatedTarget
      // 的话，鼠标划过任何一个子元素都会把高亮闪没（原生 DnD 的经典闪烁坑）
      const next = e.relatedTarget as Node | null;
      if (next !== null && e.currentTarget.contains(next)) return;
      const id = targetId ?? ROOT_TARGET;
      setDropTargetId((cur) => (cur === id ? null : cur));
    },
    onDrop: (e) => {
      e.preventDefault();
      e.stopPropagation();
      setDropTargetId(null);
      setDragging(null);
      const raw = e.dataTransfer.getData(DRAG_MIME) || e.dataTransfer.getData('text/plain');
      const payload = parseDragPayload(raw);
      if (payload === null) return;
      if (payload.kind === 'profile') opts.moveProfile(payload.id, targetId);
      else opts.moveGroup(payload.id, targetId);
    },
  });

  return { dragging, dropTargetId, handleProps, zoneProps };
}
