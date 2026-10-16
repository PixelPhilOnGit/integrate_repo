/**
 * 知识库模块的入口（「加一个模块 = 一个目录 + 注册表里一行」）。
 *
 * 库是磁盘上的普通目录（md + 附件 + 派生索引），所以这个模块**不碰**工作区
 * 沙箱 —— `platform` 里什么都不声明（和 tasks / agents 一样）。
 */

import type { Module } from '../../shell/types';
import { KnowledgeIcon } from './icon';
import { KnowledgeMain, KnowledgeSidebar, KnowledgeStatusItems } from './KnowledgeModule';
import { knowledgeStore } from './state/store';

export const knowledgeModule: Module = {
  id: 'knowledge',
  name: '知识库',
  icon: <KnowledgeIcon />,

  Sidebar: KnowledgeSidebar,
  Main: KnowledgeMain,
  StatusItems: KnowledgeStatusItems,

  platform: { listedExtensions: [], defaultExtension: '' },

  onActivate(api) {
    knowledgeStore.attachShell(api);
    void knowledgeStore.init();
  },

  onDeactivate() {
    // **刻意什么都不做。**
    //
    // 生成是 Rust 侧在跑的进程，进度经 Channel 直接进 store —— 切模块不打断
    // 它（回来时 GenPanel 原样还在）。这和 agents「切模块不杀会话」同一条理由：
    // 一个正在花钱跑的任务被「看了一眼别的模块」杀死，是坏掉的行为。
  },
};
