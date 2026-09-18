import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyAuthKindSwitch,
  addressOf,
  hasErrors,
  newProfile,
  sameConnection,
  toAuth,
  validateProfile,
} from '../../src/modules/ssh/core/profile';
import type { SshProfile } from '../../src/modules/ssh/core/types';
import { __resetIdsForTest } from '../../src/shared/ids';

beforeEach(() => __resetIdsForTest());

function profile(patch: Partial<SshProfile> = {}): SshProfile {
  return {
    id: 'c1',
    name: '本地',
    host: '127.0.0.1',
    port: 22,
    username: 'root',
    authKind: 'password',
    password: 'secret',
    privateKeyPath: '',
    passphrase: '',
    ...patch,
  };
}

describe('newProfile', () => {
  it('名字会去重 —— 连着新建两个不该都叫「新建 SSH 连接」', () => {
    const first = newProfile([]);
    const second = newProfile([first]);

    expect(first.name).toBe('新建 SSH 连接');
    expect(second.name).toBe('新建 SSH 连接 2');
  });

  it('默认值是一组能立刻用起来的参数', () => {
    const p = newProfile([]);
    expect(p.host).toBe('127.0.0.1');
    expect(p.port).toBe(22);
    expect(p.username).not.toBe('');
    expect(p.authKind).toBe('password');
  });

  it('每次给的 id 都不一样', () => {
    expect(newProfile([]).id).not.toBe(newProfile([]).id);
  });
});

describe('validateProfile', () => {
  it('填齐了就没错', () => {
    expect(hasErrors(validateProfile(profile()))).toBe(false);
  });

  it('名字、主机、用户名都不能空', () => {
    expect(validateProfile(profile({ name: '  ' })).name).toBeDefined();
    expect(validateProfile(profile({ host: '' })).host).toBeDefined();
    expect(validateProfile(profile({ username: ' ' })).username).toBeDefined();
  });

  it('端口要在 1–65535 之间', () => {
    expect(validateProfile(profile({ port: 0 })).port).toBeDefined();
    expect(validateProfile(profile({ port: 70000 })).port).toBeDefined();
    expect(validateProfile(profile({ port: 22.5 })).port).toBeDefined();
  });

  it('密码认证要求密码非空', () => {
    // 后端也会拦（空密码是 BadConfig），在这里先拦是为了少一次失败的往返
    expect(validateProfile(profile({ password: '' })).password).toBeDefined();
  });

  it('私钥认证要求路径非空，而且**不要求密码**', () => {
    const p = profile({ authKind: 'key', password: '', privateKeyPath: '' });
    const errors = validateProfile(p);

    expect(errors.privateKeyPath).toBeDefined();
    expect(errors.password).toBeUndefined();
  });

  it('私钥认证时口令可以空 —— 无口令的私钥很常见', () => {
    const p = profile({ authKind: 'key', password: '', privateKeyPath: '/k', passphrase: '' });
    expect(hasErrors(validateProfile(p))).toBe(false);
  });
});

describe('toAuth', () => {
  it('密码认证只带密码，不带私钥路径', () => {
    expect(toAuth(profile())).toEqual({ kind: 'password', password: 'secret' });
  });

  it('私钥认证只带路径和口令，**不带密码**', () => {
    const p = profile({ authKind: 'key', privateKeyPath: ' /k ', passphrase: 'pp' });
    expect(toAuth(p)).toEqual({ kind: 'key', privateKeyPath: '/k', passphrase: 'pp' });
  });
});

describe('sameConnection', () => {
  it('只有名字不一样时算同一套连接参数', () => {
    expect(sameConnection(profile(), profile({ name: '换个名字' }))).toBe(true);
  });

  it('主机、端口、用户名、凭据任一项变了就不算', () => {
    const base = profile();
    expect(sameConnection(base, profile({ host: 'other' }))).toBe(false);
    expect(sameConnection(base, profile({ port: 2222 }))).toBe(false);
    expect(sameConnection(base, profile({ username: 'dev' }))).toBe(false);
    expect(sameConnection(base, profile({ password: '别的' }))).toBe(false);
  });

  it('认证方式变了算变了', () => {
    expect(sameConnection(profile(), profile({ authKind: 'key' }))).toBe(false);
  });

  it('私钥路径和口令变了算变了', () => {
    const base = profile({ authKind: 'key', privateKeyPath: '/a' });
    expect(sameConnection(base, profile({ authKind: 'key', privateKeyPath: '/b' }))).toBe(false);
    expect(
      sameConnection(base, profile({ authKind: 'key', privateKeyPath: '/a', passphrase: 'x' })),
    ).toBe(false);
  });
});

describe('applyAuthKindSwitch', () => {
  it('切到私钥会**清掉密码** —— 那一份还会躺在磁盘上，不能让它留着', () => {
    const next = applyAuthKindSwitch(profile({ password: 'secret' }), 'key');
    expect(next.authKind).toBe('key');
    expect(next.password).toBe('');
  });

  it('切回密码会清掉私钥路径和口令', () => {
    const next = applyAuthKindSwitch(
      profile({ authKind: 'key', privateKeyPath: '/k', passphrase: 'pp' }),
      'password',
    );
    expect(next.authKind).toBe('password');
    expect(next.privateKeyPath).toBe('');
    expect(next.passphrase).toBe('');
  });

  it('切到同一种方式不动任何东西', () => {
    const p = profile({ password: 'secret' });
    expect(applyAuthKindSwitch(p, 'password')).toBe(p);
  });
});

describe('addressOf', () => {
  it('就是主机加端口', () => {
    expect(addressOf(profile({ host: 'example.com', port: 2222 }))).toBe('example.com:2222');
  });
});
