/**
 * 分屏布局：一棵二叉树。
 *
 * ```
 * { kind: 'split', dir: 'row', ratio: 0.5, a: 左, b: 右 }
 * ```
 *
 * # 为什么是树，不是「固定几宫格」
 *
 * 宫格（1 / 4 / 6 格）实现便宜，但用起来会逼着用户改自己的工作方式：
 * 想在一个大屏旁边塞一个小屏做不到。tmux / iTerm 用的都是树 ——
 * 任意切、拖动分隔条、关掉一块时兄弟节点顶上来。
 *
 * # 为什么不放在组件里
 *
 * 这一整个文件是**纯函数**：不碰 DOM、不碰 React、不碰 store。
 * 切分、折叠、算矩形、找几何邻居这些全是「输入一份结构、输出一份结构」，
 * 而它们恰恰是最容易写错、又最容易被单测盖满的部分。
 * 渲染那边只负责把 `rectsOf()` 算出来的百分比矩形摆出来。
 *
 * # 坐标约定
 *
 * 矩形一律是**相对比例**（0..1），不是像素 —— 窗口大小变了不用重算布局。
 * `x`/`y` 是左上角，`w`/`h` 是宽高。
 *
 * `dir` 的含义容易搞反，写死在这里：
 * - `'row'` —— 两块**左右**并排（界面上的「向右分屏」）
 * - `'col'` —— 两块**上下**堆叠（界面上的「向下分屏」）
 */

export type SplitDir = 'row' | 'col';

export type PaneLayout =
  | { kind: 'leaf'; sessionId: string }
  | { kind: 'split'; dir: SplitDir; ratio: number; a: PaneLayout; b: PaneLayout };

/** 相对比例矩形 */
export interface PaneRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 分隔条的拖动范围。
 *
 * 不让拖到 0 或 1：那样有一块会**变成零像素**，而它在树里还活着 ——
 * 用户看到的是「这块消失了」，但关不掉也点不着，只能靠拖回来救。
 * 代价是两块最窄各自 15%。
 */
export const MIN_RATIO = 0.15;
export const MAX_RATIO = 0.85;

/** 拖动分隔条时把比例夹进合法范围。NaN 一律当 0.5 */
export function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0.5;
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
}

export function leafPane(sessionId: string): PaneLayout {
  return { kind: 'leaf', sessionId };
}

/** 从左到右、从上到下的顺序列出所有会话 id。也是「下一个 pane」的顺序 */
export function panesOf(layout: PaneLayout): string[] {
  if (layout.kind === 'leaf') return [layout.sessionId];
  return [...panesOf(layout.a), ...panesOf(layout.b)];
}

export function hasPane(layout: PaneLayout, sessionId: string): boolean {
  if (layout.kind === 'leaf') return layout.sessionId === sessionId;
  return hasPane(layout.a, sessionId) || hasPane(layout.b, sessionId);
}

/**
 * 把 `target` 那一块切成两块。
 *
 * `before` 决定新的一块放在哪边：`true` 放左/上，`false` 放右/下。
 * 找不到 `target` 就原样返回（不抛）—— 界面上的按钮是在某一帧渲染出来的，
 * 点下去的时候那块可能已经被别的操作关掉了，那是正常的时序，不是错误。
 */
export function splitPane(
  root: PaneLayout,
  target: string,
  dir: SplitDir,
  newSessionId: string,
  before: boolean,
): PaneLayout {
  if (root.kind === 'leaf') {
    if (root.sessionId !== target) return root;
    const fresh = leafPane(newSessionId);
    return {
      kind: 'split',
      dir,
      ratio: 0.5,
      a: before ? fresh : root,
      b: before ? root : fresh,
    };
  }

  const a = splitPane(root.a, target, dir, newSessionId, before);
  if (a !== root.a) return { ...root, a };
  const b = splitPane(root.b, target, dir, newSessionId, before);
  if (b !== root.b) return { ...root, b };
  return root;
}

/**
 * 关掉一块，**兄弟节点顶上来**。
 *
 * 返回 `null` 表示这是最后一块 —— 关掉之后主区就是空的了。
 * 调用方要处理这个情况（显示空态），而不是留一个没有任何 pane 的树。
 */
export function closePane(root: PaneLayout, sessionId: string): PaneLayout | null {
  if (root.kind === 'leaf') {
    return root.sessionId === sessionId ? null : root;
  }

  // 子节点整块被关掉时，**这一层就没了**，由剩下的那个兄弟代替父节点
  const a = closePane(root.a, sessionId);
  if (a === null) return root.b;
  const b = closePane(root.b, sessionId);
  if (b === null) return root.a;

  if (a !== root.a) return { ...root, a };
  if (b !== root.b) return { ...root, b };
  return root;
}

/** 某一层 split 在树里的位置：0 是 a 边，1 是 b 边 */
export type SplitPath = readonly number[];

/**
 * 改某一层的分隔比例。
 *
 * 用路径而不是 id 定位那一层：分隔条是**递归渲染时**画出来的，
 * 渲染的时候本来就知道自己走在哪条路径上，而 split 节点没有 id 可以找。
 */
