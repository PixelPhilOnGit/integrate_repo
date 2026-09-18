/**
 * SSH 模块自己的终端实例表。
 *
 * 终端本身的逻辑全在 `shared/terminal/hub.ts`（「藏起来而不是销毁」那条路、
 * xterm 懒加载、尺寸夹取，都在那里）。这个文件只负责**这个模块的那一份**：
 * 建实例、起个测试前缀、挂上 Playwright 用的钩子。
 *
 * 为什么模块级单例而不是在组件里建：终端实例必须活在 React 树外面 ——
 * 切模块时 React 会把组件整个卸载，而会话不能跟着销毁（见 shared 那份的长注释）。
 */

import { createTerminalHub, type TerminalHub } from '../../../shared/terminal/hub';

/** 模块级单例。UI 和 store 都从这里拿 */
export const terminalHub = createTerminalHub({ testIdPrefix: 'ssh-term' });

/**
 * 给 Playwright 用的钩子。
 *
 * 为什么不让测试去读 `.xterm-rows` 的文字：那是**渲染器**的输出。换一个渲染
 * 后端（canvas、WebGL）那些节点就不存在了，而 `snapshot()` 读的是 xterm 自己的
 * 缓冲区，和渲染方式无关。断言打在缓冲区上，换渲染器时测试照样是对的。
 *
 * ⚠️ 只在开发构建里挂（`npm run dev`，e2e 跑的就是它）。
 * 生产产物里没有这个全局变量 —— 别把内部对象暴露给最终用户。
 */
if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as unknown as { __sshHub?: TerminalHub }).__sshHub = terminalHub;
}
