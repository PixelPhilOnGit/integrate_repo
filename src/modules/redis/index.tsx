/**
 * Redis 模块的入口。
 *
 * 「加一个模块 = 一个目录 + 注册表里一行」，这里就是那一行指向的东西。
 */

import type { Module } from '../../shell/types';
import { RedisIcon } from './icon';
import { RedisInspector, RedisMain, RedisSidebar, RedisStatusItems } from './RedisModule';
import { redisStore } from './state/store';

export const redisModule: Module = {
  id: 'redis',
  name: 'Redis',
  icon: <RedisIcon />,

  // 没有 Toolbar：这个模块不需要顶部通栏
  Sidebar: RedisSidebar,
  Main: RedisMain,
  Inspector: RedisInspector,
  StatusItems: RedisStatusItems,

  // Redis 不往工作区里写文件，所以不声明任何文件类型
  platform: { listedExtensions: [], defaultExtension: '' },

  onActivate(api) {
    // 接上外壳（状态和错误交给它显示），然后把连接档案从磁盘读回来。
    // init() 是幂等的：切走再切回来不会把命令台的输出重置掉。
    redisStore.attachShell(api);
    void redisStore.init();
  },

  onDeactivate() {
    // **刻意不断开连接。**
    //
    // 连接是廉价而且用户预期跨模块存活的资源：去顺序图模块看一眼再回来，
    // 连接还在，这才是通常的期待。进程退出时连接自然消亡，不需要收尾。
    // （将来真有需要断开的场景（比如 SSH 会话），再在这里做。）
  },
};
