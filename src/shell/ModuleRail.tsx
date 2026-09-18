/**
 * 最左侧那一列模块图标（VS Code 活动栏那种）。
 *
 * 从 registry 里读，外壳不认识任何具体模块。
 *
 * 底部那个是**外观切换**（浅色 / 深色 / 跟随系统）—— 它是外壳自己的东西，
 * 和模块无关，所以放在 `role="tablist"` **外面**：把一个普通按钮塞进
 * tablist 里，读屏软件会把它当成一个「模块」念出来。
 */

import { useState, useSyncExternalStore, type ReactNode } from 'react';
import { ContextMenu, type MenuItem } from '../shared/ui/ContextMenu';
import { MODULES } from './registry';
import { shellStore } from './shellInstance';
import { resolveTheme, systemPrefersDark, THEME_OPTIONS } from './theme';

export interface ModuleRailProps {
  /** 是否渲染。只有一个模块时没必要占地方 */
  visible?: boolean;
}

export function ModuleRail({ visible = true }: ModuleRailProps): ReactNode {
  const shell = useSyncExternalStore(shellStore.subscribe, shellStore.getSnapshot);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  if (!visible) return null;

  const items: MenuItem[] = THEME_OPTIONS.map(({ choice, label }) => ({
    label,
    checked: shell.theme === choice,
    onSelect: () => {
      shellStore.setTheme(choice);
      setMenu(null);
    },
  }));

  return (
    <div className="rd-module-rail" data-testid="module-rail">
      <div className="rd-rail-tabs" role="tablist" aria-label="模块">
        {MODULES.map((m, i) => {
          const active = m.id === shell.activeModule;
          // 角标是模块自己的组件（外壳不认识它的内容），有才渲染
          const Badge = m.badge;
          return (
            <button
              key={m.id}
              type="button"
              role="tab"
              aria-selected={active}
              data-testid={`module-${m.id}`}
              className={`rd-module-btn${active ? ' is-active' : ''}`}
              // Ctrl+1/2/3 与图标顺序一致，提示里写出来
              title={`${m.name}（Ctrl+${i + 1}）`}
              onClick={() => shellStore.activate(m.id)}
            >
              {m.icon}
              {Badge && <Badge />}
            </button>
          );
        })}
      </div>

      <button
        type="button"
        className="rd-module-btn rd-theme-btn"
        data-testid="theme-toggle"
        title={`外观：${currentLabel(shell.theme)}`}
        aria-label="切换外观"
        onClick={(e) => setMenu({ x: e.clientX, y: e.clientY })}
      >
        <ThemeIcon />
      </button>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />
      )}
    </div>
  );
}

function currentLabel(choice: string): string {
  return THEME_OPTIONS.find((o) => o.choice === choice)?.label ?? '跟随系统';
}

/**
 * 图标：一个半明半暗的圆。
 *
 * 刻意**不跟着当前主题换图标**（深色时显示太阳、浅色时显示月亮）：
 * 那样这个按钮看起来像「点一下就切换」，而它其实是个菜单 ——
 * 点下去弹出来的东西和图标暗示的不一样，是不会被信任的界面。
 */
function ThemeIcon(): ReactNode {
  return (
    <svg
      viewBox="0 0 20 20"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      aria-hidden="true"
    >
      <circle cx="10" cy="10" r="6.2" />
      <path d="M10 3.8a6.2 6.2 0 0 0 0 12.4z" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** 给 Playwright 用：当前生效的是浅色还是深色（e2e 里断言切换真的生效了） */
if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as unknown as { __resolvedTheme?: () => string }).__resolvedTheme = () =>
    resolveTheme(shellStore.getSnapshot().theme, systemPrefersDark());
}
