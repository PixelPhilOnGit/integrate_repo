/**
 * 知识库主区：**目录 + 卡片墙**（默认）↔ **阅读视图**（点开一张卡）。
 * 生成面板（有 run 时）浮在右下角。
 *
 * 目录结构只是卡片文件的 rel 前缀（`项目/子/卡.md`）—— 主区的文件夹卡片
 * 是「更窄的视图」，根目录始终包含整棵树的卡片，老库不会因为多了目录而
 * 突然少东西。搜索则是**全库**的（找东西不该被当前目录困住）。
 */

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { platform } from '../../../shared/platform';
import { ContextMenu, type MenuItem } from '../../../shared/ui/ContextMenu';
import { useModalKeys } from '../../../shared/ui/useModalKeys';
import { ImageEmbed } from '../../../shared/media/ImageEmbed';
import { formatBytes } from '../core/format';
import type { CardDetail } from '../services/types';
import { MarkdownView } from './MarkdownView';
import { knowledgeStore } from '../state/store';

function useKb() {
  return useSyncExternalStore(knowledgeStore.subscribe, knowledgeStore.getSnapshot);
}

export function KbMain(): ReactNode {
  const state = useKb();
  const detailVisible = state.selectedRel !== null || state.detail !== null;

  const [newCardDir, setNewCardDir] = useState<string | null>(null);
  const [newDirParent, setNewDirParent] = useState<string | null>(null);
  const [renamingDir, setRenamingDir] = useState<string | null>(null);
  const [movingRel, setMovingRel] = useState<string | null>(null);

  return (
    <div className="rd-kb-main" data-testid="kb-main">
      {detailVisible ? (
        <Reader onMove={(rel) => setMovingRel(rel)} />
      ) : (
        <CardWall
          onNewCard={(dir) => setNewCardDir(dir)}
          onNewDir={(parent) => setNewDirParent(parent)}
          onRenameDir={(rel) => setRenamingDir(rel)}
        />
      )}
      {state.gen !== null && <GenPanel />}

      {newCardDir !== null && (
        <NewCardDialog dir={newCardDir} onClose={() => setNewCardDir(null)} />
      )}
      {newDirParent !== null && (
        <NewDirDialog parent={newDirParent} onClose={() => setNewDirParent(null)} />
      )}
      {renamingDir !== null && (
        <RenameDirDialog rel={renamingDir} onClose={() => setRenamingDir(null)} />
      )}
      {movingRel !== null && (
        <MoveCardDialog rel={movingRel} onClose={() => setMovingRel(null)} />
      )}
    </div>
  );
}

// ------------------------------------------------------------------ 卡片墙

