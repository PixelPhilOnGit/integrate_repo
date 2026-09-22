/**
 * 助手模块的入口。「加一个模块 = 一个目录 + 注册表里一行」，这就是那一行指向的东西。
 *
 * # 和「智能体会话」的区别（名字只差一个 s，别混）
 *
 * * **智能体会话**（`src/modules/agents/`）跑的是**别人的 CLI**（claude / codex），
 *   上下文由那些 CLI 自己管。
 * * **助手**跑的是**我们自己的循环** —— 所以上下文策略才可配（这是这个模块
 *   存在的全部理由）。
 *
 * # 现在做到哪儿了
 *
 * **能用了。** 说一句话，它在工作区里读文件、改文件、跑命令 ——
 * 要动你的东西之前一定先弹审批。模型配置（提供方 / 地址 / 模型 / API key）
 * 在右边的「模型」面板里。
 *
 * 还没做的看 HANDOFF 的「下一步」：摘要策略、工具面扩到别的模块、检索，
 * 以及**跨重启的对话**（历史现在只在内存里，关掉应用就没了）。
 */

import type { Module } from '../../shell/types';
import {
  AssistantBadge,
  AssistantMain,
  AssistantSidebar,
  AssistantStatusItems,
} from './AssistantModule';
import { AssistantInspector } from './panels/AssistantInspector';
import { AssistantIcon } from './icon';
import { assistantStore } from './state/store';
import { useSyncExternalStore, type ReactNode } from 'react';

/**
 * Inspector 要拿到 state 和 store —— 外壳只给组件，不给 props，
 * 所以这里包一层订阅（和别的模块一样）。
 */
function InspectorBound(): ReactNode {
  const state = useSyncExternalStore(assistantStore.subscribe, assistantStore.getSnapshot);
  return <AssistantInspector state={state} store={assistantStore} />;
}

export const assistantModule: Module = {
  id: 'assistant',
  name: '助手',

  icon: <AssistantIcon />,
  badge: AssistantBadge,

  Sidebar: AssistantSidebar,
  Main: AssistantMain,
  Inspector: InspectorBound,
  StatusItems: AssistantStatusItems,

  // ⚠️ 这两个字段是给「列文件树 / 另存为」那套用的（顺序图的 `.seq.json`），
  // **不是**助手的安全边界 —— 它碰的是工作区里的**任意**文件。
  // 管住它的是 Rust 侧那道唯一的路径闸门（`Workspace::resolve`），
  // 白名单在这儿一点用都没有（多一个后缀也拦不住 `..`）。
  platform: { listedExtensions: [], defaultExtension: '' },

  onActivate(api) {
    assistantStore.attachShell(api);
    void assistantStore.init();
  },
};
