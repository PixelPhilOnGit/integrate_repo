/**
 * SQL 连接档案的默认值与校验。
 *
 * 纯函数，不碰平台也不碰 store —— 表单和高亮哪一项写错了都靠它。
 */

import { isDefaultName, nextAvailableName } from '../../../shared/connections/profiles';
import { newId } from '../../../shared/ids';
import { DEFAULT_PORT, type ConnectParams, type SqlKind, type SqlProfile } from './types';

export type ProfileField = 'name' | 'host' | 'port' | 'username' | 'database';

export type ProfileErrors = Partial<Record<ProfileField, string>>;

const MAX_NAME_LENGTH = 60;

export const DEFAULT_HOST = '127.0.0.1';

/**
 * 每种引擎的默认值。
 *
 * ⚠️ **表驱动**，不是一串三元表达式：四个引擎之后，`kind === 'mysql' ? 'root' : …`
 * 那种写法每加一个引擎就要改五处，漏一处**不报错**、只是默认值变得莫名其妙。
 */
const DEFAULT_USER: Record<SqlKind, string> = {
  postgres: 'postgres',
  mysql: 'root',
  // ClickHouse 的默认用户就叫 default
  clickhouse: 'default',
  // Mongo 本地跑通常不开鉴权，别硬塞一个用户名进去
  mongodb: '',
};

const DEFAULT_DATABASE: Record<SqlKind, string> = {
  postgres: 'postgres',
  mysql: '',
  clickhouse: '',
  mongodb: '',
};

const DEFAULT_NAME: Record<SqlKind, string> = {
  postgres: '新建 PostgreSQL 连接',
  mysql: '新建 MySQL 连接',
  clickhouse: '新建 ClickHouse 连接',
  mongodb: '新建 MongoDB 连接',
};

/**
 * 哪种引擎**必须**填库名。
 *
 * 只有 PostgreSQL：它一个连接绑一个库，不填的话驱动会拿用户名当库名，
 * 报出来的错跟「库名没填」毫无关系。其余几种都能连上去再选。
 */
const DATABASE_REQUIRED: ReadonlySet<SqlKind> = new Set<SqlKind>(['postgres']);

/** 哪种引擎**必须**填用户名。Mongo 不要求（本地开发常常不开鉴权） */
const USERNAME_REQUIRED: ReadonlySet<SqlKind> = new Set<SqlKind>([
  'postgres',
  'mysql',
  'clickhouse',
]);

/** 新建一个连接档案，名字自动去重 */
export function newProfile(existing: readonly SqlProfile[], kind: SqlKind = 'postgres'): SqlProfile {
  return {
    id: newId('sql'),
    name: nextAvailableName(
      existing.map((p) => p.name),
      DEFAULT_NAME[kind],
    ),
    kind,
    host: DEFAULT_HOST,
    port: DEFAULT_PORT[kind],
    username: DEFAULT_USER[kind],
    database: DEFAULT_DATABASE[kind],
    // ⚠️ 明文密码，见 shared/connections/profiles.ts 的 TODO(security)
    password: '',
  };
}

/**
 * 校验。
 *
 * **PostgreSQL 的库名是必填的**：它一个连接绑一个库，不填的话驱动会拿用户名
 * 当库名，报出来的错跟「库名没填」毫无关系，用户根本猜不到。MySQL 可以不填。
 */
export function validateProfile(profile: SqlProfile): ProfileErrors {
  const errors: ProfileErrors = {};

  if (profile.name.trim() === '') {
    errors.name = '名字不能为空';
  } else if (profile.name.trim().length > MAX_NAME_LENGTH) {
    errors.name = `名字不能超过 ${MAX_NAME_LENGTH} 个字`;
  }

  if (profile.host.trim() === '') {
    errors.host = '主机名不能为空';
  }

  if (!Number.isInteger(profile.port) || profile.port < 1 || profile.port > 65535) {
    errors.port = '端口要是 1–65535 之间的整数';
  }

  if (USERNAME_REQUIRED.has(profile.kind) && profile.username.trim() === '') {
    errors.username = '用户名不能为空';
  }

  if (DATABASE_REQUIRED.has(profile.kind) && profile.database.trim() === '') {
    errors.database = 'PostgreSQL 必须指定库名（它一个连接绑一个库）';
  }

  return errors;
}

export function hasErrors(errors: ProfileErrors): boolean {
  return Object.keys(errors).length > 0;
}

