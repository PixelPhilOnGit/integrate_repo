/**
 * 「接口调试」的状态。
 *
 * # 它管什么
 *
 * 编辑器里那份草稿、正在跑/刚跑完的响应、历史、保存的请求、侧栏的搜索词。
 *
 * # 它不管什么
 *
 * **响应字节不落在这儿**（和 SSH / 智能体会话同一条规矩）：正文是边收边
 * 解进一个 `BodyStream`，store 只拿着解出来的文本和字节数。真正要显示的时候
 * 才取 —— 每秒几十次的 `set()` 会把侧栏和状态栏一起拖着重渲染。
 * 调试器这边频率低得多，但「一条 2 MiB 的响应」比「每秒几十次」更值得防。
 *
 * # 每次改动都落盘
 *
 * 草稿以外的三样（历史、保存、搜索词）改了立刻写进键值库。草稿**不落盘** ——
 * 理由见 [`RequestStore.persistHistory`] 上面那段（一句话：请求头里常有 token，
 * 而键值库是明文的；历史/保存是用户**主动**要求记住的，起草中的不是）。
 */

import { newId } from '../../../shared/ids';
import { createKeyValue } from '../../../shared/platform/kv';
import { describeError } from '../../../shell/store';
import type { ShellApi } from '../../../shell/types';
import { BodyStream } from '../core/body';
import {
  canSend,
  cloneDraft,
  emptyHeaderRow,
  enabledHeaders,
  hasSensitiveHeaders,
  newDraft,
  removeHeader,
  updateHeader,
} from '../core/draft';
import { parseHistory, pushHistory, removeHistory } from '../core/history';
import { parseSaved, removeSaved, upsertSaved } from '../core/saved';
import {
  emptyResponse,
  type HeaderRow,
  type HistoryEntry,
  type RequestDraft,
  type RequestOptions,
  type ResponseState,
  type SavedRequest,
} from '../core/types';
import { requestClient } from '../services';
import type { RequestEvent } from '../services/types';

/** 键值库里的键名（三个各存各的 —— 形状不同，混在一起迟早互相带坏）。 */
const HISTORY_KEY = 'history';
const SAVED_KEY = 'saved';
const QUERY_KEY = 'query';

/**
 * 主区那两个页签组。
 *
 * ⚠️ 放在 store 而不是组件里的 `useState`：**切模块会卸载组件**，
 * 放组件里的话「切去数据库看一眼再回来」就回到第一个页签了 ——
 * 而这条是仓库里各模块一以贯之的规矩（切走再回来状态还在）。
 */
export type EditorTab = 'headers' | 'body';
export type ResponseTab = 'body' | 'headers' | 'redirects';

export interface RequestState {
  /** 第一次读盘完了没有。 */
  ready: boolean;
  /** 编辑器里正在编辑的那份。 */
  draft: RequestDraft;
  /** 正在跑/刚跑完的响应。 */
  response: ResponseState;
  /** 发过的，最新的在最前面。 */
  history: HistoryEntry[];
  /** 起过名字、留着的。 */
  saved: SavedRequest[];
  /** 侧栏搜索词（历史 + 保存的请求两边都筛）。 */
  query: string;
  /** 正在看/刚点开的那条保存的请求（高亮用）。 */
  selectedSavedId: string | null;
  /** 请求那边在看哪个页签（头 / 正文）。 */
  editorTab: EditorTab;
  /** 响应那边在看哪个页签（正文 / 响应头 / 跳转）。 */
  responseTab: ResponseTab;
  /**
   * 读盘/写盘出错的原因。
   *
   * 和任务模块一个口径：单独存一份，界面能说一句 + 给个重试，
   * 而不是让外壳那条一闪而过的错误条替用户记着。
   */
  error: string | null;
}

export class RequestStore {
  private listeners = new Set<() => void>();
  private kv = createKeyValue({ tauriFile: 'request.json', webKey: 'devtoolkit.request.v1' });
  private initPromise: Promise<void> | null = null;
  /**
   * 这一趟响应的解码器（`core/body.ts`）。
   *
   * ⚠️ 它必须**一份对着一条响应**：`TextDecoder` 的流式状态里存着「上一条
   * 响应最后那半个字符」，跨请求复用的话，下一条响应的开头会莫名其妙
   * 多出几个替换字符。所以每次 `send` 都新建一个。
   */
  private stream: BodyStream | null = null;
  private shell: ShellApi = { setStatus: () => {}, reportError: () => {} };
  private state: RequestState = {
    ready: false,
    draft: newDraft(),
    response: emptyResponse(),
    history: [],
    saved: [],
    query: '',
    selectedSavedId: null,
    editorTab: 'headers',
    responseTab: 'body',
    error: null,
  };

