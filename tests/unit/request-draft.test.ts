/**
 * 草稿那块纯逻辑（`core/draft.ts`）。
 *
 * 这一组里最要紧的是三件事：
 * 1. **地址不补 `http://`**（补了就是一次悄悄的安全降级）；
 * 2. `readDraft` 对**坏数据**的态度（救能救的字段，一条坏数据不该白屏）；
 * 3. `cloneDraft` 是**深拷**（浅拷的话，存下来的那份会跟着编辑器一起变）。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { __resetIdsForTest } from '../../src/shared/ids';
import {
  blockerOf,
  canSend,
  cloneDraft,
  enabledHeaders,
  hasSensitiveHeaders,
  newDraft,
  readDraft,
  removeHeader,
  sameRequest,
  shortUrl,
  updateHeader,
  DEFAULT_OPTIONS,
} from '../../src/modules/request/core/draft';

beforeEach(() => __resetIdsForTest());

describe('新草稿的默认值', () => {
  it('默认是 GET + 三行空头 + 一套默认选项', () => {
    const d = newDraft();
    expect(d.method).toBe('GET');
    expect(d.url).toBe('');
    expect(d.body).toBe('');
    expect(d.headers).toHaveLength(3);
    expect(d.options).toEqual(DEFAULT_OPTIONS);
  });

  it('默认值必须和传输层那套一致（界面显示 30 秒就得真的等 30 秒）', () => {
    expect(DEFAULT_OPTIONS).toEqual({
      timeoutSecs: 30,
      idleTimeoutSecs: 90,
      followRedirects: false,
      maxRedirects: 5,
      acceptInvalidCerts: false,
    });
  });
});

describe('能不能发', () => {
  it('地址空着不能发，而且说的是「怎么才能发」', () => {
    const d = newDraft();
    expect(blockerOf(d)).toBe('先填一个地址');
  });

  it('⚠️ 不替用户补 http:// —— 补的话可能把 Authorization 发到明文上', () => {
    const d = { ...newDraft(), url: 'api.example.com/users' };
    expect(blockerOf(d)).toContain('http://');
    expect(canSend(d, false)).not.toBeNull();
  });

  it('http 和 https 都放行，大小写不敏感', () => {
    expect(blockerOf({ ...newDraft(), url: 'http://x/y' })).toBeNull();
    expect(blockerOf({ ...newDraft(), url: 'HTTPS://x/y' })).toBeNull();
  });

  it('已经有一个在跑的时候不能并发发第二个', () => {
    const d = { ...newDraft(), url: 'https://x/y' };
    expect(canSend(d, true)).toBe('上一个请求还没结束');
    expect(canSend(d, false)).toBeNull();
  });
});

describe('请求头那几行', () => {
  it('没启用的、名字空着的都不发出去', () => {
    const d = newDraft();
    const [a, b, c] = d.headers;
    let headers = updateHeader(d.headers, a!.id, { name: 'accept', value: 'application/json' });
    headers = updateHeader(headers, b!.id, { name: 'x-off', value: '1', enabled: false });
    headers = updateHeader(headers, c!.id, { name: '   ', value: '空名字' });
    expect(enabledHeaders({ ...d, headers })).toEqual([['accept', 'application/json']]);
  });

  it('名字两边的空格会被去掉（粘过来的头常带着空格）', () => {
    const d = newDraft();
    const first = d.headers[0]!;
    const headers = updateHeader(d.headers, first.id, { name: '  authorization  ', value: 'Bearer x' });
    expect(enabledHeaders({ ...d, headers })).toEqual([['authorization', 'Bearer x']]);
  });

  it('删到只剩一行时补一个空行（不然表格空着，用户不知道该点哪）', () => {
    let headers = newDraft().headers;
    for (const h of [...headers]) headers = removeHeader(headers, h.id);
    expect(headers).toHaveLength(1);
    expect(headers[0]!.name).toBe('');
  });

  it('改一个不存在的 id 时原样返回（不给每次击键都换一张表）', () => {
    const headers = newDraft().headers;
    expect(updateHeader(headers, '不存在', { name: 'x' })).toBe(headers);
  });
});

describe('两份草稿是不是同一个请求（历史去重靠它）', () => {
  const base = { ...newDraft(), url: 'https://x/y', method: 'post' };

  it('方法和地址都按**去掉大小写和空格**比', () => {
    expect(sameRequest(base, { ...base, method: 'POST ' })).toBe(true);
  });

  it('正文不一样就不是同一个', () => {
    expect(sameRequest(base, { ...base, body: 'x' })).toBe(false);
  });

  it('头行的 id 和顺序不参与比较（同一份请求换个顺序还是它）', () => {
    const a = { ...base, headers: [{ id: '1', name: 'A', value: '1', enabled: true }] };
    const b = { ...base, headers: [{ id: '99', name: 'a', value: '1', enabled: true }] };
    expect(sameRequest(a, b)).toBe(true);
  });

  it('关掉的头不算数（关掉一条头再发，是同一个请求）', () => {
    const a = { ...base, headers: [{ id: '1', name: 'A', value: '1', enabled: true }] };
    const b = { ...base, headers: [{ id: '1', name: 'A', value: '1', enabled: false }] };
    expect(sameRequest(a, b)).toBe(false);
  });
});

describe('凭据类的头（列表上那个 ⚠）', () => {
  it('认得出那几个常见的', () => {
    for (const name of ['authorization', 'Cookie', 'X-API-Key', 'x-auth-token']) {
      const d = { ...newDraft(), headers: [{ id: '1', name, value: 'x', enabled: true }] };
      expect(hasSensitiveHeaders(d)).toBe(true);
    }
  });

  it('普通头不算，关掉的也不算', () => {
    const d = {
      ...newDraft(),
      headers: [
        { id: '1', name: 'content-type', value: 'application/json', enabled: true },
        { id: '2', name: 'authorization', value: 'Bearer x', enabled: false },
      ],
    };
    expect(hasSensitiveHeaders(d)).toBe(false);
  });
});

describe('深拷', () => {
  it('改原来那份，拷出来的不受影响', () => {
    const d = { ...newDraft(), url: 'https://x/y', body: 'a' };
    const copy = cloneDraft(d);
    d.body = '改了';
    d.options.timeoutSecs = 999;
    d.headers[0]!.name = '改了';
    expect(copy.body).toBe('a');
    expect(copy.options.timeoutSecs).toBe(30);
    expect(copy.headers[0]!.name).toBe('');
  });
});

describe('从磁盘读回来', () => {
  it('一份正常的草稿读回来还是它', () => {
    const d = { ...newDraft(), url: 'https://x/y', method: 'PROPFIND' };
    const back = readDraft(d);
    expect(back?.url).toBe('https://x/y');
    expect(back?.method).toBe('PROPFIND');
    expect(back?.headers).toHaveLength(3);
  });

  it('不是对象 → null（这一条真的丢掉）', () => {
    expect(readDraft(null)).toBeNull();
    expect(readDraft('nope')).toBeNull();
  });

  it('字段坏了就用默认值，不整条丢掉', () => {
    const back = readDraft({ method: 42, url: null, headers: 'x', body: [], options: 7 });
    expect(back).not.toBeNull();
    expect(back?.method).toBe('GET');
    expect(back?.url).toBe('');
    // 一行都没有的话补一个空行 —— 不然「头」那一页是空的，用户没地方写
    expect(back?.headers).toHaveLength(1);
    expect(back?.body).toBe('');
    expect(back?.options).toEqual(DEFAULT_OPTIONS);
  });

  it('⚠️ 老数据里没有 enabled 字段时，默认是**启用**', () => {
    const back = readDraft({
      method: 'GET',
      url: 'https://x',
      headers: [{ id: 'h1', name: 'accept', value: '*/*' }],
      body: '',
      options: {},
    });
    expect(back?.headers[0]?.enabled).toBe(true);
  });

  it('数字选项被夹回合法范围（手改过库也不会传出个 NaN）', () => {
    const back = readDraft({
      options: { timeoutSecs: 99999, idleTimeoutSecs: -5, maxRedirects: 3.7, acceptInvalidCerts: 'yes' },
    });
    expect(back?.options.timeoutSecs).toBe(3600);
    expect(back?.options.idleTimeoutSecs).toBe(1);
    expect(back?.options.maxRedirects).toBe(4);
    // ⚠️ 真值只认 true —— 'yes' 这种真值字符串不算，宁可不关校验
    expect(back?.options.acceptInvalidCerts).toBe(false);
  });
});

describe('列表上那个地址', () => {
  it('短的原样，长的中间截掉', () => {
    expect(shortUrl('https://x/y')).toBe('https://x/y');
    const long = `https://x/${'a'.repeat(200)}`;
    const short = shortUrl(long);
    expect(short.length).toBeLessThanOrEqual(61);
    expect(short).toContain('…');
  });
});
