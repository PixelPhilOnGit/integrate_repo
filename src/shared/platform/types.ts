/**
 * 运行时平台抽象。
 *
 * 编辑器只依赖这个接口，不直接碰 Tauri 或浏览器 API。两个实现：
 *   - tauri.ts：真实桌面应用，走 Rust command + 系统对话框
 *   - web.ts  ：纯浏览器实现，工作区是内存/IndexedDB 里的虚拟目录
 *
 * 为什么要留浏览器实现：headless 环境下没法启动 Tauri 窗口，
 * 前端必须能在普通浏览器里独立跑起来，Playwright 才驱动得了它。
 * 顺带的好处是这个程序在浏览器里也能用。
 */

export interface FileNode {
  name: string;
  /** 相对工作区根目录的路径，一律用正斜杠，Windows 上也一样 */
  path: string;
  kind: 'file' | 'dir';
  children?: FileNode[];
}

export interface Prefs {
  recentWorkspaces: string[];
  lastWorkspace: string | null;
  /**
   * 外观：`'system'` / `'light'` / `'dark'`。
   *
   * 刻意是 `string` 而不是那几个字面量的联合 —— 那个类型属于外壳
   * （`shell/theme.ts`），而平台层在上面，不该反过来认识外壳。
   * 存进来的是**用户选的那一档**，解析在 `resolveTheme` 里做；
   * 认不出来的值由 `parseThemeChoice` 兜住（旧版本、手改过的文件）。
   */
  theme: string;
}

export const EMPTY_PREFS: Prefs = {
  recentWorkspaces: [],
  lastWorkspace: null,
  theme: 'system',
};

export interface Platform {
  readonly kind: 'tauri' | 'web';

  /** 弹目录选择框；用户取消返回 null */
  pickWorkspace(): Promise<string | null>;

  /**
   * 弹文件选择框；用户取消返回 null。
   *
   * 和 `pickWorkspace` 放在一起，是因为「挑一个文件」和「挑一个目录」是同一种
   * 能力，都不含任何模块知识。第一个用它的模块是 SSH（选私钥文件）——
   * 但**接口本身不认识私钥**，将来别的模块要用直接拿去用。
   *
   * ⚠️ 浏览器实现**没有真实的文件系统**，所以它返回一个看起来合理的假路径
   * 而不是 null。返回 null 会让这个按钮在浏览器里变成死的，而浏览器版正是
   * e2e 唯一能驱动的那个版本 —— 一个点不动的按钮会让整条链路测不到。
   */
  pickFile(title: string): Promise<string | null>;

  /**
   * 确认对话框。
   * 桌面端必须走原生对话框：webview 里的 window.confirm 在各平台表现不一致，
   * 有的会被宿主静默忽略，删除这种不可逆操作不能赌。
   */
  confirm(message: string, title?: string): Promise<boolean>;

  /** 递归列出工作区目录树（只含目录和 .seq.json 文件） */
  listTree(root: string): Promise<FileNode[]>;

  readText(root: string, path: string): Promise<string>;
  writeText(root: string, path: string, contents: string): Promise<void>;

  /** 新建图文件，返回新文件的相对路径 */
  createDiagram(root: string, dir: string, name: string): Promise<string>;
  /** 新建子目录，返回新目录的相对路径 */
  createFolder(root: string, dir: string, name: string): Promise<string>;
  /** 重命名（文件和目录都可以），返回新的相对路径 */
  rename(root: string, path: string, newName: string): Promise<string>;
  /** 删除（目录会递归删除） */
  remove(root: string, path: string): Promise<void>;
  /** 移动到另一个目录，返回新的相对路径 */
  move(root: string, path: string, newDir: string): Promise<string>;

  /**
   * 导出文件。桌面端弹"另存为"对话框，浏览器端触发下载。
   * 用户取消时返回 null。
   */
  exportFile(fileName: string, data: Uint8Array, mime: string): Promise<string | null>;

  getPrefs(): Promise<Prefs>;
  setPrefs(patch: Partial<Prefs>): Promise<void>;
}

/**
 * 在目录树里按路径找节点。
 * 放在这里是因为 store（算新建目标）和 FileTree（渲染）都要用，
 * 各自实现一份迟早会漂移。
 */
export function findTreeNode(nodes: readonly FileNode[], path: string): FileNode | null {
  for (const n of nodes) {
    if (n.path === path) return n;
    if (n.children) {
      const found = findTreeNode(n.children, path);
      if (found) return found;
    }
  }
  return null;
}

/** 把平台错误包装成对用户可读的中文提示 */
export function describeError(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}
