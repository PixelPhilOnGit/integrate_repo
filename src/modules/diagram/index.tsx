/**
 * 顺序图模块的入口。
 *
 * 这就是"加一个模块"要写的全部东西：一个目录 + 在这里导出 Module 实现，
 * 然后在外壳注册表里加一行。
 */

import type { Module } from '../../shell/types';
import {
  DiagramInspector,
  DiagramMain,
  DiagramSidebar,
  DiagramStatusItems,
  DiagramToolbar,
} from './DiagramModule';
import { DIAGRAM_FILE_TYPE } from './core/fileType';
import { diagramSeed } from './core/seed';
import { diagramStore } from './state/store';
import { DiagramIcon } from './icon';

export const diagramModule: Module = {
  id: 'diagram',
  name: '顺序图',
  icon: <DiagramIcon />,

  Toolbar: DiagramToolbar,
  Sidebar: DiagramSidebar,
  Main: DiagramMain,
  Inspector: DiagramInspector,
  StatusItems: DiagramStatusItems,

  platform: {
    listedExtensions: [DIAGRAM_FILE_TYPE.extension],
    defaultExtension: DIAGRAM_FILE_TYPE.extension,
    seed: diagramSeed,
  },

  onActivate(api) {
    // 把自己接到外壳上（状态和错误都交给外壳显示），然后恢复上次的工作区
    diagramStore.attachShell(api);
    void diagramStore.init();
    // ⚠️ **切回来时要重读一次目录。** `init()` 是幂等的、只在第一次读盘 ——
    // 而用户（或者窗格里那个 Claude Code）完全可能在别的地方加了 `.seq.json`，
    // 不重读就表现为「文件明明写了，界面里没有」。
    void diagramStore.refreshTree();
  },

  onDeactivate() {
    // 目前没什么要收尾的。将来切走时若有未保存的改动，在这里落盘。
  },
};
