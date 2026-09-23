/**
 * 草稿这块的纯逻辑：默认值、请求头行的增删改、以及「草稿 → 发出去的那份」的映射。
 *
 * 不 import 界面代码、不碰 store —— 所以这一整块在 vitest 里是毫秒级的
 * `expect(...)`，不需要渲染任何一个组件。
 */

import { newId } from '../../../shared/ids';
import type { HeaderRow, RequestDraft, RequestOptions } from './types';

/**
 * 三处默认值必须一致：这里、Rust 的 `OptionsSpec` 使用方
 * （`request_commands.rs`）、传输层的 `RequestOptions::default()`。
 * 见 `core/types.ts` 里那段说明。
 */
export const DEFAULT_OPTIONS: RequestOptions = {
  timeoutSecs: 30,
  idleTimeoutSecs: 90,
  followRedirects: false,
  maxRedirects: 5,
  acceptInvalidCerts: false,
};

/** 新建一个空行（编辑器里那一条空白的头）。 */
export function emptyHeaderRow(): HeaderRow {
  return { id: newId('h'), name: '', value: '', enabled: true };
}

/**
 * 一个新请求。
 *
 * 默认 **GET + 三条空行**（空的头行在界面就是占位，发出去之前会被滤掉）——
 * 用户点进这个模块十有八九是想打一个 GET 看看。
 */
export function newDraft(): RequestDraft {
  return {
    method: 'GET',
    url: '',
    headers: [emptyHeaderRow(), emptyHeaderRow(), emptyHeaderRow()],
    body: '',
    options: { ...DEFAULT_OPTIONS },
  };
}

/**
 * 这份草稿能不能发。
 *
 * ⚠️ 和界面上的「为什么不能点」（`sendBlockers`）是**同一个判断的两面** ——
 * 加条件时两处都要改，否则就是一粒灰着的按钮配一句对不上的解释
 *（助手上线时踩过，见 HANDOFF ⑧）。
 */
export function blockerOf(draft: RequestDraft): string | null {
  if (draft.url.trim() === '') return '先填一个地址';
  if (!/^https?:\/\//i.test(draft.url.trim())) {
    // ⚠️ **不替用户补 `http://`**（Postman 会补）。补的话，用户想打的是
    // https，我们可能在**明文**上把 Authorization 头发出去 —— 那是一次
    // 悄悄的安全降级。宁可让他看见一句「地址要以 http:// 或 https:// 开头」。
    return '地址要以 http:// 或 https:// 开头';
  }
  return null;
}

/** 能发就返回 null，否则返回**一句给用户看的话**。 */
export function canSend(draft: RequestDraft, running: boolean): string | null {
  if (running) return '上一个请求还没结束';
  return blockerOf(draft);
}

/** 一份草稿里真正要发出去的那些头（没启用的、名字空着的都滤掉）。 */
export function enabledHeaders(draft: RequestDraft): Array<[string, string]> {
  return draft.headers
    .filter((h) => h.enabled && h.name.trim() !== '')
    .map((h) => [h.name.trim(), h.value]);
}

/**
 * 这一行/这份草稿里有没有「像是凭据」的头。
 *
 * ⚠️ 有实际后果：历史和历史里那份草稿是**明文**存在键值库里的
 *（连接密码和 API key 走的是系统钥匙串，那是另一套）。界面上给这样一条
 * 加个 ⚠，是为了别让生产 token 安安静静地长期躺在磁盘上。
 *
 * ⚠️ 名单不完备，也不必完备 —— 请求头是自由形式的，挑不出「哪一条一定是
 * 凭据」。它挡的是最常见的那几个。
 */
const SENSITIVE = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'x-api-key',
  'api-key',
  'x-auth-token',
]);

export function looksSensitive(name: string): boolean {
  return SENSITIVE.has(name.trim().toLowerCase());
}

/** 这份草稿里有没有凭据类的头（列表上那个 ⚠ 用它）。 */
export function hasSensitiveHeaders(draft: RequestDraft): boolean {
  return draft.headers.some((h) => h.enabled && looksSensitive(h.name));
}

/**
 * 改一行头。
 *
 * 返回新数组（React 那边按引用比较）——并且**只在真的改了这一行时才新建**，
 * 没命中的话原样返回，免得每次击键都让整张表重渲染。
 */
export function updateHeader(
  headers: HeaderRow[],
  id: string,
  patch: Partial<Omit<HeaderRow, 'id'>>,
): HeaderRow[] {
  let hit = false;
  const next = headers.map((h) => {
    if (h.id !== id) return h;
    hit = true;
    return { ...h, ...patch };
  });
  return hit ? next : headers;
}

/**
 * 删一行。
 *
 * ⚠️ 删的是**最后一行**时补一个空行：表格空着的话，用户要先把光标挪到某处
 * 再想怎么加回来 —— 而这里的操作永远是「删掉这一条，再写一条新的」。
 */