export function setRatio(root: PaneLayout, path: SplitPath, ratio: number): PaneLayout {
  const want = clampRatio(ratio);
  if (path.length === 0) {
    if (root.kind === 'leaf') return root;
    return { ...root, ratio: want };
  }

  if (root.kind === 'leaf') return root;
  const [head, ...rest] = path;
  if (head === 0) {
    const a = setRatio(root.a, rest, want);
    return a === root.a ? root : { ...root, a };
  }
  const b = setRatio(root.b, rest, want);
  return b === root.b ? root : { ...root, b };
}

/** 把这一块换成显示另一个会话（侧栏点一下就上屏，走这里） */
export function replacePane(
  root: PaneLayout,
  target: string,
  newSessionId: string,
): PaneLayout {
  if (root.kind === 'leaf') {
    return root.sessionId === target ? leafPane(newSessionId) : root;
  }
  const a = replacePane(root.a, target, newSessionId);
  if (a !== root.a) return { ...root, a };
  const b = replacePane(root.b, target, newSessionId);
  return b === root.b ? root : { ...root, b };
}

/**
 * 把 `target` 那一块**整棵**换掉 —— 不是换成另一个会话，而是换成任意一棵子树。
 *
 * 和 [`replacePane`] 的差别就在这里：那个的用途是「这一格改看另一个会话」，
 * 新的东西仍然是一个叶子；这个用来把一格**撑成一片**（新建会话时的网格铺屏）。
 */
export function replaceWith(root: PaneLayout, target: string, next: PaneLayout): PaneLayout {
  if (root.kind === 'leaf') {
    return root.sessionId === target ? next : root;
  }
  const a = replaceWith(root.a, target, next);
  if (a !== root.a) return { ...root, a };
  const b = replaceWith(root.b, target, next);
  return b === root.b ? root : { ...root, b };
}

/**
 * 把一组会话摆成网格：`cols` 列，行数按数量算。
 *
 * # 为什么列数由调用方给
 *
 * 这个文件是纯函数，不该去猜屏幕有多大。调用方（新建会话那一步）按数量算出
 * 一个「看着像网格」的列数传进来 —— 它知道自己在干什么，这里只管摆。
 *
 * # 最后一行可能不满
 *
 * 比如 5 个会话、3 列：上面一行三个，下面一行两个，**下面那两个会更宽**。
 * 因为叶子必须挂一个会话，造不出「空的格子」；与其塞一个假会话，不如让它宽着
 * —— 用户拖一下分隔条就好了。这条写进注释是因为它会被当成 bug 报上来。
 */
export function gridLayout(sessionIds: readonly string[], cols: number): PaneLayout | null {
  const ids = [...sessionIds];
  if (ids.length === 0) return null;

  const width = Math.max(1, Math.min(Math.floor(cols), ids.length));
  const rows: PaneLayout[] = [];
  for (let i = 0; i < ids.length; i += width) {
    const row = chain(ids.slice(i, i + width).map(leafPane), 'row');
    if (row !== null) rows.push(row);
  }
  return chain(rows, 'col');
}

/**
 * 按数量挑一个「看着像网格」的列数：1→1、2→2、4→2、6→3、9→3。
 *
 * 放在这儿而不是界面里，是为了让它和 [`gridLayout`] 挨着 —— 两者是同一件事
 * 的两半（一个算列数、一个摆位置），分开写迟早会各自漂移。
 */
export function gridColsFor(count: number): number {
  if (count <= 1) return 1;
  return Math.ceil(Math.sqrt(count));
}

/**
 * 把一串子树按 `dir` 依次排开，**每块一样大**。
 *
 * 不是二分递归而是左边累积：每加一块，已有那部分占 `n/(n+1)`、新块占 `1/(n+1)`。
 * 累下来正好等分（三块就是 1/3、1/3、1/3），而二分递归很容易写成
 * 「第一块 1/2、后面两块各 1/4」这种越分越小的形状。
 */
function chain(parts: readonly PaneLayout[], dir: SplitDir): PaneLayout | null {
  const head = parts[0];
  if (head === undefined) return null;

  let acc: PaneLayout = head;
  let count = 1;
  for (let i = 1; i < parts.length; i += 1) {
    const part = parts[i];
    if (part === undefined) continue;
    acc = { kind: 'split', dir, ratio: count / (count + 1), a: acc, b: part };
    count += 1;
  }
  return acc;
}

/**
 * 每个会话占的矩形（相对比例）。
 *
 * 不变量：任意两块**不重叠**、都落在 [0,1] 里、所有面积加起来是 1。
 * 这三条有测试盯着 —— 重叠了界面上就是两块叠着画，用户看到的是「花屏」。
 */
export function rectsOf(layout: PaneLayout): Record<string, PaneRect> {
  const out: Record<string, PaneRect> = {};
  walk(layout, { x: 0, y: 0, w: 1, h: 1 }, out);
  return out;
}

