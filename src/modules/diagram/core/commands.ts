/**
 * 文档变更操作。
 *
 * 全部是纯函数：接收 Doc，返回新的 Doc，绝不修改入参。
 * 这让撤销栈只需要保存 Doc 引用（结构共享，开销极小），
 * 也让每个操作都能被单独测试。
 *
 * 任何改变坐标的操作都必须经过 normalize()，以维持 model.ts 里声明的
 * 「数组顺序 == 逻辑顺序 == 视觉顺序」不变量。
 */

import type {
  Activation,
  Doc,
  Id,
  Message,
  MessageKind,
  Note,
  Participant,
  ParticipantKind,
  Theme,
} from './model';
import { SCHEMA_VERSION } from './model';
import { newId } from '../../../shared/ids';
import { L } from './layout';

/** 重建排序不变量。所有改动坐标的命令都要在最后调用它。 */
export function normalize(doc: Doc): Doc {
  const participants = [...doc.participants].sort((a, b) => a.x - b.x);
  const messages = [...doc.messages].sort((a, b) => a.y - b.y);
  const sortedP = participantsChanged(doc.participants, participants);
  const sortedM = messagesChanged(doc.messages, messages);
  if (!sortedP && !sortedM) return doc;
  return { ...doc, participants, messages };
}

function participantsChanged(a: readonly Participant[], b: readonly Participant[]): boolean {
  return a.some((x, i) => b[i] !== x);
}

function messagesChanged(a: readonly Message[], b: readonly Message[]): boolean {
  return a.some((x, i) => b[i] !== x);
}

// ---------------------------------------------------------------------------
// 文档
// ---------------------------------------------------------------------------

export function createDoc(title: string, theme: Theme): Doc {
  return {
    schemaVersion: SCHEMA_VERSION,
    title,
    theme: { ...theme },
    participants: [],
    messages: [],
    activations: [],
    notes: [],
  };
}

export function setDocTitle(doc: Doc, title: string): Doc {
  return { ...doc, title };
}

export function setDocTheme(doc: Doc, theme: Theme): Doc {
  return { ...doc, theme };
}

/** 局部改主题（样式面板用） */
export function patchDocTheme(doc: Doc, patch: Partial<Theme>): Doc {
  return { ...doc, theme: { ...doc.theme, ...patch } };
}

// ---------------------------------------------------------------------------
// 参与者
// ---------------------------------------------------------------------------

export interface AddParticipantOptions {
  kind?: ParticipantKind;
  name?: string;
  /** 插入到该下标位置；省略则追加到最右 */
  index?: number;
}

export function addParticipant(
  doc: Doc,
  opts: AddParticipantOptions = {},
): { doc: Doc; id: Id } {
  const kind = opts.kind ?? 'object';
  const id = newId('p');
  const gap = doc.theme.participantGap;

  const sorted = [...doc.participants].sort((a, b) => a.x - b.x);
  const index = opts.index === undefined ? sorted.length : Math.max(0, Math.min(opts.index, sorted.length));

  let x: number;
  let shifted = sorted;
  if (sorted.length === 0) {
    x = L.marginX + 80;
  } else if (index >= sorted.length) {
    const last = sorted[sorted.length - 1];
    x = (last ? last.x : 0) + gap;
  } else {
    // 插在中间：占住当前位置，把后面的人整体右移，避免方框重叠
    const at = sorted[index];
    x = at ? at.x : L.marginX;
    shifted = sorted.map((p, i) => (i >= index ? { ...p, x: p.x + gap } : p));
  }

  const name =
    opts.name ?? uniqueParticipantName(shifted, defaultParticipantName(kind));
  const participant: Participant = { id, kind, name, x };
  const next = [...shifted, participant];
  return { doc: normalize({ ...doc, participants: next }), id };
}

/**
 * 默认名去重：连点两次「人」不该得到两个都叫「用户」的框，
 * 那样在图和导出结果里根本分不清谁是谁。
 */
function uniqueParticipantName(existing: readonly Participant[], base: string): string {
  const used = new Set(existing.map((p) => p.name));
  if (!used.has(base)) return base;
  let i = 2;
  while (used.has(`${base}${i}`)) i += 1;
  return `${base}${i}`;
}

function defaultParticipantName(kind: ParticipantKind): string {
  switch (kind) {
    case 'actor':
      return '用户';
    case 'database':
      return '数据库';
    case 'boundary':
      return '界面';
    case 'control':
      return '控制器';
    case 'entity':
      return '实体';
    default:
      return '对象';
  }
}

