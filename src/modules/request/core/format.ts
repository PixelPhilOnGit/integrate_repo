/**
 * 显示层的纯函数：状态码怎么画、错误大类怎么措辞、时间怎么算。
 *
 * 单独一个文件是为了能单测 —— 尤其是 [`errorHint`]：它是**用户唯一能看到的
 * 那句「现在该怎么办」**，而传输层给的那句话（`connect` / `tls` / `idle` …）
 * 说的是「哪儿坏了」，不是「你该做什么」。
 */

import type { ResponseHead } from './types';

/** 状态码 → 一个色档（CSS 上那个点/标签的颜色）。 */
export function statusTone(status: number): 'ok' | 'redirect' | 'client' | 'server' {
  if (status >= 200 && status < 300) return 'ok';
  if (status >= 300 && status < 400) return 'redirect';
  if (status >= 400 && status < 500) return 'client';
  return 'server';
}

/**
 * 传输层那个错误大类 → **一句能照着做的话**。
 *
 * ⚠️ 这一层**不改写**传输层报的原文（那句话里有 `连不上 10.0.0.7：Connection
 * refused` 这种具体信息，比任何概括都值钱）—— 它补的是**下一步**。
 * 两者一起显示：`具体错 + 一句建议`。
 *
 * 认不出来的大类返回 `null`（不编话）：前端会只显示原文。
 */
export function errorHint(errorKind: string): string | null {
  switch (errorKind) {
    case 'invalid':
      return '地址、方法名或者请求头里有不合法的东西 —— 改一下再发。';
    case 'connect':
      return '连不上那台机器：地址/端口写错了、服务没起、或者中间有防火墙。';
    case 'tls':
      return '证书没通过校验。自签证书的内网服务要打开「跳过证书校验」（在右侧）。';
    case 'timeout':
      return '到响应头之前就超时了。可以把右侧那个超时调大一点，或者确认对端真的在听。';
    case 'idle':
      return '连上了、响应头也回来了，但正文一直没动静。把「空闲超时」调大可以再等等 —— 有些网关不是真流式，攒完整个回答才吐。';
    case 'redirect':
      return '跳转没跟下去：要么超过了你设的跳转次数，要么对端给的 Location 看不懂。';
    case 'protocol':
      return '对面回的东西不是合法 HTTP（或者不是 HTTP）。确认一下地址是不是打到了别的服务上。';
    case 'body':
      return '正文读到一半连接就断了。收到的部分还在下面 —— 调 SSE 的时候那半截往往正是要看的东西。';
    default:
      return null;
  }
}

/** 这个响应的 content-type（没有就是 null）。 */
export function contentTypeOf(head: ResponseHead | null): string | null {
  return head === null ? null : headerOf(head.headers, 'content-type');
}

/** 人看的体积（`1.2 MB` 那种）。 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** 毫秒 → `123 ms` / `1.2 s`。 */
export function formatMillis(millis: number): string {
  if (millis < 1000) return `${millis} ms`;
  return `${(millis / 1000).toFixed(2)} s`;
}

/** 时间戳 → `14:03:21`（历史行上那个）。 */
export function formatClock(at: number): string {
  const d = new Date(at);
  const pad = (n: number): string => n.toString().padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 日期 + 时间（保存的请求上那个）。 */
export function formatStamp(at: number): string {
  const d = new Date(at);
  const pad = (n: number): string => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${formatClock(at)}`;
}

/**
 * 响应里某个头（大小写不敏感，取第一条）。
 *
 * ⚠️ 和 `HttpResponse::header`（Rust 那边）同一条规矩：HTTP 头名不分大小写，
 * 而服务端爱怎么写就怎么写（`Content-Type` / `content-type` 都见过）。
 */
export function headerOf(headers: Array<[string, string]>, name: string): string | null {
  const want = name.toLowerCase();
  for (const [k, v] of headers) {
    if (k.toLowerCase() === want) return v;
  }
  return null;
}
