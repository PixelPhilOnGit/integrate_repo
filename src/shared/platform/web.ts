/**
 * 浏览器实现：一个存在 IndexedDB/localStorage 里的虚拟工作区。
 *
 * 存在的意义有两层：
 *   1. headless 环境下没法启动 Tauri 窗口，前端必须能在普通浏览器里完整跑起来，
 *      Playwright 才驱动得了它 —— 这是整个自动化验证链路的前提
 *   2. 顺带让这个程序在浏览器里也能用
 *
 * 目录树模型和 Rust 侧保持一致（同样的排序、同样的过滤规则），
 * 这样在浏览器里验证过的交互行为，在桌面端不会因为"列目录的顺序不一样"而失效。
 */

import type { FileNode, Platform, Prefs } from './types';
import { EMPTY_PREFS } from './types';
import {
  basename,
  dirname,
  joinPath,
  sanitizeName,
  splitPath,
  uniqueName,
} from './path';
import { isListedFile, platformConfig } from './config';

const TREE_KEY = 'devtoolkit.workspace.v1';
const PREFS_KEY = 'devtoolkit.prefs.v1';

/** 浏览器端的虚拟工作区根目录名，展示给用户看 */
export const VIRTUAL_ROOT = '/工作区';

interface VNode {
  name: string;
  kind: 'file' | 'dir';
  content?: string;
  children?: VNode[];
}

function dir(name: string, children: VNode[] = []): VNode {
  return { name, kind: 'dir', children };
}

function file(name: string, content: string): VNode {
  return { name, kind: 'file', content };
}

/** 首次打开时给一个能直接看的示例，而不是空目录 */
/**
 * 虚拟工作区的初始内容。
 *
 * 具体内容由模块通过 configurePlatform 注入 —— 平台层不认识任何模块的文档格式。
 * 没人注入时就是个空工作区。
 */
function seed(): VNode {
  const root = dir('');
  for (const f of platformConfig().seed?.() ?? []) {
    const parts = splitPath(f.path);
    const name = parts.pop();
    if (!name) continue;
    let cur = root;
    for (const seg of parts) {
      const children = (cur.children ??= []);
      let next = children.find((c) => c.name === seg && c.kind === 'dir');
      if (!next) {
        next = dir(seg);
        children.push(next);
      }
      cur = next;
    }
    (cur.children ??= []).push(file(name, f.content));
  }
  return root;
}

function readTree(): VNode {
  try {
    const raw = localStorage.getItem(TREE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && (parsed as VNode).kind === 'dir') {
        return parsed as VNode;
      }
    }
  } catch {
    // 存储损坏就重建，不要让用户卡在打不开的状态
  }
  const fresh = seed();
  writeTree(fresh);
  return fresh;
}

function writeTree(root: VNode): void {
  try {
    localStorage.setItem(TREE_KEY, JSON.stringify(root));
  } catch {
    // 配额满了也不该让编辑操作失败，内存里的树仍然是对的
  }
}

function findNode(root: VNode, parts: readonly string[]): VNode | null {
  let cur: VNode = root;
  for (const part of parts) {
    const next = cur.children?.find((c) => c.name === part);
    if (!next) return null;
    cur = next;
  }
  return cur;
}

function toFileNodes(node: VNode, prefix: string): FileNode[] {
  const out: FileNode[] = [];
  for (const child of node.children ?? []) {
    const path = joinPath(prefix, child.name);
    if (child.kind === 'dir') {
      out.push({
        name: child.name,
        path,
        kind: 'dir',
        children: toFileNodes(child, path),
      });
    } else if (isListedFile(child.name)) {
      out.push({ name: child.name, path, kind: 'file' });
    }
  }
  return sortNodes(out);
}

/** 目录在前，然后按名称排序（中文用本地化比较，保证符合直觉） */
function sortNodes(nodes: FileNode[]): FileNode[] {
  return [...nodes].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-Hans-CN');
  });
}

