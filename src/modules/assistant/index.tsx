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
 * 能用的只有**配置**（提供方 / 地址 / 模型 / API key）。循环内核
 * （`src-tauri/assistant/`）已经跑通并有测试，但 HTTP 客户端和对话界面还没接。
 * 主区域明说了这一点，不摆假的对话框。
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

  // 助手不往工作区里写文件：它的产物是对话记录，存在自己的库里
  platform: { listedExtensions: [], defaultExtension: '' },

  onActivate(api) {
    assistantStore.attachShell(api);
    void assistantStore.init();
  },
};
