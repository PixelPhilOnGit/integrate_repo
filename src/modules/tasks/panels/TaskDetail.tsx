/**
 * 主区：选中任务的东西 —— 标题、描述、资料（备注的升级版）、进度。
 *
 * # 为什么保存时机是「失焦」而不是「每敲一个字」
 *
 * 每敲一个字就写一次库 = 打一句话往 SQLite 里灌几十次事务，而且列表会跟着
 * 重排（`updated_at` 变了），**正在打字的这一条会往列表顶上跳** —— 用户眼睁睁
 * 看着自己刚点的那一行在侧栏里乱动。
 *
 * 失焦保存配上「没有保存按钮」是这里最舒服的组合：点别处、切走、关窗口都算
 * 保存（`onBlur` 一定会在这些之前发生）。⚠️ 唯一的例外是**应用被强杀** ——
 * 那时候最后一次编辑没进库，这是接受范围内的代价（比打字时列表乱跳好）。
 *
 * # 标题为什么单独一格、还这么大
 *
 * 它是列表里唯一显示的东西。写得含糊，列表就没法扫 —— 而扫列表是这个模块
 * 最主要的使用方式。
 *
 * # 框为什么全部自适应高度
 *
 * 原来描述和备注都是固定高（~96px）的小框，长一点就得在框里滚着看 —— 用户
 * 明确提了「框太小，展示不好」。现在所有正文框都**跟着内容长**（见
 * [`useAutoResize`]）：写多少、框多高，一屏里看见的就是全部。
 */

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { formatBytes, formatTime, isImageName } from '../core/format';
import { linkify } from '../core/linkify';
import { tasksClient } from '../services';
import type { TasksStore } from '../state/store';
import { DEFAULT_TITLE, isFreshDraft } from '../core/draft';
import { STATUS_LABEL, type Attachment, type Progress, type Task } from '../core/types';

interface Props {
  task: Task;
  store: TasksStore;
  /** 这一条的进度记录（从早到晚）。由外面读好传进来 —— 组件不自己去取数据 */
  progress: readonly Progress[];
}

/** 默认标题搬去了 `core/draft.ts`（侧栏「新建」也要用它做防重）——
    这里 re-export 让老引用一个字不用改 */
export { DEFAULT_TITLE };

/**
 * 应用内预览图片的大小上限 —— **和 Rust 侧 `tasks_attachment_read` 的 32 MiB
 * 是一个数**（那边是硬拦，这边是「早知道」。两边改要一起改）。
 */
const PREVIEW_MAX = 32 * 1024 * 1024;

export function TaskDetail({ task, store, progress }: Props): ReactNode {
  return (
    <div className="rd-task-board" data-testid="task-detail">
      {/* 一条任务 = 一张卡片。为什么是卡片：任务是**一件件独立的事**，
          卡片把「这一条的开始和结束」画在视觉上 —— 一屏排开的输入框
          看起来像一张表单，而表单会让人以为「要一次填完才能走」 */}
      <div className="rd-task-card" data-testid="task-card">
        <div className="rd-task-card-head">
          <TitleField key={task.id} task={task} store={store} />
          {/* 状态在这儿也写一份（只读）：卡片是「单独看这一条」的地方，
              不该为了看状态再瞟右边 */}
          <span
            className={`rd-task-pill is-${task.status}`}
            data-testid="task-card-status"
          >
            {STATUS_LABEL[task.status]}
          </span>
        </div>

        <Field
          key={`${task.id}-body`}
          label="描述"
          hint="这件事要干什么、做到什么算完"
          value={task.body}
          testId="task-body"
          onSave={(body) => void store.patch(task.id, { body })}
        />

        <MaterialsBox key={`${task.id}-materials`} task={task} store={store} />

        <ProgressBox task={task} store={store} progress={progress} />
      </div>
    </div>
  );
}

/**
 * 资料：任务挂着的一串「文字 / 文件」条目（备注的升级版）。
 *
 * # 为什么是列表而不是一个框（用户的原话：「备注可能有很多形式的东西」）
 *
 * 一个框装不下「结论 + 一份文档 + 一张截图」，而且它们形态不同：文字要**改**，
 * 文件要**开**。分成一条条之后，每条自己带时间和删除，读起来还是一份带日期
 * 的记录。老库里的单框备注在升级时会变成第一条文字条目（Rust 侧迁移干的）。
 *
 * # 三种草稿状态（都是刻意的，别再发明第四种）
 *
 * * 「＋文字」先插一个**本地草稿框**：失焦时还空着就自己收掉，不落库、不报错；
 * * 已有条目被清空 → **回退成库里的值**（和标题的空标题回退同一条规矩）；
 * * 删除只能走 ✕ —— `updateText`/`addText` 后端不收空串，所以界面上不存在
 *   「清空 = 删除」这种藏起来的动作。
 */
