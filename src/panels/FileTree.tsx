/**
 * 工作区文件树。
 *
 * 交互约定：
 *   - 单击文件 = 打开；单击文件夹 = 选中 + 展开/折叠
 *   - 双击 = 重命名（行内输入框，不用弹窗：弹窗在桌面端打断思路，
 *     而且 Tauri 的原生对话框在自动化测试里不好驱动）
 *   - **右键（或悬停时点「⋯」）弹出操作菜单** —— 重命名/删除藏在一排按钮里
 *     不够容易被发现，菜单才是这类操作的常规去处
 *   - **选中项决定"新建"建到哪儿** —— 选中目录就建在里面，选中文件就建在它旁边
 */

import { useEffect, useState, type ReactNode } from 'react';
import { platform } from '../platform';
import type { FileNode } from '../platform/types';
import { basename, dirname } from '../platform/path';
import { ContextMenu, type MenuItem } from './ContextMenu';
import type { AppState, AppStore } from '../state/store';

export interface FileTreeProps {
  state: AppState;
  store: AppStore;
}

/**
 * 树上的小图标。
 *
 * 用内联 SVG 而不是 emoji：容器里没装彩色 emoji 字体，emoji 会渲染成豆腐块，
 * 而 SVG 跨平台一致、还能跟随主题色（stroke 用 currentColor）。
 *
 * 文件夹分"打开/关闭"两种形状 —— 只靠折叠箭头区分的话，箭头一小就完全看不出状态。
 */
function TreeIcon({ kind, open }: { kind: 'dir' | 'file'; open: boolean }): ReactNode {
  const common = {
    className: 'rd-tree-icon',
    viewBox: '0 0 16 16',
    width: 14,
    height: 14,
    'aria-hidden': true,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.3,
    strokeLinejoin: 'round' as const,
  };
  if (kind === 'file') {
    return (
      <svg {...common}>
        <path d="M3.6 2.6h5.9l3 3v7.8H3.6z" />
        <path d="M9.5 2.6v3h3" />
      </svg>
    );
  }
  return open ? (
    <svg {...common}>
      {/* 打开的文件夹：背板矮一截，前板向右外张 */}
      <path d="M1.7 4.6c0-.6.4-1 1-1h2.6l1.3 1.5h5.7c.6 0 1 .4 1 1v.7H1.7z" />
      <path d="M1.7 6.8h12.6l-1.2 4.7c-.1.5-.5.8-1 .8H2.7c-.6 0-1-.4-1-1z" />
    </svg>
  ) : (
    <svg {...common}>
      <path d="M1.7 4.6c0-.6.4-1 1-1h2.6l1.3 1.5h6.7c.6 0 1 .4 1 1v5.1c0 .6-.4 1-1 1H2.7c-.6 0-1-.4-1-1z" />
    </svg>
  );
}

/** 折叠箭头。用一个会旋转的 V 形，比 ▸/▾ 两个字符更容易看出状态差异 */
function Caret({ open }: { open: boolean }): ReactNode {
  return (
    <span className={`rd-tree-caret${open ? ' is-open' : ''}`} aria-hidden="true">
      <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M6 4l4 4-4 4" />
      </svg>
    </span>
  );
}

