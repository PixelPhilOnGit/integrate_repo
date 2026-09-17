import { useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { Canvas } from './render/Canvas';
import { useLayout } from './render/useLayout';
import { FileTree } from './panels/FileTree';
import { Inspector } from './panels/Inspector';
import { Toolbar } from './panels/Toolbar';
import { store, type AppState } from './state/store';

export function App(): ReactNode {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const layout = useLayout(state.doc);

  // 快捷键挂在 window 上而不是画布元素上，这样不管焦点在哪都能用
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
        if (e.shiftKey) store.redo();
        else store.undo();
        return;
      }
      if (mod && key === 'y') {
        e.preventDefault();
        store.redo();
        return;
      }
      if (mod && key === 's') {
        e.preventDefault();
        void store.save();
        return;
      }
      if (mod && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        store.setViewport({ zoom: store.getSnapshot().viewport.zoom * 1.2 });
        return;
      }
      if (mod && e.key === '-') {
        e.preventDefault();
        store.setViewport({ zoom: store.getSnapshot().viewport.zoom / 1.2 });
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        store.deleteSelection();
        return;
      }
      if (e.key === 'Escape') {
        store.stopEditing();
        store.select({ type: 'none' });
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

  return (
    <div className="rd-app">
      <Toolbar state={state} store={store} layout={layout} />

      <div className="rd-main">
        <FileTree state={state} store={store} />
        <Canvas state={state} store={store} layout={layout} />
        <Inspector state={state} store={store} />
      </div>

      <StatusBar state={state} />
      {state.error && <ErrorBanner state={state} />}
    </div>
  );
}

/**
 * 方向键微调。
 * 参与者只能左右移、消息只能上下移 —— 这与它们各自在顺序图里的自由度一致，
 * 允许无意义的移动只会让用户困惑。
 */
function nudge(key: string, big: boolean): void {
  const step = big ? 10 : 1;
  const state = store.getSnapshot();
  const { doc, selection } = state;
  if (selection.type === 'none') return;

  switch (selection.type) {
    case 'participant': {
      const p = doc.participants.find((x) => x.id === selection.id);
      if (!p) return;
      const dx = key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0;
      if (dx !== 0) store.updateParticipant(p.id, { x: p.x + dx });
      return;
    }
    case 'message': {
      const m = doc.messages.find((x) => x.id === selection.id);
      if (!m) return;
      const dy = key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0;
      if (dy !== 0) store.updateMessage(m.id, { y: m.y + dy });
      return;
    }
    case 'note': {
      const n = doc.notes.find((x) => x.id === selection.id);
      if (!n) return;
      const dx = key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0;
      const dy = key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0;
      if (dx !== 0 || dy !== 0) store.updateNote(n.id, { x: n.x + dx, y: n.y + dy });
      return;
    }
    default:
      return;
  }
}

function StatusBar({ state }: { state: AppState }): ReactNode {
  return (
    <div className="rd-statusbar">
      <span data-testid="status-text">{state.status ?? ''}</span>
      <span className="rd-spacer" />
      {state.currentPath && (
        <span className="rd-muted" data-testid="current-path">
          {state.currentPath}
          {state.dirty ? ' ·未保存' : ''}
        </span>
      )}
      <span className="rd-muted">
        {state.doc.participants.length} 参与者 / {state.doc.messages.length} 消息
      </span>
    </div>
  );
}

function ErrorBanner({ state }: { state: AppState }): ReactNode {
  return (
    <div className="rd-error" role="alert" data-testid="error-banner">
      <span>{state.error}</span>
      <button type="button" onClick={() => store.clearError()}>
        关闭
      </button>
    </div>
  );
}