export function createWebPlatform(): Platform {
  const withTree = <T>(fn: (root: VNode) => T): T => {
    const root = readTree();
    const result = fn(root);
    writeTree(root);
    return result;
  };

  return {
    kind: 'web',

    async pickWorkspace(): Promise<string | null> {
      return VIRTUAL_ROOT;
    },

    async confirm(message: string, title?: string): Promise<boolean> {
      return window.confirm(title ? `${title}\n\n${message}` : message);
    },

    async listTree(): Promise<FileNode[]> {
      return withTree((root) => toFileNodes(root, ''));
    },

    async readText(_root: string, path: string): Promise<string> {
      const node = findNode(readTree(), splitPath(path));
      if (!node || node.kind !== 'file') throw new Error(`文件不存在：${path}`);
      return node.content ?? '';
    },

    async writeText(_root: string, path: string, contents: string): Promise<void> {
      withTree((root) => {
        const parts = splitPath(path);
        const name = parts.pop();
        if (!name) throw new Error('路径为空');
        const parent = parts.length === 0 ? root : findNode(root, parts);
        if (!parent || parent.kind !== 'dir') throw new Error(`目录不存在：${dirname(path)}`);
        const children = (parent.children ??= []);
        const existing = children.find((c) => c.name === name);
        if (existing && existing.kind === 'file') {
          existing.content = contents;
        } else {
          children.push(file(name, contents));
        }
      });
    },

    /**
     * 只创建**空文件占位**，与 Rust 侧 `create_diagram` 的行为严格一致。
     *
     * 这里刻意不写初始 JSON：如果浏览器版替前端把内容写好、桌面版不写，
     * 那条"建完立刻打开"的路径在两边就是两条不同的代码路径 ——
     * 桌面端"新建图后打不开"这类 bug 就永远不会被 e2e 测到。
     * 初始内容由 store.newDiagram 统一负责。
     */
    async createDiagram(_root: string, dirPath: string, name: string): Promise<string> {
      return withTree((root) => {
        const parent = dirPath === '' ? root : findNode(root, splitPath(dirPath));
        if (!parent || parent.kind !== 'dir') throw new Error(`目录不存在：${dirPath}`);
        const children = (parent.children ??= []);
        const fileName = uniqueName(
          children.map((c) => c.name),
          sanitizeName(name) || '未命名',
          platformConfig().defaultExtension,
        );
        children.push(file(fileName, ''));
        return joinPath(dirPath, fileName);
      });
    },

    async createFolder(_root: string, dirPath: string, name: string): Promise<string> {
      return withTree((root) => {
        const parent = dirPath === '' ? root : findNode(root, splitPath(dirPath));
        if (!parent || parent.kind !== 'dir') throw new Error(`目录不存在：${dirPath}`);
        const children = (parent.children ??= []);
        const folderName = uniqueName(
          children.map((c) => c.name),
          sanitizeName(name) || '新建文件夹',
        );
        children.push(dir(folderName));
        return joinPath(dirPath, folderName);
      });
    },

    async rename(_root: string, path: string, newName: string): Promise<string> {
      return withTree((root) => {
        const parts = splitPath(path);
        const oldName = parts.pop();
        if (!oldName) throw new Error('路径为空');
        const parent = parts.length === 0 ? root : findNode(root, parts);
        if (!parent) throw new Error(`目录不存在：${dirname(path)}`);
        const node = parent.children?.find((c) => c.name === oldName);
        if (!node) throw new Error(`找不到：${path}`);

        const clean = sanitizeName(newName);
        if (!clean) throw new Error('名称不能为空');
        // 图文件必须保留扩展名，用户只改主名
        const finalName =
          node.kind === 'file' && !isListedFile(clean)
            ? clean + platformConfig().defaultExtension
            : clean;

        const clash = parent.children?.some((c) => c !== node && c.name === finalName);
        if (clash) throw new Error(`「${finalName}」已存在`);

        node.name = finalName;
        return joinPath(parts.join('/'), finalName);
      });
    },

    async remove(_root: string, path: string): Promise<void> {
      withTree((root) => {
        const parts = splitPath(path);
        const name = parts.pop();
        if (!name) throw new Error('路径为空');
        const parent = parts.length === 0 ? root : findNode(root, parts);
        if (!parent?.children) return;
        const i = parent.children.findIndex((c) => c.name === name);
        if (i >= 0) parent.children.splice(i, 1);
      });
    },

    async move(_root: string, path: string, newDir: string): Promise<string> {
      return withTree((root) => {
        const parts = splitPath(path);
        const name = parts.pop();
        if (!name) throw new Error('路径为空');
        const parent = parts.length === 0 ? root : findNode(root, parts);
        if (!parent?.children) throw new Error(`目录不存在：${dirname(path)}`);
        const i = parent.children.findIndex((c) => c.name === name);
        if (i < 0) throw new Error(`找不到：${path}`);
        const [node] = parent.children.splice(i, 1);
        if (!node) throw new Error(`找不到：${path}`);

        // 不能把目录移进它自己的子目录
        const destParts = splitPath(newDir);
        if (node.kind === 'dir' && newDir.startsWith(path + '/')) {
          parent.children.splice(i, 0, node);
          throw new Error('不能把文件夹移动到它自己内部');
        }

        const dest = destParts.length === 0 ? root : findNode(root, destParts);
        if (!dest || dest.kind !== 'dir') {
          parent.children.splice(i, 0, node);
          throw new Error(`目标目录不存在：${newDir}`);
        }
        const children = (dest.children ??= []);
        const finalName = uniqueName(
          children.map((c) => c.name),
          node.name.replace(/\.seq\.json$/i, ''),
          node.kind === 'file' ? platformConfig().defaultExtension : '',
        );
        node.name = finalName;
        children.push(node);
        return joinPath(newDir, finalName);
      });
    },

    async exportFile(fileName: string, data: Uint8Array, mime: string): Promise<string | null> {
      // 复制一份再交给 Blob，避开 TS 对 ArrayBufferLike 的严格类型
      const buf = new ArrayBuffer(data.byteLength);
      new Uint8Array(buf).set(data);
      const blob = new Blob([buf], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      a.remove();
      // 立刻 revoke 会让部分浏览器来不及取数据，延后释放
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      return fileName;
    },

    async getPrefs(): Promise<Prefs> {
      // 浏览器版没有"选择目录"这一步（工作区是虚拟的），所以默认就把它打开，
      // 否则每次打开都停在"还没有选择工作区"的空界面上
      const fallback: Prefs = { ...EMPTY_PREFS, lastWorkspace: VIRTUAL_ROOT };
      try {
        const raw = localStorage.getItem(PREFS_KEY);
        if (!raw) return fallback;
        const parsed = JSON.parse(raw) as Partial<Prefs>;
        return {
          recentWorkspaces: Array.isArray(parsed.recentWorkspaces)
            ? parsed.recentWorkspaces.filter((x): x is string => typeof x === 'string')
            : [VIRTUAL_ROOT],
          lastWorkspace: typeof parsed.lastWorkspace === 'string' ? parsed.lastWorkspace : VIRTUAL_ROOT,
        };
      } catch {
        return fallback;
      }
    },

    async setPrefs(patch: Partial<Prefs>): Promise<void> {
      const current = await this.getPrefs();
      const next: Prefs = { ...current, ...patch };
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(next));
      } catch {
        // 忽略配额错误
      }
    },
  };
}

/** 测试辅助：清空虚拟工作区，让下一个用例从种子状态开始 */
export function __resetWebWorkspace(): void {
  localStorage.removeItem(TREE_KEY);
  localStorage.removeItem(PREFS_KEY);
}

export { basename };