function CardWall({
  onNewCard,
  onNewDir,
  onRenameDir,
}: {
  onNewCard: (dir: string) => void;
  onNewDir: (parent: string) => void;
  onRenameDir: (rel: string) => void;
}): ReactNode {
  const state = useKb();
  const [folderMenu, setFolderMenu] = useState<{ x: number; y: number; dir: string } | null>(
    null
  );
  const visible = knowledgeStore.visible();
  const searching = state.query.trim() !== '';
  // 筛选/搜索时只展示卡片：文件夹不是状态，混在结果里会让人以为它在匹配
  const folders =
    searching || state.filter !== 'all' ? [] : knowledgeStore.subdirs();

  if (state.activeVault === null) {
    return <div className="rd-empty">左边先新建或选择一个知识库</div>;
  }

  const empty = visible.length === 0 && folders.length === 0;

  return (
    <div className="rd-kb-workspace">
      <Breadcrumbs
        onNewCard={() => onNewCard(state.currentDir)}
        onNewDir={() => onNewDir(state.currentDir)}
      />

      {folders.length > 0 && (
        <div className="rd-kb-folders" data-testid="kb-folders">
          {folders.map((dir) => (
            <div
              key={dir}
              className="rd-kb-folder"
              data-testid={`kb-folder-${dir}`}
              role="button"
              tabIndex={0}
              onClick={() => knowledgeStore.setCurrentDir(dir)}
              onKeyDown={(e) => {
                // 焦点在里面的「⋯」按钮上时，空格/回车归按钮（不然会误进目录）
                if (e.target !== e.currentTarget) return;
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  knowledgeStore.setCurrentDir(dir);
                }
              }}
            >
              <span className="rd-kb-folder-icon" aria-hidden="true">
                📁
              </span>
              <span className="rd-kb-folder-name" title={dir}>
                {dir.split('/').pop()}
              </span>
              <span className="rd-muted rd-kb-folder-count">
                {knowledgeStore.countInDir(dir)} 张卡片
              </span>
              <button
                type="button"
                className="rd-kb-folder-more"
                data-testid={`kb-folder-menu-${dir}`}
                title="文件夹操作"
                onClick={(e) => {
                  e.stopPropagation();
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  setFolderMenu({ x: r.left, y: r.bottom, dir });
                }}
              >
                ⋯
              </button>
            </div>
          ))}
        </div>
      )}

      {empty ? (
        <div className="rd-empty" data-testid="kb-wall-empty">
          {searching
            ? '没有搜到 —— 换个词试试'
            : state.filter !== 'all'
              ? '这一档里没有卡片'
              : state.currentDir === ''
                ? '这里还空着：点上面的「＋ 卡片」自己写，或者在左下角上传资料让 AI 整理'
                : '这个文件夹还空着：点上面的「＋ 卡片」自己写，或者把资料交给 AI 整理'}
        </div>
      ) : (
        visible.length > 0 && (
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
                  {c.attachments.length > 0 && (
                    <span className="rd-kb-tag" title="挂着文件">
                      📎 {c.attachments.length}
                    </span>
                  )}
                </span>
              </button>
            ))}
          </div>
        )
      )}

      {folderMenu !== null && (
        <ContextMenu
          x={folderMenu.x}
          y={folderMenu.y}
          onClose={() => setFolderMenu(null)}
          items={folderMenuItems(folderMenu.dir, {
            onNewCard,
            onNewDir,
            onRenameDir,
          })}
        />
      )}
    </div>
  );
}

function Breadcrumbs({
  onNewCard,
  onNewDir,
}: {
  onNewCard: () => void;
  onNewDir: () => void;
}): ReactNode {
  const state = useKb();
  const parts = state.currentDir === '' ? [] : state.currentDir.split('/');
  const searching = state.query.trim() !== '';

  return (
    <div className="rd-kb-bar" data-testid="kb-crumbs">
      <div className="rd-kb-crumb-track">
        <button
          type="button"
          className={`rd-kb-crumb${state.currentDir === '' ? ' is-current' : ''}`}
          data-testid="kb-crumb-root"
          title="根目录（包含所有目录里的卡片）"
          onClick={() => knowledgeStore.setCurrentDir('')}
        >
          全部
        </button>
        {parts.map((part, i) => {
          const rel = parts.slice(0, i + 1).join('/');
          return (
            <span key={rel} className="rd-kb-crumb-seg">
              <span className="rd-kb-crumb-sep">/</span>
              <button
                type="button"
                className={`rd-kb-crumb${i === parts.length - 1 ? ' is-current' : ''}`}
                data-testid={`kb-crumb-${rel}`}
                onClick={() => knowledgeStore.setCurrentDir(rel)}
              >
                {part}
              </button>
            </span>
          );
        })}
        {searching && <span className="rd-muted rd-kb-crumb-note">搜索整个知识库</span>}
      </div>
      <span className="rd-spacer" />
      <button type="button" className="rd-btn" data-testid="kb-new-card" onClick={onNewCard}>
        ＋ 卡片
      </button>
      <button type="button" className="rd-btn" data-testid="kb-new-dir" onClick={onNewDir}>
        ＋ 文件夹
      </button>
    </div>
  );
}