export function updateParticipant(
  doc: Doc,
  id: Id,
  patch: Partial<Omit<Participant, 'id'>>,
): Doc {
  return normalize({
    ...doc,
    participants: doc.participants.map((p) => (p.id === id ? { ...p, ...patch } : p)),
  });
}

export function moveParticipant(doc: Doc, id: Id, x: number): Doc {
  return updateParticipant(doc, id, { x });
}

/** 删除参与者，并级联清理所有引用它的东西（消息、激活条、附着注释） */
export function removeParticipant(doc: Doc, id: Id): Doc {
  const removedMessageIds = new Set(
    doc.messages.filter((m) => m.from === id || m.to === id).map((m) => m.id),
  );
  return normalize({
    ...doc,
    participants: doc.participants.filter((p) => p.id !== id),
    messages: doc.messages.filter((m) => !removedMessageIds.has(m.id)),
    activations: doc.activations.filter(
      (a) => a.participant !== id && !removedMessageIds.has(a.startMessageId),
    ),
    notes: doc.notes.filter((n) => n.attachTo !== id),
  });
}

/** 把参与者之间的横向间距拉均匀，保留首尾位置 */
export function distributeParticipants(doc: Doc): Doc {
  const ps = [...doc.participants].sort((a, b) => a.x - b.x);
  if (ps.length < 3) return doc;
  const first = ps[0];
  const last = ps[ps.length - 1];
  if (!first || !last) return doc;
  const step = (last.x - first.x) / (ps.length - 1);
  const next = ps.map((p, i) => ({ ...p, x: Math.round(first.x + step * i) }));
  return normalize({ ...doc, participants: next });
}

// ---------------------------------------------------------------------------
// 消息
// ---------------------------------------------------------------------------

export interface AddMessageOptions {
  kind: MessageKind;
  from: Id;
  to: Id;
  label?: string;
  /** 纵坐标；省略时排到最后一条下方 */
  y?: number;
}

/**
 * 新增消息，并做符合 UML 习惯的激活条自动维护：
 *   - sync  → 在接收方开启激活条（对方开始执行）
 *   - self  → 在自身开启激活条
 *   - return → 关闭发送方最近一个尚未结束的激活条
 *   - async → 不动激活条（异步调用不阻塞对方，通常不画成执行状态）
 *
 * 这些默认行为让用户不用手动摆弄激活条就能画出像样的图，
 * 需要精细控制时仍可在属性面板里手动开关。
 */
export function addMessage(doc: Doc, opts: AddMessageOptions): { doc: Doc; id: Id } {
  const id = newId('m');
  const y = opts.y ?? nextMessageY(doc);
  const kind: MessageKind = opts.kind;
  const from = opts.from;
  const to = kind === 'self' ? from : opts.to;

  const message: Message = {
    id,
    kind,
    from,
    to,
    label: opts.label ?? defaultMessageLabel(kind),
    y,
  };

  let next: Doc = { ...doc, messages: [...doc.messages, message] };
  next = applyAutoActivation(next, message);
  return { doc: normalize(next), id };
}

function defaultMessageLabel(kind: MessageKind): string {
  switch (kind) {
    case 'return':
      return '返回结果';
    case 'async':
      return '异步通知';
    case 'self':
      return '自处理';
    default:
      return '请求';
  }
}

/**
 * 一条消息在纵向上一直占到哪儿。
 *
 * 自调用不是一条横线：它往右下绕一圈再回来，视觉上比 y 多占 L.selfLoopHeight。
 * 排下一条消息时必须按这个算，否则下一条的标签会压在上一条的折线上。
 */
export function messageBottom(m: Message): number {
  return m.y + (m.kind === 'self' ? L.selfLoopHeight : 0);
}

export function nextMessageY(doc: Doc): number {
  if (doc.messages.length === 0) return L.marginTop + 200;
  const lowest = doc.messages.reduce((acc, m) => Math.max(acc, messageBottom(m)), 0);
  return lowest + doc.theme.messageSpacing;
}

/**
 * 找出某个参与者身上"还在执行中"的激活条 —— 即没有显式终点、且开始于 `y` 之前的那条。
 * 有多条时取开始得最晚的（最靠里那层）。
 *
 * 这是判断"这次到达是不是重入调用"的依据：对方的执行还没结束又来一条消息，
 * 说明它被打断了，新的执行要嵌进去。
 */
