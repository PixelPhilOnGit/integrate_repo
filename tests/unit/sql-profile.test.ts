import { beforeEach, describe, expect, it } from 'vitest';
import { __resetIdsForTest } from '../../src/shared/ids';
import {
  applyKindSwitch,
  applyNewDialogKindSwitch,
  hasErrors,
  newProfile,
  sameConnection,
  toConnectParams,
  validateProfile,
} from '../../src/modules/sql/core/profile';
import { DEFAULT_PORT, type SqlKind, type SqlProfile } from '../../src/modules/sql/core/types';

beforeEach(() => __resetIdsForTest());

function profile(patch: Partial<SqlProfile> = {}): SqlProfile {
  return {
    id: 'c1',
    name: '本地库',
    kind: 'postgres',
    host: '127.0.0.1',
    port: 5432,
    username: 'postgres',
    database: 'postgres',
    password: '',
    ...patch,
  };
}

describe('新建 SQL 连接档案', () => {
  it('默认值跟着引擎走', () => {
    const pg = newProfile([]);
    expect(pg.kind).toBe('postgres');
    expect(pg.port).toBe(5432);
    expect(pg.username).toBe('postgres');
    expect(pg.database).toBe('postgres');

    const my = newProfile([], 'mysql');
    expect(my.kind).toBe('mysql');
    expect(my.port).toBe(3306);
    expect(my.username).toBe('root');
    // MySQL 可以不指定库
    expect(my.database).toBe('');
  });

  it('名字按引擎区分，而且去重', () => {
    const a = newProfile([], 'mysql');
    const b = newProfile([a], 'mysql');
    expect(a.name).toBe('新建 MySQL 连接');
    expect(b.name).toBe('新建 MySQL 连接 2');
    expect(newProfile([], 'postgres').name).toBe('新建 PostgreSQL 连接');
  });
});

describe('SQL 连接档案校验', () => {
  it('正常档案没有错误', () => {
    expect(hasErrors(validateProfile(profile()))).toBe(false);
  });

  /**
   * 这条是一条**容易漏**的规则：PostgreSQL 一个连接绑一个库，库名不填的话
   * 驱动会拿用户名当库名，报出来的错跟「库名没填」毫无关系。
   */
  it('PostgreSQL 必须填库名，MySQL 不用', () => {
    expect(validateProfile(profile({ kind: 'postgres', database: '' })).database).toContain(
      '必须指定库名',
    );
    expect(validateProfile(profile({ kind: 'mysql', database: '' })).database).toBeUndefined();
  });

  it('端口要在 1–65535', () => {
    for (const port of [0, -1, 65536, 3.5, NaN]) {
      expect(validateProfile(profile({ port })).port, `端口 ${port}`).toBeDefined();
    }
    expect(validateProfile(profile({ port: 1 })).port).toBeUndefined();
    expect(validateProfile(profile({ port: 65535 })).port).toBeUndefined();
  });

  it('名字、主机、用户名都不能为空', () => {
    const errors = validateProfile(profile({ name: ' ', host: '', username: '' }));
    expect(Object.keys(errors).sort()).toEqual(['host', 'name', 'username']);
  });
});

describe('切引擎时跟着换的默认值', () => {
  it('用户没动过的端口会跟着换', () => {
    const pg = profile();
    expect(applyKindSwitch(pg, 'mysql').port).toBe(3306);
  });

  /**
   * 只换**用户没动过**的字段。用户特意改成 15432 之后切引擎，
   * 程序不该把他的设置冲掉 —— 那会显得像在跟用户抢方向盘。
   */
  it('用户改过的端口不跟着换', () => {
    const custom = profile({ port: 15432 });
    expect(applyKindSwitch(custom, 'mysql').port).toBe(15432);
  });

  it('用户名同理', () => {
    expect(applyKindSwitch(profile(), 'mysql').username).toBe('root');
    expect(applyKindSwitch(profile({ username: '我的账号' }), 'mysql').username).toBe('我的账号');
  });

  it('切到 PostgreSQL 时补一个默认库名', () => {
    const my = profile({ kind: 'mysql', database: '' });
    expect(applyKindSwitch(my, 'postgres').database).toBe('postgres');
  });

  it('切引擎不动名字和密码', () => {
    const next = applyKindSwitch(profile({ password: 'secret' }), 'mysql');
    expect(next.name).toBe('本地库');
    expect(next.password).toBe('secret');
  });

  it('默认端口表覆盖两种引擎', () => {
    expect(DEFAULT_PORT.postgres).toBe(5432);
    expect(DEFAULT_PORT.mysql).toBe(3306);
  });
});

