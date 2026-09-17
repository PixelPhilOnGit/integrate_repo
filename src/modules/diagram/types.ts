/**
 * 顺序图模块的类型定义。
 *
 * 这些类型**刻意不放在 `state/store.ts` 里**：`render/` 和 `panels/` 下的视图组件
 * 要的是「选中了什么」「视口在哪」「正在拖一条什么消息」这些**数据形状**，
 * 它们不该为了拿一个类型就去 import store —— 那会让视图层对 store 的实现产生
 * 编译期依赖，store 一改内部结构（比如把某个字段挪走）视图层就跟着报错，
 * 哪怕它根本不关心那个字段。
 *
 * 分界线是：**类型住这里，行为住 store**。
 * `AppStore` 类、`MIN_ZOOM` / `MAX_ZOOM` / `FIT_PADDING` 这些常量属于 store 的行为，
 * 留在 `state/store.ts`；`AppState` 只是 store 对外快照的形状，所以住这里。
 *
 * 这个文件只依赖模块内的 `core/model` 和共享层的 `platform/types`，不反向依赖任何人。
 */

import type { Doc, Id, MessageKind } from './core/model';
import type { FileNode } from '../../shared/platform/types';

/** 画布上当前选中的东西。`none` 是显式状态，不是 `null` —— 调用方不必判空 */
export type Selection =
  | { type: 'none' }
  | { type: 'participant'; id: Id }
  | { type: 'message'; id: Id }
  | { type: 'activation'; id: Id }
  | { type: 'note'; id: Id };

/** 正在内联编辑的对象 */
export interface EditTarget {
  type: 'participant' | 'message' | 'note';
  id: Id;
}

export interface Viewport {
  zoom: number;
  /** 视图左上角在文档坐标系里的位置 */
  panX: number;
  panY: number;
}

/** 拖拽画消息时的实时预览（还没落到文档里） */
export interface PendingMessage {
  from: Id;
  to: Id;
  y: number;
  kind: MessageKind;
}

/**
 * store 对外暴露的完整快照。
 *
 * 视图组件拿它来渲染；它们只读，改状态一律走 `AppStore` 上的动作方法。
 */
export interface AppState {
  ready: boolean;
  busy: boolean;
  doc: Doc;
  selection: Selection;
  editing: EditTarget | null;
  /** 拖拽画消息的预览；null 表示当前没有在画 */
  pendingMessage: PendingMessage | null;
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  viewport: Viewport;
  workspaceRoot: string | null;
  tree: FileNode[];
  /** 文件树里选中的条目（目录或文件）。工具栏的"新建"要跟着它走 */
  treeSelection: string | null;
  currentPath: string | null;
}
