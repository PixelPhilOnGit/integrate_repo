/**
 * 布局：把文档模型算成一组可绘制的几何体。
 *
 * 这是纯函数 —— 输入 Doc + 文字测量器，输出 Layout，没有任何副作用或 DOM 依赖。
 * 渲染层只负责把 Layout 画出来，交互层只负责把鼠标事件映射回 id。
 *
 * 计算顺序是有依赖的，不能随意调整：
 *   1. 参与者头部尺寸（需要量文字）
 *   2. 生命线的起止 y
 *   3. 激活条的 y 区间（锚定在消息的 y 上）
 *   4. 激活条的嵌套深度与横向偏移
 *   5. 消息端点（要吸附到激活条边缘，所以必须在 3、4 之后）
 *   6. 整体包围盒
 */

import type {
  Activation,
  Doc,
  Id,
  Message,
  MessageKind,
  Participant,
  ParticipantKind,
} from './model';
import { indexById } from './model';
import type { Point, Rect } from '../../../shared/geometry';
import { distanceToSegment, rectContainsPoint, unionRect } from '../../../shared/geometry';
import type { TextMeasurer } from '../../../shared/text';
import { wrapText } from '../../../shared/text';

export const L = {
  marginX: 44,
  marginTop: 28,
  bottomPad: 40,
  /** 方框左右内边距 */
  boxPadX: 18,
  boxPadY: 9,
  minBoxWidth: 76,
  /** 激活条宽度与最小高度 */
  activationWidth: 12,
  activationMinHeight: 26,
  /** 嵌套激活条每一层的右移量 */
  activationNestOffset: 6,
  /** 自调用消息的折线尺寸 */
  selfLoopWidth: 48,
  selfLoopHeight: 36,
  /** 消息标签离箭头的距离 */
  labelGap: 7,
  minLifelineHeight: 180,
  /** 头部最低点与生命线起点之间的空隙 */
  headerGap: 16,
  noteMaxWidth: 190,
  notePad: 8,
  noteLineHeight: 1.35,
} as const;

export interface ParticipantBoxGeom {
  id: Id;
  kind: ParticipantKind;
  /** 生命线横坐标，也是头部水平中心 */
  centerX: number;
  /** 头部整体占位（含名称） */
  box: Rect;
  /** 图形本体（火柴人或方框），名称可能在其下方 */
  shape: Rect;
  label: string;
  /** 名称基线 y */
  labelY: number;
  /** 名称锚点：actor 居中在图形下方 */
  labelAnchorX: number;
}

export interface LifelineGeom {
  participantId: Id;
  x: number;
  y1: number;
  y2: number;
}

export interface MessageGeom {
  id: Id;
  kind: MessageKind;
  from: Id;
  to: Id;
  /** 箭头起点 */
  x1: number;
  y1: number;
  /** 箭头终点 */
  x2: number;
  y2: number;
  /** 折线路径（自调用消息用），已算好的 SVG path d */
  path: string;
  /** 箭头方向：用于确定箭头头部朝向 */
  angleDeg: number;
  label: string;
  labelX: number;
  labelY: number;
  labelAnchor: 'middle' | 'start';
  /** 显示用的序号，null 表示不显示 */
  seqLabel: string | null;
  seqX: number;
  seqY: number;
  /** 包围盒，用于命中测试与导出裁剪 */
  bounds: Rect;
}

export interface ActivationGeom {
  id: Id;
  participant: Id;
  x: number;
  y: number;
  width: number;
  height: number;
  /** 嵌套深度，0 为最外层 */
  depth: number;
  bounds: Rect;
}

export interface NoteGeom {
  id: Id;
  x: number;
  y: number;
  width: number;
  height: number;
  lines: string[];
  lineHeight: number;
  bounds: Rect;
}

export interface Layout {
  participants: ParticipantBoxGeom[];
  lifelines: LifelineGeom[];
  messages: MessageGeom[];
  activations: ActivationGeom[];
  notes: NoteGeom[];
  /** 生命线的起点 y（所有参与者对齐） */
  lifelineTop: number;
  /** 生命线终点 y */
  lifelineBottom: number;
  /** 整张图的包围盒 */
  bounds: Rect;
}

/** 参与者头部图形的高度（不含名称行） */
function figureHeight(kind: ParticipantKind, fontSize: number): number {
  return kind === 'actor' ? Math.round(fontSize * 3.1) : Math.round(fontSize * 2.05);
}

