/**
 * 外壳 store 的单例。
 *
 * 单独一个文件是为了打断循环依赖：AppShell 要用它，ModuleRail 也要用它，
 * 而 registry 又要 import 各模块 —— 如果实例和类型放在一起会绕成环。
 * 这里只 import 类型，不 import 任何模块。
 */

import { ShellStore } from './store';
import { MODULES, moduleIdFromHash } from './registry';

/**
 * 初始模块：`#<module>` 优先（多窗口：新窗口带 hash 落在指定模块），
 * 认不出来回落第一个。⚠️ **必须在 render 之前定好**，否则会先画一帧
 * 第一个模块再跳过去（那一下是看得见的闪烁）。
 *
 * `typeof window` 守卫是给 vitest（node 环境）的：这个文件可能被纯逻辑
 * 测试间接 import，那里没有 window。
 */
const initial =
  (typeof window !== 'undefined' ? moduleIdFromHash(window.location.hash) : null) ??
  MODULES[0]?.id ??
  '';

export const shellStore = new ShellStore(initial);