function findExecutingActivation(
  doc: Doc,
  participantId: Id,
  y: number,
): Activation | undefined {
  let best: Activation | undefined;
  let bestY = Number.NEGATIVE_INFINITY;
  for (const a of doc.activations) {
    if (a.participant !== participantId) continue;
    // 有终点的说明已经结束了
    if (a.endMessageId !== undefined) continue;
    const start = doc.messages.find((m) => m.id === a.startMessageId);
    if (!start || start.y >= y) continue;
    if (start.y > bestY) {
      bestY = start.y;
      best = a;
    }
  }
  return best;
}

function applyAutoActivation(doc: Doc, m: Message): Doc {
  if (m.kind === 'sync' || m.kind === 'self') {
    const target = m.kind === 'self' ? m.from : m.to;
    // 已经有覆盖该位置的激活条就不重复加
    const existing = doc.activations.find(
      (a) => a.participant === target && a.startMessageId === m.id,
    );
    if (existing) return doc;

    // 对方还在执行中 → 这一条是重入，嵌进去
    const parent = findExecutingActivation(doc, target, m.y);
    const activation: Activation = {
      id: newId('a'),
      participant: target,
      startMessageId: m.id,
      ...(parent ? { parentId: parent.id } : {}),
    };
    return { ...doc, activations: [...doc.activations, activation] };
  }

  if (m.kind === 'return') {
    // 关闭发送方最近一个还没结束的激活条
    const open = [...doc.activations]
      .filter((a) => a.participant === m.from && a.endMessageId === undefined)
      .sort((a, b) => startY(doc, b) - startY(doc, a))[0];
    if (!open) return doc;
    return {
      ...doc,
      activations: doc.activations.map((a) =>
        a.id === open.id ? { ...a, endMessageId: m.id } : a,
      ),
    };
  }

  return doc;
}

function startY(doc: Doc, a: Activation): number {
  const msg = doc.messages.find((m) => m.id === a.startMessageId);
  return msg ? msg.y : 0;
}

export function updateMessage(
  doc: Doc,
  id: Id,
  patch: Partial<Omit<Message, 'id'>>,
): Doc {
  const before = doc.messages.find((m) => m.id === id);
  let next: Doc = {
    ...doc,
    messages: doc.messages.map((m) => (m.id === id ? { ...m, ...patch } : m)),
  };
  // 类型变了要同步维护激活条，否则把同步消息改成返回之后，
  // 接收方会留下一根没有意义的执行柱，看着像 bug
  if (before && patch.kind !== undefined && patch.kind !== before.kind) {
    next = reconcileActivation(next, id, patch.kind);
  }
  return normalize(next);
}

/**
 * 消息类型变化时调整它对应的激活条。
 *
 * 只处理「自动生成」的那一类（即没有显式终点的），用户手工设过终点的激活条
 * 一律保留 —— 那是明确意图，不该被类型切换悄悄抹掉。
 */
function reconcileActivation(doc: Doc, messageId: Id, kind: MessageKind): Doc {
  const msg = doc.messages.find((m) => m.id === messageId);
  if (!msg) return doc;

  const anchored = doc.activations.filter((a) => a.startMessageId === messageId);

  if (kind === 'async' || kind === 'return') {
    const drop = new Set(
      anchored.filter((a) => a.endMessageId === undefined).map((a) => a.id),
    );
    if (drop.size === 0) return doc;
    return { ...doc, activations: doc.activations.filter((a) => !drop.has(a.id)) };
  }

  // sync / self：确保目标上有激活条
  const target = kind === 'self' ? msg.from : msg.to;
  if (anchored.some((a) => a.participant === target)) return doc;
  const activation: Activation = {
    id: newId('a'),
    participant: target,
    startMessageId: messageId,
  };
  return { ...doc, activations: [...doc.activations, activation] };
}

export function moveMessage(doc: Doc, id: Id, y: number): Doc {
  return updateMessage(doc, id, { y });
}

/**
 * 删除消息。
 * 锚定在该消息上的激活条会被一并删除（失去了起点就没有意义）；
 * 而以它为终点的激活条只是清空终点，自动延伸 —— 比直接删掉更符合预期。
 */
