/**
 * Tauri 实现：调用 Rust command，使用系统对话框。
 *
 * 这里所有 Tauri 模块都用**动态 import**，而不是顶层静态 import。
 * 原因：静态 import 会把 Tauri 的模块打进浏览器那份产物里，而某些插件在模块
 * 顶层就会去访问 __TAURI_INTERNALS__，在纯浏览器里直接抛错。
 * 动态 import + 缓存既能保证浏览器路径完全不加载它们，又不会每次调用都重新解析。
 */

import type { FileNode, Platform, Prefs } from './types';
import { EMPTY_PREFS } from './types';

type CoreModule = typeof import('@tauri-apps/api/core');
type DialogModule = typeof import('@tauri-apps/plugin-dialog');
type StoreModule = typeof import('@tauri-apps/plugin-store');

let coreMod: Promise<CoreModule> | null = null;
let dialogMod: Promise<DialogModule> | null = null;
let storeMod: Promise<StoreModule> | null = null;

const core = (): Promise<CoreModule> => (coreMod ??= import('@tauri-apps/api/core'));
const dialog = (): Promise<DialogModule> => (dialogMod ??= import('@tauri-apps/plugin-dialog'));
const store = (): Promise<StoreModule> => (storeMod ??= import('@tauri-apps/plugin-store'));

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await core();
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    // Rust 侧返回的错误是字符串，包装成 Error 以便上层统一处理
    throw new Error(typeof e === 'string' ? e : String(e));
  }
}

let prefsStore: Promise<Awaited<ReturnType<StoreModule['load']>>> | null = null;
function prefs() {
  if (!prefsStore) {
    prefsStore = store().then((m) => m.load('prefs.json', { autoSave: true }));
  }
  return prefsStore;
}

export function createTauriPlatform(): Platform {
  return {
    kind: 'tauri',

    async pickWorkspace(): Promise<string | null> {
      const { open } = await dialog();
      const picked = await open({
        directory: true,
        multiple: false,
        title: '选择工作区目录',
      });
      if (Array.isArray(picked)) return picked[0] ?? null;
      return picked;
    },

    async confirm(message: string, title?: string): Promise<boolean> {
      const { confirm } = await dialog();
      // ask 已废弃，用 message 的 YesNo 按钮组合
      return confirm(message, {
        title: title ?? '请确认',
        kind: 'warning',
        okLabel: '确定',
        cancelLabel: '取消',
      });
    },

    async listTree(root: string): Promise<FileNode[]> {
      return call<FileNode[]>('list_tree', { root });
    },

    async readText(root: string, path: string): Promise<string> {
      return call<string>('read_text_file', { root, path });
    },

    async writeText(root: string, path: string, contents: string): Promise<void> {
      await call<void>('write_text_file', { root, path, contents });
    },

    async createDiagram(root: string, dir: string, name: string): Promise<string> {
      return call<string>('create_diagram', { root, dir, name });
    },

    async createFolder(root: string, dir: string, name: string): Promise<string> {
      return call<string>('create_folder', { root, dir, name });
    },

    async rename(root: string, path: string, newName: string): Promise<string> {
      return call<string>('rename_entry', { root, path, newName });
    },

    async remove(root: string, path: string): Promise<void> {
      await call<void>('delete_entry', { root, path });
    },

    async move(root: string, path: string, newDir: string): Promise<string> {
      return call<string>('move_entry', { root, path, newDir });
    },

    async exportFile(fileName: string, data: Uint8Array, mime: string): Promise<string | null> {
      const { save } = await dialog();
      const ext = fileName.split('.').pop() ?? 'bin';
      const target = await save({
        defaultPath: fileName,
        filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
      });
      if (!target) return null;
      // 关于二进制怎么过去的（结论来自 tauri 2.11.5 的 process-ipc-message-fn.js）：
      // 参数是「具名 record」时走 JSON 路径，其中的 Uint8Array 会被 Array.from()
      // 转成普通数字数组，serde 正好能把 JSON 序列反序列化成 Vec<u8>。
      // （只有整个 invoke 的 payload 都是 ArrayBuffer 时才走 octet-stream，
      //   而那种形态下带命名参数的命令反而会报错。）
      // 代价是 JSON 编码大约膨胀 3.5 倍；导出是低频操作，不值得为它引入 base64。
      await call<void>('write_export', { path: target, data });
      void mime;
      return target;
    },

    async getPrefs(): Promise<Prefs> {
      const s = await prefs();
      const recent = await s.get<string[]>('recentWorkspaces');
      const last = await s.get<string | null>('lastWorkspace');
      return {
        recentWorkspaces: Array.isArray(recent) ? recent : [],
        lastWorkspace: typeof last === 'string' ? last : null,
      };
    },

    async setPrefs(patch: Partial<Prefs>): Promise<void> {
      const s = await prefs();
      const current = await this.getPrefs();
      const next: Prefs = { ...EMPTY_PREFS, ...current, ...patch };
      await s.set('recentWorkspaces', next.recentWorkspaces);
      await s.set('lastWorkspace', next.lastWorkspace);
      await s.save();
    },
  };
}
