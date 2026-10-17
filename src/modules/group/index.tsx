/**
 * 群组协作模块的入口。
 *
 * 「加一个模块 = 一个目录 + 注册表里一行」，这里就是那一行指向的东西。
 *
 * 它和「智能体会话」的区别值得写清楚（名字有点像）：
 * * agents 里是**交互式终端**（PTY/TUI），进程活得久、画面在 xterm 里；
 * * 这里是无头一次性 CLI（`claude -p` / `codex exec` / `csc -p`），
 *   一轮一个进程，输出是 JSONL，拼成聊天时间线。
 *
 * 和「助手」的区别：助手跑的是**我们自己的循环**；这里驱动的是**别人的 CLI**。
 */

import type { Module } from '../../shell/types';
import { GroupInspector, GroupMain, GroupSidebar, GroupStatusItems } from './GroupModule';
import { GroupIcon } from './icon';
import { groupStore } from './state/store';

export const groupModule: Module = {
  id: 'group',
  name: '群组协作',
  icon: <GroupIcon />,

  Sidebar: GroupSidebar,
  Main: GroupMain,
  Inspector: GroupInspector,
  StatusItems: GroupStatusItems,

  platform: { listedExtensions: [], defaultExtension: '' },

  onActivate(api) {
    groupStore.attachShell(api);
    void groupStore.init();
  },

  onDeactivate() {
    // **刻意什么都不做**：正在跑的轮次不因为切模块而中止（那可能是几分钟的活）。
    // 事件还会继续推；store 会把非当前群的事件只记成「还在跑」。
  },
};