export function removeMessage(doc: Doc, id: Id): Doc {
  return normalize({
    ...doc,
    messages: doc.messages.filter((m) => m.id !== id),
    activations: doc.activations
      .filter((a) => a.startMessageId !== id)
      .map((a) => (a.endMessageId === id ? { ...a, endMessageId: undefined } : a)),
  });
}

/** 把消息纵向间距拉均匀 */
export function distributeMessages(doc: Doc): Doc {
  const ms = [...doc.messages].sort((a, b) => a.y - b.y);
  if (ms.length < 3) return doc;
  const first = ms[0];
  const last = ms[ms.length - 1];
  if (!first || !last) return doc;
  const step = (last.y - first.y) / (ms.length - 1);
  const next = ms.map((m, i) => ({ ...m, y: Math.round(first.y + step * i) }));
  return normalize({ ...doc, messages: next });
}

// ---------------------------------------------------------------------------
// 激活条
// ---------------------------------------------------------------------------

/** 在某个参与者的某条消息处开关激活条，属性面板的按钮用 */
export function toggleActivation(doc: Doc, participantId: Id, messageId: Id): Doc {
  const existing = doc.activations.find(
    (a) => a.participant === participantId && a.startMessageId === messageId,
  );
  if (existing) {
    return { ...doc, activations: doc.activations.filter((a) => a.id !== existing.id) };
  }
  const activation: Activation = {
    id: newId('a'),
    participant: participantId,
    startMessageId: messageId,
  };
  return { ...doc, activations: [...doc.activations, activation] };
}

export function removeActivation(doc: Doc, id: Id): Doc {
  return { ...doc, activations: doc.activations.filter((a) => a.id !== id) };
}

/** 给激活条设置结束消息；传 undefined 则恢复自动延伸 */
export function setActivationEnd(doc: Doc, id: Id, endMessageId?: Id): Doc {
  return {
    ...doc,
    activations: doc.activations.map((a) =>
      a.id === id ? { ...a, endMessageId } : a,
    ),
  };
}

// ---------------------------------------------------------------------------
// 注释
// ---------------------------------------------------------------------------

export function addNote(
  doc: Doc,
  opts: { text?: string; x: number; y: number; attachTo?: Id },
): { doc: Doc; id: Id } {
  const id = newId('n');
  const note: Note = {
    id,
    text: opts.text ?? '说明',
    x: opts.x,
    y: opts.y,
    ...(opts.attachTo ? { attachTo: opts.attachTo } : {}),
  };
  return { doc: { ...doc, notes: [...doc.notes, note] }, id };
}

export function updateNote(doc: Doc, id: Id, patch: Partial<Omit<Note, 'id'>>): Doc {
  return {
    ...doc,
    notes: doc.notes.map((n) => (n.id === id ? { ...n, ...patch } : n)),
  };
}

export function removeNote(doc: Doc, id: Id): Doc {
  return { ...doc, notes: doc.notes.filter((n) => n.id !== id) };
}

// ---------------------------------------------------------------------------
// 上下文定位
//
// 下面这三个函数解决同一类问题：工具栏按钮**不能无视用户当前在哪儿**。
// 之前的实现是「加消息就从最左边第一个人发给第二个人、加注释就贴第一个人、
// 加自调用也贴第一个人」，用户选中什么都没用，观感就是"点了没反应/放错地方"。
// ---------------------------------------------------------------------------

/** 工具栏动作的上下文：用户当前选中了什么 */
export type Focus =
  | { kind: 'none' }
  | { kind: 'participant'; id: Id }
  | { kind: 'message'; id: Id };

/**
 * 决定新消息的收发双方。
 *
 * 规则是「承接上下文」而不是「每次都从头开始」：
 *   选中一条消息 → 顺着它的流向继续（返回消息就是原路返回，自调用落在它的接收方）
 *   选中一个参与者 → 以它作为发送方，接收方取它右边那个（没有右边就取左边）
 *   什么都没选 → 维持原来的默认（最左 → 最右）
 */
