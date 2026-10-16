/**
 * 文件浏览器：检查器「文件」标签的内容（上=目录树、下=文件预览、中间可拖分界）。
 *
 * 用户对这块的原话是「默认不展示、点击才展示」——所以它不在检查器的
 * 默认视图里，靠 `.rd-tabs` 的「文件」标签请出来（见 `AgentsModule.tsx`）。
 *
 * # 它是只读的
 *
 * 不提供编辑/重命名/删除：agent 们在终端里改文件，用户在别处管文件。
 * 这里的职责是「看见」——看结构、看内容、看 agent 改了什么。
 *
 * # 跟谁走
 *
 * 跟 `activeWorkspaceId`（= 当前显示的那套分屏对应的工作目录），由
 * `explorerStore` 订阅推导。远端工作目录给诚实空态（路径在别的机器上）。
 */

import { useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { platform } from '../../../shared/platform';
import { ContextMenu, type MenuItem } from '../../../shared/ui/ContextMenu';
import { Caret, TreeIcon } from '../../../shared/ui/treeGlyphs';
import { flatten, formatBytes, isHidden } from '../core/explorer';
import { explorerStore, type ExplorerSnapshot } from '../state/explorer';

export function FileExplorer(): ReactNode {
  const view = useSyncExternalStore(explorerStore.subscribe, explorerStore.getSnapshot);
  const [menu, setMenu] = useState<{ x: number; y: number; rel: string } | null>(null);

  const boxRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  /**
   * 分界拖拽：走 pointer capture、拖动期间**直接改 DOM**（不走 React 状态）。
   * 拖动是每秒几十次的事，每次 setState 会让整棵树跟着重渲染 ——
   * 和 `ResizableSlot` 是同一条理由。
   */
  const onSplitDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    const box = boxRef.current;
    const preview = previewRef.current;
    if (!box || !preview) return;
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const rect = box.getBoundingClientRect();
    const onMove = (ev: PointerEvent): void => {
      const share = Math.min(0.85, Math.max(0.15, (ev.clientY - rect.top) / rect.height));
      preview.style.flexBasis = `${(share * 100).toFixed(1)}%`;
    };
    const onUp = (): void => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
  };

  const canBrowse = view.workspaceId !== null && !view.remote;

  return (
    <div className="rd-explorer" data-testid="agent-explorer" ref={boxRef}>
      <div className="rd-explorer-head">
        <span className="rd-explorer-path" title={view.workspacePath}>
          {view.workspaceId === null ? '文件' : view.workspacePath}
        </span>
        <button
          type="button"
          className="rd-btn"
          data-testid="agent-explorer-refresh"
          title="重新读一遍目录和预览（agent 改过文件之后点这个）"
          disabled={!canBrowse}
          onClick={() => explorerStore.refresh()}
        >
          刷新
        </button>
      </div>

      {view.workspaceId === null ? (
        <div className="rd-empty">左边先加一个工作目录</div>
      ) : view.remote ? (
        <div className="rd-empty" data-testid="agent-explorer-remote-empty">
          远端工作目录不能浏览文件（路径在那台机器上）
        </div>
      ) : view.rootLoading ? (
        <div className="rd-empty">读目录中…</div>
      ) : view.rootEntries.length === 0 && view.listError === null ? (
        <div className="rd-empty">这个目录是空的</div>
      ) : (
        <>
          <div className="rd-explorer-tree" data-testid="agent-explorer-tree">
            {flatten(view.rootEntries, view.expanded, view.cache).map(({ entry, depth }) => {
              const isDir = entry.kind === 'dir';
              const open = isDir && view.expanded.has(entry.path);
              const cls = [
                'rd-tree-row',
                view.selected === entry.path ? 'is-selected' : '',
                isHidden(entry.name) ? 'is-hidden' : '',
              ]
                .filter(Boolean)
                .join(' ');
              return (
                <div
                  key={entry.path}
                  className={cls}
                  data-testid={`${isDir ? 'agent-dir' : 'agent-file'}-${entry.path}`}
                  aria-expanded={isDir ? open : undefined}
                  onClick={() =>
                    isDir ? explorerStore.toggleDir(entry.path) : explorerStore.selectFile(entry.path)
                  }
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setMenu({ x: e.clientX, y: e.clientY, rel: entry.path });
                  }}
                  title={entry.name}
                >
                  {Array.from({ length: depth }, (_, i) => (
                    <span key={i} className="rd-tree-indent" aria-hidden="true" />
                  ))}
                  {isDir ? <Caret open={open} /> : <span className="rd-tree-caret" />}
                  <TreeIcon kind={isDir ? 'dir' : 'file'} open={open} />
                  <span className="rd-tree-name">{entry.name}</span>
                  {entry.isSymlink && (
                    <span className="rd-explorer-symlink" title="符号链接">
                      ↗
                    </span>
                  )}
                </div>
              );
            })}
          </div>

          <div
            className="rd-explorer-split"
            data-testid="agent-explorer-split"
            onPointerDown={onSplitDown}
            aria-hidden="true"
          />

          <div className="rd-explorer-preview" ref={previewRef}>
            <PreviewArea view={view} />
          </div>
        </>
      )}

      {view.listError !== null && (
        <div className="rd-explorer-status" data-testid="agent-explorer-error">
          {view.listError}
        </div>
      )}

      {/* 右键菜单：web 版没有系统程序可开，干脆不弹（别给点了没反应的项） */}
      {menu !== null && platform.kind === 'tauri' && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={
            [
              {
                label: '用系统程序打开',
                onSelect: () => {
                  explorerStore.openWithSystem(menu.rel);
                  setMenu(null);
                },
              },
            ] satisfies MenuItem[]
          }
        />
      )}
    </div>
  );
}

function PreviewArea({ view }: { view: ExplorerSnapshot }): ReactNode {
  const p = view.preview;

  switch (p.kind) {
    case 'empty':
      return <div className="rd-empty">点一个文件看看内容</div>;
    case 'loading':
      return <div className="rd-empty">读取中…</div>;
    case 'text':
      return (
        <>
          <div className="rd-explorer-preview-head" title={view.selected ?? ''}>
            {view.selected}
          </div>
          <pre className="rd-explorer-text" data-testid="agent-preview">
            {p.text}
          </pre>
        </>
      );
    case 'binary':
    case 'tooLarge': {
      const message =
        p.kind === 'binary'
          ? '二进制文件，这里不显示内容。'
          : `这个文件有点大（${formatBytes(p.size)}），预览只到 2 MB。`;
      return (
        <div className="rd-explorer-note" data-testid={`agent-preview-${p.kind}`}>
          <p>{message}</p>
          {platform.kind === 'tauri' && view.selected !== null && (
            <button
              type="button"
              className="rd-btn"
              data-testid="agent-preview-open"
              onClick={() => explorerStore.openWithSystem(view.selected ?? '')}
            >
              用系统程序打开
            </button>
          )}
        </div>
      );
    }
    case 'error':
      return (
        <div className="rd-explorer-note" data-testid="agent-preview-error">
          <p>{p.message}</p>
          <p className="rd-muted">（文件可能被改过或删了 —— 点上面的「刷新」）</p>
        </div>
      );
  }
}
