/**
 * 浏览器假实现走完整条链路（`core/fakeHttp.ts` 的计划 + `services/web.ts` 的驱动）。
 *
 * 这一组不碰 DOM：它验的是「e2e 里那套假服务器到底会吐出什么」。分工和
 * `agents-fake.test.ts` 一样 —— **e2e 管「画出来没有」，这里管每一环的语义**。
 *
 * 最要紧的是两条：**事件顺序**（started 必须在 chunk 之前，
 * finished/failed 必须是最后一条）和**断流时把已经收到的字节数带出来**。
 */

import { describe, expect, it } from 'vitest';
import { planFor } from '../../src/modules/request/core/fakeHttp';
import { createWebRequestClient, MAX_FORWARD_BYTES } from '../../src/modules/request/services/web';
import type { RequestEvent } from '../../src/modules/request/services/types';
import { DEFAULT_OPTIONS } from '../../src/modules/request/core/draft';

const client = createWebRequestClient();

interface SendInput {
  method?: string;
  url: string;
  headers?: Array<[string, string]>;
  body?: string;
  options?: Partial<typeof DEFAULT_OPTIONS>;
}

/** 发一次，把所有事件收齐（假的延迟最小 0ms，整条链路几十毫秒）。 */
async function collect(input: SendInput): Promise<RequestEvent[]> {
  const events: RequestEvent[] = [];
  await client.send({
    method: input.method ?? 'GET',
    url: input.url,
    headers: input.headers ?? [],
    body: input.body ?? '',
    options: { ...DEFAULT_OPTIONS, ...input.options },
    onEvent: (e) => events.push(e),
  });
  return events;
}

describe('消息的顺序', () => {
  it('started 在最前、chunk 在中间、finished 在最后', async () => {
    const events = await collect({ url: 'https://demo.example/json' });
    expect(events[0]?.kind).toBe('started');
    expect(events[events.length - 1]?.kind).toBe('finished');
    expect(events.filter((e) => e.kind === 'chunk').length).toBeGreaterThan(1);
  });

  it('连不上时只有一条 failed（没有 started）', async () => {
    const events = await collect({ url: 'https://unreachable.invalid/x' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'failed', errorKind: 'connect' });
  });

  it('地址不合法也是 failed，大类是 invalid', async () => {
    const events = await collect({ url: 'example.com/x' });
    expect(events[0]).toMatchObject({ kind: 'failed', errorKind: 'invalid' });
  });
});

describe('正文', () => {
  it('分块给（不是一次给完）—— 不然「流式」在 e2e 里永远测不到', async () => {
    const events = await collect({ url: 'https://demo.example/slow' });
    expect(events.filter((e) => e.kind === 'chunk')).toHaveLength(4);
  });

  it('一个汉字被切在两块之间也解得回来（假实现故意这么切）', async () => {
    const events = await collect({ url: 'https://demo.example/text' });
    const text = events
      .filter((e): e is Extract<RequestEvent, { kind: 'chunk' }> => e.kind === 'chunk')
      .map((e) => new TextDecoder().decode(Uint8Array.from(atob(e.base64), (c) => c.charCodeAt(0))))
      .join('');
    expect(text).toContain('阿德');
    expect(text).not.toContain('�');
  });

  it('HEAD 不带正文（按规矩）', async () => {
    const events = await collect({ method: 'HEAD', url: 'https://demo.example/anything' });
    expect(events.filter((e) => e.kind === 'chunk')).toHaveLength(0);
  });
});

describe('状态码', () => {
  it('500 也是**一条正常响应**（正文照收）', async () => {
    const events = await collect({ url: 'https://demo.example/error' });
    expect(events[0]).toMatchObject({ kind: 'started', status: 500 });
    expect(events[events.length - 1]?.kind).toBe('finished');
  });

  it('/secret 没带 authorization 就是 401，带了就是 200', async () => {
    const without = await collect({ url: 'https://demo.example/secret' });
    expect(without[0]).toMatchObject({ kind: 'started', status: 401 });

    const with_ = await collect({
      url: 'https://demo.example/secret',
      headers: [['authorization', 'Bearer x']],
    });
    expect(with_[0]).toMatchObject({ kind: 'started', status: 200 });
  });
});