export function removeHeader(headers: HeaderRow[], id: string): HeaderRow[] {
  const next = headers.filter((h) => h.id !== id);
  return next.length === 0 ? [emptyHeaderRow()] : next;
}

/**
 * 两份草稿是不是「同一个请求」（历史去重用的）。
 *
 * ⚠️ 比的是**发出去会变的那几样**：方法、地址、正文和**启用的头**。
 * 不比较行 id 和顺序 —— 同一份请求改了个头行的顺序、或者编辑了一下再改回来，
 * 那还是同一个请求，不该在历史里长出两条。
 */
export function sameRequest(a: RequestDraft, b: RequestDraft): boolean {
  if (a.method.trim().toUpperCase() !== b.method.trim().toUpperCase()) return false;
  if (a.url.trim() !== b.url.trim()) return false;
  if (a.body !== b.body) return false;
  const ha = enabledHeaders(a);
  const hb = enabledHeaders(b);
  if (ha.length !== hb.length) return false;
  return ha.every(([name, value], i) => {
    const [n2, v2] = hb[i] ?? ['', ''];
    return name.toLowerCase() === n2?.toLowerCase() && value === v2;
  });
}

/**
 * 深拷一份草稿。
 *
 * ⚠️ 存进历史、存成保存的请求、以及「发出去的那一份」都要先过它 ——
 * 直接引用编辑器里那个对象的话，用户接着改，**存下来那份会跟着变**
 *（而它看起来是存住了的）。头行的 id 顺便换新：它们只给 React 当 key。
 */
export function cloneDraft(draft: RequestDraft): RequestDraft {
  return {
    method: draft.method,
    url: draft.url,
    headers: draft.headers.map((h) => ({ ...h, id: newId('h') })),
    body: draft.body,
    options: { ...draft.options },
  };
}

/** 列表上那一行显示的地址（太长的中间截掉）。 */
export function shortUrl(url: string, max = 60): string {
  const trimmed = url.trim();
  if (trimmed.length <= max) return trimmed;
  const head = trimmed.slice(0, Math.ceil(max / 2) - 1);
  const tail = trimmed.slice(trimmed.length - Math.floor(max / 2) + 1);
  return `${head}…${tail}`;
}

// ---------------------------------------------------------------- 从磁盘读回来

/**
 * 从键值库里读回来的东西一律是 `unknown` —— 这里负责**逐字段校验**。
 *
 * ⚠️ 不做校验的话，一条坏数据（用户手改过库、或者某个版本写坏过）会让
 * 整个侧栏白屏。而这里的取舍是：**能救的字段就救**，救不了的用默认值 ——
 * 一条历史里地址坏了，也不该把这份请求整个丢掉（用户可能只是想再看看
 * 当时发了什么头）。
 *
 * 返回 `null` 只在一种情况下：这一条根本不是个对象。
 */
export function readDraft(raw: unknown): RequestDraft | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;

  const headers = Array.isArray(o['headers'])
    ? o['headers'].map(readHeaderRow).filter((h): h is HeaderRow => h !== null)
    : [];

  return {
    method: typeof o['method'] === 'string' ? o['method'] : 'GET',
    url: typeof o['url'] === 'string' ? o['url'] : '',
    // 一行都没有的话补一个空行 —— 不然「头」那一页会是空的，
    // 而用户连个能输入的地方都没有
    headers: headers.length > 0 ? headers : [emptyHeaderRow()],
    body: typeof o['body'] === 'string' ? o['body'] : '',
    options: readOptions(o['options']),
  };
}

function readHeaderRow(raw: unknown): HeaderRow | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  return {
    // id 坏了就换一个新的：它只给 React 当 key 用，重来一次没有代价
    id: typeof o['id'] === 'string' && o['id'] !== '' ? o['id'] : newId('h'),
    name: typeof o['name'] === 'string' ? o['name'] : '',
    value: typeof o['value'] === 'string' ? o['value'] : '',
    // ⚠️ 默认是**启用**：老数据里没有这个字段（将来的版本可能加），
    // 而「读回来发现全都被关掉了」比「多启用了一条」难查得多
    enabled: o['enabled'] !== false,
  };
}

function readOptions(raw: unknown): RequestOptions {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const num = (v: unknown, fallback: number, min: number, max: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback;

  return {
    timeoutSecs: num(o['timeoutSecs'], DEFAULT_OPTIONS.timeoutSecs, 1, 3600),
    idleTimeoutSecs: num(o['idleTimeoutSecs'], DEFAULT_OPTIONS.idleTimeoutSecs, 1, 3600),
    followRedirects: o['followRedirects'] === true,
    maxRedirects: num(o['maxRedirects'], DEFAULT_OPTIONS.maxRedirects, 0, 20),
    acceptInvalidCerts: o['acceptInvalidCerts'] === true,
  };
}