/** actor 的名称画在图形下方，其余画在方框内 */
function labelBelowShape(kind: ParticipantKind): boolean {
  return kind === 'actor';
}

function buildParticipantBox(
  p: Participant,
  fontSize: number,
  measurer: TextMeasurer,
  fontFamily: string,
): ParticipantBoxGeom {
  const label = p.name;
  const textW = measurer.measure(label, fontSize, fontFamily);
  const width = Math.max(L.minBoxWidth, Math.ceil(textW) + L.boxPadX * 2);
  const figH = figureHeight(p.kind, fontSize);
  const below = labelBelowShape(p.kind);
  const nameH = Math.round(fontSize * 1.5);
  const totalH = below ? figH + nameH : Math.max(figH, nameH + L.boxPadY * 2);

  const x = p.x - width / 2;
  const y = L.marginTop;
  const box: Rect = { x, y, width, height: totalH };
  const shape: Rect = below
    ? { x, y, width, height: figH }
    : { x, y, width, height: totalH };

  const labelY = below
    ? y + figH + Math.round(fontSize * 1.05)
    : y + totalH / 2 + fontSize * 0.35;

  return {
    id: p.id,
    kind: p.kind,
    centerX: p.x,
    box,
    shape,
    label,
    labelY,
    labelAnchorX: p.x,
  };
}

/** 找出某条生命线上覆盖 y 的激活条；多层嵌套时取最靠内的那个 */
function activationCovering(
  acts: readonly ActivationGeom[],
  participantId: Id,
  y: number,
): ActivationGeom | null {
  let best: ActivationGeom | null = null;
  for (const a of acts) {
    if (a.participant !== participantId) continue;
    if (y < a.y || y > a.y + a.height) continue;
    if (!best || a.depth > best.depth) best = a;
  }
  return best;
}

/**
 * 消息端点的横向落点。
 *
 * 消息不应该连到生命线中轴上，而应吸附到激活条的边缘 —— 这是顺序图看起来
 * 专业与否的分水岭：有激活条时箭头要顶在条上，不能穿过它。
 */
function attachX(
  acts: readonly ActivationGeom[],
  participantId: Id,
  centerX: number,
  y: number,
  otherX: number,
): number {
  const a = activationCovering(acts, participantId, y);
  if (!a) return centerX;
  // 对方在我右边 → 用我的右边缘；否则用左边缘
  return otherX >= centerX ? a.x + a.width : a.x;
}

/** 自动编号：返回消息不参与编号，其余按纵向顺序 1、2、3… */
function buildSequenceNumbers(messages: readonly Message[]): Map<Id, string> {
  const out = new Map<Id, string>();
  let n = 0;
  for (const m of messages) {
    if (m.kind === 'return') continue;
    n += 1;
    out.set(m.id, String(m.seq ?? n));
  }
  return out;
}

