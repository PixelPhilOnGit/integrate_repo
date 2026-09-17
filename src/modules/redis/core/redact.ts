/**
 * 命令回显的脱敏。
 *
 * 命令台会把用户敲的命令原样记进日志，而 `AUTH mypassword` 这样一条命令
 * 就等于把密码写进了界面日志里（还可能被截图、被贴进 issue）。
 *
 * 这一层不解决「密码以明文落盘」那个已知妥协（那个见 `shared/connections/profiles.ts`），
 * 它解决的是**别让同一个密码再泄漏到第二个地方**。
 *
 * 规则：任何位置出现 `AUTH` 这个 token（大小写不敏感）之后的内容一律隐藏。
 * 这样 `AUTH user pass`、`HELLO 3 AUTH default pass` 都能覆盖 ——
 * 隐藏用户名的代价可以接受，漏掉密码不行。
 */

import { formatArgs } from './tokenize';

/** 被隐藏的部分显示成什么 */
export const REDACTED = '••••••';

/**
 * 把一条命令脱敏成可以记进日志的样子。
 *
 * @param args 已经分好词的命令（`args[0]` 是命令名）
 */
export function redactArgs(args: readonly string[]): string {
  const authAt = args.findIndex((arg) => arg.toUpperCase() === 'AUTH');

  if (authAt < 0) return formatArgs(args);

  // AUTH 本身还在（它是命令语义的一部分，藏着反而看不懂），之后的全隐掉
  const head = args.slice(0, authAt + 1);
  const hidden = args.length - authAt - 1;

  return hidden === 0 ? formatArgs(head) : `${formatArgs(head)} ${REDACTED}`;
}
