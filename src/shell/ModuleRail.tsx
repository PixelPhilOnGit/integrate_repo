/**
 * 最左侧那一列模块图标（VS Code 活动栏那种）。
 *
 * 从 registry 里读，外壳不认识任何具体模块。
 */

import { useSyncExternalStore, type ReactNode } from 'react';
import { MODULES } from './registry';
import { shellStore } from './shellInstance';

export interface ModuleRailProps {
  /** 是否渲染。只有一个模块时没必要占地方 */
  visible?: boolean;
}

export function ModuleRail({ visible = true }: ModuleRailProps): ReactNode {
  const shell = useSyncExternalStore(shellStore.subscribe, shellStore.getSnapshot);
  if (!visible) return null;

  return (
    <div className="rd-module-rail" data-testid="module-rail" role="tablist" aria-label="模块">
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
  );
}
