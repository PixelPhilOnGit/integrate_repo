/**
 * 连接档案的默认值与校验。
 *
 * 纯函数，不碰平台也不碰 store —— 表单和高亮哪一项写错了都靠它。
 */

import { newId } from '../../../shared/ids';
import type { ConnectParams, ConnectionProfile } from './types';

export type ProfileField = 'name' | 'host' | 'port' | 'db';

/** 字段名 → 中文错误。没有错误的字段不出现在结果里 */
export type ProfileErrors = Partial<Record<ProfileField, string>>;

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 6379;
export const DEFAULT_DB = 0;

const MAX_NAME_LENGTH = 60;

/** 新建一个连接档案，名字自动去重（「新建连接」「新建连接 2」……） */
export function newProfile(existing: readonly ConnectionProfile[]): ConnectionProfile {
  return {
    id: newId('conn'),
    name: nextAvailableName(existing),
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    db: DEFAULT_DB,
    username: '',
    // ⚠️ 明文密码，见 services/credentials.ts 的 TODO(security)
    password: '',
  };
}

function nextAvailableName(existing: readonly ConnectionProfile[]): string {
  const taken = new Set(existing.map((p) => p.name));
  const base = '新建连接';
  if (!taken.has(base)) return base;

  for (let n = 2; ; n += 1) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * 校验。
 *
 * 端口校验成 1–65535（这是 TCP 的硬约束）。**但 db 只校验「非负整数」，
 * 不校验上界** —— Redis 的 `databases` 是可配的（默认 16，也可以配成 1 或 256），
 * 写死 0–15 会在别人的服务器上误伤。越界的库号交给服务端报
 * `ERR DB index is out of range`，那是真相，顺便也让用户看到真实的错误。
 */
export function validateProfile(profile: ConnectionProfile): ProfileErrors {
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

  if (!Number.isInteger(profile.db) || profile.db < 0) {
    errors.db = '库号要是非负整数';
  }

  return errors;
}

export function hasErrors(errors: ProfileErrors): boolean {
  return Object.keys(errors).length > 0;
}

/**
 * 档案 → 连接参数。
 *
 * 名字是纯 UI 字段，不往后端传 —— 后端只关心怎么连上。
 */
export function toConnectParams(profile: ConnectionProfile): ConnectParams {
  return {
    id: profile.id,
    host: profile.host.trim(),
    port: profile.port,
    db: profile.db,
    username: profile.username,
    password: profile.password,
  };
}

/** 两个档案的**连接相关**字段是否一致（用来判断改了参数之后要不要提示重连） */
export function sameConnection(a: ConnectionProfile, b: ConnectionProfile): boolean {
  return (
    a.host.trim() === b.host.trim() &&
    a.port === b.port &&
    a.db === b.db &&
    a.username === b.username &&
    a.password === b.password
  );
}