export function FileTree({ state, store }: FileTreeProps): ReactNode {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [menu, setMenu] = useState<{ x: number; y: number; node: FileNode | null } | null>(null);

  const selected = state.treeSelection;

  /**
   * 当前文件变化时，把它所在的目录链全部展开。
   *
   * 不这么做的话，"建到文件夹里的图"会消失在一个折叠的文件夹里 ——
   * 用户看到的是"新建成功了但树上什么都没有"。
   *
   * 只在 currentPath 变化时触发，所以用户手动折叠起来的目录不会被强行撑开。
   */
  useEffect(() => {
    const path = state.currentPath;
    if (!path) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      let dir = dirname(path);
      while (dir) {
        next.add(dir);
        dir = dirname(dir);
      }
      return next;
    });
  }, [state.currentPath]);

  const toggle = (path: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const beginRename = (node: FileNode): void => {
    setRenaming(node.path);
    setDraft(node.kind === 'file' ? basename(node.path).replace(/\.seq\.json$/i, '') : node.name);
  };

  const commitRename = async (): Promise<void> => {
    const path = renaming;
    setRenaming(null);
    if (!path || !draft.trim()) return;
    await store.renameEntry(path, draft.trim());
  };

  const removeEntry = async (node: FileNode): Promise<void> => {
    const ok = await platform.confirm(
      node.kind === 'dir'
        ? `确定删除文件夹「${node.name}」及其中所有内容吗？此操作不可撤销。`
        : `确定删除「${node.name}」吗？此操作不可撤销。`,
    );
    if (!ok) return;
    await store.deleteEntry(node.path);
    store.selectTreeEntry(null);
  };

  /** 某个条目对应的"新建目标目录" */
  const dirFor = (node: FileNode): string =>
    node.kind === 'dir' ? node.path : dirname(node.path);

  const itemsFor = (node: FileNode | null): MenuItem[] => {
    if (!node) {
      // 右键点在空白处
      return [
        { label: '新建图', onSelect: () => void store.newDiagram(store.creationDir()) },
        { label: '新建文件夹', onSelect: () => void store.newFolder(store.creationDir()) },
      ];
    }
    const target = dirFor(node);
    const where = target === '' ? '工作区根目录' : target;
    const items: MenuItem[] = [
      { label: `新建图到「${where}」`, onSelect: () => void store.newDiagram(target) },
      { label: '新建文件夹', onSelect: () => void store.newFolder(target) },
    ];
    if (node.kind === 'dir') {
      items.push({
        label: expanded.has(node.path) ? '折叠' : '展开',
        separatorBefore: true,
        onSelect: () => toggle(node.path),
      });
    }
    items.push(
      { label: '重命名', separatorBefore: node.kind !== 'dir', onSelect: () => beginRename(node) },
      { label: '删除', danger: true, onSelect: () => void removeEntry(node) },
    );
    return items;
  };

  const renderNodes = (nodes: readonly FileNode[], depth: number): ReactNode =>
    nodes.map((node) => {
      const isOpen = expanded.has(node.path);
      const isSelected = selected === node.path;
      const isCurrent = state.currentPath === node.path;
      const rowClass = [
        'rd-tree-row',
        isSelected ? 'is-selected' : '',
        isCurrent ? 'is-current' : '',
      ]
        .filter(Boolean)
        .join(' ');

      /** 缩进辅助线：让层级一眼可见，而不是靠数格子猜 */
      const indents = Array.from({ length: depth }, (_, i) => (
        <span key={i} className="rd-tree-indent" aria-hidden="true" />
      ));

      if (renaming === node.path) {
        return (
          <div key={node.path} className="rd-tree-row">
            {indents}
            <span className="rd-tree-caret" />
            <input
              className="rd-rename-input"
              autoFocus
              value={draft}
              aria-label="重命名"
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => void commitRename()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void commitRename();
                if (e.key === 'Escape') setRenaming(null);
                e.stopPropagation();
              }}
            />
          </div>
        );
      }

      return (
        <div key={node.path}>
          <div
            className={rowClass}
            data-testid={`tree-${node.kind}-${node.path}`}
            onClick={() => {
              store.selectTreeEntry(node.path);
              if (node.kind === 'dir') toggle(node.path);
              else void store.openFile(node.path);
            }}
            onDoubleClick={(e) => {
              e.stopPropagation();
              beginRename(node);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              store.selectTreeEntry(node.path);
              setMenu({ x: e.clientX, y: e.clientY, node });
            }}
          >
            {indents}
            {node.kind === 'dir' ? <Caret open={isOpen} /> : <span className="rd-tree-caret" />}
            <TreeIcon kind={node.kind} open={isOpen} />
            <span className="rd-tree-name">
              {node.kind === 'file' ? basename(node.path).replace(/\.seq\.json$/i, '') : node.name}
            </span>
            {state.dirty && isCurrent && (
              <span className="rd-dot" title="有未保存的改动">
                ●
              </span>
            )}
            {/* 悬停时出现的入口：右键不够容易被发现 */}
            <button
              type="button"
              className="rd-tree-more"
              title="更多操作"
              aria-label={`「${node.name}」的操作`}
              data-testid={`tree-more-${node.path}`}
              onClick={(e) => {
                e.stopPropagation();
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                store.selectTreeEntry(node.path);
                setMenu({ x: r.left, y: r.bottom, node });
              }}
            >
              ⋯
            </button>
          </div>

          {node.kind === 'dir' && isOpen && node.children && renderNodes(node.children, depth + 1)}
        </div>
      );
    });

  const targetDir = store.creationDir();
  const targetLabel = targetDir === '' ? '工作区根目录' : targetDir;

  return (
    <div className="rd-panel rd-filetree" data-testid="file-tree">
      <div className="rd-panel-head">
        <span>工作区</span>
        <button
          type="button"
          data-testid="btn-pick-workspace"
          onClick={() => void store.pickWorkspace()}
        >
          选择目录
        </button>
      </div>

      {state.workspaceRoot ? (
        <div className="rd-workspace-path" title={state.workspaceRoot}>
          {state.workspaceRoot}
        </div>
      ) : (
        <div className="rd-empty">还没有选择工作区</div>
      )}

      {state.workspaceRoot && (
        <div className="rd-tree-actions">
          <button
            type="button"
            data-testid="btn-new-diagram-in-tree"
            title={`新建图到「${targetLabel}」`}
            onClick={() => void store.newDiagram(targetDir)}
          >
            新建图
          </button>
          <button
            type="button"
            data-testid="btn-new-folder-in-tree"
            title={`新建文件夹到「${targetLabel}」`}
            onClick={() => void store.newFolder(targetDir)}
          >
            新建文件夹
          </button>
        </div>
      )}

      <div
        className="rd-tree-body"
        data-testid="tree-body"
        onContextMenu={(e) => {
          // 空白处右键：菜单里的"新建"落在当前目标目录
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY, node: null });
        }}
      >
        {state.tree.length === 0 && state.workspaceRoot ? (
          <div className="rd-empty">这个目录里还没有图，点上面的「新建图」开始</div>
        ) : (
          renderNodes(state.tree, 0)
        )}
      </div>

      {state.workspaceRoot && (
        <div className="rd-tree-target" data-testid="tree-target">
          新建到：{targetLabel}
        </div>
      )}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={itemsFor(menu.node)} onClose={() => setMenu(null)} />
      )}
    </div>
  );
}
