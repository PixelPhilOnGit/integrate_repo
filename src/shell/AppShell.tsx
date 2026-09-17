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
import { ModuleRail } from './ModuleRail';
import { MODULES, moduleById } from './registry';
import { shellStore } from './shellInstance';

export function AppShell(): ReactNode {
  const shell = useSyncExternalStore(shellStore.subscribe, shellStore.getSnapshot);
  const mod = moduleById(shell.activeModule) ?? MODULES[0];
  const prevId = useRef<string | null>(null);

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

          <div className="rd-main">
            <Sidebar />
            <Main />
            {Inspector && <Inspector />}
          </div>
        </div>
      </div>

      <div className="rd-statusbar">
        <span data-testid="status-text">{shell.status ?? ''}</span>
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

/** 外壳级快捷键：切换模块。其余快捷键归各模块自己 */
function useShellShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null;
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