describe('跳转', () => {
  it('不开跳转：302 原样交出来', async () => {
    const events = await collect({ url: 'https://demo.example/redirect' });
    expect(events[0]).toMatchObject({ kind: 'started', status: 302, redirects: [] });
  });

  it('开了跳转：落到 200，并且带着那条跳转记录', async () => {
    const events = await collect({
      url: 'https://demo.example/redirect',
      options: { followRedirects: true },
    });
    expect(events[0]).toMatchObject({
      kind: 'started',
      status: 200,
      redirects: [{ status: 302, from: 'https://demo.example/redirect', to: 'https://demo.example/json' }],
    });
  });

  it('绕圈：跟到上限就报 redirect', async () => {
    const events = await collect({
      url: 'https://demo.example/loop',
      options: { followRedirects: true, maxRedirects: 2 },
    });
    expect(events[0]).toMatchObject({ kind: 'failed', errorKind: 'redirect' });
  });
});

describe('证书', () => {
  it('自签证书的地址默认失败，大类是 tls', async () => {
    const events = await collect({ url: 'https://self-signed.local/api' });
    expect(events[0]).toMatchObject({ kind: 'failed', errorKind: 'tls' });
  });

  it('开了那个开关就通了', async () => {
    const events = await collect({
      url: 'https://self-signed.local/api',
      options: { acceptInvalidCerts: true },
    });
    expect(events[0]).toMatchObject({ kind: 'started', status: 200 });
  });
});

describe('读到一半断了', () => {
  it('带出**已经收到的字节数**（那半截正是调 SSE 时要看的）', async () => {
    const events = await collect({ url: 'https://demo.example/cut' });
    const chunks = events.filter((e) => e.kind === 'chunk');
    expect(chunks).toHaveLength(1);

    const last = events[events.length - 1];
    expect(last?.kind).toBe('failed');
    if (last?.kind === 'failed') {
      expect(last.errorKind).toBe('body');
      expect(last.bytes).toBeGreaterThan(0);
    }
  });
});

describe('转发上限', () => {
  it(`超过 ${MAX_FORWARD_BYTES} 字节就停手，并且标 truncated`, async () => {
    const events = await collect({ url: 'https://demo.example/big' });
    const last = events[events.length - 1];
    expect(last).toMatchObject({ kind: 'finished', truncated: true });
    // ⚠️ 交出去的字节数**不超过上限**（不是「读完再截」）
    const forwarded = events
      .filter((e): e is Extract<RequestEvent, { kind: 'chunk' }> => e.kind === 'chunk')
      .reduce((n, e) => n + atob(e.base64).length, 0);
    expect(forwarded).toBeLessThanOrEqual(MAX_FORWARD_BYTES);
    expect(forwarded).toBeGreaterThan(0);
  });
});

describe('计划本身（纯函数）', () => {
  it('默认那条路由回显这次请求（调接口时最有用的一种响应）', () => {
    const plan = planFor({
      method: 'POST',
      url: 'https://demo.example/api/users?page=2',
      headers: [['x-trace', 'abc']],
      body: '{"a":1}',
      options: { followRedirects: false, maxRedirects: 5, acceptInvalidCerts: false },
    });
    expect(plan.head?.status).toBe(200);
    const echoed = JSON.parse(plan.chunks.join('')) as {
      method: string;
      headers: Record<string, string>;
      body: string;
    };
    expect(echoed.method).toBe('POST');
    expect(echoed.headers['x-trace']).toBe('abc');
    expect(echoed.body).toBe('{"a":1}');
    expect(plan.chunks.join('')).toContain('page=2');
  });

  it('认不出来的地址形状直接失败（和传输层一样挑剔）', () => {
    const plan = planFor({
      method: 'GET',
      url: 'ftp://x/y',
      headers: [],
      body: '',
      options: { followRedirects: false, maxRedirects: 5, acceptInvalidCerts: false },
    });
    expect(plan.head).toBeNull();
    expect(plan.fail?.errorKind).toBe('invalid');
  });
});