export function resolveEndpoints(
  doc: Doc,
  focus: Focus,
  kind: MessageKind,
): { from: Id; to: Id } | null {
  const ps = doc.participants;
  if (ps.length === 0) return null;
  const first = ps[0];
  if (!first) return null;

  /** 取某个参与者在横向上的邻居：优先右边，右边没有了就左边 */
  const neighbour = (id: Id): Participant | undefined => {
    const i = ps.findIndex((p) => p.id === id);
    if (i < 0) return undefined;
    return ps[i + 1] ?? ps[i - 1];
  };

  if (focus.kind === 'message') {
    const m = doc.messages.find((x) => x.id === focus.id);
    if (m) {
      if (kind === 'return') {
        // 自调用没有"对方"（收发是同一个参与者），原路返回会得到 from === to，
        // 画出来就是一条零长度的退化箭头。这种情况退给相邻的参与者。
        const back = m.from === m.to ? (neighbour(m.to)?.id ?? m.from) : m.from;
        return { from: m.to, to: back };
      }
      if (kind === 'self') return { from: m.to, to: m.to };
      const next = neighbour(m.to) ?? ps.find((p) => p.id === m.from) ?? first;
      return { from: m.to, to: next.id };
    }
  }

  if (focus.kind === 'participant') {
    const self = ps.find((p) => p.id === focus.id) ?? first;
    if (kind === 'self') return { from: self.id, to: self.id };
    const next = neighbour(self.id) ?? self;
    return { from: self.id, to: next.id };
  }

  const to = kind === 'return' ? (ps[ps.length - 1] ?? first) : (ps[1] ?? first);
  return { from: first.id, to: to.id };
}

/**
 * 在指定消息**之后**插入一条新消息，并把后面的消息整体下移，为它腾出位置。
 *
 * 这是"选中一条消息，然后在它后面接着画下一条"的自然操作。
 * 没有它的话新消息永远追加在图的末尾，用户得手动把它拖上去 ——
 * 而拖上去又会打乱和激活条的对应关系。
 */
export function insertMessageAfter(
  doc: Doc,
  afterId: Id,
  opts: Omit<AddMessageOptions, 'y'>,
): { doc: Doc; id: Id } {
  const anchor = doc.messages.find((m) => m.id === afterId);
  if (!anchor) return addMessage(doc, opts);

  const gap = doc.theme.messageSpacing;
  // 从锚点的**下沿**起算，而不是它的 y —— 自调用往右下占了额外高度
  const y = messageBottom(anchor) + gap;
  // 后面的整体下移，维持「纵向位置 == 逻辑顺序」这个不变量
  const shifted: Doc = {
    ...doc,
    messages: doc.messages.map((m) => (messageBottom(m) >= y ? { ...m, y: m.y + gap } : m)),
  };
  return addMessage(shifted, { ...opts, y });
}

/**
 * 某条生命线上所有相关的消息（作为发送方或接收方），按纵向排序。
 * 激活条的截断、新开都要在"这条生命线上的消息"里找锚点。
 */
export function messagesOnParticipant(doc: Doc, participantId: Id): Message[] {
  return doc.messages
    .filter((m) => m.from === participantId || m.to === participantId)
    .sort((a, b) => a.y - b.y);
}

/**
 * 手工拖放消息时允许的最小间距。
 *
 * 刻意比 theme.messageSpacing 小：那个是"新增消息时的默认行距"（宽松、好看），
 * 这个是"不许重叠"的底线。拖放是用户明确指定的位置，只要两个标签不撞在一起
 * 就该尊重 —— 不能因为默认行距是 44，就把拖到 30 的位置硬推开，
 * 那会让"我拖到哪儿它就在哪儿"这个最基本的预期失效。
 */
const MIN_MESSAGE_GAP = 22;

/**
 * 在指定的纵向位置上插入一条消息（拖拽画消息时用）。
 *
 * 和 insertMessageAfter 的区别：那个是"插在某条已知消息后面"（用默认行距），
 * 这个是"插在用户拖到的这个高度上"（只保证不重叠）。
 */
export function insertMessageAtY(
  doc: Doc,
  requestedY: number,
  opts: Omit<AddMessageOptions, 'y'>,
): { doc: Doc; id: Id } {
  const sorted = [...doc.messages].sort((a, b) => a.y - b.y);

  const nextIndex = sorted.findIndex((m) => m.y > requestedY);
  const at = nextIndex < 0 ? sorted.length : nextIndex;
  const prev = at > 0 ? sorted[at - 1] : undefined;
  const next = sorted[at];

  // 离上一条太近就往下让一点点，保证标签不叠
  let y = requestedY;
  if (prev) y = Math.max(y, messageBottom(prev) + MIN_MESSAGE_GAP);

  if (next && y > next.y - MIN_MESSAGE_GAP) {
    // 和下面一条挤了，把从它开始的整体下移，腾出空间
    const shift = y - (next.y - MIN_MESSAGE_GAP);
    const shifted: Doc = {
      ...doc,
      messages: doc.messages.map((m) => (m.y >= next.y ? { ...m, y: m.y + shift } : m)),
    };
    return addMessage(shifted, { ...opts, y });
  }
  return addMessage(doc, { ...opts, y });
}

