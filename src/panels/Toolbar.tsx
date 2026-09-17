/** 顶部工具栏。所有按钮都直接映射到 store 的动作，不持有自己的状态。 */

import type { ReactNode } from 'react';
import { THEMES } from '../core/theme';
import { exportMermaidFile, exportPngFile, exportSvgFile } from '../render/exportActions';
import type { Layout } from '../core/layout';
import type { AppState, AppStore } from '../state/store';

export interface ToolbarProps {
  state: AppState;
  store: AppStore;
  layout: Layout;
}

export function Toolbar({ state, store, layout }: ToolbarProps): ReactNode {
  const { doc, canUndo, canRedo, workspaceRoot, currentPath } = state;
  const hasParticipants = doc.participants.length > 0;

  // 新建目标跟着文件树的选中走，默认是工作区根目录
  const targetDir = store.creationDir();
  const targetLabel = targetDir === '' ? '工作区根目录' : targetDir;

  const runExport = async (fn: () => Promise<string | null>): Promise<void> => {
    try {
      const out = await fn();
      if (out) store.setStatus(`已导出到 ${out}`);
    } catch (e) {
      // 导出失败要让用户看见原因，不能静默
      store.reportError(e);
    }
  };

  return (
    <div className="rd-toolbar">
      <div className="rd-group">
        <span className="rd-brand">rustDraw</span>
      </div>

      <div className="rd-group">
        <button
          type="button"
          data-testid="btn-new-diagram"
          disabled={!workspaceRoot}
          title={`新建图到「${targetLabel}」（跟随左侧文件树的选中）`}
          onClick={() => void store.newDiagram(targetDir)}
        >
          新建图
        </button>
        <button
          type="button"
          disabled={!workspaceRoot}
          title={`新建文件夹到「${targetLabel}」`}
          onClick={() => void store.newFolder(targetDir)}
        >
          新建文件夹
        </button>
      </div>

      <div className="rd-group">
        <span className="rd-label">参与者</span>
        <button
          type="button"
          data-testid="btn-add-actor"
          title="添加人形参与者"
          onClick={() => store.addParticipant('actor')}
        >
          人
        </button>
        <button
          type="button"
          data-testid="btn-add-object"
          title="添加对象"
          onClick={() => store.addParticipant('object')}
        >
          对象
        </button>
        <button
          type="button"
          title="添加数据库"
          onClick={() => store.addParticipant('database')}
        >
          库
        </button>
      </div>

      <div className="rd-group">
        <span className="rd-label">消息</span>
        <button
          type="button"
          data-testid="btn-add-sync"
          disabled={!hasParticipants}
          title="同步消息（实心箭头，接收方进入执行状态）"
          onClick={() => store.addMessage('sync')}
        >
          同步
        </button>
        <button
          type="button"
          data-testid="btn-add-async"
          disabled={!hasParticipants}
          title="异步消息（空心箭头）"
          onClick={() => store.addMessage('async')}
        >
          异步
        </button>
        <button
          type="button"
          data-testid="btn-add-return"
          disabled={!hasParticipants}
          title="返回消息（虚线，关闭发送方的执行状态）"
          onClick={() => store.addMessage('return')}
        >
          返回
        </button>
        <button
          type="button"
          data-testid="btn-add-self"
          disabled={!hasParticipants}
          title="自调用消息"
          onClick={() => store.addMessage('self')}
        >
          自调用
        </button>
        <button
          type="button"
          data-testid="btn-add-note"
          disabled={!hasParticipants}
          onClick={() => store.addNote()}
        >
          注释
        </button>
      </div>

      <div className="rd-group">
        <button type="button" data-testid="btn-undo" disabled={!canUndo} onClick={() => store.undo()}>
          撤销
        </button>
        <button type="button" data-testid="btn-redo" disabled={!canRedo} onClick={() => store.redo()}>
          重做
        </button>
      </div>

      <div className="rd-group">
        <button
          type="button"
          data-testid="btn-save"
          disabled={!currentPath || !state.dirty}
          onClick={() => void store.save()}
        >
          保存
        </button>
      </div>

      <div className="rd-group rd-right">
        <label className="rd-label" htmlFor="rd-theme-select">
          主题
        </label>
        <select
          id="rd-theme-select"
          data-testid="theme-select"
          value={THEMES.find((t) => t.id === doc.theme.id)?.id ?? 'custom'}
          onChange={(e) => {
            const found = THEMES.find((t) => t.id === e.target.value);
            if (found) store.setTheme({ ...found });
          }}
        >
          {THEMES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
          {!THEMES.some((t) => t.id === doc.theme.id) && <option value="custom">自定义</option>}
        </select>

        <span className="rd-label">导出</span>
        <button type="button" onClick={() => void runExport(() => exportSvgFile(doc, layout, currentPath))}>
          SVG
        </button>
        <button
          type="button"
          data-testid="btn-export-png"
          onClick={() => void runExport(() => exportPngFile(doc, layout, currentPath))}
        >
          PNG
        </button>
        <button
          type="button"
          data-testid="btn-export-mermaid"
          onClick={() => void runExport(() => exportMermaidFile(doc, currentPath))}
        >
          Mermaid
        </button>
      </div>
    </div>
  );
}
