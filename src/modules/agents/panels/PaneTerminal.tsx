/**
 * 一个窗格里的终端。
 *
 * # 这个组件**不创建终端**
 *
 * 终端实例归 `core/terminalHub.ts` 管（真正干活的是 `shared/terminal/hub.ts`），
 * 这里只做两件事：给 hub 一个宿主节点，以及在切换时告诉 hub「挂这个 / 收起上一个」。
 *
 * 之所以不在这里 `new Terminal()`：切模块时 React 会把这个组件整个卸载，
 * 而终端**不能跟着销毁** —— 会话还在跑，画面也得留着。所以实例必须活在一个
 * 比 React 树更长的作用域里。
 *
 * # 和 SSH 那份的区别：宿主**永远是新的**
 *
 * SSH 那边同一时刻只有一个终端挂着（标签切换时宿主节点是同一个 div，只是内容换）。
 * 这里每个窗格有自己的宿主节点，而且**分屏/关闭会让节点重新挂载** ——
 * 所以 effect 的依赖是「这个窗格显示哪个会话」，卸载时老老实实 detach。
 */

import { useEffect, useRef, type ReactNode } from 'react';
import { agentHub } from '../core/terminalHub';

interface Props {
  sessionId: string;
  /** 键盘焦点在这一格上吗。是的话挂载时就把焦点给终端 */
  focused: boolean;
}

export function PaneTerminal({ sessionId, focused }: Props): ReactNode {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    agentHub.attach(sessionId, host);
    // 切走（换会话、关窗格、切模块）时挪到屏幕外，**不销毁** ——
    // 进程还活着，回来时要看到原来的画面
    return () => {
      agentHub.detach(sessionId);
    };
  }, [sessionId]);

  // ⚠️ 焦点单独一个 effect，**依赖只有「是不是聚焦的这一格」**。
  //
  // 混进上面那个 effect 的话，每次 attach 都会抢一次焦点 —— 而 attach 在
  // 切模块回来、分屏、拖分隔条之后都会发生，那意味着用户刚点开集成向导、
  // 或者正在侧栏里改名，焦点会被终端抢走。
  //
  // 只在「这一格成为聚焦的那一格」时给一次：新建会话、点侧栏跳过去、
  // 方向键换格 —— 都是用户刚做的一个动作，此时把键盘交给终端正是他要的。
  useEffect(() => {
    if (focused) agentHub.focus(sessionId);
  }, [focused, sessionId]);

  // testid 带上会话 id：屏幕外的存放点里还躺着一批终端，容器带着**同样的**
  // 前缀，不带 id 的话测试会选到好几个（SSH 那边踩过这个坑）
  return (
    <div
      className="rd-term-host rd-agent-term-host"
      data-testid={`agents-term-host-${sessionId}`}
      ref={hostRef}
    />
  );
}
