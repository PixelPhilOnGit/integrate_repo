/**
 * 任务模块的入口。
 *
 * 「加一个模块 = 一个目录 + 注册表里一行」，这里就是那一行指向的东西。
 *
 * # 为什么它值得单独一个模块（而不是塞进别的模块的一个面板）
 *
 * 任务是**所有事**的入口，不隶属于任何一个技术域：写代码、查数据、连服务器、
 * 甚至「给客户回邮件」都可以是一条任务。挂在某个模块下的话，它的可见性就跟着
 * 那个模块走了 —— 而「我接下来要干什么」这个问题不该需要先切到某个模块。
 *
 * # 和智能体会话的关系（现在没有）
 *
 * 用户明确要求这一轮**只做任务本身**：记、看、改状态、搜。把任务派给某个
 * agent 会话、把执行结果回写到任务上，是下一步的事 —— 数据模型已经为它留好了
 * 位置（Rust 那边开了外键，见 `store.rs` 的注释），但现在不接。
 */

import type { Module } from '../../shell/types';
import { TasksIcon } from './icon';
import { tasksStore } from './state/store';
import { TasksBadge, TasksInspector, TasksMain, TasksSidebar, TasksStatusItems } from './TasksModule';

export const tasksModule: Module = {
  id: 'tasks',
  name: '任务',
  icon: <TasksIcon />,

  // 角标：还有几条没做完（用户在别的模块里时唯一看得见的地方）
  badge: TasksBadge,

  Sidebar: TasksSidebar,
  Main: TasksMain,
  Inspector: TasksInspector,
  StatusItems: TasksStatusItems,

  // 任务存在自己的 SQLite 库里，不往工作区写文件
  platform: { listedExtensions: [], defaultExtension: '' },

  onActivate(api) {
    // 接上外壳（失败提示交给它显示），然后把任务读出来。
    // `init()` 是幂等的：切走再切回来不会把筛选条件重置掉
    tasksStore.attachShell(api);
    void tasksStore.init();
  },
};
