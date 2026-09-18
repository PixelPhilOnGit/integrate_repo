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
}

export function PaneTerminal({ sessionId }: Props): ReactNode {
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