function walk(layout: PaneLayout, rect: PaneRect, out: Record<string, PaneRect>): void {
  if (layout.kind === 'leaf') {
    out[layout.sessionId] = rect;
    return;
  }

  // 比例在用之前再夹一次：持久化过的旧文件、手改过的文件都可能带着
  // 越界的值进来，一条越界的比例会让某一块算出负数宽度
  const ratio = clampRatio(layout.ratio);
  const a: PaneRect =
    layout.dir === 'row'
      ? { x: rect.x, y: rect.y, w: rect.w * ratio, h: rect.h }
      : { x: rect.x, y: rect.y, w: rect.w, h: rect.h * ratio };
  const b: PaneRect =
    layout.dir === 'row'
      ? { x: rect.x + rect.w * ratio, y: rect.y, w: rect.w * (1 - ratio), h: rect.h }
      : { x: rect.x, y: rect.y + rect.h * ratio, w: rect.w, h: rect.h * (1 - ratio) };

  walk(layout.a, a, out);
  walk(layout.b, b, out);
}

export type Direction = 'left' | 'right' | 'up' | 'down';

/** 比这个还小的缝隙就当没有。防止浮点误差把贴着的两块判成「不挨着」 */
const EPS = 1e-6;

/**
 * 几何方向上挨着的那一块。
 *
 * 按**实际位置**找邻居，而不是按树里的顺序 —— 用户看到的是屏幕上的位置，
 * 「往右移一格」当然该按位置算。找不到就返回 null（不绕回另一头）：
 * 在最右边按右键什么都不发生，比突然跳到最左边更符合直觉。
 */
export function neighborOf(
  rects: Record<string, PaneRect>,
  sessionId: string,
  dir: Direction,
): string | null {
  const cur = rects[sessionId];
  if (!cur) return null;

  let best: string | null = null;
  let bestEdge = 0;
  let bestOverlap = 0;

  for (const [id, r] of Object.entries(rects)) {
    if (id === sessionId) continue;

    let edge: number;
    let overlap: number;
    if (dir === 'left' || dir === 'right') {
      const beyond =
        dir === 'left' ? r.x + r.w <= cur.x + EPS : r.x >= cur.x + cur.w - EPS;
      if (!beyond) continue;
      overlap = Math.min(cur.y + cur.h, r.y + r.h) - Math.max(cur.y, r.y);
      edge = dir === 'left' ? r.x + r.w : r.x;
    } else {
      const beyond =
        dir === 'up' ? r.y + r.h <= cur.y + EPS : r.y >= cur.y + cur.h - EPS;
      if (!beyond) continue;
      overlap = Math.min(cur.x + cur.w, r.x + r.w) - Math.max(cur.x, r.x);
      edge = dir === 'up' ? r.y + r.h : r.y;
    }

    if (overlap <= EPS) continue;
    // 先看谁贴得更近；贴着同样近时看谁在「正对面」重叠得更多
    const closer = dir === 'left' || dir === 'up' ? edge > bestEdge : edge < bestEdge;
    if (best === null || closer || (Math.abs(edge - bestEdge) <= EPS && overlap > bestOverlap)) {
      best = id;
      bestEdge = edge;
      bestOverlap = overlap;
    }
  }

  return best;
}

// -------------------------------------------------------------- 持久化

/** 嵌套深度上限。损坏的文件不该让我们递归到爆栈 */
const MAX_DEPTH = 16;

/**
 * 从持久化的数据里读一份布局。
 *
 * **按不可信输入处理**（和顺序图模块读 `.seq.json` 同一条规矩）：
 * 文件可能是手改过的、旧版本的、被截断的。读不出来就返回 `null`，
 * 由调用方退回「没有分屏」这个干净状态 —— 而不是让一棵畸形的树
 * 一路走到渲染，算出 NaN 坐标然后白屏。
 *
 * 明确拒绝的几种：形状不对、dir 不认、会话 id 重复（同一个会话出现在两块里，
 * 焦点和上屏的语义就没法定义了）、嵌套过深。
 */
export function parseLayout(raw: unknown, depth = 0): PaneLayout | null {
  if (depth > MAX_DEPTH) return null;
  if (typeof raw !== 'object' || raw === null) return null;

  const node = raw as Record<string, unknown>;

  if (node['kind'] === 'leaf') {
    const sessionId = node['sessionId'];
    if (typeof sessionId !== 'string' || sessionId === '') return null;
    return { kind: 'leaf', sessionId };
  }

  if (node['kind'] === 'split') {
    const dir = node['dir'];
    if (dir !== 'row' && dir !== 'col') return null;
    const a = parseLayout(node['a'], depth + 1);
    const b = parseLayout(node['b'], depth + 1);
    if (a === null || b === null) return null;
    if (duplicates(a, b)) return null;
    return { kind: 'split', dir, ratio: clampRatio(Number(node['ratio'])), a, b };
  }

  return null;
}

function duplicates(a: PaneLayout, b: PaneLayout): boolean {
  const seen = new Set(panesOf(a));
  return panesOf(b).some((id) => seen.has(id));
}
