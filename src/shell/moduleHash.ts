/**
 * `location.hash` 里那个模块名的解析。
 *
 * 单独一个**零 import** 的文件：registry 会把全部模块拉起来（这里面有浏览器
 * 专属的东西），而这段纯解析要在 node 环境的 vitest 里直接测。
 * 「这个 id 是不是注册表里真的有一个」的校验在 registry 的
 * `moduleIdFromHash` 里做（那半的回归由 e2e 的 `/#nope` 用例钉着）。
 */

/** 取 `#` 之后、`?` 之前的那截并 trim；空的话返回 null。 */
export function parseModuleHash(hash: string): string | null {
  const raw = hash.replace(/^#/, '').split('?')[0] ?? '';
  const id = raw.trim();
  return id === '' ? null : id;
}
