/**
 * 智能体会话模块自己的终端实例表。
 *
 * 终端本身的逻辑全在 `shared/terminal/hub.ts`（「藏起来而不是销毁」那条路、
 * xterm 懒加载、尺寸夹取，都在那里）。这个文件只负责**这个模块的那一份**：
 * 建实例、起个测试前缀、挂上 Playwright 用的钩子。
 *
 * 和 SSH 那份几乎一样 —— 但**不能共用同一个实例**：两个模块的会话表是分开的
 * （会话 id 各自生成），混在一个 hub 里会让 `dispose` 找不到人、
 * 「当前挂了几块」这种计数也失去意义。
 */

import { createTerminalHub, type TerminalHub } from '../../../shared/terminal/hub';

/** 模块级单例。UI 和 store 都从这里拿 */
export const agentHub = createTerminalHub({ testIdPrefix: 'agents-term' });

/**
 * 给 Playwright 用的钩子。
 *
 * 读的是 xterm 自己的缓冲区而不是 DOM —— 后者换个渲染后端（canvas、WebGL）
 * 就什么都没有了。
 *
 * ⚠️ 只在开发构建里挂（`npm run dev`，e2e 跑的就是它）。
 */
if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as unknown as { __agentsHub?: TerminalHub }).__agentsHub = agentHub;
}
