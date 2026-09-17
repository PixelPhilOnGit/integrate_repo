/**
 * SQL 模块的入口。
 *
 * 「加一个模块 = 一个目录 + 注册表里一行」，这里就是那一行指向的东西。
 */

import type { Module } from '../../shell/types';
import { SqlIcon } from './icon';
import { SqlInspector, SqlMain, SqlSidebar, SqlStatusItems } from './SqlModule';
import { sqlStore } from './state/store';

export const sqlModule: Module = {
  id: 'sql',
  name: '数据库',
  icon: <SqlIcon />,

  Sidebar: SqlSidebar,
  Main: SqlMain,
  Inspector: SqlInspector,
  StatusItems: SqlStatusItems,

  // SQL 不往工作区里写文件，所以不声明任何文件类型
  platform: { listedExtensions: [], defaultExtension: '' },

  onActivate(api) {
    // init() 是幂等的：切走再切回来不会把查询结果重置掉
    sqlStore.attachShell(api);
    void sqlStore.init();
  },

  onDeactivate() {
    // 和 Redis 一样**刻意不断开连接**：切去看一眼别的模块再回来，
    // 连接和结果都还在，这才是通常的期待。
  },
};
