/**
 * 知识库侧栏：库切换 + 筛选 + 搜索 + 卡片列表 + 来源区。
 *
 * 结构照任务模块（`TaskList.tsx`）的「切换 + chips + 搜索 + 行列表」——
 * 用户不用学第二套；来源区在下面（上传、按来源生成、删除）。
 */

import { useState, useSyncExternalStore, type ReactNode } from 'react';
import { platform } from '../../../shared/platform';
import { ContextMenu, type MenuItem } from '../../../shared/ui/ContextMenu';
import { FilterChip } from '../../../shared/ui/FilterChip';
import { NoMatch, SearchBox } from '../../../shared/ui/SearchBox';
import type { KbFilter } from '../core/filters';
import type { SourceRow } from '../services/types';
import { knowledgeStore } from '../state/store';

function useKb() {
  return useSyncExternalStore(knowledgeStore.subscribe, knowledgeStore.getSnapshot);
}

interface Props {
  onNewVault: () => void;
  onGenerate: (sourceRel: string) => void;
}

export function KbSidebar({ onNewVault, onGenerate }: Props): ReactNode {
  const state = useKb();
  const [sourceMenu, setSourceMenu] = useState<{ x: number; y: number; rel: string } | null>(null);
  const [vaultMenu, setVaultMenu] = useState<{ x: number; y: number } | null>(null);
  const counts = knowledgeStore.counts();
  const visible = knowledgeStore.visible();
  const searching = state.query.trim() !== '';

  return (
    <div className="rd-panel rd-kb-sidebar" data-testid="kb-sidebar">
      <div className="rd-panel-head">
        <select
          className="rd-kb-vault"
          data-testid="kb-vault-select"
          value={state.activeVault ?? ''}
          onChange={(e) => void knowledgeStore.setActiveVault(e.target.value)}
          title="切换知识库（库与库完全隔离）"
        >
          {state.vaults.length === 0 && <option value="">（还没有知识库）</option>}
          {state.vaults.map((v) => (
            <option key={v.name} value={v.name}>
              {v.name}（{v.cardCount} 卡 / {v.sourceCount} 资料）
            </option>
          ))}
        </select>
        <button type="button" data-testid="kb-new-vault" title="新建知识库" onClick={onNewVault}>
          ＋
        </button>
        <button
          type="button"
          data-testid="kb-vault-menu"
          title="知识库操作"
          disabled={state.activeVault === null}
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            setVaultMenu({ x: r.left, y: r.bottom });
          }}
        >
          ⋯
        </button>
      </div>

      {state.activeVault === null ? (
        <div className="rd-empty">先新建一个知识库</div>
      ) : (
        <>
          <div className="rd-chips" data-testid="kb-filters">
            {(
              [
                ['all', '全部', counts.all],
                ['unreviewed', '未评审', counts.unreviewed],
                ['reviewed', '已评审', counts.reviewed],
                ['archived', '归档', counts.archived],
              ] as const
            ).map(([key, label, n]) => (
              <FilterChip
                key={key}
                label={label}
                count={n}
                active={state.filter === key}
                testId={`kb-filter-${key}`}
                onClick={() => knowledgeStore.setFilter(key as KbFilter)}
              />
            ))}
          </div>

          <SearchBox
            value={state.query}
            onChange={(q) => knowledgeStore.setQuery(q)}
            testId="kb-search"
            placeholder="搜标题、内容、标签"
          />

          <div className="rd-kb-list" data-testid="kb-card-list">
            {searching && visible.length === 0 ? (
              <NoMatch testId="kb-nomatch" />
            ) : visible.length === 0 ? (
              <div className="rd-empty rd-muted">
                {state.filter === 'all'
                  ? '还没有卡片 —— 传一份资料让 AI 整理，或者自己写 md 放进库目录'
                  : '这一档里没有卡片'}
              </div>
            ) : (
              visible.map((c) => (
                <div
                  key={c.rel}
                  className={`rd-kb-row${state.selectedRel === c.rel ? ' is-selected' : ''}`}
                  data-testid={`kb-card-${c.rel}`}
                  data-status={c.status}
                  role="button"
                  tabIndex={0}
                  onClick={() => void knowledgeStore.selectCard(c.rel)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      void knowledgeStore.selectCard(c.rel);
                    }
                  }}
                >
                  <span className={`rd-kb-dot is-${c.status}${c.archived ? ' is-archived' : ''}`} />
                  <span className="rd-kb-row-title" title={c.title}>
                    {c.title}
                  </span>
                  {c.sources.length > 0 && (
                    <span className="rd-kb-row-mark" title="有来源资料">
                      ⇤
                    </span>
                  )}
                </div>
              ))
            )}
          </div>

          <div className="rd-kb-sources" data-testid="kb-sources">
            <div className="rd-kb-sources-head">
              <span>来源资料</span>
              <button
                type="button"
                data-testid="kb-source-add"
                title="选一份文件挂进这个知识库（原件会拷进来）"
                onClick={() => void knowledgeStore.addSource()}
              >
                ＋ 上传
              </button>
            </div>
            {state.sources.length === 0 ? (
              <div className="rd-muted rd-kb-sources-empty">还没有资料</div>
            ) : (
              state.sources.map((s) => (
                <SourceLine
                  key={s.rel}
                  source={s}
                  onGenerate={() => onGenerate(s.rel)}
                  onMenu={(x, y) => setSourceMenu({ x, y, rel: s.rel })}
                />
              ))
            )}
          </div>
        </>
      )}

      {sourceMenu !== null && (
        <ContextMenu
          x={sourceMenu.x}
          y={sourceMenu.y}
          onClose={() => setSourceMenu(null)}
          items={sourceMenuItems(sourceMenu.rel, () => setSourceMenu(null))}
        />
      )}

      {vaultMenu !== null && (
        <ContextMenu
          x={vaultMenu.x}
          y={vaultMenu.y}
          onClose={() => setVaultMenu(null)}
          items={vaultMenuItems(() => setVaultMenu(null))}
        />
      )}
    </div>
  );
}