function MaterialsBox({ task, store }: { task: Task; store: TasksStore }): ReactNode {
  /** 未落库的草稿（每个有新框的序号）。换任务时整块重建，草稿自然清掉 */
  const [drafts, setDrafts] = useState<number[]>([]);
  const nextDraft = useRef(0);
  /** 文件对话框开着的时候按钮得是禁的（双击会开出两个框，各挂各的文件） */
  const [addingFile, setAddingFile] = useState(false);

  const addDraft = (): void => {
    nextDraft.current += 1;
    setDrafts((d) => [...d, nextDraft.current]);
  };

  const addFile = (): void => {
    if (addingFile) return;
    setAddingFile(true);
    void store.addFileAttachment().finally(() => setAddingFile(false));
  };

  return (
    <div className="rd-task-field">
      <span className="rd-task-field-head">
        <span className="rd-task-field-label">备注</span>
        <span className="rd-muted rd-task-field-hint">
          结论、踩过的坑、要留的资料 —— 文字和文件都往这儿放，一条条加
        </span>
      </span>

      {task.attachments.length === 0 && drafts.length === 0 && (
        <p className="rd-hint rd-muted" data-testid="task-materials-empty">
          还没有。写一段用「＋文字」；文档、截图用「＋文件」—— 文件会拷一份进来，
          原文件之后挪走、删掉都不影响。
        </p>
      )}

      <ul className="rd-task-materials" data-testid="task-materials">
        {task.attachments.map((att) =>
          att.kind === 'text' ? (
            <TextItem key={att.id} att={att} store={store} />
          ) : (
            <FileItem key={att.id} att={att} store={store} />
          ),
        )}
        {drafts.map((n) => (
          <DraftItem
            key={`draft-${n}`}
            store={store}
            onDone={() => setDrafts((d) => d.filter((x) => x !== n))}
          />
        ))}
      </ul>

      <div className="rd-task-materials-add">
        <button
          type="button"
          className="rd-task-chip"
          data-testid="task-text-add"
          title="加一段文字（写结论、贴链接）"
          onClick={addDraft}
        >
          ＋ 文字
        </button>
        <button
          type="button"
          className="rd-task-chip"
          data-testid="task-file-add"
          title="加一个文件（会拷一份进应用数据目录）"
          disabled={addingFile}
          onClick={addFile}
        >
          {addingFile ? '选择中…' : '＋ 文件'}
        </button>
      </div>
    </div>
  );
}

/**
 * 一条**文字**资料：自适应高度的输入框 + 时间 + 删除。
 *
 * 直接就是可编辑的（不做「先看、点一下才编辑」那套）：这里的规矩是**写下来
 * 的东西就是活的**，点进去改和写的时候一样顺手。空着失焦 = 回退（同标题），
 * 想删就走 ✕。
 */
function TextItem({ att, store }: { att: Attachment; store: TasksStore }): ReactNode {
  const [value, setValue] = useState(att.text);
  const ref = useAutoResize(value);

  const save = (): void => {
    const trimmed = value.trim();
    if (trimmed === '') {
      setValue(att.text); // 空的不收，把库里的原样放回来
      return;
    }
    if (trimmed !== att.text) void store.updateAttachmentText(att.id, trimmed);
  };

  return (
    <li className="rd-task-material is-text" data-testid={`task-material-${att.id}`}>
      <div className="rd-task-material-head">
        <span className="rd-mono rd-muted rd-task-material-time">{formatTime(att.createdAt)}</span>
        <RemoveButton att={att} store={store} />
      </div>
      <textarea
        ref={ref}
        className="rd-task-material-text"
        data-testid={`task-material-text-${att.id}`}
        value={value}
        placeholder="（空）"
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
      />
      {/* 框里没法放可点的东西（textarea 是纯文本）—— 链接在下面单独一行
          渲染成能点的。用**已保存**的文本（正在打字时的半截链接不该可点） */}
      <LinkLine text={att.text} store={store} />
    </li>
  );
}

