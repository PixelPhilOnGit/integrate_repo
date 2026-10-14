/**
 * 资料文字里的链接识别：把一段纯文本切成「文字段 + 链接段」，
 * 界面把链接段渲染成可点的地方。
 *
 * # 为什么只有 http/https
 *
 * 和后端 `open.rs` 的校验同一套口径：正文里混进来的 `javascript:`、`file:`
 * 之类**不该变成可点的东西**。两边各拦一道 —— 这边是「不给它做链接的样子」，
 * 那边是「真发过来也不开」。
 *
 * 纯函数，不碰 React —— 单测直接喂字符串（见 `tests/unit/tasks-linkify.test.ts`）。
 */

export interface Linkified {
  kind: 'text' | 'url';
  value: string;
}

/**
 * 结尾这些标点**不属于链接**：「见 https://x.com/a。」句号是正文的。
 * 不剥掉的话，点开的是一个多半打不开的地址。
 */
const TRAILING_PUNCT = /[.,;:!?，。；：！？、）)】」』"'…]+$/u;

export function linkify(text: string): Linkified[] {
  const re = /https?:\/\/[^\s]+/gi;
  const out: Linkified[] = [];
  let last = 0;

  for (const m of text.matchAll(re)) {
    const start = m.index ?? 0;
    const full = m[0];
    const url = full.replace(TRAILING_PUNCT, '');

    if (start > last) out.push({ kind: 'text', value: text.slice(last, start) });
    if (url === '') {
      // 兜底（正则至少要求 `https://`，正常到不了）：宁可整段当文字，别丢字符
      out.push({ kind: 'text', value: full });
    } else {
      out.push({ kind: 'url', value: url });
      const rest = full.slice(url.length);
      if (rest !== '') out.push({ kind: 'text', value: rest });
    }
    last = start + full.length;
  }

  if (last < text.length) out.push({ kind: 'text', value: text.slice(last) });
  return out;
}
