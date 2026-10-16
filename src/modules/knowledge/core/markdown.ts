/**
 * 手写的 markdown 子集解析器：**解析成 AST，不做 HTML 字符串**。
 *
 * # 为什么不引 markdown 库
 *
 * 全仓没有 markdown 依赖（助手消息是纯文本、任务资料只认链接），而卡片渲染
 * 要的只是一个小而确定的子集。引一个库还搭进来一条「HTML 注入 → 必须配
 * sanitizer」的链路 —— 这里输出的是 AST，React 那边逐节点映射成元素，
 * **根本没有 innerHTML 这回事**，XSS 这一类问题在源头不存在。
 *
 * # 支持的子集（够画卡片就行，扩的时候先改测试）
 *
 * 块：标题（#..####）、段落、无序/有序列表、围栏代码、引用、分隔线；
 * **`seq` 围栏单独成节点**（内容是 .seq.json 原文，阅读器交给顺序图的渲染栈）。
 * 行内：粗体、斜体、行内代码、`[](url)`（只放行 http/https）、
 * `[[卡片]]`（含 `[[目标|别名]]`）、`![[图片]]`。
 *
 * ⚠️ 不认识的行 = 段落，不认识的行内字符 = 纯文本 —— **解析永远不失败**，
 * 用户手编的文件再多花样，卡片也画得出来。
 */

/** 块级节点 */
export type MdBlock =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'quote'; text: string }
  | { kind: 'code'; lang: string; text: string }
  /** `seq` 围栏：`json` 是围栏内容原文（阅读器里 JSON.parse 后交给顺序图） */
  | { kind: 'seq'; json: string }
  | { kind: 'hr' };

/** 行内节点 */
export type MdInline =
  | { kind: 'text'; text: string }
  | { kind: 'bold'; text: string }
  | { kind: 'italic'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'link'; text: string; url: string }
  | { kind: 'wikilink'; target: string; alias: string }
  | { kind: 'image'; target: string };

/** 段落里的**单换行**按标准 markdown 处理：并成一个空格 */
export function parseMarkdown(text: string): MdBlock[] {
  const lines = text.split(/\r?\n/);
  const blocks: MdBlock[] = [];
  let i = 0;

  const flushParagraph = (buf: string[]): void => {
    if (buf.length > 0) {
      blocks.push({ kind: 'paragraph', text: buf.join(' ') });
      buf.length = 0;
    }
  };

  const para: string[] = [];
  while (i < lines.length) {
    const line = lines[i] ?? '';

    // 围栏代码
    const fence = /^```(.*)$/.exec(line);
    if (fence !== null) {
      flushParagraph(para);
      const lang = (fence[1] ?? '').trim().toLowerCase();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i] ?? '')) {
        body.push(lines[i] ?? '');
        i += 1;
      }
      i += 1; // 吃掉收尾围栏（没有收尾就吃到尾，宽容）
      const content = body.join('\n');
      if (lang === 'seq') {
        blocks.push({ kind: 'seq', json: content });
      } else {
        blocks.push({ kind: 'code', lang, text: content });
      }
      continue;
    }

    // 标题
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading !== null) {
      flushParagraph(para);
      blocks.push({ kind: 'heading', level: (heading[1] ?? '').length, text: heading[2] ?? '' });
      i += 1;
      continue;
    }

    // 分隔线
    if (/^\s*---+\s*$/.test(line)) {
      flushParagraph(para);
      blocks.push({ kind: 'hr' });
      i += 1;
      continue;
    }

    // 列表（连续的行归成一张表）
    const ul = /^\s*[-*]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ul !== null || ol !== null) {
      flushParagraph(para);
      const ordered = ol !== null;
      const items: string[] = [];
      while (i < lines.length) {
        const cur = lines[i] ?? '';
        const m = ordered ? /^\s*\d+[.)]\s+(.*)$/.exec(cur) : /^\s*[-*]\s+(.*)$/.exec(cur);
        if (m === null) break;
        items.push(m[1] ?? '');
        i += 1;
      }
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }

    // 引用
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote !== null) {
      flushParagraph(para);
      const body: string[] = [quote[1] ?? ''];
      i += 1;
      while (i < lines.length) {
        const m = /^\s*>\s?(.*)$/.exec(lines[i] ?? '');
        if (m === null) break;
        body.push(m[1] ?? '');
        i += 1;
      }
      blocks.push({ kind: 'quote', text: body.join(' ') });
      continue;
    }

    if (line.trim() === '') {
      flushParagraph(para);
      i += 1;
      continue;
    }

    para.push(line.trim());
    i += 1;
  }
  flushParagraph(para);
  return blocks;
}

/**
 * 行内解析。**顺序有讲究**：`![[…]]` 必须在 `[[…]]` 之前匹配（否则图片
 * 会先被当 wikilink 吃掉一半），行内代码在粗斜体之前（代码里不解释格式）。
 */
export function parseInline(text: string): MdInline[] {
  const out: MdInline[] = [];
  const re = /(!\[\[[^\]]+\]\])|(\[\[[^\]]+\]\])|(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\((https?:\/\/[^)\s]+)\))/g;

  let last = 0;
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ kind: 'text', text: text.slice(last, at) });
    const tok = m[0];

    if (tok.startsWith('![[')) {
      out.push({ kind: 'image', target: tok.slice(3, -2).trim() });
    } else if (tok.startsWith('[[')) {
      const inner = tok.slice(2, -2);
      const [targetRaw, aliasRaw] = inner.split('|');
      const target = (targetRaw ?? '').trim();
      out.push({ kind: 'wikilink', target, alias: (aliasRaw ?? target).trim() });
    } else if (tok.startsWith('`')) {
      out.push({ kind: 'code', text: tok.slice(1, -1) });
    } else if (tok.startsWith('**')) {
      out.push({ kind: 'bold', text: tok.slice(2, -2) });
    } else if (tok.startsWith('*')) {
      out.push({ kind: 'italic', text: tok.slice(1, -1) });
    } else {
      // [text](url)：url 已经由正则锁死 http/https —— `javascript:` 这类
      // 连匹配都匹配不上，会**原样当纯文本**（不报错、不可点）
      const link = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(tok);
      if (link !== null) {
        out.push({ kind: 'link', text: link[1] ?? '', url: link[2] ?? '' });
      } else {
        out.push({ kind: 'text', text: tok });
      }
    }
    last = at + tok.length;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out;
}