export function computeLayout(
  doc: Doc,
  measurer: TextMeasurer,
): Layout {
  const { theme } = doc;
  const fontFamily = theme.fontFamily;
  const fontSize = theme.fontSize;

  // ---- 1. 参与者头部 ----
  const participants = doc.participants.map((p) =>
    buildParticipantBox(p, fontSize, measurer, fontFamily),
  );
  const headerBottom = participants.reduce<number>(
    (acc, b) => Math.max(acc, b.box.y + b.box.height),
    L.marginTop,
  );
  const lifelineTop = headerBottom + L.headerGap;

  // ---- 2. 生命线纵向范围 ----
  const lowestMessageY = doc.messages.reduce((acc, m) => Math.max(acc, m.y), lifelineTop);
  const lifelineBottom =
    doc.messages.length === 0
      ? lifelineTop + L.minLifelineHeight
      : lowestMessageY + theme.messageSpacing;

  const byId = indexById(doc.messages);

  // ---- 3. 激活条的 y 区间 ----
  // 先把区间算出来，才能判断嵌套关系。endMessage 为空时延伸到该生命线上
  // 下一个激活条的开始处（这正是"同一次调用里再发起调用"的语义）。
  interface RawAct {
    src: Activation;
    startY: number;
    endY: number;
  }
  const starts = new Map<Id, number>();
  const explicitEnds = new Map<Id, number>();
  for (const a of doc.activations) {
    const sm = byId.get(a.startMessageId);
    starts.set(a.id, sm ? sm.y : lifelineTop);
    if (a.endMessageId) {
      const em = byId.get(a.endMessageId);
      if (em) explicitEnds.set(a.id, em.y);
    }
  }

  /**
   * child 是不是嵌在 ancestor 里面（可以隔多层）。
   *
   * 嵌套关系由 `parentId` 显式记录，不能靠区间包含推断 —— 从区间上看，
   * "顺序执行两段"和"执行中被打断重入"长得一模一样。详见 model.ts 的说明。
   */
  const actById = indexById(doc.activations);
  const isNestedIn = (childId: Id, ancestorId: Id): boolean => {
    const seen = new Set<Id>();
    let cur = actById.get(childId);
    while (cur?.parentId && !seen.has(cur.parentId)) {
      if (cur.parentId === ancestorId) return true;
      seen.add(cur.parentId);
      cur = actById.get(cur.parentId);
    }
    return false;
  };

  const raw: RawAct[] = doc.activations.map((a) => {
    const startY = starts.get(a.id) ?? lifelineTop;
    const explicit = explicitEnds.get(a.id);
    let endY: number;

    if (explicit !== undefined) {
      endY = explicit;
    } else {
      endY = lifelineBottom;
      for (const other of doc.activations) {
        if (other.id === a.id || other.participant !== a.participant) continue;
        const otherStart = starts.get(other.id);
        if (otherStart === undefined) continue;
        // 同一条生命线上更靠后的激活条起点会截断我 ——
        // 但**嵌在我里面的不算**：那是在我执行期间到达的重入调用，
        // 不该让外层看起来已经结束了。
        if (otherStart > startY && otherStart < endY && !isNestedIn(other.id, a.id)) {
          endY = otherStart;
        }
        // 如果我起于某个"已显式结束"的激活条内部，就不能活得比它长 ——
        // 否则会画出一根戳出外层的柱子
        const otherEnd = explicitEnds.get(other.id);
        if (
          otherEnd !== undefined &&
          otherStart < startY &&
          otherEnd > startY &&
          otherEnd < endY
        ) {
          endY = otherEnd;
        }
      }
    }
    return { src: a, startY, endY: Math.max(endY, startY + L.activationMinHeight) };
  });

  // ---- 4. 嵌套深度 → 横向偏移 ----
  const activations: ActivationGeom[] = raw.map((r) => {
    // 深度优先按显式记录的嵌套链算
    let depth = 0;
    const chain = new Set<Id>();
    let cur: Activation | undefined = r.src;
    while (cur?.parentId && !chain.has(cur.parentId)) {
      chain.add(cur.parentId);
      const parent = actById.get(cur.parentId);
      if (!parent) break;
      depth += 1;
      cur = parent;
    }

    // 没有嵌套记录的（老文件、手写文件）回落到区间包含推断
    if (depth === 0) {
      for (const other of raw) {
        if (other.src.id === r.src.id) continue;
        if (other.src.participant !== r.src.participant) continue;
        // 别人完全包住我 → 我深一层
        const contains =
          other.startY <= r.startY &&
          other.endY >= r.endY &&
          (other.startY < r.startY || other.endY > r.endY);
        if (contains) depth += 1;
      }
    }
    const center = doc.participants.find((p) => p.id === r.src.participant)?.x ?? 0;
    const x =
      center - L.activationWidth / 2 + depth * L.activationNestOffset;
    const height = r.endY - r.startY;
    return {
      id: r.src.id,
      participant: r.src.participant,
      x,
      y: r.startY,
      width: L.activationWidth,
      height,
      depth,
      bounds: { x, y: r.startY, width: L.activationWidth, height },
    };
  });

  const seqNumbers = buildSequenceNumbers(doc.messages);
  const centerById = new Map<Id, number>();
  for (const p of doc.participants) centerById.set(p.id, p.x);

  // ---- 5. 消息 ----
  const messages: MessageGeom[] = doc.messages.map((m) => {
    const fromX = centerById.get(m.from) ?? 0;
    const toX = centerById.get(m.to) ?? 0;
    const showSeq = theme.showSequenceNumbers;
    const seqLabel = showSeq ? (seqNumbers.get(m.id) ?? null) : null;

    if (m.kind === 'self') {
      // 自调用：从生命线右边缘出发，向右绕一圈再回来
      const x = attachX(activations, m.from, fromX, m.y, Number.POSITIVE_INFINITY);
      const w = L.selfLoopWidth;
      const h = L.selfLoopHeight;
      const path = `M ${x} ${m.y} H ${x + w} V ${m.y + h} H ${x}`;
      const bounds: Rect = {
        x: x - 2,
        y: m.y - L.labelGap - theme.messageFontSize,
        width: w + L.labelGap,
        height: h + L.labelGap + theme.messageFontSize,
      };
      return {
        id: m.id,
        kind: m.kind,
        from: m.from,
        to: m.to,
        x1: x,
        y1: m.y,
        x2: x,
        y2: m.y + h,
        path,
        angleDeg: 180, // 回到起点时箭头朝左
        label: m.label,
        labelX: x + w + L.labelGap,
        labelY: m.y + h / 2,
        labelAnchor: 'start' as const,
        seqLabel,
        seqX: x + w / 2,
        seqY: m.y - L.labelGap,
        bounds,
      };
    }

    const x1 = attachX(activations, m.from, fromX, m.y, toX);
    const x2 = attachX(activations, m.to, toX, m.y, fromX);
    const labelX = (x1 + x2) / 2;
    const labelY = m.y - L.labelGap;
    const textW = measurer.measure(m.label, theme.messageFontSize, fontFamily);
    const left = Math.min(x1, x2);
    const width = Math.abs(x2 - x1);
    return {
      id: m.id,
      kind: m.kind,
      from: m.from,
      to: m.to,
      x1,
      y1: m.y,
      x2,
      y2: m.y,
      path: `M ${x1} ${m.y} H ${x2}`,
      angleDeg: x2 >= x1 ? 0 : 180,
      label: m.label,
      labelX,
      // 文字居中于箭头上方，但如果标签比箭头长，整体会溢出，这是顺序图的常规表现
      labelY,
      labelAnchor: 'middle' as const,
      seqLabel,
      seqX: labelX - textW / 2 - 4,
      seqY: labelY,
      bounds: {
        x: left - 2,
        y: labelY - theme.messageFontSize,
        width: width + 4,
        height: theme.messageFontSize + L.labelGap * 2,
      },
    };
  });

  // ---- 6. 注释 ----
  const notes: NoteGeom[] = doc.notes.map((n) => {
    const lines = wrapText(
      n.text,
      L.noteMaxWidth,
      theme.messageFontSize,
      measurer,
      fontFamily,
    );
    const lineHeight = theme.messageFontSize * L.noteLineHeight;
    const textW = lines.reduce(
      (acc, line) => Math.max(acc, measurer.measure(line, theme.messageFontSize, fontFamily)),
      0,
    );
    const width = Math.ceil(textW) + L.notePad * 2;
    const height = Math.ceil(lines.length * lineHeight) + L.notePad * 2;
    // 位置**只由 n.x / n.y 决定**。
    //
    // 之前这里写的是「有 attachTo 就用那个参与者的 x」，后果是拖动注释时
    // 横向位移被无声忽略 —— 用户拖了半天纹丝不动，只有纵向能挪。
    // attachTo 现在只是导出 Mermaid 时用的语义标注（注释挂在谁身上），不参与定位。
    return {
      id: n.id,
      x: n.x,
      y: n.y,
      width,
      height,
      lines,
      lineHeight,
      bounds: { x: n.x, y: n.y, width, height },
    };
  });

  // ---- 7. 包围盒 ----
  //
  // 这里必须用**所有可见元素的并集**来定尺寸，包括注释。
  // 之前纵向写的是 lifelineBottom + bottomPad —— 只跟消息走，完全没算注释，
  // 后果是拖到生命线下方的注释落在包围盒之外，导出 SVG/PNG 时被裁掉。
  // 横向当时用了并集、纵向没有，两边不一致本身就是信号。
  let content: Rect | null = null;
  for (const p of participants) content = unionRect(content, p.box);
  for (const a of activations) content = unionRect(content, a.bounds);
  for (const m of messages) content = unionRect(content, m.bounds);
  for (const n of notes) content = unionRect(content, n.bounds);

  // 纵向还要兜住生命线本身：一条消息都没有时，生命线仍有固定高度
  const contentTop = content ? content.y : L.marginTop;
  const contentBottom = Math.max(content ? content.y + content.height : 0, lifelineBottom);
  const contentLeft = content ? content.x : L.marginX;
  const contentRight = content ? content.x + content.width : L.marginX * 2;

  const wrapped: Rect = {
    x: contentLeft - L.marginX,
    // 注释可以被拖到生命线上方（y 小于 0），所以顶部也要跟着让
    y: contentTop - L.marginTop,
    width: contentRight - contentLeft + L.marginX * 2,
    height: contentBottom - contentTop + L.marginTop + L.bottomPad,
  };

  return {
    participants,
    lifelines: participants.map((p) => ({
      participantId: p.id,
      x: p.centerX,
      y1: lifelineTop,
      y2: lifelineBottom,
    })),
    messages,
    activations,
    notes,
    lifelineTop,
    lifelineBottom,
    bounds: wrapped,
  };
}