/**
 * 把激活条的终点吸附到 `y` 附近的消息上。
 *
 * 拖到该参与者所有消息之下时**清除终点**，恢复"自动延伸" ——
 * 这是撤销截断的手势（往下一拖就长回去），比再找个按钮更自然。
 */
export function setActivationEndAtY(doc: Doc, activationId: Id, y: number): Doc {
  const activation = doc.activations.find((a) => a.id === activationId);
  if (!activation) return doc;

  const start = doc.messages.find((m) => m.id === activation.startMessageId);
  const startY = start ? start.y : 0;
  // 终点至少要离起点一个最小高度，否则激活条会退化成一条线
  const candidates = messagesOnParticipant(doc, activation.participant).filter(
    (m) => m.y >= startY + L.activationMinHeight,
  );
  const last = candidates[candidates.length - 1];

  if (!last || y > last.y + doc.theme.messageSpacing / 2) {
    return setActivationEnd(doc, activationId, undefined);
  }

  const above = candidates.filter((m) => m.y <= y);
  const snapped = above[above.length - 1] ?? candidates[0];
  return snapped ? setActivationEnd(doc, activationId, snapped.id) : doc;
}

/**
 * 把一个激活条在指定消息处断开，并在其后新开一段。
 *
 * 对应 UML 里"同一个参与者先执行一段、中途空着、再执行一段"的情形：
 * 不截断的话激活条会一路延伸下去，看起来像是对方一直在忙。
 *
 * 两件事一起做是有意的 —— 只截断不新开，用户还得再找那条消息去手动开，
 * 而"截断"这个动作的意图本来就是"这里断一下，后面重新开始执行"。
 */
export function splitActivation(doc: Doc, activationId: Id, atMessageId: Id): Doc {
  const activation = doc.activations.find((a) => a.id === activationId);
  if (!activation) return doc;

  const at = doc.messages.find((m) => m.id === atMessageId);
  if (!at) return doc;

  // 1) 当前这段截断在这条消息
  const truncated = setActivationEnd(doc, activationId, atMessageId);

  // 2) 从它之后、这条生命线上的第一条消息开始新的一段
  const next = messagesOnParticipant(truncated, activation.participant).find(
    (m) => m.y > at.y && !truncated.activations.some((a) => a.startMessageId === m.id),
  );
  if (!next) return truncated;

  const fresh: Activation = {
    id: newId('a'),
    participant: activation.participant,
    startMessageId: next.id,
  };
  return { ...truncated, activations: [...truncated.activations, fresh] };
}

export interface NotePlacement {
  x: number;
  y: number;
  attachTo?: Id;
}

/**
 * 新注释放哪儿。
 *
 * 优先级：选中的消息旁边 > 选中的参与者旁边 > 鼠标最后点过的位置 > 默认位置。
 * 永远贴第一个参与者是原来的行为，用户的原话是"为啥新增注释都是在第一个主体上面"。
 */
export function notePlacement(
  doc: Doc,
  focus: Focus,
  at?: { x: number; y: number } | null,
): NotePlacement {
  const ps = doc.participants;

  // 纵向：选中消息就贴着那条消息；否则往下错开已有注释，避免叠成一摞
  const stackedY = doc.notes.reduce((acc, n) => Math.max(acc, n.y + 70), L.marginTop + 150);

  if (focus.kind === 'message') {
    const m = doc.messages.find((x) => x.id === focus.id);
    if (m) {
      const target = ps.find((p) => p.id === m.to) ?? ps.find((p) => p.id === m.from);
      if (target) return { x: target.x + 56, y: m.y, attachTo: target.id };
    }
  }

  if (focus.kind === 'participant') {
    const p = ps.find((x) => x.id === focus.id);
    if (p) return { x: p.x + 56, y: stackedY, attachTo: p.id };
  }

  if (at) return { x: Math.round(at.x), y: Math.round(at.y) };

  const anchor = ps[0];
  return anchor
    ? { x: anchor.x + 56, y: stackedY, attachTo: anchor.id }
    : { x: 120, y: stackedY };
}
