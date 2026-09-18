/**
 * SSH 模块的入口。
 *
 * 「加一个模块 = 一个目录 + 注册表里一行」，这里就是那一行指向的东西。
 * 它是第四个模块，也是第一个**不需要往工作区写任何文件**的连接类模块 ——
 * 所以 `platform` 里什么都没声明。
 */

import type { Module } from '../../shell/types';
import { SshIcon } from './icon';
import { SshInspector, SshMain, SshSidebar, SshStatusItems } from './SshModule';
import { sshStore } from './state/store';

export const sshModule: Module = {
  id: 'ssh',
  name: 'SSH',
  icon: <SshIcon />,

  Sidebar: SshSidebar,
  Main: SshMain,
  Inspector: SshInspector,
  StatusItems: SshStatusItems,

  // SSH 不往工作区里写文件，所以不声明任何文件类型（和 Redis / SQL 一样）
  platform: { listedExtensions: [], defaultExtension: '' },

  onActivate(api) {
    sshStore.attachShell(api);
    void sshStore.init();
  },

  onDeactivate() {
    // **刻意什么都不做 —— 会话不关。**
    //
    // `shell/types.ts` 里 `onDeactivate` 的注释预期「终端之类需要断连接的模块
    // 会用到它」，这里违背了那一条，理由很具体：切到顺序图看一眼再回来，
    // 会话没了，那是个坏掉的终端客户端。用户预期的是「我开着的那几个终端一直在」。
    //
    // 会话和终端的画面都由 `core/terminalHub.ts` 持有（它活在 React 树外面，
    // 切模块不会碰到它），所以回来看得到原来的画面 —— 包括 vim 的备用屏幕
    // 和滚动位置，那些用「重放字节」是重建不出来的。
    //
    // 真正要收尾的时机是**应用退出**，那时候进程没了，连接自然断。
    // webview 重载留下的孤儿由 `init()` 里的 `closeAll()` 收。
  },
};
