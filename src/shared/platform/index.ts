/**
 * 平台入口：根据运行环境选实现。
 *
 * 编辑器只 import 这里的 platform，不关心自己跑在桌面窗口还是浏览器里。
 */

import type { Platform } from './types';
import { isTauri } from './detect';
import { createTauriPlatform } from './tauri';
import { createWebPlatform } from './web';

export const platform: Platform = isTauri()
  ? createTauriPlatform()
  : createWebPlatform();

export type { FileNode, Platform, Prefs } from './types';
export { describeError, EMPTY_PREFS } from './types';
export { configurePlatform, platformConfig, isListedFile } from './config';
export type { PlatformConfig, SeedFile } from './config';
export {
  basename,
  dirname,
  joinPath,
  sanitizeName,
  splitPath,
  stripExt,
  uniqueName,
} from './path';
