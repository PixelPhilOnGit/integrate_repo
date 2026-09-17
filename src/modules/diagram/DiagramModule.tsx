/**
 * 顺序图模块的四个槽位。
 *
 * 外壳只认 `Module` 接口，它把这些组件填进去：
 *   Toolbar（顶部通栏） / Sidebar（左） / Main（中） / Inspector（右） / StatusItems（状态栏右侧）
 *
 * 全局快捷键也在这里 —— 撤销/重做/保存/Delete/方向键**全是顺序图操作**，
 * 所以它们属于模块而不是外壳。外壳只保留 Ctrl+1/2/3 切换模块。
 */

import { useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { Canvas } from './render/Canvas';
import { useLayout } from './render/useLayout';
import { FileTree } from './panels/FileTree';
import { Inspector } from './panels/Inspector';
import { Toolbar } from './panels/Toolbar';
import { diagramStore } from './state/store';

/** 订阅模块自己的 store。外壳不掺和模块的状态 */
function useDiagram() {
  const state = useSyncExternalStore(diagramStore.subscribe, diagramStore.getSnapshot);
  const layout = useLayout(state.doc);
  return { state, layout };
}

export function DiagramToolbar(): ReactNode {
  const { state, layout } = useDiagram();
  return <Toolbar state={state} store={diagramStore} layout={layout} />;
}

export function DiagramSidebar(): ReactNode {
  const { state } = useDiagram();
  return <FileTree state={state} store={diagramStore} />;
}

export function DiagramMain(): ReactNode {
  const { state, layout } = useDiagram();
  useDiagramShortcuts();

  // 不要再包一层 div：Canvas 的根元素本身就是 flex:1，多一层会改变布局
  return <Canvas state={state} store={diagramStore} layout={layout} />;
}

export function DiagramInspector(): ReactNode {
  const { state } = useDiagram();
  return <Inspector state={state} store={diagramStore} />;
}

/** 状态栏右侧：当前文件、脏标记、图规模 */
export function DiagramStatusItems(): ReactNode {
  const { state } = useDiagram();
  return (
    <>
      {state.currentPath && (
        <span className="rd-muted" data-testid="current-path">
          {state.currentPath}
          {state.dirty ? ' ·未保存' : ''}
        </span>
      )}
      <span className="rd-muted">
        {state.doc.participants.length} 参与者 / {state.doc.messages.length} 消息
      </span>
    </>
  );
}

/**
 * 方向键微调。
 * 参与者只能左右移、消息只能上下移 —— 这与它们各自在顺序图里的自由度一致，
 * 允许无意义的移动只会让用户困惑。
 */
function nudge(key: string, big: boolean): void {
  const step = big ? 10 : 1;
  const state = diagramStore.getSnapshot();
  const { doc, selection } = state;
  if (selection.type === 'none') return;

  switch (selection.type) {
    case 'participant': {
      const p = doc.participants.find((x) => x.id === selection.id);
      if (!p) return;
      const dx = key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0;
      if (dx !== 0) diagramStore.updateParticipant(p.id, { x: p.x + dx });
      return;
    }
    case 'message': {
      const m = doc.messages.find((x) => x.id === selection.id);
      if (!m) return;
      const dy = key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0;
      if (dy !== 0) diagramStore.updateMessage(m.id, { y: m.y + dy });
      return;
    }
    case 'note': {
      const n = doc.notes.find((x) => x.id === selection.id);
      if (!n) return;
      const dx = key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0;
      const dy = key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0;
      if (dx !== 0 || dy !== 0) diagramStore.updateNote(n.id, { x: n.x + dx, y: n.y + dy });
      return;
    }
    default:
      return;
  }
}

/** 顺序图的全局快捷键。挂在 window 上，这样不管焦点在哪都能用 */
function useDiagramShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null;
      const typing =
        t !== null &&
        (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      // 正在输入文字时把键盘完全让给输入框
      if (typing) return;

      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();

      if (mod && key === 'z') {
        e.preventDefault();
        if (e.shiftKey) diagramStore.redo();
        else diagramStore.undo();
        return;
      }
      if (mod && key === 'y') {
        e.preventDefault();
        diagramStore.redo();
        return;
      }
      if (mod && key === 's') {
        e.preventDefault();
        void diagramStore.save();
        return;
      }
      if (mod && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        const { viewport } = diagramStore.getSnapshot();
        diagramStore.setViewport({ zoom: viewport.zoom * 1.2 });
        return;
      }
      if (mod && e.key === '-') {
        e.preventDefault();
        const { viewport } = diagramStore.getSnapshot();
        diagramStore.setViewport({ zoom: viewport.zoom / 1.2 });
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        diagramStore.deleteSelection();
        return;
      }
      if (e.key === 'Escape') {
        diagramStore.stopEditing();
        diagramStore.select({ type: 'none' });
        return;
      }
      if (e.key.startsWith('Arrow')) {
        e.preventDefault();
        nudge(e.key, e.shiftKey);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
