/**
 * 知识库主区：**卡片墙**（默认，评审工作流）↔ **阅读视图**（点开一张卡）。
 * 生成面板（有 run 时）浮在右下角。
 */

import { useSyncExternalStore, type ReactNode } from 'react';
import { MarkdownView } from './MarkdownView';
import { knowledgeStore } from '../state/store';
import { platform } from '../../../shared/platform';

function useKb() {
  return useSyncExternalStore(knowledgeStore.subscribe, knowledgeStore.getSnapshot);
}

export function KbMain(): ReactNode {
  const state = useKb();
  const detailVisible = state.selectedRel !== null || state.detail !== null;

  return (
    <div className="rd-kb-main" data-testid="kb-main">
      {detailVisible ? <Reader /> : <CardWall />}
      {state.gen !== null && <GenPanel />}
    </div>
  );
}

// ------------------------------------------------------------------ 卡片墙

function CardWall(): ReactNode {
  const state = useKb();
  const visible = knowledgeStore.visible();

  if (state.activeVault === null) {
    return <div className="rd-empty">左边先新建或选择一个知识库</div>;
  }
  if (visible.length === 0) {
    return (
      <div className="rd-empty" data-testid="kb-wall-empty">
        {state.query.trim() !== ''
          ? '没有搜到 —— 换个词试试'
          : '这里还空着：传一份资料让 AI 整理成卡片（左下角「上传」）'}
      </div>
    );
  }

  return (
    <div className="rd-kb-wall" data-testid="kb-wall">
      {visible.map((c) => (
        <button
          key={c.rel}
          type="button"
          className={`rd-kb-card${c.status === 'unreviewed' ? ' is-unreviewed' : ''}`}
          data-testid={`kb-wall-${c.rel}`}
          onClick={() => void knowledgeStore.selectCard(c.rel)}
        >
          <span className="rd-kb-card-title">{c.title}</span>
          <span className="rd-kb-card-excerpt">{c.excerpt || '（空卡片）'}</span>
          <span className="rd-kb-card-foot">
            <span className={`rd-kb-badge is-${c.status}`}>
              {c.status === 'reviewed' ? '已评审' : '未评审'}
            </span>
            {c.tags.slice(0, 3).map((t) => (
              <span key={t} className="rd-kb-tag">
                {t}
              </span>
            ))}
          </span>
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ 阅读器

function Reader(): ReactNode {
  const state = useKb();
  const detail = state.detail;

  if (detail === null) {
    return <div className="rd-empty">{state.detailLoading ? '读取中…' : '卡片不在了'}</div>;
  }

  const reviewed = detail.status === 'reviewed';

  return (
    <div className="rd-kb-reader" data-testid="kb-reader">
      <div className="rd-kb-reader-head">
        <button
          type="button"
          className="rd-btn"
          data-testid="kb-back"
          title="回到卡片墙"
          onClick={() => void knowledgeStore.selectCard(null)}
        >
          ← 返回
        </button>
        <h2 className="rd-kb-reader-title" data-testid="kb-reader-title" title={detail.rel}>
          {detail.title}
        </h2>
        <span className={`rd-kb-badge is-${detail.status}`}>{reviewed ? '已评审' : '未评审'}</span>
      </div>

      <div className="rd-kb-reader-actions">
        {reviewed ? (
          <button
            type="button"
            className="rd-btn"
            data-testid="kb-unreview"
            onClick={() => void knowledgeStore.setStatus(detail.rel, 'unreviewed')}
          >
            撤销评审
          </button>
        ) : (
          <button
            type="button"
            className="rd-btn-primary"
            data-testid="kb-review-next"
            title="标为已评审，并自动打开下一张未评审的"
            onClick={() => void knowledgeStore.markReviewedAndNext(detail.rel)}
          >
            已评审，下一张
          </button>
        )}
        <button
          type="button"
          className="rd-btn"
          data-testid="kb-archive"
          onClick={() => void knowledgeStore.setArchived(detail.rel, !detail.archived)}
        >
          {detail.archived ? '取消归档' : '归档'}
        </button>
        <span className="rd-spacer" />
        <button
          type="button"
          className="rd-btn rd-danger"
          data-testid="kb-delete-card"
          onClick={() => {
            void (async () => {
              const ok = await platform.confirm(
                `删除卡片「${detail.title}」？\n\n对应的 md 文件会从库里删掉，此操作不可撤销。`,
                '删除卡片'
              );
              if (ok) await knowledgeStore.deleteCard(detail.rel);
            })();
          }}
        >
          删除
        </button>
      </div>

      <div className="rd-kb-reader-meta rd-muted">
        {detail.created !== '' && <span>创建：{detail.created}</span>}
        {detail.tags.length > 0 && <span>标签：{detail.tags.join('、')}</span>}
        {detail.archived && <span>（已归档）</span>}
      </div>

      <div className="rd-kb-reader-body">
        <MarkdownView
          body={detail.body}
          linkExists={(target) => knowledgeStore.cardByTitle(target) !== null}
          onWikilink={(target) => {
            void (async () => {
              const hit = knowledgeStore.cardByTitle(target);
              if (hit !== null) {
                await knowledgeStore.selectCard(hit.rel);
              }
              // 断链：按钮本身已经是 is-broken 样式 + title 提示（不另外弹）
            })();
          }}
        />
      </div>
    </div>
  );
}

// -------------------------------------------------------------- 生成面板

function GenPanel(): ReactNode {
  const state = useKb();
  const gen = state.gen;
  if (gen === null) return null;

  const running = gen.done === null && gen.error === null;
  return (
    <div className="rd-kb-gen" data-testid="kb-gen-panel">
      <div className="rd-kb-gen-head">
        <span>生成中（{gen.sourceRel.split('/').pop() ?? gen.sourceRel}）</span>
        <button type="button" className="rd-btn" data-testid="kb-gen-dismiss" onClick={() => knowledgeStore.dismissGen()}>
          收起
        </button>
      </div>
      <ol className="rd-kb-gen-notes" data-testid="kb-gen-notes">
        {gen.notes.map((n, i) => (
          <li key={i}>{n}</li>
        ))}
      </ol>
      {gen.error !== null && (
        <p className="rd-danger" data-testid="kb-gen-error">
          {gen.error}
        </p>
      )}
      {gen.done !== null && (
        <p className="rd-kb-gen-done" data-testid="kb-gen-done">
          完成：写了 {gen.done} 张卡片（未评审，去墙上看看）
        </p>
      )}
      <div className="rd-kb-gen-actions">
        {running && (
          <button
            type="button"
            className="rd-btn rd-danger"
            data-testid="kb-gen-cancel"
            onClick={() => void knowledgeStore.cancelGenerate()}
          >
            停止
          </button>
        )}
      </div>
    </div>
  );
}
