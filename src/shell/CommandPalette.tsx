/**
 * 命令面板（Ctrl/Cmd+K）。
 *
 * # 为什么会有一个「命令面板」
 *
 * 十一个模块、每个模块还有自己的快捷键之后，用户记得住入口但不一定记得住
 * 图标在哪一格。命令面板是现在桌面软件的通行做法：一个输入框搜「一切可执行
 * 的东西」，不用先学会界面长什么样。
 *
 * # 这一版刻意只做「跳转 + 少量外壳命令」
 *
 * 面板里现在只有：模块切换、外观三档、检查器开关、在新窗口打开。
 * **不把各模块的业务命令塞进来** —— 那需要模块注册自己的命令表，是另一层
 * 架构（`Module` 接口目前没有这个槽位）。先把壳级导航做扎实，比铺一个
 * 半成品命令总线有价值。
 *
 * # 为什么在终端里不抢 Ctrl+K
 *
 * Ctrl+K 在 bash/zsh 的 readline 里是「删到行尾」，在 xterm 里抢掉它会让
 * 终端用户疯掉。所以全局快捷键**只在不处于输入框/终端焦点时打开**；
 * 输入框里想开面板，点图标栏顶部的放大镜。
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { platform } from '../shared/platform';
import { shortcutLabel } from '../shared/platform/detect';
import { fuzzyMatch } from '../shared/search';
import { useModalKeys } from '../shared/ui/useModalKeys';
import { MODULES } from './registry';
import { shellStore } from './shellInstance';
import { THEME_OPTIONS } from './theme';

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
}

interface PaletteItem {
  id: string;
  label: string;
  hint: string;
  shortcut?: string;
  icon: ReactNode;
  run: () => void;
}

export function CommandPalette({ open, onClose }: CommandPaletteProps): ReactNode {
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  // 每次打开清空查询 —— 上次搜到一半关掉，下次再打开还停在旧结果里很怪
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    // 等面板挂载完再聚焦（autoFocus 在某些 WebKit 版本上会被外层 effect 抢）
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  useModalKeys({ ref: panelRef, open });

  const shell = shellStore.getSnapshot();
  const activeModule = MODULES.find((m) => m.id === shell.activeModule);
  const inspectorOpen = activeModule !== undefined && shellStore.inspectorOpen(activeModule.id);

  const items = useMemo((): PaletteItem[] => {
    const moduleItems: PaletteItem[] = MODULES.map((m, index) => ({
      id: `module-${m.id}`,
      label: m.name,
      hint: '切换模块',
      shortcut: index < 9 ? shortcutLabel(`Ctrl+${index + 1}`) : undefined,
      icon: m.icon,
      run: () => shellStore.activate(m.id),
    }));

    const actionItems: PaletteItem[] = [
      ...THEME_OPTIONS.map(
        ({ choice, label }): PaletteItem => ({
          id: `theme-${choice}`,
          label: `外观：${label}`,
          hint: shell.theme === choice ? '当前' : '外观',
          icon: <ThemeIcon />,
          run: () => shellStore.setTheme(choice),
        }),
      ),
    ];

    if (activeModule?.Inspector !== undefined) {
      actionItems.push({
        id: 'toggle-inspector',
        label: inspectorOpen ? '收起检查器' : '展开检查器',
        hint: shortModuleName(activeModule.name),
        icon: <PanelIcon />,
        run: () => shellStore.setInspectorOpen(activeModule.id, !inspectorOpen),
      });
    }

    if (platform.kind !== 'web' && activeModule !== undefined) {
      actionItems.push({
        id: 'new-window',
        label: '在新窗口打开当前模块',
        hint: shortModuleName(activeModule.name),
        icon: <WindowIcon />,
        run: () => void platform.openModuleWindow(activeModule.id),
      });
    }

    return [...moduleItems, ...actionItems];
  }, [activeModule, inspectorOpen, shell.theme]);

  const filtered = useMemo(() => {
    const q = query.trim();
    if (q === '') return items;
    return items
      .map((item, index) => {
        const match = fuzzyMatch(q, `${item.label} ${item.hint}`);
        return match === null ? null : { item, index, score: match.score };
      })
      .filter((entry): entry is { item: PaletteItem; index: number; score: number } => entry !== null)
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .map((entry) => entry.item);
  }, [items, query]);

  // 结果变了把选中项拉回第一行；键盘上下移动时保证当前行在可视区里
  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open) return null;

  const run = (item: PaletteItem | undefined): void => {
    if (item === undefined) return;
    onClose();
    item.run();
  };

  return (
    <div
      className="rd-palette-backdrop"
      data-testid="command-palette"
      // 只在点到背板本身时关闭；在面板里拖选文字、松手落到背板上不该关
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="rd-palette"
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="命令面板"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onClose();
            return;
          }
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((i) => (filtered.length === 0 ? 0 : (i + 1) % filtered.length));
            return;
          }
          if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((i) =>
              filtered.length === 0 ? 0 : (i - 1 + filtered.length) % filtered.length,
            );
            return;
          }
          // 输入框里回车 = 执行当前选中项；落在某个列表按钮上时走它自己的
          // 原生 click（否则一次回车会执行两遍）
          if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') {
            e.preventDefault();
            run(filtered[active]);
          }
        }}
      >
        <div className="rd-palette-search">
          <SearchIcon />
          <input
            ref={inputRef}
            data-testid="command-palette-input"
            value={query}
            placeholder="搜索模块或命令…"
            aria-label="搜索模块或命令"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
          />
          <kbd className="rd-palette-key">{shortcutLabel('Esc')}</kbd>
        </div>

        <div className="rd-palette-list" role="listbox" aria-label="命令">
          {filtered.length === 0 ? (
            <div className="rd-palette-empty" data-testid="command-palette-empty">
              没有匹配的模块或命令
            </div>
          ) : (
            filtered.map((item, index) => (
              <button
                key={item.id}
                ref={index === active ? activeRef : undefined}
                type="button"
                role="option"
                aria-selected={index === active}
                className={`rd-palette-item${index === active ? ' is-active' : ''}`}
                data-testid={`palette-${item.id}`}
                onMouseEnter={() => setActive(index)}
                onFocus={() => setActive(index)}
                onClick={() => run(item)}
              >
                <span className="rd-palette-item-icon">{item.icon}</span>
                <span className="rd-palette-item-label">{item.label}</span>
                <span className="rd-palette-item-hint">{item.hint}</span>
                {item.shortcut !== undefined && (
                  <kbd className="rd-palette-key">{item.shortcut}</kbd>
                )}
              </button>
            ))
          )}
        </div>

        <div className="rd-palette-foot">
          <span>
            <kbd className="rd-palette-key">↑↓</kbd> 选择
          </span>
          <span>
            <kbd className="rd-palette-key">Enter</kbd> 执行
          </span>
          <span className="rd-spacer" />
          <span>终端里不抢 Ctrl+K</span>
        </div>
      </div>
    </div>
  );
}

function shortModuleName(name: string): string {
  return name.length > 6 ? `${name.slice(0, 6)}…` : name;
}

function SearchIcon(): ReactNode {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <circle cx="8.5" cy="8.5" r="5" />
      <path d="M12.2 12.2 16.5 16.5" />
    </svg>
  );
}

function ThemeIcon(): ReactNode {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
      <circle cx="10" cy="10" r="4.2" />
      <path d="M10 1.8v2M10 16.2v2M1.8 10h2M16.2 10h2M4.2 4.2l1.4 1.4M14.4 14.4l1.4 1.4M15.8 4.2l-1.4 1.4M5.6 14.4l-1.4 1.4" />
    </svg>
  );
}

function PanelIcon(): ReactNode {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true">
      <rect x="2.5" y="3.5" width="15" height="13" rx="2" />
      <path d="M12.5 3.5v13" />
    </svg>
  );
}

function WindowIcon(): ReactNode {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true">
      <rect x="2.5" y="4.5" width="12" height="11" rx="1.5" />
      <path d="M6 2.5h10a1.5 1.5 0 0 1 1.5 1.5v10" />
    </svg>
  );
}
