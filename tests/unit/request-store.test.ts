/**
 * store 那条链路（事件 → 状态 → 历史），客户端是**假实现**（脚本化的事件）。
 *
 * 为什么不用真的那一个 `services/web.ts`：这一组要验的是 **store 对事件的
 * 反应**（收到一半断掉、撞上限、点历史会清掉响应……），而不是假服务器吐得对不对。
 * 假服务器的语义在 `request-web.test.ts` 里，两边分工。
 *
 * ⚠️ 这一组最容易漏的是**终态**：`finished` / `failed` 之后响应必须定格，
 * 否则界面上那个「正在接收…」永远转下去。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  send: vi.fn(async (_request: unknown): Promise<void> => {}),
}));

vi.mock('../../src/modules/request/services', () => ({
  requestClient: { send: fake.send },
}));

import { __resetIdsForTest } from '../../src/shared/ids';
import { RequestStore } from '../../src/modules/request/state/store';
import type { RequestEvent, SendRequest } from '../../src/modules/request/services/types';
import type { ShellApi } from '../../src/shell/types';

beforeEach(() => {
  __resetIdsForTest();
  fake.send.mockReset();
  fake.send.mockImplementation(async () => {});
});

interface Harness {
  store: RequestStore;
  errors: string[];
  statuses: string[];
  /** 发出去的那份（断言前端到底传了什么） */
  sent(): SendRequest;
}

function harness(): Harness {
  const store = new RequestStore();
  const errors: string[] = [];
  const statuses: string[] = [];
  const shell: ShellApi = {
    setStatus: (m) => statuses.push(m ?? ''),
    reportError: (e) => errors.push(e instanceof Error ? e.message : String(e)),
  };
  store.attachShell(shell);
  return {
    store,
    errors,
    statuses,
    sent: () => fake.send.mock.calls[0]?.[0] as SendRequest,
  };
}

/** 让假客户端按给定的事件脚本走一遍（send 被调用的那一刻同步推）。 */
function script(events: RequestEvent[]): void {
  fake.send.mockImplementation(async (request: unknown) => {
    const req = request as SendRequest;
    for (const e of events) req.onEvent(e);
  });
}

const started = (status = 200): RequestEvent => ({
  kind: 'started',
  status,
  reason: 'OK',
 headers: [['content-type', 'text/plain']],
  finalUrl: 'https://x/y',
  redirects: [],
  httpVersion: 'HTTP/1.1',
  elapsedMillis: 12,
});

const chunk = (text: string): RequestEvent => ({
  kind: 'chunk',
  base64: Buffer.from(text, 'utf-8').toString('base64'),
});

describe('发出去的是什么', () => {
  it('只把**启用的**头发出去，地址和方法去掉两边的空格', () => {
    const h = harness();
    h.store.setUrl('  https://x/y  ');
    h.store.setMethod('post');
    h.store.updateHeaderRow(h.store.getSnapshot().draft.headers[0]!.id, { name: 'accept', value: '*/*' });
    const second = h.store.getSnapshot().draft.headers[1]!;
    h.store.updateHeaderRow(second.id, { name: 'x-off', value: '1', enabled: false });

    h.store.send();

    const sent = h.sent();
    expect(sent.method).toBe('post');
    expect(sent.url).toBe('https://x/y');
    expect(sent.headers).toEqual([['accept', '*/*']]);
  });

  it('地址不合法时**根本不发**，而且说出为什么', () => {
    const h = harness();
    h.store.setUrl('example.com/y');
    h.store.send();
    expect(fake.send).not.toHaveBeenCalled();
    expect(h.errors).toEqual(['地址要以 http:// 或 https:// 开头']);
  });
});

describe('事件怎么变成界面状态', () => {
  it('started → 状态码和响应头都在了（正文还没来）', () => {
    const h = harness();
    h.store.setUrl('https://x/y');
    script([started(201)]);
    h.store.send();

    const r = h.store.getSnapshot().response;
    expect(r.phase).toBe('running');
    expect(r.head?.status).toBe(201);
    expect(r.text).toBe('');
  });

  it('chunk 边来边解（不是攒完才显示）', () => {
    const h = harness();
    h.store.setUrl('https://x/y');
    script([started(), chunk('前半'), chunk('后半')]);
    h.store.send();

    const r = h.store.getSnapshot().response;
    expect(r.text).toBe('前半后半');
    expect(r.bytes).toBe(Buffer.byteLength('前半后半'));
    expect(r.phase).toBe('running');
  });

  it('finished → 定格成 done，耗时和体积都记下来', () => {
    const h = harness();
    h.store.setUrl('https://x/y');
    script([started(), chunk('abc'), { kind: 'finished', bytes: 3, truncated: false, totalMillis: 40 }]);
    h.store.send();

    const r = h.store.getSnapshot().response;
    expect(r.phase).toBe('done');
    expect(r.totalMillis).toBe(40);
    expect(r.bytes).toBe(3);
  });

  it('⚠️ 撞上限时 truncated 要立起来（界面上的横幅靠它）', () => {
    const h = harness();
    h.store.setUrl('https://x/y');
    script([started(), chunk('abc'), { kind: 'finished', bytes: 3, truncated: true, totalMillis: 5 }]);
    h.store.send();
    expect(h.store.getSnapshot().response.truncated).toBe(true);
  });

  it('failed → 定格成 failed，正文留着（断之前收到的那半截）', () => {
    const h = harness();
    h.store.setUrl('https://x/y');
    script([started(), chunk('半截'), { kind: 'failed', errorKind: 'body', message: '断了', bytes: 6 }]);
    h.store.send();

    const r = h.store.getSnapshot().response;
    expect(r.phase).toBe('failed');
    expect(r.text).toBe('半截');
    expect(r.error).toEqual({ errorKind: 'body', message: '断了', bytes: 6 });
  });

  it('一个字节都没来就失败（连不上）', () => {
    const h = harness();
    h.store.setUrl('https://x/y');
    script([{ kind: 'failed', errorKind: 'connect', message: '连不上', bytes: 0 }]);
    h.store.send();

    const r = h.store.getSnapshot().response;
    expect(r.phase).toBe('failed');
    expect(r.head).toBeNull();
    expect(r.error?.errorKind).toBe('connect');
  });
});

