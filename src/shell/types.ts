/**
 * 外壳与模块之间的契约。
 *
 * 这个文件**不 import 任何东西** —— 模块要 import 它，外壳也要 import 它，
 * 一旦它依赖了别的东西就会绕成环。
 *
 * 设计意图：外壳只负责「把当前模块画出来」和「显示状态/错误」，
 * 它**不知道**模块内部是什么样。模块也**不需要**外壳帮它存业务状态 ——
 * 每个模块自己持有自己的 store。
 */

import type { ComponentType, ReactNode } from 'react';

/**
 * 模块能用的外壳能力。
 *
 * 刻意做得很窄：只有报告状态和错误。
 * 加任何一项都要问「这是外壳该管的事，还是模块自己的事」——
 * 模块之间不通过外壳通信，外壳也不替模块存数据。
 */
export interface ShellApi {
  /** 在底部状态栏左侧显示一条消息；传 null 清除 */
  setStatus(msg: string | null): void;
  /** 弹出错误条。模块不需要自己 try/catch 展示，交给外壳统一处理 */
  reportError(e: unknown): void;
}

/**
 * 平台层需要模块提供的东西。
 *
 * 平台层（文件读写、目录树）是共享的，不该认识任何具体模块的文件格式；
 * 这些由模块在这里声明，组合根启动时统一注入。
 */
export interface ModulePlatformSpec {
  /** 目录树里列出哪些后缀的文件 */
  listedExtensions: string[];
  /** 新建文件时补的默认后缀 */
  defaultExtension: string;
  /** 浏览器版虚拟工作区的初始文件 */
  seed?: () => Array<{ path: string; content: string }>;
}

export interface Module {
  /** 唯一标识，同时用于键盘快捷键 Ctrl+1/2/3 的顺序 */
  id: string;
  /** 图标栏上的悬浮提示 */
  name: string;
  /** 图标栏上的图标 */
  icon: ReactNode;
  /**
   * 图标栏上的角标，可以不提供。
   *
   * 为什么是一个**组件**而不是一个数字：角标的内容是模块自己的状态
   * （比如「有几个会话在等你」），而外壳不认识任何具体模块。
   * 做成组件之后，模块在自己的角标里订阅自己的 store ——
   * 和 `StatusItems` 是同一个模式，外壳依然只是「摆一个槽位」。
   *
   * 它解决的是这样一个场景：**用户在别的模块里（比如画图），而 agent 在等他。**
   * 没有这个角标，这个模块的提醒价值就只在他切过来的时候才存在。
   */
  badge?: ComponentType;

  /** 顶部工具栏，横跨内容区全宽。不是所有模块都需要 */
  Toolbar?: ComponentType;
  /** 左侧栏。画图模块放的是文件树 */
  Sidebar: ComponentType;
  /** 主区域。画图模块放的是工具栏 + 画布 */
  Main: ComponentType;
  /** 右侧属性面板，可以不提供 */
  Inspector?: ComponentType;
  /** 状态栏右侧属于本模块的部分，可以不提供 */
  StatusItems?: ComponentType;

  /** 平台层配置（文件类型、初始内容） */
  platform: ModulePlatformSpec;

  /** 模块被切到时调用。适合在这里做「恢复上次打开的东西」这类惰性初始化 */
  onActivate?(api: ShellApi): void;
  /** 模块被切走时调用。终端之类需要断连接的模块会用到 */
  onDeactivate?(): void;
}
