import { describe, expect, it } from 'vitest';
import {
  findKnownHost,
  forgetKnownHost,
  knownHostId,
  normalizeHost,
  rememberKnownHost,
  sanitizeKnownHosts,
  sortKnownHosts,
} from '../../src/modules/ssh/core/knownHosts';
import type { KnownHost } from '../../src/modules/ssh/core/types';

const NOW = '2026-09-18T00:00:00.000Z';

function host(patch: Partial<KnownHost> = {}): KnownHost {
  return {
    host: 'example.com',
    port: 22,
    algorithm: 'ssh-ed25519',
    fingerprint: 'SHA256:AAA',
    addedAt: NOW,
    ...patch,
  };
}

describe('normalizeHost', () => {
  it('去空白、转小写 —— DNS 名字大小写不敏感', () => {
    expect(normalizeHost('  Example.COM ')).toBe('example.com');
  });

  it('去掉 IPv6 的方括号', () => {
    // 地址栏里写 [::1]:22 是惯例，但存下来的是 ::1。
    // 不统一的话，填 [::1] 的人会拿不到自己之前存的那条记录
    expect(normalizeHost('[::1]')).toBe('::1');
    expect(normalizeHost('[2001:DB8::1]')).toBe('2001:db8::1');
  });

  it('没加方括号的 IPv6 原样留下', () => {
    expect(normalizeHost('::1')).toBe('::1');
  });
});

describe('findKnownHost', () => {
  it('按 host + port 找', () => {
    const list = [host()];
    expect(findKnownHost(list, 'example.com', 22)).not.toBeNull();
  });

  it('⚠️ 端口不同就是两台不同的机器 —— 只按 host 找会让它们互相冒充', () => {
    // 只要能让你连一次他那台跑在非常规端口上的机器，就能覆盖掉 22 端口的记录
    const list = [host({ port: 2222, fingerprint: 'SHA256:EVIL' })];
    expect(findKnownHost(list, 'example.com', 22)).toBeNull();
    expect(findKnownHost(list, 'example.com', 2222)?.fingerprint).toBe('SHA256:EVIL');
  });

  it('查找时不区分大小写和方括号', () => {
    const list = [host({ host: 'example.com' })];
    expect(findKnownHost(list, 'EXAMPLE.com', 22)).not.toBeNull();
  });

  it('没存过返回 null', () => {
    expect(findKnownHost([], 'example.com', 22)).toBeNull();
  });
});

describe('rememberKnownHost', () => {
  it('记一条新的', () => {
    const list = rememberKnownHost([], host(), NOW);
    expect(list).toHaveLength(1);
    expect(list[0]?.fingerprint).toBe('SHA256:AAA');
  });

  it('同一个 host:port 再记一次是**替换**而不是追加', () => {
    const first = rememberKnownHost([], host(), NOW);
    const second = rememberKnownHost(first, host({ fingerprint: 'SHA256:BBB' }), NOW);

    expect(second).toHaveLength(1);
    expect(second[0]?.fingerprint).toBe('SHA256:BBB');
  });

  it('端口不同是并存的记录', () => {
    const first = rememberKnownHost([], host(), NOW);
    const second = rememberKnownHost(first, host({ port: 2222 }), NOW);
    expect(second).toHaveLength(2);
  });

  it('存进去的 host 是规范化过的', () => {
    const list = rememberKnownHost([], host({ host: '  [::1] ' }), NOW);
    expect(list[0]?.host).toBe('::1');
  });
});

describe('forgetKnownHost', () => {
  it('按 host + port 删，别的端口不受影响', () => {
    const list = [host(), host({ port: 2222 })];
    const after = forgetKnownHost(list, 'example.com', 22);

    expect(after).toHaveLength(1);
    expect(after[0]?.port).toBe(2222);
  });

  it('删一个不存在的不报错', () => {
    expect(forgetKnownHost([host()], 'nope', 22)).toHaveLength(1);
  });
});

describe('sanitizeKnownHosts', () => {
  it('不是数组就当空的', () => {
    expect(sanitizeKnownHosts(null)).toEqual([]);
    expect(sanitizeKnownHosts({})).toEqual([]);
    expect(sanitizeKnownHosts('x')).toEqual([]);
  });

  it('丢掉没有 host 或者没有指纹的记录', () => {
    const raw = [
      { host: 'a.com', port: 22, fingerprint: 'SHA256:AAA' },
      { host: '', port: 22, fingerprint: 'SHA256:BBB' },
      { host: 'c.com', port: 22, fingerprint: '' },
      'garbage',
    ];
    const list = sanitizeKnownHosts(raw);

    expect(list).toHaveLength(1);
    expect(list[0]?.host).toBe('a.com');
  });

  it('⚠️ 空指纹必须丢掉 —— 留着等于留一条「不用比对就通过」的记录', () => {
    // 判定逻辑里空指纹永远匹配不上，但它会**占住 host:port 这个键**，
    // 让用户以为这台机器已经信任过了
    const list = sanitizeKnownHosts([{ host: 'a.com', port: 22, fingerprint: '   ' }]);
    expect(list).toEqual([]);
  });

  it('坏记录不连坐：一条坏了别的照样恢复', () => {
    const raw = [
      null,
      { host: 'a.com', port: 22, fingerprint: 'SHA256:AAA' },
      { host: 'b.com', port: 22, fingerprint: 'SHA256:BBB' },
    ];
    expect(sanitizeKnownHosts(raw)).toHaveLength(2);
  });

  it('端口不合法就回落到 22', () => {
    const list = sanitizeKnownHosts([{ host: 'a.com', port: 0, fingerprint: 'SHA256:AAA' }]);
    expect(list[0]?.port).toBe(22);
  });

  it('host 会被规范化', () => {
    const list = sanitizeKnownHosts([{ host: ' Example.COM ', port: 22, fingerprint: 'S' }]);
    expect(list[0]?.host).toBe('example.com');
  });
});

describe('knownHostId', () => {
  it('给测试用的 id 里不会有冒号 —— 冒号在 CSS 选择器里要转义', () => {
    expect(knownHostId('example.com', 22)).toBe('example.com_22');
  });
});

describe('sortKnownHosts', () => {
  it('先按主机名再按端口', () => {
    const list = sortKnownHosts([
      host({ host: 'b.com' }),
      host({ host: 'a.com', port: 2222 }),
      host({ host: 'a.com', port: 22 }),
    ]);
    expect(list.map((h) => `${h.host}:${h.port}`)).toEqual([
      'a.com:22',
      'a.com:2222',
      'b.com:22',
    ]);
  });
});