/**
 * 一条**文件**资料：图片给缩略图（点开看大图），别的给图标 + 名字 + 大小。
 *
 * 点名字 = 用系统默认程序打开（真实路径只在 Rust 侧解析，这边只递 id，
 * 见 `task_commands.rs` 的模块头）。图片**太大**（超过预览上限）就退回图标，
 * 不试着读进内存。
 */
function FileItem({ att, store }: { att: Attachment; store: TasksStore }): ReactNode {
  const [viewing, setViewing] = useState(false);
  const thumbable = isImageName(att.fileName) && att.fileSize <= PREVIEW_MAX;

  return (
    <li className="rd-task-material is-file" data-testid={`task-material-${att.id}`}>
      <div className="rd-task-material-head">
        <span className="rd-mono rd-muted rd-task-material-time">{formatTime(att.createdAt)}</span>
        <RemoveButton att={att} store={store} />
      </div>
      <div className="rd-task-material-file">
        {thumbable ? (
          <Thumbnail att={att} onOpen={() => setViewing(true)} />
        ) : (
          <span className="rd-task-material-icon" aria-hidden="true">
            📄
          </span>
        )}
        <span className="rd-task-material-fileinfo">
          <button
            type="button"
            className="rd-task-material-name"
            data-testid={`task-material-open-${att.id}`}
            title="用系统默认程序打开"
            onClick={() => void store.openAttachment(att.id)}
          >
            {att.fileName}
          </button>
          <span className="rd-muted rd-task-material-size">{formatBytes(att.fileSize)}</span>
        </span>
      </div>
      {viewing && <ImageViewer att={att} onClose={() => setViewing(false)} />}
    </li>
  );
}

/** 每条右边那个 ✕。删除是低频动作，但**一直看得见**（藏到 hover 里对触摸屏不友好） */
function RemoveButton({ att, store }: { att: Attachment; store: TasksStore }): ReactNode {
  return (
    <button
      type="button"
      className="rd-task-material-remove"
      data-testid={`task-material-remove-${att.id}`}
      title={att.kind === 'file' ? '删掉这条资料（盘上那份也删）' : '删掉这条资料'}
      aria-label="删掉这条资料"
      onClick={() => void store.removeAttachment(att.id)}
    >
      ✕
    </button>
  );
}

/**
 * 还没落库的新文字条目：点「＋文字」出来的空框，光标直接在里面。
 * 失焦时还空着就自己收掉（不落库、不报错）；有内容才交给 store。
 */
function DraftItem({ store, onDone }: { store: TasksStore; onDone: () => void }): ReactNode {
  const [value, setValue] = useState('');
  const ref = useAutoResize(value);

  // 点「＋文字」就是为了马上写 —— 光标直接落进去（只做一次，挂载时）
  useEffect(() => {
    ref.current?.focus();
  }, []);

  const commit = (): void => {
    const trimmed = value.trim();
    onDone(); // 草稿框先收起来，存不存得下都不该在界面上留个空框
    if (trimmed !== '') void store.addTextAttachment(trimmed);
  };

  return (
    <li className="rd-task-material is-text is-draft" data-testid="task-material-draft">
      <textarea
        ref={ref}
        className="rd-task-material-text"
        data-testid="task-material-draft-input"
        value={value}
        placeholder="写点什么…（点别处就存下；空着会自动收掉）"
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
      />
    </li>
  );
}

/** 把一段文字里的 http(s) 链接渲染成可点的一行（没有链接就什么都不画） */
function LinkLine({ text, store }: { text: string; store: TasksStore }): ReactNode {
  const urls = linkify(text).filter((p) => p.kind === 'url');
  if (urls.length === 0) return null;

  return (
    <p className="rd-task-material-links">
      链接：
      {urls.map((u, i) => (
        <button
          key={`${u.value}-${i}`}
          type="button"
          className="rd-task-link"
          data-testid="task-material-link"
          title="用系统浏览器打开"
          onClick={() => void store.openUrl(u.value)}
        >
          {u.value}
        </button>
      ))}
    </p>
  );
}

/**
 * 图片缩略图：按 id 把字节读回来做成 Blob URL。
 *
 * ⚠️ Blob URL 的生命周期要自己管：**创建即登记、卸载即 revoke**，而且这是
 * 在 `<StrictMode>` 下（dev 里 effect 会跑两遍）—— 靠 `alive` 标记让被放弃的
 * 那一次不设值、不清错，见 `shared/platform/web.ts` 里同款写法的注释。
 * 依赖只写 `[id]`：reload 换的是 props 不是这条资料，不需要重新拉字节。
 */
