/**
 * SQL 连接档案的默认值与校验。
 *
 * 纯函数，不碰平台也不碰 store —— 表单和高亮哪一项写错了都靠它。
 */

import { nextAvailableName } from '../../../shared/connections/profiles';
import { newId } from '../../../shared/ids';
import { DEFAULT_PORT, type ConnectParams, type SqlKind, type SqlProfile } from './types';

export type ProfileField = 'name' | 'host' | 'port' | 'username' | 'database';

export type ProfileErrors = Partial<Record<ProfileField, string>>;

const MAX_NAME_LENGTH = 60;

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_USER = 'postgres';

/** 新建一个连接档案，名字自动去重 */
export function newProfile(existing: readonly SqlProfile[], kind: SqlKind = 'postgres'): SqlProfile {
  return {
    id: newId('sql'),
    name: nextAvailableName(
      existing.map((p) => p.name),
      kind === 'mysql' ? '新建 MySQL 连接' : '新建 PostgreSQL 连接',
    ),
    kind,
    host: DEFAULT_HOST,
    port: DEFAULT_PORT[kind],
    username: kind === 'mysql' ? 'root' : DEFAULT_USER,
    database: kind === 'mysql' ? '' : 'postgres',
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

  if (profile.username.trim() === '') {
    errors.username = '用户名不能为空';
  }

  if (profile.kind === 'postgres' && profile.database.trim() === '') {
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

  const oldDefaultUser = profile.kind === 'mysql' ? 'root' : DEFAULT_USER;
  if (profile.username.trim() === oldDefaultUser) {
    next.username = kind === 'mysql' ? 'root' : DEFAULT_USER;
  }

  // PostgreSQL 必须有库名，空着就补一个常见的默认值
  if (kind === 'postgres' && profile.database.trim() === '') {
    next.database = 'postgres';
  }

  return next;
}