export function toConnectParams(profile: SqlProfile): ConnectParams {
  return {
    id: profile.id,
    kind: profile.kind,
    host: profile.host.trim(),
    port: profile.port,
    username: profile.username.trim(),
    password: profile.password,
    database: profile.database.trim(),
  };
}

/** 两个档案的**连接相关**字段是否一致（用来判断改了参数之后要不要提示重连） */
export function sameConnection(a: SqlProfile, b: SqlProfile): boolean {
  return (
    a.kind === b.kind &&
    a.host.trim() === b.host.trim() &&
    a.port === b.port &&
    a.username.trim() === b.username.trim() &&
    a.database.trim() === b.database.trim() &&
    a.password === b.password
  );
}

/**
 * 切引擎时要跟着改的默认值。
 *
 * 只改「用户没自己动过」的字段：端口还是旧引擎的默认端口、用户名还是旧默认，
 * 才跟着换。用户改过的一律不动 —— 那样会显得程序在跟他抢方向盘。
 */
export function applyKindSwitch(profile: SqlProfile, kind: SqlKind): SqlProfile {
  const next: SqlProfile = { ...profile, kind };

  if (profile.port === DEFAULT_PORT[profile.kind]) {
    next.port = DEFAULT_PORT[kind];
  }

  const oldDefaultUser = DEFAULT_USER[profile.kind];
  if (profile.username.trim() === oldDefaultUser) {
    next.username = DEFAULT_USER[kind];
  }

  // 新引擎要求填库名、而旧引擎留下的值是空 → 补一个默认
  if (DATABASE_REQUIRED.has(kind) && profile.database.trim() === '') {
    next.database = DEFAULT_DATABASE[kind];
  }

  return next;
}

/**
 * 「新建连接」弹框里换引擎：`applyKindSwitch` 之上，**名字也跟着换**。
 *
 * 为什么要单独加一条名字规则：`applyKindSwitch` 刻意不动 `name` —— 那是给右侧
 * 表单用的，用户把连接起名叫「生产库」之后，换个引擎不该被改名。但弹框里的名字
 * 多半还没被人碰过，不换的话会建出一个叫「新建 PostgreSQL 连接」的 MySQL 连接。
 *
 * 判据和端口 / 用户名**是同一条**：只改用户没动过的。名字还停在旧引擎的默认名
 * 上（**含去重序号**，见 `isDefaultName`）才算「没动过」。
 *
 * ⚠️ 这个判据一开始写成了全等，于是第二条连接换引擎时名字不跟着换（它叫
 * 「新建 PostgreSQL 连接 **2**」，和默认名不全等）—— e2e 抓出来的。
 *
 * `existing` 是给名字去重用的 —— 换过去之后可能和已有的重名。
 */
export function applyNewDialogKindSwitch(
  existing: readonly SqlProfile[],
  draft: SqlProfile,
  kind: SqlKind,
): SqlProfile {
  // 同一个引擎：原样返回**同一个引用**（调用方多半在 setState 里，白造一个对象
  // 会让它以为状态变了）。
  if (draft.kind === kind) return draft;

  const next = applyKindSwitch(draft, kind);
  // ⚠️ 用 `isDefaultName` 而不是全等 —— 去重过的「新建 PostgreSQL 连接 2」
  // 也算默认名（判据写窄了的症状：第二条连接切成 MySQL 之后，名字还写着
  // PostgreSQL。见那个函数的注释）。
  if (!isDefaultName(draft.name, DEFAULT_NAME[draft.kind])) return next;

  return {
    ...next,
    name: nextAvailableName(
      existing.map((p) => p.name),
      DEFAULT_NAME[kind],
    ),
  };
}

/**
 * 新建时可以从外面带进来的字段（弹框收集到的那份）。
 *
 * ⚠️ **没有 `id`**：档案的 id 只该有一个来源（store 里的 `newId`）。弹框那份
 * 草稿档案自带一个 id，但那是给 React 当 key 用的，插进来时一律丢掉 ——
 * 两个来源意味着有一天会撞，而撞了**不报错**。
 *
 * ⚠️ **也没有 `kind`**：它以位置参数为准（见 `createProfile(kind, init)`），
 * 两个来源会打架。
 */
export type SqlProfileInit = Partial<Omit<SqlProfile, 'id' | 'kind'>>;