function useAttachmentUrl(att: Attachment): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let made: string | null = null;
    tasksClient
      .readAttachment(att.id)
      .then((bytes) => {
        if (!alive) return;
        made = URL.createObjectURL(new Blob([bytes], { type: mimeForName(att.fileName) }));
        setUrl(made);
      })
      .catch(() => {
        // 读不出来就什么都不画（外层会落到名字+图标那副样子）—— 真要打开的
        // 时候，错误会从「打开」那条路上完整地说出来，这里不重复弹
      });
    return () => {
      alive = false;
      if (made !== null) URL.revokeObjectURL(made);
    };
    // 依赖只写 `[att.id]`：资料没有改名功能，名字跟着 id 走 —— id 不变
    // 就不用重新拉字节（reload 换的是 props 不是这条资料）
  }, [att.id]);

  return url;
}

/** 图片文件名的 MIME（Blob 带上类型，`<img>` 那边就不用靠嗅探了） */
function mimeForName(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'bmp':
      return 'image/bmp';
    case 'avif':
      return 'image/avif';
    case 'svg':
      return 'image/svg+xml';
    default:
      return 'application/octet-stream';
  }
}

function Thumbnail({ att, onOpen }: { att: Attachment; onOpen: () => void }): ReactNode {
  const url = useAttachmentUrl(att);
  if (url === null) {
    // 还在读（或者读不出来）：占位，别闪
    return <span className="rd-task-thumb is-loading" aria-hidden="true" />;
  }
  return (
    <button
      type="button"
      className="rd-task-thumb"
      data-testid={`task-material-thumb-${att.id}`}
      title="点开看大图"
      onClick={onOpen}
    >
      <img src={url} alt={att.fileName} />
    </button>
  );
}

/** 应用内大图：点背景 / 按 Esc 关 */
function ImageViewer({ att, onClose }: { att: Attachment; onClose: () => void }): ReactNode {
  const url = useAttachmentUrl(att);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="rd-task-image-viewer"
      data-testid="task-image-viewer"
      role="dialog"
      aria-label={`查看 ${att.fileName}`}
      onClick={onClose}
    >
      {url === null ? (
        <span className="rd-muted">正在读图…</span>
      ) : (
        <img src={url} alt={att.fileName} onClick={(e) => e.stopPropagation()} />
      )}
    </div>
  );
}

/**
 * 进度记录：一条条带时间戳的「什么时候干了什么」。
 *
 * # 为什么要它（用户的原话：「归档后最后回顾才能知道」）
 *
 * 备注只有一个框，写的是**结论**（最后剩下什么）。而一件事的过程 ——
 * 中间试过什么、哪儿卡住过、怎么绕过去的 —— 恰恰是**回顾时最值钱**的部分，
 * 而它**没法事后补**（一周之后你只记得结论）。
 * 所以这里是**一条条记**：每记一笔自动带时间，读起来就是一条时间线。
 *
 * # 为什么没有「编辑/删除某一条」
 *
 * 它是一份**流水账**：改了就不叫记录了。记错了就在下一条里说清楚
 * （「上一条写错了，其实是……」）—— 这正是流水账该有的样子。
 */
function ProgressBox({
  task,
  store,
  progress,
}: {
  task: Task;
  store: TasksStore;
  progress: readonly Progress[];
}): ReactNode {
  const [draft, setDraft] = useState('');

  const submit = (): void => {
    const text = draft.trim();
    if (text === '') return;
    setDraft('');
    void store.addProgress(text);
  };

  return (
    <div className="rd-task-field">
      <span className="rd-task-field-head">
        <span className="rd-task-field-label">进度</span>
        <span className="rd-muted rd-task-field-hint">
          随手记一笔：刚干了什么、卡在哪。归档之后回头看的就靠它
        </span>
      </span>

      <div className="rd-task-progress-add">
        <input
          type="text"
          data-testid="task-progress-input"
          placeholder="刚干了什么 / 卡在哪 / 换了什么思路"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
        />
        <button
          type="button"
          className="rd-btn"
          data-testid="task-progress-add"
          disabled={draft.trim() === ''}
          onClick={submit}
        >
          记一笔
        </button>
      </div>

      {progress.length === 0 ? (
        <p className="rd-hint rd-muted" data-testid="task-progress-empty">
          还没有记录。这条时间线是你自己的事后回顾用的，别人看不到。
        </p>
      ) : (
        <ul className="rd-task-progress-list" data-testid="task-progress-list">
          {progress.map((entry) => (
            <li key={entry.id} className="rd-task-progress-item" data-testid={`task-progress-${entry.id}`}>
              <span className="rd-mono rd-muted rd-task-progress-time">{formatTime(entry.at)}</span>
              <span className="rd-task-progress-text">{entry.text}</span>
            </li>
          ))}
        </ul>
      )}
      {/* task 只是用来触发重建的（换任务时草稿要清掉） */}
      <span hidden>{task.id}</span>
    </div>
  );
}

