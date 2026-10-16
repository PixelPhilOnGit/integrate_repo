/**
 * 知识库模块的各个槽位 + 两个对话框。
 *
 * 外壳只认 `Module` 接口，这里把这些组件填进去：Sidebar（左）/ Main（中）/
 * StatusItems（状态栏右侧）。没有 Toolbar —— 工具都在侧栏里。
 */

import { useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useModalKeys } from '../../shared/ui/useModalKeys';
import { KbMain } from './panels/Main';
import { KbSidebar } from './panels/Sidebar';
import { knowledgeStore } from './state/store';

function useKb() {
  return useSyncExternalStore(knowledgeStore.subscribe, knowledgeStore.getSnapshot);
}

export function KnowledgeSidebar(): ReactNode {
  const [newVault, setNewVault] = useState(false);
  const [genSource, setGenSource] = useState<string | null>(null);

  return (
    <>
      <KbSidebar onNewVault={() => setNewVault(true)} onGenerate={(rel) => setGenSource(rel)} />
      {newVault && <NewVaultDialog onClose={() => setNewVault(false)} />}
      {genSource !== null && (
        <GenerateDialog sourceRel={genSource} onClose={() => setGenSource(null)} />
      )}
    </>
  );
}

export { KbMain as KnowledgeMain };

/** 状态栏右侧：「N 张卡片 · M 张未评审」 */
export function KnowledgeStatusItems(): ReactNode {
  const state = useKb();
  const counts = useMemo(() => knowledgeStore.counts(), [state.cards]);

  if (state.activeVault === null) return null;
  return (
    <>
      <span className="rd-muted" data-testid="kb-status">
        {counts.all} 张卡片
      </span>
      <span
        className={counts.unreviewed > 0 ? 'rd-agent-waiting-text' : 'rd-muted'}
        data-testid="kb-status-unreviewed"
      >
        {counts.unreviewed > 0 ? `${counts.unreviewed} 张待评审` : '都评审过了'}
      </span>
    </>
  );
}

function NewVaultDialog({ onClose }: { onClose: () => void }): ReactNode {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useModalKeys({ ref });

  const submit = (): void => {
    const trimmed = name.trim();
    if (trimmed === '' || busy) return;
    setBusy(true);
    void (async () => {
      await knowledgeStore.createVault(trimmed);
      onClose();
    })();
  };

  return (
    <div className="rd-modal-backdrop">
      <div className="rd-modal" ref={ref} role="dialog" aria-modal="true" aria-labelledby="kb-new-vault-title">
        <h2 className="rd-modal-title" id="kb-new-vault-title">
          新建知识库
        </h2>
        <p className="rd-hint">
          一个知识库 = 一个目录（卡片是里面的 markdown 文件，可以用 Obsidian 直接打开）。
          库与库完全隔离：搜索、生成、评审各算各的。
        </p>
        <input
          className="rd-rename-input"
          data-testid="kb-new-vault-name"
          autoFocus
          value={name}
          placeholder="例如：团队 A 的知识 / 客户端排障"
          aria-label="知识库名字"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
            e.stopPropagation();
          }}
        />
        <div className="rd-modal-actions">
          <button type="button" data-testid="kb-new-vault-cancel" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="rd-btn-primary"
            data-testid="kb-new-vault-confirm"
            disabled={name.trim() === '' || busy}
            onClick={submit}
          >
            创建
          </button>
        </div>
      </div>
    </div>
  );
}

function GenerateDialog({
  sourceRel,
  onClose,
}: {
  sourceRel: string;
  onClose: () => void;
}): ReactNode {
  const state = useKb();
  const ref = useRef<HTMLDivElement>(null);
  useModalKeys({ ref });
  const [cli, setCli] = useState<'claude' | 'codex'>('claude');
  const [note, setNote] = useState('');

  const probe = state.cliProbe;
  const claudeOk = probe?.claude != null;
  const codexOk = probe?.codex != null;
  const anyOk = claudeOk || codexOk;
  const name = sourceRel.split('/').pop() ?? sourceRel;

  const start = (): void => {
    onClose();
    void knowledgeStore.generate(sourceRel, cli, note);
  };

  return (
    <div className="rd-modal-backdrop">
      <div className="rd-modal" ref={ref} role="dialog" aria-modal="true" aria-labelledby="kb-gen-title">
        <h2 className="rd-modal-title" id="kb-gen-title">
          用 AI 整理「{name}」
        </h2>
        <p className="rd-hint">
          用你机器上装着的 CLI 读这份资料，生成知识卡片（未评审状态入库）。
          生成的卡片里可以带文字、时序图、图片引用。
        </p>

        <div className="rd-kb-gen-cli" data-testid="kb-gen-cli">
          <label>
            <input
              type="radio"
              name="kb-cli"
              value="claude"
              checked={cli === 'claude'}
              disabled={!claudeOk}
              onChange={() => setCli('claude')}
            />
            Claude Code{claudeOk ? '' : '（没装）'}
          </label>
          <label>
            <input
              type="radio"
              name="kb-cli"
              value="codex"
              checked={cli === 'codex'}
              disabled={!codexOk}
              onChange={() => setCli('codex')}
            />
            Codex{codexOk ? '' : '（没装）'}
          </label>
        </div>
        {!anyOk && (
          <p className="rd-danger" data-testid="kb-gen-no-cli">
            这台机器上没找到 claude / codex —— 装一个再回来（生成要用它们读文件）。
          </p>
        )}

        <textarea
          className="rd-kb-gen-note"
          data-testid="kb-gen-note"
          value={note}
          placeholder="（可选）补充要求，例如：重点提取接口约定；按模块拆卡"
          aria-label="补充要求"
          onChange={(e) => setNote(e.target.value)}
        />

        <div className="rd-modal-actions">
          <button type="button" data-testid="kb-gen-cancel-dialog" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="rd-btn-primary"
            data-testid="kb-gen-start"
            disabled={!anyOk}
            onClick={start}
          >
            开始生成
          </button>
        </div>
      </div>
    </div>
  );
}