  attachShell(shell: ShellApi): void {
    this.shell = shell;
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getSnapshot = (): RequestState => this.state;

  private set(patch: Partial<RequestState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }

  /** 惰性初始化：切到本模块时由 `onActivate` 调。幂等 */
  init(): Promise<void> {
    this.initPromise ??= this.load();
    return this.initPromise;
  }

  private async load(): Promise<void> {
    try {
      const [history, saved, query] = await Promise.all([
        this.kv.get<unknown>(HISTORY_KEY),
        this.kv.get<unknown>(SAVED_KEY),
        this.kv.get<unknown>(QUERY_KEY),
      ]);
      this.set({
        ready: true,
        history: parseHistory(history),
        saved: parseSaved(saved),
        query: typeof query === 'string' ? query : '',
        error: null,
      });
    } catch (e) {
      // 起不来也要让界面能用（空列表 + 一句解释 + 重试）—— 和历史/保存都丢了
      // 比起来，「这个模块整个打不开」是更糟的失败
      this.set({ ready: true, error: describeError(e) });
      this.shell.reportError(e);
    }
  }

  /** 重试（错误提示上那个按钮）。 */
  async retry(): Promise<void> {
    this.set({ error: null });
    this.initPromise = null;
    await this.init();
  }

  // ---------------------------------------------------------------- 草稿

  setMethod(method: string): void {
    this.set({ draft: { ...this.state.draft, method } });
  }

  setUrl(url: string): void {
    this.set({ draft: { ...this.state.draft, url } });
  }

  setBody(body: string): void {
    this.set({ draft: { ...this.state.draft, body } });
  }

  setOption(patch: Partial<RequestOptions>): void {
    this.set({ draft: { ...this.state.draft, options: { ...this.state.draft.options, ...patch } } });
  }

  addHeader(): void {
    this.set({
      draft: { ...this.state.draft, headers: [...this.state.draft.headers, emptyHeaderRow()] },
    });
  }

  updateHeaderRow(id: string, patch: Partial<Pick<HeaderRow, 'name' | 'value' | 'enabled'>>): void {
    this.set({
      draft: { ...this.state.draft, headers: updateHeader(this.state.draft.headers, id, patch) },
    });
  }

  removeHeaderRow(id: string): void {
    this.set({ draft: { ...this.state.draft, headers: removeHeader(this.state.draft.headers, id) } });
  }

  /** 清空编辑器（回到一个全新的请求）。 */
  resetDraft(): void {
    this.set({ draft: newDraft(), response: emptyResponse(), selectedSavedId: null });
  }

  // ---------------------------------------------------------------- 发送

  /** 现在能不能发（不能的话给出**为什么**）。界面上那粒灰按钮和它用的是同一个判断 */
  blocker(): string | null {
    return canSend(this.state.draft, this.state.response.phase === 'running');
  }

  /**
   * 发出去。
   *
   * ⚠️ **不 await** 那个 promise：它在整条响应收完之后才 settle。
   * 事件是边跑边来的（`onEvent`），界面跟着事件走。
   */
  send(): void {
    const blocker = this.blocker();
    if (blocker !== null) {
      this.shell.reportError(new Error(blocker));
      return;
    }

    // 发出去的那一份在**这一刻**定下来：之后用户在编辑器里怎么改，
    // 都不该影响这条已经在路上的请求（也不该影响记进历史的那份草稿）。
    const sent = cloneDraft(this.state.draft);
    this.stream = new BodyStream();
    // ⚠️ 响应页签拉回「正文」：上一轮在看「跳转」的话，这一轮多半没有跳转，
    // 就会停在一个空页签上（而用户刚发出去，想看的肯定是正文）
    this.set({ response: { ...emptyResponse(), phase: 'running' }, responseTab: 'body' });

    void requestClient
      .send({
        method: sent.method.trim(),
        url: sent.url.trim(),
        headers: enabledHeaders(sent),
        body: sent.body,
        options: sent.options,
        onEvent: (event) => this.applyEvent(sent, event),
      })
      .catch((e: unknown) => {
        // ⚠️ 只有「命令根本没跑起来」才会走到这儿（少发了一个字段那种）。
        // 请求本身的失败是事件（`failed`），和这条路不是一回事。
        this.finish(emptyResponse(), sent, {
          kind: 'failed',
          errorKind: 'invalid',
          message: describeError(e),
          bytes: 0,
        });
        this.shell.reportError(e);
      });
  }

  private applyEvent(sent: RequestDraft, event: RequestEvent): void {
    switch (event.kind) {
      case 'started':
        this.set({
          response: {
            ...this.state.response,
            phase: 'running',
            head: {
              status: event.status,
              reason: event.reason,
              headers: event.headers,
              finalUrl: event.finalUrl,
              redirects: event.redirects,
              httpVersion: event.httpVersion,
              elapsedMillis: event.elapsedMillis,
            },
          },
        });
        break;

      case 'chunk': {
        const stream = this.stream;
        if (stream === null) break; // 不该发生（每次 send 都新建了）
        stream.push(event.base64);
        this.set({
          response: {
            ...this.state.response,
            text: stream.text,
            bytes: stream.bytes,
            prefix: stream.prefix,
          },
        });
        break;
      }

      case 'finished':
        this.stream?.finish();
        this.finish(
          {
            ...this.state.response,
            phase: 'done',
            text: this.stream?.text ?? '',
            bytes: event.bytes,
            prefix: this.stream?.prefix ?? new Uint8Array(),
            truncated: event.truncated,
            totalMillis: event.totalMillis,
          },
          sent,
          { kind: 'ok', status: this.state.response.head?.status ?? 0, totalMillis: event.totalMillis, bytes: event.bytes, truncated: event.truncated },
        );
        break;

      case 'failed':
        this.stream?.finish();
        this.finish(
          {
            ...this.state.response,
            phase: 'failed',
            text: this.stream?.text ?? '',
            bytes: event.bytes,
            prefix: this.stream?.prefix ?? new Uint8Array(),
            error: { errorKind: event.errorKind, message: event.message, bytes: event.bytes },
          },
          sent,
          { kind: 'failed', errorKind: event.errorKind, message: event.message, bytes: event.bytes },
        );
        break;
    }
  }

  /** 收尾：把响应定格，并且**记一条历史**（历史是这个模块的账本）。 */
  private finish(response: ResponseState, sent: RequestDraft, outcome: HistoryEntry['outcome']): void {
    this.stream = null;
    const entry: HistoryEntry = {
      id: newId('hist'),
      at: Date.now(),
      method: sent.method.trim().toUpperCase(),
      url: sent.url.trim(),
      outcome,
      draft: sent,
    };
    const history = pushHistory(this.state.history, entry);
    this.set({ response, history });
    this.persistHistory(history);
  }

  // ---------------------------------------------------------------- 历史

  openHistory(id: string): void {
    const entry = this.state.history.find((e) => e.id === id);
    if (entry === undefined) return;
    // ⚠️ 连响应一起清掉：不清的话，下面显示的那条响应属于**另一个**请求，
    // 而这种错配在界面上没有任何提示（用户会以为自己刚才发的那条回来了）
    this.set({ draft: cloneDraft(entry.draft), response: emptyResponse(), selectedSavedId: null });
  }

  removeHistoryEntry(id: string): void {
    const history = removeHistory(this.state.history, id);
    this.set({ history });
    this.persistHistory(history);
  }

  clearHistory(): void {
    this.set({ history: [] });
    this.persistHistory([]);
  }

  // ---------------------------------------------------------------- 保存的请求

  /**
   * 存一条。**同名就是同一个请求**（覆盖，不再长出一条）。
   *
   * 返回 `false` = 名字是空的（界面那边已经拦了，这里是第二道）。
   */
  save(name: string): boolean {
    if (name.trim() === '') return false;
    const saved = upsertSaved(this.state.saved, name, this.state.draft, Date.now());
    this.set({ saved, selectedSavedId: saved.find((s) => s.name === name.trim())?.id ?? null });
    void this.kv.set(SAVED_KEY, saved).catch((e: unknown) => this.persistFailed(e));
    return true;
  }

  openSaved(id: string): void {
    const entry = this.state.saved.find((s) => s.id === id);
    if (entry === undefined) return;
    this.set({ draft: cloneDraft(entry.draft), response: emptyResponse(), selectedSavedId: id });
  }

  removeSavedEntry(id: string): void {
    const saved = removeSaved(this.state.saved, id);
    this.set({
      saved,
      selectedSavedId: this.state.selectedSavedId === id ? null : this.state.selectedSavedId,
    });
    void this.kv.set(SAVED_KEY, saved).catch((e: unknown) => this.persistFailed(e));
  }

  // ---------------------------------------------------------------- 页签

  setEditorTab(tab: EditorTab): void {
    this.set({ editorTab: tab });
  }

  /** ⚠️ 切到「跳转」页签只在真有跳转时才有意义 —— 调用方（面板）负责不画它 */
  setResponseTab(tab: ResponseTab): void {
    this.set({ responseTab: tab });
  }

  // ---------------------------------------------------------------- 搜索

  setQuery(query: string): void {
    this.set({ query });
    // 搜索词也落盘：切走再回来不该丢掉（和连接侧栏一个口径）。
    // 写失败无所谓 —— 它只是个便利，下次打开时是空的而已
    void this.kv.set(QUERY_KEY, query).catch(() => undefined);
  }

  // ---------------------------------------------------------------- 落盘

  /**
   * 历史落盘。
   *
   * ⚠️ **草稿本身不落盘**（历史里那份是用户主动发的，草稿是还没发出去的
   * 半成品）。理由：请求头里常有 `authorization` 这种**明文凭据**，而键值库
   * 是明文的（连接密码和助手的 key 走系统钥匙串，那是另一套）。
   * 起草中的东西没必要替用户留一份在磁盘上。
   */
  private persistHistory(history: HistoryEntry[]): void {
    void this.kv.set(HISTORY_KEY, history).catch((e: unknown) => this.persistFailed(e));
  }

  /** 写盘失败：不弹错误条（它多半是配额满了），在状态栏说一句就够 */
  private persistFailed(e: unknown): void {
    this.shell.setStatus(`接口调试：历史没存住（${describeError(e)}）`);
  }

  /** 这份草稿里有没有凭据类的头（列表上那个 ⚠）。 */
  currentHasSensitive(): boolean {
    return hasSensitiveHeaders(this.state.draft);
  }
}

export const requestStore = new RequestStore();