/**
 * 标题那一格。
 *
 * 用 `key={task.id}` 让**换任务时组件重建** —— 否则受控输入会把上一条的内容
 * 留在框里（React 会复用同一个 DOM 节点），而「详情里显示的是别的任务」
 * 是最容易让人改错东西的一类 bug。
 */
function TitleField({ task, store }: { task: Task; store: TasksStore }): ReactNode {
  const [value, setValue] = useState(task.title);
  const ref = useRef<HTMLInputElement>(null);

  // 刚建出来的任务（标题还是默认那个）把光标放这儿：用户下一步一定是给它起名
  useEffect(() => {
    if (task.title === DEFAULT_TITLE) {
      ref.current?.focus();
      ref.current?.select();
    }
  }, [task.title]);

  const save = (): void => {
    const trimmed = value.trim();
    if (trimmed === '' || trimmed === task.title) {
      setValue(task.title); // 空标题不收，也不让框里留着空白
      return;
    }
    void store.patch(task.id, { title: trimmed });
  };

  return (
    <input
      ref={ref}
      type="text"
      className="rd-task-title-input"
      data-testid="task-title"
      aria-label="任务标题"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        // 回车就存（标题是单行，回车没有别的含义）
        if (e.key === 'Enter') {
          e.currentTarget.blur();
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          // 刚建出来、一个字没动的空任务：Esc = 放弃**整条**（2026-10-15
          // 体验评审：新建即落库，此前手滑建的「新任务」Esc 撤不掉、
          // 只能手动去删）
          if (isFreshDraft(task) && value === task.title) {
            void store.remove(task.id);
            return;
          }
          // 否则只是取消这次编辑：回到原值。⚠️ 不 blur —— blur 会触发
          // save()，把改了一半的字存下去
          setValue(task.title);
        }
      }}
    />
  );
}

/** 描述 / 文字资料共用一条规矩的框：多行、自适应高度、失焦保存 */
function Field({
  label,
  hint,
  value,
  testId,
  onSave,
}: {
  label: string;
  hint: string;
  value: string;
  testId: string;
  onSave: (next: string) => void;
}): ReactNode {
  const [draft, setDraft] = useState(value);
  const ref = useAutoResize(draft);

  const save = (): void => {
    if (draft !== value) onSave(draft);
  };

  return (
    <label className="rd-task-field">
      <span className="rd-task-field-head">
        <span className="rd-task-field-label">{label}</span>
        <span className="rd-muted rd-task-field-hint">{hint}</span>
      </span>
      <textarea
        ref={ref}
        className="rd-task-textarea"
        data-testid={testId}
        value={draft}
        placeholder="（空）"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
      />
    </label>
  );
}

/**
 * 让 textarea **跟着内容长**（用户提的「框太小，展示出来不好」）：
 * 每次内容变化就先把高度归零、再按 `scrollHeight` 撑开 —— 归零是必须的，
 * 否则删字的时候只会越撑越高。
 *
 * 多垫 2px 是给上下各 1px 的边框（`box-sizing: border-box` 的高度含边框，
 * 不算的话最后一行会差一点点、窗口里挂着一条极细的滚动）。
 */
function useAutoResize(value: string): RefObject<HTMLTextAreaElement | null> {
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [value]);

  return ref;
}

/** 主区空态：没选中任何任务时说清楚该干什么 */
export function TaskEmptyMain(): ReactNode {
  return (
    <div className="rd-empty rd-task-empty-main" data-testid="task-empty-main">
      左边点一条任务看它的内容；或者点「新建」记一条。
    </div>
  );
}