function SourceLine({
  source,
  onGenerate,
  onMenu,
}: {
  source: SourceRow;
  onGenerate: () => void;
  onMenu: (x: number, y: number) => void;
}): ReactNode {
  const badge =
    source.extractStatus === 'ok' ? '' : source.extractStatus === 'none' ? '（图片）' : '（提取失败）';
  return (
    <div className="rd-kb-source" data-testid={`kb-source-${source.rel}`} title={source.name}>
      <span className="rd-kb-source-name">
        {source.name}
        {badge !== '' && <span className="rd-muted">{badge}</span>}
      </span>
      <button type="button" data-testid={`kb-generate-${source.rel}`} title="用 AI 整理这份资料" onClick={onGenerate}>
        生成
      </button>
      <button
        type="button"
        className="rd-kb-source-more"
        data-testid={`kb-source-menu-${source.rel}`}
        title="更多"
        onClick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          onMenu(r.left, r.bottom);
        }}
      >
        ⋯
      </button>
    </div>
  );
}

function sourceMenuItems(rel: string, close: () => void): MenuItem[] {
  return [
    {
      label: '删除这份资料（保留卡片）',
      danger: true,
      onSelect: () => {
        close();
        void (async () => {
          const ok = await platform.confirm(
            '删掉这份资料的原件？\n\n由它生成的卡片**保留**，来源链接自动断开。\n（要连卡片一起删，选下面那一项。）',
            '删除资料'
          );
          if (ok) await knowledgeStore.deleteSource(rel, false);
        })();
      },
    },
    {
      label: '连生成的卡片一起删…',
      danger: true,
      onSelect: () => {
        close();
        void (async () => {
          const ok = await platform.confirm(
            '连这份资料生成的卡片一起删？\n\n卡片（和你可能评审过的标记）都会没掉，原件的文件也会删。此操作不可撤销。',
            '连卡片一起删'
          );
          if (ok) await knowledgeStore.deleteSource(rel, true);
        })();
      },
    },
  ];
}

function vaultMenuItems(close: () => void): MenuItem[] {
  const items: MenuItem[] = [];
  if (platform.kind === 'tauri') {
    items.push({
      label: '在系统里打开库目录',
      onSelect: () => {
        close();
        void knowledgeStore.revealVault();
      },
    });
  }
  items.push({
    label: '删除这个知识库…',
    danger: true,
    onSelect: () => {
      close();
      void (async () => {
        const name = knowledgeStore.getSnapshot().activeVault;
        if (name === null) return;
        const ok = await platform.confirm(
          `删除知识库「${name}」？\n\n整个目录（卡片、资料、索引）都会被删掉，此操作不可撤销。\n想留个底的话先「在系统里打开库目录」拷一份。`,
          '删除知识库'
        );
        if (ok) await knowledgeStore.deleteVault(name);
      })();
    },
  });
  return items;
}