// ---------------------------------------------------------------------------
// 命中测试
// ---------------------------------------------------------------------------

export type HitTarget =
  | { type: 'participant'; id: Id }
  | { type: 'message'; id: Id }
  | { type: 'activation'; id: Id }
  | { type: 'note'; id: Id }
  | { type: 'lifeline'; id: Id };

/**
 * 把画布坐标映射回文档元素。
 *
 * 判定顺序必须与 Diagram 的**渲染层级相反**（后画的在上层，应当先被命中）：
 *   渲染顺序 = 生命线 → 激活条 → 消息 → 注释 → 参与者
 *   判定顺序 = 参与者 → 注释 → 消息 → 激活条 → 生命线
 * 两边不一致的话，就会出现"看着在最上面的元素点不中"。
 *
 * 消息用两种判定：先看**整体包围盒**（含上方的文字标签，那才是用户最自然的
 * 点击目标），再退回"到线段距离"兜底。只按线段距离判定的话，点消息文字选不中
 * 消息 —— 因为标签在线上方 7px 处，超出任何合理的容差。
 */
export function hitTest(layout: Layout, p: Point, tolerance = 6): HitTarget | null {
  for (const b of layout.participants) {
    if (rectContainsPoint(b.box, p)) return { type: 'participant', id: b.id };
  }
  for (const n of layout.notes) {
    if (rectContainsPoint(n.bounds, p)) return { type: 'note', id: n.id };
  }
  for (const m of layout.messages) {
    if (rectContainsPoint(m.bounds, p)) return { type: 'message', id: m.id };
    const d = distanceToSegment(p, { x: m.x1, y: m.y1 }, { x: m.x2, y: m.y2 });
    if (d <= tolerance) return { type: 'message', id: m.id };
    // 自调用是折线，额外测右边那一段竖线
    if (m.kind === 'self') {
      const d2 = distanceToSegment(p, { x: m.x2, y: m.y1 }, { x: m.x2, y: m.y2 });
      if (d2 <= tolerance) return { type: 'message', id: m.id };
    }
  }
  for (const a of layout.activations) {
    if (rectContainsPoint(a.bounds, p)) return { type: 'activation', id: a.id };
  }
  for (const l of layout.lifelines) {
    if (Math.abs(p.x - l.x) <= tolerance && p.y >= l.y1 && p.y <= l.y2) {
      return { type: 'lifeline', id: l.participantId };
    }
  }
  return null;
}

