/**
 * 外壳 store 的单例。
 *
 * 单独一个文件是为了打断循环依赖：AppShell 要用它，ModuleRail 也要用它，
 * 而 registry 又要 import 各模块 —— 如果实例和类型放在一起会绕成环。
 * 这里只 import 类型，不 import 任何模块。
 */

import { ShellStore } from './store';
import { MODULES } from './registry';

export const shellStore = new ShellStore(MODULES[0]?.id ?? '');
