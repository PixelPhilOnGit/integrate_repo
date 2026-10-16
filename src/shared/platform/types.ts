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

/**
 * 文件浏览器的一个目录项（**单层**列表，Rust 侧 `DirEntry` 的镜像）。
 *
 * ⚠️ 和 `FileNode` 分开是刻意的：那个的 `children` 语义是「递归树」，
 * 这个是「一层、没有 children」—— 见 Rust 侧 `DirEntry` 的注释。
 */
export interface DirEntry {
  name: string;
  /** 相对 `listDir` 的 root 参数，正斜杠（和 FileNode 同一约定） */
  path: string;
  kind: 'file' | 'dir';
  /** 符号链接（按 `kind:"file"` 报，点开成不成由 Rust 的路径闸门裁决） */
  isSymlink: boolean;
}

/** 文件预览的三态（Rust 侧 `Preview` 的镜像，serde 判别联合） */
export type Preview =
  | { kind: 'text'; text: string }
  | { kind: 'binary' }
  | { kind: 'tooLarge'; size: number };

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
  /**
   * 左侧栏的宽度，**按模块 id 存**（`{ sql: 320, redis: 240 }`）。
   *
   * ⚠️ 为什么不全局一份：五个模块的侧栏深度差得远 —— SQL 是
   * 「引擎 → 连接 → 库 → 表」四层，顺序图那一栏全是长路径，而 Redis 只要
   * 一个连接名。全局一份的话，为 SQL 拖宽会把画布那边挤掉一大块。
   *
   * 认不出来的模块 id 就是没存过（第一次拖之前不在这个表里），给默认宽度。
   */
  sidePanelWidths: Record<string, number>;
  /** 右侧检查器的宽度，同样按模块 id 存。理由同上。 */
  inspectorPanelWidths: Record<string, number>;
}

export const EMPTY_PREFS: Prefs = {
  recentWorkspaces: [],
  lastWorkspace: null,
  theme: 'system',
  sidePanelWidths: {},
  inspectorPanelWidths: {},
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

  /**
   * **单层**列出目录（文件浏览器的懒加载用）。`root` 是绝对路径（用户选的工作
   * 目录），`rel` 是目录内相对路径（空串 = 根）。不过滤：隐藏项、任意后缀都列；
   * 目录在前。和 `listTree` 是两条路，见 Rust 侧 `list_dir` 的注释。
   */
  listDir(root: string, rel: string): Promise<DirEntry[]>;

  /** 读文件预览（文本 / 二进制 / 超限 三态）。先 stat 再读，>2 MiB 不读内容。 */
  readPreview(root: string, rel: string): Promise<Preview>;

  /**
   * 用系统默认程序打开 `root` 里的一个文件/目录（「用系统程序打开」）。
   * 浏览器版没有系统程序可开 —— 空操作（菜单项在调用方就不渲染）。
   */
  openPath(root: string, rel: string): Promise<void>;

  /**
   * 在新窗口里打开某个模块（多窗口）。
   *
   * 桌面端走 Rust 的 `open_window` 命令 —— 窗口构造必须和主窗口带**同一套
   * flag**（clipboard、drag-drop 那些每窗口能力），所以不能在前端用 JS API
   * 另起一个，见 `window_commands.rs`。浏览器版**没有第二个窗口**：实现是
   * 空操作，调用方（外壳的两个入口）负责说一句诚实的话。
   */
  openModuleWindow(moduleId: string): Promise<void>;

  /**
   * 设置当前窗口的标题（切模块时跟着变）。
   *
   * 桌面端走 `getCurrentWindow().setTitle()`；浏览器版写 `document.title`。
   * 多窗口之后标题是**分窗口身份**的一部分 —— 两个窗口都叫「Devtoolkit」
   * 的话用户分不清谁是谁。
   */
  setWindowTitle(title: string): Promise<void>;

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
