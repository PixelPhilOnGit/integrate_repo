/**
 * 侧栏里的模糊搜索：**只算分，不碰界面**。
 *
 * # 为什么是子序列，不是子串
 *
 * 「模糊搜」省的那点事主要在这儿：`prod` 能搜到 `production-api`，`192168`
 * 能搜到 `192.168.1.20`，`wsapi` 能搜到 `D:\work\api`（跨目录分隔符）。
 * 子串匹配这三条一条都做不到。
 *
 * # 打分要解决的是「一堆结果里谁排前面」
 *
 * 子序列的坏处是**什么都匹配得上**（只要字母按顺序出现）。所以分数要让「像」
 * 的排前面：
 *
 * - **连着的**比断开的值钱（`prod` 打中 `production` 里的连续四个字符）
 * - **词首 / 分隔符之后**的值钱（搜 `api` 时 `D:\work\api` 该排在
 *   `D:\work\rapid` 前面）
 * - **开头就中**的最值钱（搜 `prod` 时 `prod-db` 排在 `my-prod-db` 前）
 * - 同样匹配上时，**短的排前面**（说明匹配得更「满」）
 *
 * 大小写不敏感；空查询**匹配一切**（调用方据此走「不过滤」那条路）。
 */

/** 连续命中的加成 */
const BONUS_CONSECUTIVE = 8;
/** 命中在词首 / 分隔符之后 */
const BONUS_BOUNDARY = 6;
/** 命中在文本开头 */
const BONUS_PREFIX = 10;
/** 每跳过一个字符扣一点 —— 让「紧凑」的匹配赢 */
const PENALTY_GAP = 1;
/** 文本每长一个字符扣一点（很轻，只用来打破平局） */
const PENALTY_LENGTH = 0.5;

/**
 * 找一个「像词首」的位置时往前看多远。
 *
 * 不往前看的话，`a-ap` 里搜 `api` 会从第一个 `a` 开始一路跳到后面 ——
 * 而真正的词首（`-` 之后那个 `a`）就在旁边。看 8 个字符足够覆盖
 * 「一两个词的间隔」，再远就不值得了。
 */
const LOOKAHEAD = 8;

export interface MatchResult {
  /** 分数，越高越像。只会返回 > 0 的结果（没匹配上返回 null） */
  score: number;
  /** 命中的字符在原串里的下标（界面要高亮时用；不需要就别取值） */
  positions: number[];
}

/**
 * 分隔符：命中在它们之后算「词首」。
 *
 * 把 `.` `:` `/` `\` 这些一起算进来是有意的 —— 连接名里最常搜的就是
 * IP（`192.168.1.20`）和路径（`D:\work\api`），而它们的「词」就是这些符号切开的。
 */
const BOUNDARY = new Set([' ', '-', '_', '.', ':', '/', '\\', '@', '(', ')', '[', ']']);

function isBoundaryAt(text: string, index: number): boolean {
  if (index === 0) return true;
  const prev = text[index - 1];
  return prev !== undefined && BOUNDARY.has(prev);
}

/**
 * 一个查询串在一次文本里的匹配。匹配不上返回 null。
 *
 * 逐字符贪心，但**每步先看看前面一小段里有没有词首**：有就走词首。纯贪心
 * （永远取第一个出现的）在 `a-ap` 这种串上会把 `a` 吃在开头，后面接不上别的高分位置。
 */
export function fuzzyMatch(query: string, text: string): MatchResult | null {
  if (query === '') return { score: 1, positions: [] };

  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (q.length > t.length) return null;

  const positions: number[] = [];
  let score = 0;
  let at = 0;

  for (let i = 0; i < q.length; i += 1) {
    const ch = q[i];
    if (ch === undefined) continue;

    // 在 [at, at + LOOKAHEAD] 里挑一个位置：优先连着上一个、其次词首，
    // 都没有就退到最靠前的那个
    let chosen = -1;
    const limit = Math.min(t.length - 1, at + LOOKAHEAD);
    for (let j = at; j <= limit; j += 1) {
      if (t[j] !== ch) continue;
      if (j === at || isBoundaryAt(text, j)) {
        chosen = j;
        break;
      }
      if (chosen < 0) chosen = j; // 兜底：先记下最靠前的
    }
    if (chosen < 0) {
      // 往前看的那一段里没有 —— 整个串里再找一次（不看了，直接取第一个）
      const rest = t.indexOf(ch, at);
      if (rest < 0) return null;
      chosen = rest;
    }

    const gap = chosen - at;
    if (gap > 0) score -= gap * PENALTY_GAP;
    if (gap === 0 && positions.length > 0) score += BONUS_CONSECUTIVE;
    if (isBoundaryAt(text, chosen)) score += BONUS_BOUNDARY;
    if (chosen === 0) score += BONUS_PREFIX;

    positions.push(chosen);
    at = chosen + 1;
  }

  score -= text.length * PENALTY_LENGTH;

  // 全是扣分的极端情况（长文本、跳得厉害）：仍然算匹配，但给个地板价，
  // 免得排序时和「没匹配」混在一起
  return { score: Math.max(score, 1), positions };
}

/** 只要分的便利版。没匹配上返回 null */
export function fuzzyScore(query: string, text: string): number | null {
  return fuzzyMatch(query, text)?.score ?? null;
}

/**
 * 在多段文字里找最好的一次匹配 —— 连接行要同时看名字和地址（`prod` 在名字里，
 * `192.168` 在地址里），两段都看才不会漏。
 *
 * 返回**最高的那个分**（不返回位置：跨两段的下标没有意义，
 * 界面要高亮的话得按字段分别调用）。
 */
export function fuzzyBest(query: string, texts: readonly string[]): number | null {
  let best: number | null = null;
  for (const text of texts) {
    const score = fuzzyScore(query, text);
    if (score !== null && (best === null || score > best)) best = score;
  }
  return best;
}

/**
 * 按匹配分排序并过滤。`texts` 是被搜的那几段（名字 / 地址 / 路径……）。
 *
 * 空查询时**原样返回**（顺序都不动）—— 这是「搜索框空着的时候和以前一模一样」
 * 那条约定的落点，别在这儿做任何「顺手排个序」。
 */
export function fuzzyFilter<T>(
  items: readonly T[],
  query: string,
  texts: (item: T) => readonly string[],
): T[] {
  if (query.trim() === '') return [...items];

  const q = query.trim();
  const scored: Array<{ item: T; score: number }> = [];
  for (const item of items) {
    const score = fuzzyBest(q, texts(item));
    if (score !== null) scored.push({ item, score });
  }
  // 同分时保持原来的顺序（`sort` 在 V8 里是稳定的，这里靠它）
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.item);
}
