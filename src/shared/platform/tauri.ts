/**
 * Tauri 实现：调用 Rust command，使用系统对话框。
 *
 * 这里所有 Tauri 模块都用**动态 import**，而不是顶层静态 import。
 * 原因：静态 import 会把 Tauri 的模块打进浏览器那份产物里，而某些插件在模块
 * 顶层就会去访问 __TAURI_INTERNALS__，在纯浏览器里直接抛错。
 * 动态 import + 缓存既能保证浏览器路径完全不加载它们，又不会每次调用都重新解析。
 */

import type { DirEntry, FileNode, Platform, Prefs, Preview } from './types';
import { EMPTY_PREFS } from './types';
import { createSqliteKeyValue } from './kv';
import { invoke } from './invoke';
import { readWidths } from './panelWidths';

type DialogModule = typeof import('@tauri-apps/plugin-dialog');

let dialogMod: Promise<DialogModule> | null = null;

const dialog = (): Promise<DialogModule> => (dialogMod ??= import('@tauri-apps/plugin-dialog'));

/**
 * `@tauri-apps/api/window`：同样是动态 import + 缓存。
 *
 * ⚠️ 静态 import 会把它打进浏览器产物（见文件头），而 `getCurrentWindow()`
 * 在纯浏览器里会直接抛 —— 那是「16 个 e2e 全红」级别的错法。
 */
type TauriWindowModule = typeof import('@tauri-apps/api/window');

let windowMod: Promise<TauriWindowModule> | null = null;

const tauriWindow = (): Promise<TauriWindowModule> =>
  (windowMod ??= import('@tauri-apps/api/window'));

/**
 * 外壳偏好走**和模块一样的那套键值存储**（SQLite）。
 *
 * 老的 `prefs.json` 会在第一次读的时候被搬进来（键名沿用原来的，所以值一一对上）。
 * 搬迁失败时它自己会退回老实现 —— 见 `kv.ts`。
 */
const prefsKv = createSqliteKeyValue('prefs');

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

    async pickFile(title: string): Promise<string | null> {
      const { open } = await dialog();
      const picked = await open({
        directory: false,
        multiple: false,
        title,
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
      return invoke<FileNode[]>('list_tree', { root });
    },

    async readText(root: string, path: string): Promise<string> {
      return invoke<string>('read_text_file', { root, path });
    },

    async writeText(root: string, path: string, contents: string): Promise<void> {
      await invoke<void>('write_text_file', { root, path, contents });
    },

    async createDiagram(root: string, dir: string, name: string): Promise<string> {
      return invoke<string>('create_diagram', { root, dir, name });
    },

    async createFolder(root: string, dir: string, name: string): Promise<string> {
      return invoke<string>('create_folder', { root, dir, name });
    },

    async rename(root: string, path: string, newName: string): Promise<string> {
      return invoke<string>('rename_entry', { root, path, newName });
    },

    async remove(root: string, path: string): Promise<void> {
      await invoke<void>('delete_entry', { root, path });
    },

    async move(root: string, path: string, newDir: string): Promise<string> {
      return invoke<string>('move_entry', { root, path, newDir });
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
      await invoke<void>('write_export', { path: target, data });
      void mime;
      return target;
    },

    async openModuleWindow(moduleId: string): Promise<void> {
      await invoke<void>('open_window', { module: moduleId });
    },

    async listDir(root: string, rel: string): Promise<DirEntry[]> {
      return invoke<DirEntry[]>('fs_list_dir', { root, rel });
    },

    async readPreview(root: string, rel: string): Promise<Preview> {
      return invoke<Preview>('fs_read_preview', { root, rel });
    },

    async openPath(root: string, rel: string): Promise<void> {
      await invoke<void>('fs_open_path', { root, rel });
    },

    async applyScenario(name: string): Promise<void> {
      await invoke<void>('scenario_set', { name });
    },

    async setWindowTitle(title: string): Promise<void> {
      const { getCurrentWindow } = await tauriWindow();
      await getCurrentWindow().setTitle(title);
    },

    async getPrefs(): Promise<Prefs> {
      const recent = await prefsKv.get<string[]>('recentWorkspaces');
      const last = await prefsKv.get<string | null>('lastWorkspace');
      const theme = await prefsKv.get<string>('theme');
      const sidePanelWidths = await prefsKv.get<Record<string, number>>('sidePanelWidths');
      const inspectorPanelWidths = await prefsKv.get<Record<string, number>>('inspectorPanelWidths');
      const scenario = await prefsKv.get<string>('scenario');
      const scenarios = await prefsKv.get<string[]>('scenarios');
      const scenarioWorkspaces = await prefsKv.get<Record<string, { recent: string[]; last: string | null }>>(
        'scenarioWorkspaces'
      );
      const inspectorOpen = await prefsKv.get<Record<string, boolean>>('inspectorOpen');
      return {
        recentWorkspaces: Array.isArray(recent) ? recent : [],
        lastWorkspace: typeof last === 'string' ? last : null,
        theme: typeof theme === 'string' ? theme : EMPTY_PREFS.theme,
        sidePanelWidths: readWidths(sidePanelWidths),
        inspectorPanelWidths: readWidths(inspectorPanelWidths),
        scenario: typeof scenario === 'string' ? scenario : '',
        scenarios: Array.isArray(scenarios)
          ? scenarios.filter((x): x is string => typeof x === 'string')
          : [],
        scenarioWorkspaces:
          typeof scenarioWorkspaces === 'object' && scenarioWorkspaces !== null
            ? scenarioWorkspaces
            : {},
        inspectorOpen:
          typeof inspectorOpen === 'object' && inspectorOpen !== null ? inspectorOpen : {},
      };
    },

    async setPrefs(patch: Partial<Prefs>): Promise<void> {
      // ⚠️ **只写 patch 里出现的键。** 老写法是「读全 5 个键 → 合并 → 全写回」，
      // 多窗口之后那是一个覆盖窗口：窗口 B 拖一次侧栏宽度，会把本地快照里
      // 那 4 个键一并写回，正好冲掉窗口 A 刚写的 `recentWorkspaces`。
      // 每键各存各的（下面 kv 本来就是单键 UPSERT），冲突面就缩到一个键。
      // （`recentWorkspaces` / `lastWorkspace` 的调用方本来就给整份，语义不变。）
      for (const [key, value] of Object.entries(patch)) {
        await prefsKv.set(key, value);
      }
    },
  };
}