function folderMenuItems(
  dir: string,
  actions: {
    onNewCard: (dir: string) => void;
    onNewDir: (parent: string) => void;
    onRenameDir: (rel: string) => void;
  }
): MenuItem[] {
  return [
    {
      label: '打开',
      onSelect: () => knowledgeStore.setCurrentDir(dir),
    },
    {
      label: '在这里新建卡片…',
      onSelect: () => actions.onNewCard(dir),
    },
    {
      label: '新建子文件夹…',
      onSelect: () => actions.onNewDir(dir),
    },
    {
      label: '重命名…',
      separatorBefore: true,
      onSelect: () => actions.onRenameDir(dir),
    },
    {
      label: '删除空文件夹…',
      danger: true,
      onSelect: () => {
        void (async () => {
          const ok = await platform.confirm(
            `删除文件夹「${dir}」？\n\n只允许删**空文件夹**（里面的卡片和子文件夹要先移走/删掉）。`,
            '删除文件夹'
          );
          if (ok) await knowledgeStore.deleteDir(dir);
        })();
      },
    },
  ];
}

// ------------------------------------------------------------------ 阅读器

function Reader({ onMove }: { onMove: (rel: string) => void }): ReactNode {
  const state = useKb();
  const detail = state.detail;
  const [editing, setEditing] = useState(false);
  const [appendText, setAppendText] = useState('');
  const [appendBusy, setAppendBusy] = useState(false);
  const [attachBusy, setAttachBusy] = useState(false);

  // 换了一张卡：编辑态和没发出去的草稿都不该漂过去
  const relKey = detail?.rel ?? '';
  useEffect(() => {
    setEditing(false);
    setAppendText('');
  }, [relKey]);

  if (detail === null) {
    return <div className="rd-empty">{state.detailLoading ? '读取中…' : '卡片不在了'}</div>;
  }

  const reviewed = detail.status === 'reviewed';

  const submitAppend = (): void => {
    const text = appendText.trim();
    if (text === '' || appendBusy) return;
    setAppendBusy(true);
    void (async () => {
      const ok = await knowledgeStore.appendToCard(detail.rel, text);
      setAppendBusy(false);
      // 失败时把用户写的东西留在框里（错误条已经说了为什么）
      if (ok) setAppendText('');
    })();
  };

  const addAttachment = (): void => {
    if (attachBusy) return;
    setAttachBusy(true);
    void knowledgeStore.attachFile(detail.rel).finally(() => setAttachBusy(false));
  };

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
          data-testid="kb-edit"
          onClick={() => setEditing((v) => !v)}
        >
          {editing ? '取消编辑' : '编辑'}
        </button>
        <button
          type="button"
          className="rd-btn"
          data-testid="kb-move"
          title="把这张卡片移到另一个目录"
          onClick={() => onMove(detail.rel)}
        >
          移动…
        </button>
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
                `删除卡片「${detail.title}」？\n\n对应的 md 文件会从库里删掉（只被它引用的附件也会删），此操作不可撤销。`,
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
        {detail.rel.includes('/') && (
          <span>{detail.rel.slice(0, detail.rel.lastIndexOf('/'))}</span>
        )}
        {detail.created !== '' && <span>创建：{detail.created}</span>}
        {detail.tags.length > 0 && <span>标签：{detail.tags.join('、')}</span>}
        {detail.sources.length > 0 && (
          <span data-testid="kb-reader-sources">
            来源：
            {detail.sources
              .map(
                (rel) =>
                  state.sources.find((s) => s.rel === rel)?.name ??
                  rel.split('/').pop() ??
                  rel,
              )
              .join('、')}
          </span>
        )}
        {detail.archived && <span>（已归档）</span>}
      </div>

      {editing ? (
        <EditForm
          key={detail.rel}
          rel={detail.rel}
          title={detail.title}
          body={detail.body}
          onDone={() => setEditing(false)}
        />
      ) : (
        <div className="rd-kb-reader-body">
          <MarkdownView
            body={detail.body}
            loadImage={(target) => knowledgeStore.readFile(target)}
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
      )}

      <AttachmentsBox
        detail={detail}
        busy={attachBusy}
        onAdd={addAttachment}
      />

      {!editing && (
        <div className="rd-kb-append" data-testid="kb-append">
          <div className="rd-kb-append-head">
            <span className="rd-kb-section-title">继续补充</span>
            <span className="rd-muted">Ctrl/⌘ + Enter 追加；每一条都带时间</span>
          </div>
          <textarea
            className="rd-kb-append-text"
            data-testid="kb-append-text"
            value={appendText}
            placeholder="像任务备注一样，不断往这张卡片里加内容…"
            aria-label="追加内容"
            onChange={(e) => setAppendText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                submitAppend();
              }
              e.stopPropagation();
            }}
          />
          <div className="rd-kb-append-actions">
            <button
              type="button"
              className="rd-btn-primary"
              data-testid="kb-append-submit"
              disabled={appendBusy || appendText.trim() === ''}
              onClick={submitAppend}
            >
              {appendBusy ? '写入中…' : '追加'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** 编辑全文（标题 + 正文）。保存后状态/标签/来源/附件原样保留。 */
function EditForm({
  rel,
  title,
  body,
  onDone,
}: {
  rel: string;
  title: string;
  body: string;
  onDone: () => void;
}): ReactNode {
  const [nextTitle, setNextTitle] = useState(title);
  const [nextBody, setNextBody] = useState(body);
  const [busy, setBusy] = useState(false);

  const save = (): void => {
    if (nextTitle.trim() === '' || busy) return;
    setBusy(true);
    void (async () => {
      const ok = await knowledgeStore.updateCard(rel, nextTitle, nextBody);
      setBusy(false);
      if (ok) onDone();
    })();
  };

  return (
    <div className="rd-kb-edit" data-testid="kb-edit-form">
      <input
        className="rd-rename-input rd-kb-edit-title"
        data-testid="kb-edit-title"
        value={nextTitle}
        aria-label="卡片标题"
        onChange={(e) => setNextTitle(e.target.value)}
        onKeyDown={(e) => e.stopPropagation()}
      />
      <textarea
        className="rd-kb-edit-body"
        data-testid="kb-edit-body"
        value={nextBody}
        aria-label="卡片正文"
        onChange={(e) => setNextBody(e.target.value)}
        onKeyDown={(e) => e.stopPropagation()}
      />
      <div className="rd-kb-edit-actions">
        <button type="button" className="rd-btn" data-testid="kb-edit-cancel" onClick={onDone}>
          取消
        </button>
        <button
          type="button"
          className="rd-btn-primary"
          data-testid="kb-edit-save"
          disabled={busy || nextTitle.trim() === ''}
          onClick={save}
        >
          {busy ? '保存中…' : '保存'}
        </button>
      </div>
    </div>
  );
}

/** 卡片挂着的文件：图片给缩略图，别的给图标；名字点开走系统默认程序。 */
function AttachmentsBox({
  detail,
  busy,
  onAdd,
}: {
  detail: CardDetail;
  busy: boolean;
  onAdd: () => void;
}): ReactNode {
  return (
    <div className="rd-kb-attachments" data-testid="kb-attachments">
      <div className="rd-kb-attachments-head">
        <span className="rd-kb-section-title">附件</span>
        <span className="rd-muted">文件会拷一份进库里；原文件之后挪走/删掉都不影响</span>
        <span className="rd-spacer" />
        <button
          type="button"
          className="rd-btn"
          data-testid="kb-attach-add"
          disabled={busy}
          onClick={onAdd}
        >
          {busy ? '选择中…' : '＋ 挂载文件'}
        </button>
      </div>
      {detail.attachments.length === 0 ? (
        <p className="rd-muted rd-kb-attachments-empty">还没有附件</p>
      ) : (
        <ul className="rd-kb-attachment-list">
          {detail.attachments.map((att) => (
            <li className="rd-kb-attachment" key={att.rel} data-testid={`kb-attachment-${att.rel}`}>
              {att.isImage ? (
                <ImageEmbed
                  target={att.rel}
                  load={(target) => knowledgeStore.readFile(target)}
                  className="rd-kb-attachment-thumb"
                  testId={`kb-attachment-image-${att.rel}`}
                  lightboxTestId="kb-attachment-lightbox"
                />
              ) : (
                <span className="rd-kb-attachment-icon" aria-hidden="true">
                  📄
                </span>
              )}
              <button
                type="button"
                className="rd-kb-attachment-name"
                data-testid={`kb-attachment-open-${att.rel}`}
                title="用系统默认程序打开"
                onClick={() => void knowledgeStore.openAttachment(detail.rel, att.rel)}
              >
                {att.name}
              </button>
              <span className="rd-muted rd-kb-attachment-size">{formatBytes(att.byteSize)}</span>
              <button
                type="button"
                className="rd-kb-attachment-remove"
                data-testid={`kb-attachment-remove-${att.rel}`}
                title="摘掉这个附件（没有别的卡片引用时，盘上那份也删）"
                aria-label="摘掉这个附件"
                onClick={() => {
                  void (async () => {
                    const ok = await platform.confirm(
                      `摘掉「${att.name}」？\n\n如果没有别的卡片还在引用它，盘上那份拷贝也会删掉。`,
                      '摘掉附件'
                    );
                    if (ok) {
                      await knowledgeStore.removeAttachment(detail.rel, att.rel);
                    }
                  })();
                }}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ 对话框

function NewCardDialog({ dir, onClose }: { dir: string; onClose: () => void }): ReactNode {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useModalKeys({ ref });

  const submit = (): void => {
    const trimmed = title.trim();
    if (trimmed === '' || busy) return;
    setBusy(true);
    void (async () => {
      const ok = await knowledgeStore.createCard(trimmed, body, dir);
      setBusy(false);
      if (ok) onClose();
    })();
  };

  return (
    <div className="rd-modal-backdrop">
      <div className="rd-modal" ref={ref} role="dialog" aria-modal="true" aria-labelledby="kb-new-card-title">
        <h2 className="rd-modal-title" id="kb-new-card-title">
          新建卡片
        </h2>
        <p className="rd-hint">
          位置：{dir === '' ? '全部（根目录）' : dir}
          。卡片就是库目录里的一个 markdown 文件，之后可以一条条追加备注、挂文件。
        </p>
        <input
          className="rd-rename-input"
          data-testid="kb-new-card-input-title"
          autoFocus
          value={title}
          placeholder="标题，例如：登录接口约定"
          aria-label="卡片标题"
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
            e.stopPropagation();
          }}
        />
        <textarea
          className="rd-kb-new-card-body"
          data-testid="kb-new-card-input-body"
          value={body}
          placeholder="（可选）先写点正文；以后随时可以追加"
          aria-label="卡片正文"
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
        />
        <div className="rd-modal-actions">
          <button type="button" data-testid="kb-new-card-cancel" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="rd-btn-primary"
            data-testid="kb-new-card-confirm"
            disabled={title.trim() === '' || busy}
            onClick={submit}
          >
            创建
          </button>
        </div>
      </div>
    </div>
  );
}

function NewDirDialog({ parent, onClose }: { parent: string; onClose: () => void }): ReactNode {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useModalKeys({ ref });

  const submit = (): void => {
    const trimmed = name.trim();
    if (trimmed === '' || busy) return;
    setBusy(true);
    void (async () => {
      const ok = await knowledgeStore.createDir(trimmed, parent);
      setBusy(false);
      if (ok) onClose();
    })();
  };

  return (
    <div className="rd-modal-backdrop">
      <div className="rd-modal" ref={ref} role="dialog" aria-modal="true" aria-labelledby="kb-new-dir-title">
        <h2 className="rd-modal-title" id="kb-new-dir-title">
          新建文件夹
        </h2>
        <p className="rd-hint">
          位置：{parent === '' ? '全部（根目录）' : parent}。文件夹就是库目录里的子目录，
          可以放卡片，也可以再建子文件夹（像笔记软件一样分项目）。
        </p>
        <input
          className="rd-rename-input"
          data-testid="kb-new-dir-name"
          autoFocus
          value={name}
          placeholder="例如：客户端排障 / 项目 A"
          aria-label="文件夹名字"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
            e.stopPropagation();
          }}
        />
        <div className="rd-modal-actions">
          <button type="button" data-testid="kb-new-dir-cancel" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="rd-btn-primary"
            data-testid="kb-new-dir-confirm"
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

function RenameDirDialog({ rel, onClose }: { rel: string; onClose: () => void }): ReactNode {
  const [name, setName] = useState(rel.split('/').pop() ?? rel);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useModalKeys({ ref });

  const submit = (): void => {
    const trimmed = name.trim();
    if (trimmed === '' || busy) return;
    setBusy(true);
    void (async () => {
      const ok = await knowledgeStore.renameDir(rel, trimmed);
      setBusy(false);
      if (ok) onClose();
    })();
  };

  return (
    <div className="rd-modal-backdrop">
      <div className="rd-modal" ref={ref} role="dialog" aria-modal="true" aria-labelledby="kb-rename-dir-title">
        <h2 className="rd-modal-title" id="kb-rename-dir-title">
          重命名文件夹
        </h2>
        <p className="rd-hint">里面的卡片和子文件夹会跟着一起改。</p>
        <input
          className="rd-rename-input"
          data-testid="kb-rename-dir-name"
          autoFocus
          value={name}
          aria-label="文件夹新名字"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
            e.stopPropagation();
          }}
        />
        <div className="rd-modal-actions">
          <button type="button" data-testid="kb-rename-dir-cancel" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="rd-btn-primary"
            data-testid="kb-rename-dir-confirm"
            disabled={name.trim() === '' || busy}
            onClick={submit}
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

function MoveCardDialog({ rel, onClose }: { rel: string; onClose: () => void }): ReactNode {
  const state = useKb();
  const currentDir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
  const [dir, setDir] = useState(currentDir);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useModalKeys({ ref });

  const submit = (): void => {
    if (busy) return;
    setBusy(true);
    void (async () => {
      const moved = await knowledgeStore.moveCard(rel, dir);
      setBusy(false);
      if (moved !== null) onClose();
    })();
  };

  return (
    <div className="rd-modal-backdrop">
      <div className="rd-modal" ref={ref} role="dialog" aria-modal="true" aria-labelledby="kb-move-title">
        <h2 className="rd-modal-title" id="kb-move-title">
          移动卡片
        </h2>
        <p className="rd-hint">卡片文件会跟着移动；同名时自动加序号。</p>
        <select
          className="rd-kb-move-target"
          data-testid="kb-move-target"
          value={dir}
          aria-label="目标文件夹"
          onChange={(e) => setDir(e.target.value)}
        >
          <option value="">全部（根目录）</option>
          {state.dirs.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
        <div className="rd-modal-actions">
          <button type="button" data-testid="kb-move-cancel" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="rd-btn-primary"
            data-testid="kb-move-confirm"
            disabled={busy || dir === currentDir}
            onClick={submit}
          >
            移动
          </button>
        </div>
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
        <span>
          生成中（
          {gen.sourceRels.length === 1
            ? (state.sources.find((s) => s.rel === gen.sourceRels[0])?.name ??
              gen.sourceRels[0]?.split('/').pop() ??
              '资料')
            : `${gen.sourceRels.length} 份资料`}
          ）
        </span>
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
