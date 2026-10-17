/**
 * `@成员` 的解析与输入框补全。**纯函数**（可穷举）。
 *
 * # 规则（和用户拍板的一致）
 *
 * * 不 @ = 附近所有成员都会回答（广播）；
 * * @ 了谁 = 只有那些成员回答；
 * * **未知 @（例如 `@张三` 但群里没有这个人）要被拦住** —— 静默退化成
 *   「所有人都回答」会让用户以为只是没点名，这个错误很难自己发现。
 *
 * # 边界规则（几个真会踩的点）
 *
 * * `foo@bar.com` 里的 `@` **不算提及**（前面是字母）；
 * * `@甲虫` 在群里只有「甲」时算**未知提及**（不能把「甲虫」切成「甲」）；
 * * 中文名、带空格的名字、名字里的正则元字符都要能处理（不做正则拼接）；
 * * 输入法组合期间（`isComposing`）不触发候选 —— 那是调用方的事，这里只做纯文本。
 */

export interface MentionMember {
  memberId: string;
  name: string;
}

export interface ParsedMentions {
  /** 按出现顺序去重 */
  mentions: MentionMember[];
  /** 认不出来的 `@xxx`（已经去掉 `@`） */
  unknown: string[];
}

/** `@` 前面允许出现的字符（行首也算）。字母/数字后面不算 —— 挡邮箱。 */
function beforeBoundary(text: string, index: number): boolean {
  if (index === 0) return true;
  return !/[\p{L}\p{N}_]/u.test(text.charAt(index - 1));
}

/** 名字后面允许出现的字符。又跟着字母/数字 = 名字没匹配完（`@甲虫`）。 */
function afterBoundary(text: string, index: number): boolean {
  if (index >= text.length) return true;
  return !/[\p{L}\p{N}_]/u.test(text.charAt(index));
}

/** 未知提及的 token 取到哪：空白或常见标点为止。 */
function unknownToken(text: string, start: number): { token: string; end: number } {
  let end = start;
  while (end < text.length && !/[\s、,，。;；:：!！?？"'「」（）()【】\[\]@]/u.test(text.charAt(end))) {
    end += 1;
  }
  return { token: text.slice(start, end), end };
}

/**
 * 解析一段文字里的提及。
 *
 * 成员名按**长度降序**匹配（「甲虫」优先于「甲」），匹配成功的不再参与后面的
 * 位置，避免同名前缀互相抢。
 */
export function parseMentions(
  text: string,
  members: readonly MentionMember[],
): ParsedMentions {
  const sorted = [...members].sort((a, b) => b.name.length - a.name.length);
  const mentions: MentionMember[] = [];
  const unknown: string[] = [];
  const seen = new Set<string>();

  let i = 0;
  while (i < text.length) {
    if (text.charAt(i) !== '@' || !beforeBoundary(text, i)) {
      i += 1;
      continue;
    }

    const rest = text.slice(i + 1);
    const hit = sorted.find(
      (m) => rest.startsWith(m.name) && afterBoundary(rest, m.name.length),
    );

    if (hit !== undefined) {
      if (!seen.has(hit.memberId)) {
        seen.add(hit.memberId);
        mentions.push(hit);
      }
      i += 1 + hit.name.length;
      continue;
    }

    const { token, end } = unknownToken(text, i + 1);
    if (token !== '' && !unknown.includes(token)) unknown.push(token);
    i = end > i + 1 ? end : i + 1;
  }

  return { mentions, unknown };
}

/**
 * 光标处是否在一个 `@` 片段里（决定要不要弹候选）。
 *
 * 返回 `start`（`@` 的位置）和 `query`（`@` 到光标之间）。query 只允许
 * 名字里常见的字符；出现标点/换行就当已经结束了。
 */
export function mentionQuery(
  text: string,
  caret: number,
): { start: number; query: string } | null {
  if (caret <= 0) return null;
  const before = text.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at < 0 || !beforeBoundary(text, at)) return null;
  const query = text.slice(at + 1, caret);
  if (!/^[\p{L}\p{N} _-]*$/u.test(query)) return null;
  return { start: at, query };
}

/** 候选：大小写不敏感的子串匹配；空 query 给全部。 */
export function filterCandidates(
  members: readonly MentionMember[],
  query: string,
): MentionMember[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [...members];
  return members.filter((m) => m.name.toLowerCase().includes(q));
}

/**
 * 把一个候选写回输入框：把 `@query` 换成 `@名字 `，光标放到空格后。
 *
 * 找不到当前片段就原样返回（比如用户刚删了 `@`）。
 */
export function applyMention(
  text: string,
  caret: number,
  name: string,
): { text: string; caret: number } {
  const q = mentionQuery(text, caret);
  if (q === null) return { text, caret };

  // 后面已经是空白就不要再加一个空格（否则出现两个空格）；光标越过那一个。
  const hasSpace = caret < text.length && /\s/.test(text.charAt(caret));
  const insert = `@${name}${hasSpace ? '' : ' '}`;
  const next = `${text.slice(0, q.start)}${insert}${text.slice(caret)}`;
  return {
    text: next,
    caret: q.start + insert.length + (hasSpace ? 1 : 0),
  };
}
