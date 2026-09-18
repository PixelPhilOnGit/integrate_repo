/**
 * SSH 连接档案的默认值与校验。
 *
 * 纯函数，不碰平台也不碰 store —— 表单校验和「改了参数要不要提示重连」都靠它。
 */

import { nextAvailableName } from '../../../shared/connections/profiles';
import { newId } from '../../../shared/ids';
import {
  DEFAULT_SSH_PORT,
  type SshAuth,
  type SshAuthKind,
  type SshProfile,
} from './types';

export type ProfileField =
  | 'name'
  | 'host'
  | 'port'
  | 'username'
  | 'password'
  | 'privateKeyPath';

export type ProfileErrors = Partial<Record<ProfileField, string>>;

const MAX_NAME_LENGTH = 60;

export const DEFAULT_HOST = '127.0.0.1';

/**
 * 默认用户名。
 *
 * 和 SQL 默认 `postgres` 是一个思路：给一个**最常见的**值，让「新建 → 连上」
 * 这条路上没有必须停下来填的坑。SSH 没有普适的默认用户，但对一个开发者工具
 * 来说 `root` 是命中率最高的那个（容器、虚拟机、树莓派、云主机）。
 * 填错了改一下就行，比每次都要手打一遍强。
 */
export const DEFAULT_USER = 'root';

/** 新建一个连接档案，名字自动去重 */
export function newProfile(
  existing: readonly SshProfile[],
  authKind: SshAuthKind = 'password',
): SshProfile {
  return {
    id: newId('ssh'),
    name: nextAvailableName(existing.map((p) => p.name), '新建 SSH 连接'),
    host: DEFAULT_HOST,
    port: DEFAULT_SSH_PORT,
    username: DEFAULT_USER,
    authKind,
    // ⚠️ 明文密码，见 shared/connections/profiles.ts 的 TODO(security)
    password: '',
    privateKeyPath: '',
    // ⚠️ 同上，私钥口令也是明文。它是第四个要搬进钥匙串的字段
    passphrase: '',
  };
}

/**
 * 校验。
 *
 * 只校验「本地的参数对不对」，**不校验能不能连上** —— 那是连接时的事。
 * 主机名写错、密钥路径写错都要等真去连才知道，不在这里假装能判断。
 */
export function validateProfile(profile: SshProfile): ProfileErrors {
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

  if (profile.authKind === 'key') {
    if (profile.privateKeyPath.trim() === '') {
      errors.privateKeyPath = '私钥文件路径不能为空';
    }
  } else if (profile.password === '') {
    // 后端也会拦这一条（空密码是 BadConfig）。在这里先拦住，
    // 用户就不用等一次失败的往返才知道
    errors.password = '密码不能为空（服务器允许空密码的情况请改用私钥）';
  }

  return errors;
}

export function hasErrors(errors: ProfileErrors): boolean {
  return Object.keys(errors).length > 0;
}

/** 档案里那部分「凭据」。终端尺寸、会话 id、信任状态都不来自档案 */
export function toAuth(profile: SshProfile): SshAuth {
  return profile.authKind === 'key'
    ? {
        kind: 'key',
        privateKeyPath: profile.privateKeyPath.trim(),
        passphrase: profile.passphrase,
      }
    : { kind: 'password', password: profile.password };
}

/** 侧栏那一行显示的地址 */
export function addressOf(profile: SshProfile): string {
  return `${profile.host}:${profile.port}`;
}

/**
 * 两个档案的**连接相关**字段是否一致。
 *
 * 用来判断「连上之后改了参数要不要提示重连」。名字不在比较范围内 ——
 * 改个名字不影响已经连上的会话。
 */
export function sameConnection(a: SshProfile, b: SshProfile): boolean {
  return (
    a.host.trim() === b.host.trim() &&
    a.port === b.port &&
    a.username.trim() === b.username.trim() &&
    a.authKind === b.authKind &&
    a.password === b.password &&
    a.privateKeyPath.trim() === b.privateKeyPath.trim() &&
    a.passphrase === b.passphrase
  );
}

/**
 * 换认证方式时要顺手清掉的东西。
 *
 * 和 SQL 的 `applyKindSwitch` 有个关键差别：那个是**保留**用户填过的值，
 * 这个是**清掉**另一边的凭据。
 *
 * 理由：切到私钥认证之后，档案里那份密码就再也不会被用到了，但它还在磁盘上
 * 躺着。用户以为「我改成密钥了，密码应该没了吧」而实际没有 —— 那是个
 * 安全上的意外，不只是洁癖问题。口令同理。
 *
 * 代价是切回来要重填。这个代价比「以为删了其实没删」小得多。
 */
export function applyAuthKindSwitch(
  profile: SshProfile,
  authKind: SshAuthKind,
): SshProfile {
  if (profile.authKind === authKind) return profile;

  return authKind === 'key'
    ? { ...profile, authKind, password: '' }
    : { ...profile, authKind, privateKeyPath: '', passphrase: '' };
}
