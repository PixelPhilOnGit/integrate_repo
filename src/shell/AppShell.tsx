/**
 * 应用外壳。
 *
 * 职责只有三件：
 *   1. 把**当前模块**的各个槽位摆出来
 *   2. 显示状态栏和错误条
 *   3. 处理模块切换（点击图标栏、Ctrl+1/2/3）
 *
 * 它**不认识任何具体模块** —— 只认 `Module` 接口。工作区、文件树、文档
 * 这些东西全在模块自己手里。
 */

import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { platform } from '../shared/platform';
import { ModuleRail } from './ModuleRail';
import { MODULES, moduleById } from './registry';
import { ResizableSlot } from './ResizableSlot';
import { ScenarioControl } from './ScenarioControl';
import { shellStore } from './shellInstance';

export function AppShell(): ReactNode {
  const shell = useSyncExternalStore(shellStore.subscribe, shellStore.getSnapshot);
  const mod = moduleById(shell.activeModule) ?? MODULES[0];
  const prevId = useRef<string | null>(null);
  const inspectorOpen = mod !== undefined && shellStore.inspectorOpen(mod.id);

  /**
   * 模块的装载/卸载钩子。
   *
   * 用 ref 记住上一个模块，而不是把 onDeactivate 放进 cleanup 函数 ——
   * StrictMode 下 effect 会跑两次，cleanup 的写法会把刚装载的模块立刻卸掉。
   */
  useEffect(() => {
    if (!mod) return;
    const previous = prevId.current;
    if (previous === mod.id) return;
    if (previous) moduleById(previous)?.onDeactivate?.();
    mod.onActivate?.(shellStore);
    prevId.current = mod.id;
  }, [mod]);

  // 读回上次选的外观，并开始监听系统主题（只在「跟随系统」那一档才跟着变）。
  // 放这儿而不是 main.tsx：外壳自己那点持久化的东西归外壳管
  useEffect(() => {
    void shellStore.initTheme();
  }, []);

  // 窗口标题和 location.hash 跟着当前模块走（多窗口）。
  // 不同步 hash 的话窗口一刷新就跳回初始模块；标题不设的话两个窗口都叫
  // 「Devtoolkit」，用户分不清谁是谁（顺带把「标题永不变化」那条欠账清掉 ——
  // 文档名进标题的部分不在这一轮）。
  useEffect(() => {
    if (!mod) return;
    void platform.setWindowTitle(`${mod.name} — SuperIndividual`);
    // replaceState 而不是直接赋值：不往历史里堆条目（深链/前进后退不在本轮范围）
    window.history.replaceState(null, '', `#${mod.id}`);
  }, [mod]);

  useShellShortcuts();

  if (!mod) return <div className="rd-app">没有注册任何模块</div>;

  const { Toolbar, Sidebar, Main, Inspector, StatusItems } = mod;

  return (
    <div className="rd-app" data-testid="app-shell">
      {/*
        这一层横向容器是必须的：.rd-app 本身是纵向 flex，
        图标栏直接当它的子元素会变成"顶部的一行"而不是"左侧的一列"。
        状态栏留在外面，横跨整个窗口宽度（和 VS Code 一致）。
      */}
      <div className="rd-body">
        <ModuleRail />

        <div className="rd-content">
          {Toolbar && <Toolbar />}

          {/*
            左右两个槽位都可以拖宽（双击回默认），宽度按**模块**记在偏好里 ——
            见 `ResizableSlot.tsx` 和 `shared/platform/panelWidths.ts` 的头部。
            ⚠️ 槽位包在模块自己那层 `.rd-panel` **外面**：`width` 是槽位的，
            面板在里面 `width: 100%`（CSS 里那两条作用域规则）。
          */}
          <div className="rd-main">
            <ResizableSlot side="left" moduleId={mod.id}>
              <Sidebar />
            </ResizableSlot>
            <Main />
            {/*
              检查器**默认折叠**（用户点名要的：「最右侧的展示，最起码默认是
              折叠的」）。展开态按模块记在偏好里；右边这条窄把手永远在，
              不然用户找不到「那块东西去哪了」。
            */}
            {Inspector && inspectorOpen && (
              <ResizableSlot side="right" moduleId={mod.id}>
                <Inspector />
              </ResizableSlot>
            )}
            {Inspector && (
              <button
                type="button"
                className={`rd-inspector-toggle${inspectorOpen ? ' is-open' : ''}`}
                data-testid="inspector-toggle"
                aria-pressed={inspectorOpen}
                title={inspectorOpen ? '收起检查器' : '展开检查器'}
                onClick={() => shellStore.setInspectorOpen(mod.id, !inspectorOpen)}
              >
                <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M6 4l4 4-4 4" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="rd-statusbar">
        <span data-testid="status-text">{shell.status ?? ''}</span>
        <ScenarioControl />
        <span className="rd-spacer" />
        {StatusItems && <StatusItems />}
      </div>

      {shell.error && (
        <div className="rd-error" role="alert" data-testid="error-banner">
          <span>{shell.error}</span>
          <button type="button" onClick={() => shellStore.clearError()}>
            关闭
          </button>
        </div>
      )}
    </div>
  );
}

/** 外壳级快捷键：切换模块 + 开新窗口。其余快捷键归各模块自己 */
function useShellShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null;

      // 新窗口（多窗口）。
      //
      // ⚠️ **不是 Ctrl+Shift+N**：那组是 agents 的「同目录再开一个会话」，
      // 而且它在**捕获阶段**处理、`stopPropagation` —— 外壳（冒泡阶段）
      // 永远收不到。O = Open，全仓已查空闲。
      //
      // ⚠️ 守卫刻意**只挡 INPUT/contentEditable、不挡 TEXTAREA**：终端
      // （xterm 的隐藏 textarea）聚焦时也要能按出来 —— 这是抄 agents 的
      // 守卫形状。代价：ssh 终端里会抢掉远端程序的这个组合（记进 HANDOFF）。
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === 'KeyO') {
        e.preventDefault();
        if (platform.kind === 'web') {
          // 浏览器版没有第二个窗口 —— 如实说，别装作没发生
          shellStore.setStatus('这是浏览器版，没有多窗口');
          return;
        }
        void platform.openModuleWindow(shellStore.getSnapshot().activeModule);
        return;
      }

      // 模块切换的守卫更严（TEXTAREA 也挡）：终端里按 Ctrl+1..9 没有意义
      const typing =
        t !== null &&
        (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (typing) return;

      if ((e.ctrlKey || e.metaKey) && /^[1-9]$/.test(e.key)) {
        const idx = Number(e.key) - 1;
        const target = MODULES[idx];
        if (target) {
          e.preventDefault();
          shellStore.activate(target.id);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