describe('历史', () => {
  it('成功的一条记下来了（方法、地址、状态码、耗时）', () => {
    const h = harness();
    h.store.setUrl('https://x/y');
    h.store.setMethod('PUT');
    script([started(201), chunk('ok'), { kind: 'finished', bytes: 2, truncated: false, totalMillis: 33 }]);
    h.store.send();

    const history = h.store.getSnapshot().history;
    expect(history).toHaveLength(1);
    expect(history[0]!.method).toBe('PUT');
    expect(history[0]!.url).toBe('https://x/y');
    expect(history[0]!.outcome).toEqual({ kind: 'ok', status: 201, totalMillis: 33, bytes: 2, truncated: false });
  });

  it('失败的一条也记（失败也是那次调用的结果）', () => {
    const h = harness();
    h.store.setUrl('https://x/y');
    script([{ kind: 'failed', errorKind: 'tls', message: '证书不对', bytes: 0 }]);
    h.store.send();

    const entry = h.store.getSnapshot().history[0]!;
    expect(entry.outcome.kind).toBe('failed');
  });

  it('发出去那一刻的内容进历史 —— 之后改编辑器不影响它', () => {
    const h = harness();
    h.store.setUrl('https://x/y');
    script([started(), { kind: 'finished', bytes: 0, truncated: false, totalMillis: 1 }]);
    h.store.send();
    h.store.setUrl('https://改过了');

    expect(h.store.getSnapshot().history[0]!.url).toBe('https://x/y');
  });

  it('⚠️ 点历史会把响应一起清掉（不清的话下面那条响应属于另一个请求）', () => {
    const h = harness();
    h.store.setUrl('https://x/y');
    script([started(), chunk('旧响应'), { kind: 'finished', bytes: 3, truncated: false, totalMillis: 1 }]);
    h.store.send();
    const id = h.store.getSnapshot().history[0]!.id;

    h.store.openHistory(id);

    expect(h.store.getSnapshot().draft.url).toBe('https://x/y');
    expect(h.store.getSnapshot().response.phase).toBe('idle');
    expect(h.store.getSnapshot().response.text).toBe('');
  });
});

describe('保存的请求', () => {
  it('存下来的是当时那份，之后改编辑器不影响它', () => {
    const h = harness();
    h.store.setUrl('https://x/y');
    expect(h.store.save('查用户')).toBe(true);
    h.store.setUrl('https://改过了');

    const saved = h.store.getSnapshot().saved[0]!;
    expect(saved.name).toBe('查用户');
    expect(saved.draft.url).toBe('https://x/y');
    expect(h.store.getSnapshot().selectedSavedId).toBe(saved.id);
  });

  it('名字空着存不了（界面上那个按钮也是灰的）', () => {
    const h = harness();
    h.store.setUrl('https://x/y');
    expect(h.store.save('   ')).toBe(false);
    expect(h.store.getSnapshot().saved).toEqual([]);
  });

  it('点保存的那条：装回编辑器，并把响应清掉', () => {
    const h = harness();
    h.store.setUrl('https://x/y');
    h.store.setBody('{"a":1}');
    h.store.save('查用户');
    const id = h.store.getSnapshot().saved[0]!.id;

    h.store.resetDraft();
    expect(h.store.getSnapshot().draft.body).toBe('');

    h.store.openSaved(id);
    expect(h.store.getSnapshot().draft.url).toBe('https://x/y');
    expect(h.store.getSnapshot().draft.body).toBe('{"a":1}');
    expect(h.store.getSnapshot().selectedSavedId).toBe(id);
  });

  it('删一条保存的请求', () => {
    const h = harness();
    h.store.setUrl('https://x/y');
    h.store.save('查用户');
    const id = h.store.getSnapshot().saved[0]!.id;

    h.store.removeSavedEntry(id);
    expect(h.store.getSnapshot().saved).toEqual([]);
    expect(h.store.getSnapshot().selectedSavedId).toBeNull();
  });
});

describe('页签', () => {
  it('选中的响应页签切得动，而且只在 store 里（切模块不丢）', () => {
    const h = harness();
    h.store.setResponseTab('headers');
    expect(h.store.getSnapshot().responseTab).toBe('headers');
  });

  it('发出新请求时响应页签回到「正文」（上一轮在看「跳转」的话会停在一个空页签上）', () => {
    const h = harness();
    h.store.setUrl('https://x/y');
    h.store.setResponseTab('redirects');
    script([started(), { kind: 'finished', bytes: 0, truncated: false, totalMillis: 1 }]);
    h.store.send();
    expect(h.store.getSnapshot().responseTab).toBe('body');
  });
});
