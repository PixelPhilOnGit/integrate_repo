/**
 * 把一条回复渲染成给人看的文本行。
 *
 * 格式**照着 redis-cli 的手感来**（`(integer) 1`、`"value"`、`1) "a"`、
 * `(nil)`、`(error) ERR ...`）—— 用户认得这套记号，换个样式反而是负担。
 *
 * 纯函数：不碰 DOM、不发请求，所以能在 node 下把各种回复形状穷举测一遍。
 */

import type { RedisReply } from './types';

/**
 * 一个容器最多渲染多少项。
 *
 * `KEYS *` 打在一个几十万 key 的库上会返回一个大数组，全画出来会把 WebView 卡死。
 * 超出部分折叠成一行提示 —— 信息没丢（用户知道还有多少），代价只是要看得自己加
 * pattern 过滤或分页。
 */
export const MAX_ARRAY_ITEMS = 200;

/** 渲染成若干行。标量回复是一行，嵌套容器是多行。 */
export function renderReply(reply: RedisReply): string[] {
  const lines: string[] = [];
  renderInto(reply, '', lines);
  return lines;
}

/** 单行摘要，给状态栏之类的地方用 */
export function summarize(reply: RedisReply): string {
  return renderReply(reply)[0] ?? '';
}

type Entry = { key: RedisReply | null; value: RedisReply };

/** 是容器就返回它的项，标量返回 null */
function containerEntries(reply: RedisReply): Entry[] | null {
  switch (reply.type) {
    case 'array':
      return reply.items.map((value) => ({ key: null, value }));
    case 'set':
      return reply.items.map((value) => ({ key: null, value }));
    case 'map':
      return reply.entries.map(([key, value]) => ({ key, value }));
    default:
      return null;
  }
}

function renderInto(reply: RedisReply, prefix: string, out: string[]): void {
  const entries = containerEntries(reply);

  if (entries === null) {
    out.push(prefix + inline(reply));
    return;
  }

  if (entries.length === 0) {
    out.push(prefix + '(empty array)');
    return;
  }

  const shown = entries.slice(0, MAX_ARRAY_ITEMS);
  for (const [index, entry] of shown.entries()) {
    const label = `${prefix}${index + 1}) `;
    // map 的键先内联出来，值接着往后排
    const childPrefix = entry.key === null ? label : `${label}${inline(entry.key)} => `;
    renderInto(entry.value, childPrefix, out);
  }

  if (entries.length > shown.length) {
    out.push(`${prefix}…（还有 ${entries.length - shown.length} 项，用 pattern 过滤或分页再看）`);
  }
}

/** 标量的单行形式 */
function inline(reply: RedisReply): string {
  switch (reply.type) {
    case 'nil':
      return '(nil)';
    case 'status':
      return reply.text;
    case 'error':
      return `(error) ${reply.message}`;
    case 'integer':
      return `(integer) ${reply.value}`;
    case 'bulk':
      // 二进制值只报长度，不试着显示内容 —— Rust 侧给的是 lossy 解码的结果，
      // 拿它当内容是误导（对比 redis-cli 会显示 \xHH 转义，那是另一套实现）。
      return reply.binary ? `(二进制, ${reply.bytes} 字节)` : `"${escapeText(reply.text)}"`;
    case 'double':
      return `(double) ${formatDouble(reply.value)}`;
    case 'boolean':
      return reply.value ? '(true)' : '(false)';
    case 'verbatim':
      return `=${reply.format} "${escapeText(reply.text)}"`;
    case 'bigNumber':
      return `(bignumber) ${reply.text}`;
    // 容器只在 map 的键位置上可能走到这里（键几乎总是标量）
    case 'array':
    case 'set':
    case 'map':
      return '(...)';
  }
}

/**
 * 把字符串包进引号时需要的转义。
 *
 * 控制字符转成 `\xHH`（redis 的值里带换行是常事，原样打出来会把一行日志撑成好几行），
 * 引号和反斜杠转义掉，其余（含中文）原样保留。
 */
function escapeText(text: string): string {
  let out = '';
  for (const ch of text) {
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else {
      const code = ch.codePointAt(0) ?? 0;
      if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, '0')}`;
      else out += ch;
    }
  }
  return out;
}

/** Redis 的双精度会出现 inf / -inf / nan，JS 的 String() 给的是 Infinity 那套写法 */
function formatDouble(value: number): string {
  if (Number.isNaN(value)) return 'nan';
  if (value === Infinity) return 'inf';
  if (value === -Infinity) return '-inf';
  return String(value);
}

/** 耗时显示：不到 1 毫秒也显示成 0.4ms，别四舍五入成 0 */
export function formatElapsed(ms: number): string {
  if (ms < 10) return `${ms.toFixed(1)}ms`;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}
