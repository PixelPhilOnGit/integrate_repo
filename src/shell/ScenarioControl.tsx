/**
 * 「场景」的入口：当前场景 + 切换菜单 + 新建。
 *
 * # 两处挂着同一个组件
 *
 * * **图标栏顶部**（只显示图标，悬停出名字）——「场景在最左边」的直觉位置；
 * * **状态栏左端**（图标 + 名字）——场景名一眼可见，切换完不用回忆自己在哪。
 *
 * 两处各持各的菜单状态（同一个组件渲染两份，互不干扰）。
 *
 * # 为什么是「写偏好 + 重载窗口」而不是热切换
 *
 * 见 `shell/store.ts` 的 `switchScenario` 注释：场景换的是**存储命名空间**，
 * 热切换要给每个模块维护一遍重读逻辑，漏一个就是静悄悄的错。
 */

import { useState, useSyncExternalStore, type ReactNode } from 'react';
import { useRef } from 'react';
import { ContextMenu, type MenuItem } from '../shared/ui/ContextMenu';
import { useModalKeys } from '../shared/ui/useModalKeys';
import { shellStore } from './shellInstance';

function useShell() {
  return useSyncExternalStore(shellStore.subscribe, shellStore.getSnapshot);
}

/** 场景的图标：两层叠起来的方块（「分卷」的意象） */
function ScenarioIcon(): ReactNode {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 3.2 17 7l-7 3.8L3 7z" />
      <path d="M3.4 10.6 10 14.2l6.6-3.6" opacity="0.7" />
      <path d="M3.4 13.8 10 17.4l6.6-3.6" opacity="0.45" />
    </svg>
  );
}

interface Props {
  /** compact = 图标栏那版（只出图标）；否则状态栏那版（图标 + 名字） */
  compact?: boolean;
}

export function ScenarioControl({ compact = false }: Props): ReactNode {
  const shell = useShell();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [creating, setCreating] = useState(false);
  const label = shell.scenario === '' ? '默认' : shell.scenario;

  const items: MenuItem[] = [
    ...['', ...shell.scenarios].map(
      (name): MenuItem => ({
        label: name === '' ? '默认' : name,
        checked: shell.scenario === name,
        onSelect: () => {
          setMenu(null);
          void shellStore.switchScenario(name);
        },
      }),
    ),
    {
      label: '新建场景…',
      separatorBefore: true,
      onSelect: () => {
        setMenu(null);
        setCreating(true);
      },
    },
  ];

  return (
    <>
      <button
        type="button"
        className={compact ? 'rd-module-btn rd-scenario-btn is-compact' : 'rd-scenario-chip'}
        data-testid={compact ? 'scenario-rail-btn' : 'scenario-btn'}
        title={`场景：${label}（连接 / 任务 / 知识库等业务数据按场景分卷）`}
        aria-label={`场景：${label}`}
        onClick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          // 图标栏在左边缘：菜单往右下方弹
          setMenu(compact ? { x: r.right + 4, y: r.top } : { x: r.left, y: r.top });
        }}
      >
        <ScenarioIcon />
        {!compact && <span className="rd-scenario-name">{label}</span>}
      </button>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />}
      {creating && <NewScenarioDialog onClose={() => setCreating(false)} />}
    </>
  );
}

function NewScenarioDialog({ onClose }: { onClose: () => void }): ReactNode {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useModalKeys({ ref });

  const submit = (): void => {
    if (name.trim() === '' || busy) return;
    setBusy(true);
    void (async () => {
      const ok = await shellStore.createScenario(name.trim());
      // 成功的话窗口已经在重载路上了；失败（重名/非法）留在框里改
      if (!ok) setBusy(false);
    })();
  };

  return (
    <div className="rd-modal-backdrop">
      <div className="rd-modal" ref={ref} role="dialog" aria-modal="true" aria-labelledby="scenario-new-title">
        <h2 className="rd-modal-title" id="scenario-new-title">
          新建场景
        </h2>
        <p className="rd-hint">
          场景 = 一份独立的「工作现场」：连接、任务、知识库、智能体会话的工作目录
          都按场景分开（外观和助手配置是全局的）。建好会
          <strong>直接切过去并重载窗口</strong>。例如：团队 1 / 团队 2 / 个人项目。
        </p>
        <input
          className="rd-rename-input"
          data-testid="scenario-new-name"
          autoFocus
          value={name}
          placeholder="例如：团队 A / 客户现场"
          aria-label="场景名字"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
            e.stopPropagation();
          }}
        />
        <div className="rd-modal-actions">
          <button type="button" data-testid="scenario-new-cancel" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="rd-btn-primary"
            data-testid="scenario-new-confirm"
            disabled={name.trim() === '' || busy}
            onClick={submit}
          >
            建好并切过去
          </button>
        </div>
      </div>
    </div>
  );
}
