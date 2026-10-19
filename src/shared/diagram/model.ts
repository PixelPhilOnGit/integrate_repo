/**
 * 顺序图的数据模型。
 *
 * 设计约束（改动前务必先读）：
 *
 * 1. 本文件及 core/ 下所有模块都是**纯 TypeScript** —— 不 import React、不碰 DOM。
 *    这样布局、命令、撤销这些真正容易出错的逻辑可以用 vitest 毫秒级验证。
 *
 * 2. `participants` 数组按 `x` 升序、`messages` 数组按 `y` 升序，这是**不变量**。
 *    数组顺序即逻辑顺序（从左到右 / 从上到下），Mermaid 导出和自动编号都依赖它。
 *    任何改动坐标的命令都必须重新排序以维持该不变量 —— 见 commands.ts 的 normalize()。
 *
 *    这样设计是为了消除「逻辑顺序」和「视觉位置」两份真相：位置拖到哪，逻辑顺序就是什么。
 *
 * 3. 激活条锚定到**消息 id** 而不是坐标（见 Activation）。拖动或删除消息时，
 *    激活条自动跟随/清理，不需要任何同步代码。这是顺序图编辑器最容易做烂的地方。
 *
 * 4. 未来要加 alt/opt/loop/par 分组框时：给 Message/Activation/Participant 加可选的
 *    `groupId`，布局阶段按组递归计算包围盒即可，不需要重构现有结构。
 *    下面这些 `groupId?` 字段就是为此预留的，目前恒为 undefined。
 */

export type Id = string;

/** 参与者形态。actor 画成人形，其余画成带图标的方框。 */
export type ParticipantKind =
  | 'actor'
  | 'object'
  | 'boundary'
  | 'control'
  | 'entity'
  | 'database';

export const PARTICIPANT_KINDS: readonly ParticipantKind[] = [
  'actor',
  'object',
  'boundary',
  'control',
  'entity',
  'database',
];

export interface Participant {
  id: Id;
  kind: ParticipantKind;
  /** 显示名称 */
  name: string;
  /** 消息里引用的短别名；为空时用 name */
  alias?: string;
  /** 生命线的横坐标（也是方框的中心线） */
  x: number;
  /** 预留：未来归属的控制结构分组框 */
  groupId?: Id;
}

export type MessageKind = 'sync' | 'async' | 'return' | 'self';

export const MESSAGE_KINDS: readonly MessageKind[] = ['sync', 'async', 'return', 'self'];

export interface Message {
  id: Id;
  kind: MessageKind;
  /** 发送方参与者 id；self 类型时与 to 相同 */
  from: Id;
  /** 接收方参与者 id */
  to: Id;
  label: string;
  /** 显式序号；留空则按纵向顺序自动编号 */
  seq?: number;
  /** 箭头的纵坐标 */
  y: number;
  /** 预留：未来归属的控制结构分组框 */
  groupId?: Id;
}

/**
 * 激活条（执行说明）。
 *
 * `startMessageId` 指向触发执行的那条消息 —— 锚定 id 而非坐标，是关键设计。
 * `endMessageId` 留空时，激活条会延伸到该生命线上下一个激活条开始处（或图底部）。
 */
export interface Activation {
  id: Id;
  participant: Id;
  startMessageId: Id;
  endMessageId?: Id;
  /**
   * 嵌套的父激活条。
   *
   * 一条消息到达"正在执行中"的参与者时（对方被重入调用了），新开的激活条要嵌在
   * 外层里面。这件事**没法靠区间包含推断**：从区间上看，"顺序执行两段"和
   * "执行中被打断重入"长得一模一样，都是两条首尾相接的区间。
   * 所以嵌套关系必须显式记下来。
   *
   * 语义约定：**没有显式终点的激活条 = 还在执行中**。此时到达的消息算重入。
   * 想表示"执行完了、又执行一段"，用返回消息闭合，或者拖激活条下边缘截断。
   */
  parentId?: Id;
  /** 预留：未来归属的控制结构分组框 */
  groupId?: Id;
}

export interface Note {
  id: Id;
  text: string;
  x: number;
  y: number;
  /** 附着到某个参与者时，坐标跟随该参与者 */
  attachTo?: Id;
}

export interface Theme {
  id: string;
  name: string;
  mode: 'light' | 'dark';
  /** 画布背景 */
  background: string;
  fontFamily: string;
  /** 参与者名称字号 */
  fontSize: number;
  /** 消息标签字号 */
  messageFontSize: number;
  textColor: string;
  /** 生命线颜色 */
  lineColor: string;
  participantFill: string;
  participantStroke: string;
  activationFill: string;
  activationStroke: string;
  noteFill: string;
  noteStroke: string;
  noteTextColor: string;
  /**
   * 三种消息的线条与箭头颜色。
   *
   * UML 规范里同步/异步**只靠箭头头的实心/空心区分**（同步实心、异步空心），
   * 那是个十来像素的差异，在正常缩放下基本看不出来 —— 连 PlantUML 都被指出
   * 「-> 和 ->> 的箭头都是空心的」，说明规范这条本身就不好用。
   *
   * 所以这里保留合规的箭头差异，再叠加一层颜色：不改变语义，
   * 但让人一眼能扫出哪些是同步调用、哪些是发完就走的通知。
   * 黑白打印主题把三个都设成黑色，导出去印的时候不引入灰色。
   */
  syncMessageColor: string;
  asyncMessageColor: string;
  returnMessageColor: string;
  lineWidth: number;
  /** 新增消息时与上一条的默认纵向间距 */
  messageSpacing: number;
  /** 新增参与者时的默认横向间距 */
  participantGap: number;
  /** 是否在消息上显示序号 */
  showSequenceNumbers: boolean;
}

export interface Doc {
  /** 磁盘格式版本，用于以后迁移；见 schema.ts */
  schemaVersion: number;
  title: string;
  theme: Theme;
  participants: Participant[];
  messages: Message[];
  activations: Activation[];
  notes: Note[];
}

/** 当前写出的格式版本 */
export const SCHEMA_VERSION = 1;

/** 磁盘上的文件扩展名 */
export const FILE_EXT = '.seq.json';

/** 按 id 建索引，避免在热路径上反复 find，也避开下标访问的类型噪音 */
export function indexById<T extends { id: Id }>(items: readonly T[]): Map<Id, T> {
  const m = new Map<Id, T>();
  for (const it of items) m.set(it.id, it);
  return m;
}

/** 参与者在消息里显示的标签：优先 alias */
export function participantLabel(p: Participant): string {
  return p.alias && p.alias.length > 0 ? p.alias : p.name;
}