/**
 * ⚠️ 弹框里换引擎和**右侧表单里**换引擎不是一回事 —— 差别只在**名字**上。
 *
 * 右侧表单：用户已经把连接起名叫「生产库」了，换个引擎不该被改名（上面那条
 * 「切引擎不动名字」钉着）。弹框：名字多半还没被人碰过，不换的话会建出一个
 * 叫「新建 PostgreSQL 连接」的 MySQL 连接。
 */
describe('弹框里换引擎（applyNewDialogKindSwitch）', () => {
  /** 弹框里的草稿：就是 `newProfile` 造出来的那份（名字已按引擎预填） */
  const draft = (kind: SqlKind = 'postgres'): SqlProfile => newProfile([], kind);

  it('名字还停在默认名时，跟着换成新引擎的', () => {
    const next = applyNewDialogKindSwitch([], draft('postgres'), 'mysql');
    expect(next.name).toBe('新建 MySQL 连接');
    // 端口那些照旧走 applyKindSwitch 的规则
    expect(next.port).toBe(3306);
  });

  it('⚠️ 名字被用户改过就一个字都不动', () => {
    const custom: SqlProfile = { ...draft('postgres'), name: '生产库' };
    const next = applyNewDialogKindSwitch([], custom, 'mysql');
    expect(next.name).toBe('生产库');
    // 但端口照旧联动 —— 判据是同一条「只看那个字段有没有被用户动过」
    expect(next.port).toBe(3306);
  });

  it('换过去的默认名也要去重', () => {
    // 已经有一条「新建 MySQL 连接」了
    const existing: SqlProfile[] = [{ ...draft('mysql'), id: 'x' }];
    const next = applyNewDialogKindSwitch(existing, draft('postgres'), 'mysql');
    expect(next.name).toBe('新建 MySQL 连接 2');
  });

  it('同一个引擎返回同一个引用', () => {
    // 调用方多半在 setState 里 —— 白造一个对象会让它以为状态变了
    const d = draft('postgres');
    expect(applyNewDialogKindSwitch([], d, 'postgres')).toBe(d);
  });

  it('⚠️ 去重过的默认名也算默认名 ——「新建 PostgreSQL 连接 2」也要跟着换', () => {
    // ⚠️ 这条盯的是判据的**宽度**。一开始写的是全等比较，于是第二条连接换引擎时
    // 名字不跟着换（它被去重成「新建 PostgreSQL 连接 **2**」，和默认名不全等）——
    // 症状是一个名字里写着 PostgreSQL 的 MySQL 连接。e2e 抓出来的。
    const second = newProfile([{ ...draft('postgres'), id: 'x' }], 'postgres');
    expect(second.name).toBe('新建 PostgreSQL 连接 2');

    const next = applyNewDialogKindSwitch([], second, 'mysql');
    expect(next.name).toBe('新建 MySQL 连接');
  });
});

describe('档案 → 连接参数', () => {
  it('名字不往后端传，首尾空白去掉', () => {
    const params = toConnectParams(profile({ host: '  10.0.0.1  ', database: ' mydb ' }));
    expect(params).toEqual({
      id: 'c1',
      kind: 'postgres',
      host: '10.0.0.1',
      port: 5432,
      username: 'postgres',
      password: '',
      database: 'mydb',
    });
    expect('name' in params).toBe(false);
  });
});

describe('连接参数是否变过', () => {
  it('引擎和连接字段变了就算变了', () => {
    const base = profile();
    expect(sameConnection(base, { ...base })).toBe(true);
    expect(sameConnection(base, { ...base, kind: 'mysql' })).toBe(false);
    expect(sameConnection(base, { ...base, host: 'other' })).toBe(false);
    expect(sameConnection(base, { ...base, database: 'other' })).toBe(false);
    expect(sameConnection(base, { ...base, password: 'x' })).toBe(false);
  });

  it('只改名字不算', () => {
    const base = profile();
    expect(sameConnection(base, { ...base, name: '换个名字' })).toBe(true);
  });
});
