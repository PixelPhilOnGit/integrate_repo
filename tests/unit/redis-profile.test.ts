import { beforeEach, describe, expect, it } from 'vitest';
import { __resetIdsForTest } from '../../src/shared/ids';
import {
  DEFAULT_DB,
  DEFAULT_HOST,
  DEFAULT_PORT,
  hasErrors,
  newProfile,
  sameConnection,
  toConnectParams,
  validateProfile,
} from '../../src/modules/redis/core/profile';
import type { ConnectionProfile } from '../../src/modules/redis/core/types';

beforeEach(() => __resetIdsForTest());

function profile(patch: Partial<ConnectionProfile> = {}): ConnectionProfile {
  return {
    id: 'c1',
    name: '本地',
    host: '127.0.0.1',
    port: 6379,
    db: 0,
    username: '',
    password: '',
    ...patch,
  };
}

describe('新建连接档案', () => {
  it('默认值指向本机', () => {
    const p = newProfile([]);
    expect(p.host).toBe(DEFAULT_HOST);
    expect(p.port).toBe(DEFAULT_PORT);
    expect(p.db).toBe(DEFAULT_DB);
    expect(p.username).toBe('');
    expect(p.password).toBe('');
  });

  it('id 是唯一的', () => {
    const a = newProfile([]);
    const b = newProfile([]);
    expect(a.id).not.toBe(b.id);
  });

  it('名字自动去重', () => {
    const first = newProfile([]);
    const second = newProfile([first]);
    const third = newProfile([first, second]);

    expect(first.name).toBe('新建连接');
    expect(second.name).toBe('新建连接 2');
    expect(third.name).toBe('新建连接 3');
  });

  it('已有档案改名之后，原来的名字可以被重新占用', () => {
    const first = newProfile([]);
    const renamed = { ...first, name: '改过的名字' };
    expect(newProfile([renamed]).name).toBe('新建连接');
  });
});

describe('连接档案校验', () => {
  it('正常档案没有错误', () => {
    expect(hasErrors(validateProfile(profile()))).toBe(false);
  });

  it('名字不能为空，也不能太长', () => {
    expect(validateProfile(profile({ name: '' })).name).toContain('不能为空');
    expect(validateProfile(profile({ name: '   ' })).name).toContain('不能为空');
    expect(validateProfile(profile({ name: 'x'.repeat(61) })).name).toContain('不能超过');
    // 刚好 60 个字是合法的
    expect(validateProfile(profile({ name: 'x'.repeat(60) })).name).toBeUndefined();
  });

  it('主机名不能为空', () => {
    expect(validateProfile(profile({ host: '' })).host).toContain('不能为空');
    expect(validateProfile(profile({ host: '  ' })).host).toContain('不能为空');
  });

  it('端口要是 1–65535 的整数', () => {
    expect(validateProfile(profile({ port: 0 })).port).toBeDefined();
    expect(validateProfile(profile({ port: -1 })).port).toBeDefined();
    expect(validateProfile(profile({ port: 65536 })).port).toBeDefined();
    expect(validateProfile(profile({ port: 3.5 })).port).toBeDefined();
    expect(validateProfile(profile({ port: NaN })).port).toBeDefined();

    expect(validateProfile(profile({ port: 1 })).port).toBeUndefined();
    expect(validateProfile(profile({ port: 65535 })).port).toBeUndefined();
    expect(validateProfile(profile({ port: 6379 })).port).toBeUndefined();
  });

  it('库号只要非负整数，**不校验上界**', () => {
    // Redis 的 databases 是可配的（默认 16，也能配成 256），
    // 前端写死 0–15 会在别人的服务器上误伤。越界的库号交给服务端报错。
    expect(validateProfile(profile({ db: -1 })).db).toBeDefined();
    expect(validateProfile(profile({ db: 1.5 })).db).toBeDefined();
    expect(validateProfile(profile({ db: NaN })).db).toBeDefined();

    expect(validateProfile(profile({ db: 0 })).db).toBeUndefined();
    expect(validateProfile(profile({ db: 15 })).db).toBeUndefined();
    expect(validateProfile(profile({ db: 99 })).db).toBeUndefined();
  });

  it('多个字段可以同时报错', () => {
    const errors = validateProfile(profile({ name: '', host: '', port: 0, db: -1 }));
    expect(Object.keys(errors).sort()).toEqual(['db', 'host', 'name', 'port']);
  });
});

describe('档案 → 连接参数', () => {
  it('只带连接需要的东西，名字不往后端传', () => {
    const params = toConnectParams(profile({ name: '我的连接', host: '  10.0.0.1  ' }));
    expect(params).toEqual({
      id: 'c1',
      host: '10.0.0.1', // 首尾空白去掉
      port: 6379,
      db: 0,
      username: '',
      password: '',
    });
    expect('name' in params).toBe(false);
  });
});

describe('连接参数是否变过', () => {
  it('连接相关的字段变了就算变了', () => {
    const base = profile();
    expect(sameConnection(base, { ...base })).toBe(true);

    expect(sameConnection(base, { ...base, host: 'other' })).toBe(false);
    expect(sameConnection(base, { ...base, port: 6380 })).toBe(false);
    expect(sameConnection(base, { ...base, db: 1 })).toBe(false);
    expect(sameConnection(base, { ...base, password: 'secret' })).toBe(false);
    expect(sameConnection(base, { ...base, username: 'u' })).toBe(false);
  });

  it('只改名字不算连接参数变化', () => {
    const base = profile();
    expect(sameConnection(base, { ...base, name: '换个名字' })).toBe(true);
  });

  it('主机名首尾空白不算变化', () => {
    const base = profile();
    expect(sameConnection(base, { ...base, host: '  127.0.0.1  ' })).toBe(true);
  });
});
