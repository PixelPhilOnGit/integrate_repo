/**
 * 平台层的配置注入点。
 *
 * 平台层是所有模块共用的，**不该认识任何具体模块的文件格式**。
 * 它以前硬编码了 `.seq.json`（目录树过滤、改名补后缀）和顺序图的示例文档
 * （浏览器版虚拟工作区的种子），于是"共享的 platform/"反向依赖了画图模块。
 *
 * 现在这些由组合根（main.tsx）在启动时注入 —— 那里本来就认识所有模块。
 *
 * 刻意做成**惰性读取**（模块级变量 + 函数取值）而不是构造参数：
 * `platform` 是在模块加载时就创建的，而配置要等 main.tsx 跑起来才有。
 * 只要在**任何一次实际文件操作之前**调用 configurePlatform 即可。
 */

export interface SeedFile {
  /** 相对路径，可以带子目录，如 '归档/旧版.seq.json' */
  path: string;
  content: string;
}

export interface PlatformConfig {
  /** 目录树里列出哪些后缀的文件 */
  listedExtensions: string[];
  /** 新建文件时补的默认后缀 */
  defaultExtension: string;
  /** 浏览器版虚拟工作区首次打开时的初始文件 */
  seed?: () => SeedFile[];
}

let current: PlatformConfig = { listedExtensions: [], defaultExtension: '' };

export function configurePlatform(config: PlatformConfig): void {
  current = config;
}

export function platformConfig(): PlatformConfig {
  return current;
}

/** 这个文件名要不要显示在目录树里 */
export function isListedFile(name: string): boolean {
  const lower = name.toLowerCase();
  return current.listedExtensions.some((e) => lower.endsWith(e.toLowerCase()));
}