/**
 * 探测激活条的"截断手柄"（下边缘那条窄带）。
 *
 * 单独成一个函数、并且必须在通用 hitTest **之前**调用，原因是：
 * 激活条一旦被截断，它的终点就落在某条消息上，而消息的命中区（覆盖标签+箭头，
 * 高约 27px、横跨整条线）会把那条窄带整个盖住 —— 结果就是"截断过一次之后
 * 再也抓不到手柄"。手柄是个刻意的、面积很小的操作点，理应优先；
 * 消息在它的长度方向上有大片可点区域，被让出 9px 完全不影响选中。
 */
export function hitActivationEdge(
  layout: Layout,
  p: Point,
  band = 9,
): Id | null {
  let best: Id | null = null;
  let bestDepth = -1;
  for (const a of layout.activations) {
    if (p.x < a.x - 3 || p.x > a.x + a.width + 3) continue;
    // 上边界到 a.y + a.height - band，下边界多给 3px 容错
    if (p.y < a.y + a.height - band || p.y > a.y + a.height + 3) continue;
    // 嵌套时取最靠里的那一根
    if (a.depth > bestDepth) {
      bestDepth = a.depth;
      best = a.id;
    }
  }
  return best;
}

/** 消息在文档数组中的下标，用于拖拽重排时判断跨越了谁 */
export function messageIndexOf(doc: Doc, id: Id): number {
  return doc.messages.findIndex((m) => m.id === id);
}

/** 按纵向位置找插入点：返回应插入的下标 */
export function messageInsertIndexAtY(
  doc: Doc,
  y: number,
  excludeId?: Id,
): number {
  let i = 0;
  for (const m of doc.messages) {
    if (m.id === excludeId) continue;
    if (m.y > y) break;
    i += 1;
  }
  return i;
}
