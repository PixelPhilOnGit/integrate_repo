/**
 * 智能体会话模块的入口。
 *
 * 「加一个模块 = 一个目录 + 注册表里一行」，这里就是那一行指向的东西。
 *
 * 和 SSH 一样**不往工作区里写任何文件**，所以 `platform` 里什么都不声明 ——
 * 它操作的是用户自己的项目目录（由用户从系统对话框选），不是 Devtoolkit 的
 * 工作区。这两件事刻意分开：工作区是那个唯一的文件沙箱，而这个模块要起的
 * 是**用户本机的进程**，两者不是一回事。
 */

import type { Module } from '../../shell/types';
import { AgentsBadge } from './Badge';
import { AgentsIcon } from './icon';
import { AgentsInspector, AgentsMain, AgentsSidebar, AgentsStatusItems } from './AgentsModule';
import { agentsStore } from './state/store';

export const agentsModule: Module = {
  id: 'agents',
  name: '智能体会话',
  icon: <AgentsIcon />,
  badge: AgentsBadge,

  Sidebar: AgentsSidebar,
  Main: AgentsMain,
  Inspector: AgentsInspector,
  StatusItems: AgentsStatusItems,

  platform: { listedExtensions: [], defaultExtension: '' },

  onActivate(api) {
    agentsStore.attachShell(api);
    void agentsStore.init();
    // 环境自检：切过来就查一次（检查器那一格不该是空的）
    void agentsStore.refreshEnvironment();
  },

  onDeactivate() {
    // **刻意什么都不做 —— 会话不关。**
    //
    // 和 SSH 那条同理，但这里更要紧：切到别的模块画个图，回来发现三个 agent
    // 全被杀掉了，那不只是「坏掉的终端客户端」——那些进程正在跑测试、
    // 正在改用户的代码。终端画面由 `core/terminalHub.ts` 持有（活在 React 树
    // 外面），所以回来看得到原样。
    //
    // 状态轮询同样不停：用户在别的模块里的时候，正是最需要知道
    // 「有 agent 在等我」的时候（图标栏那个角标就是为这个场景挂的）。
  },
};
