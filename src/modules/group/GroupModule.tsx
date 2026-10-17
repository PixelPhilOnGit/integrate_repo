/**
 * 群组协作模块的四个槽位。
 *
 * * **侧栏**：群列表 + 选中群的成员状态（排队/思考/工具/完成/失败）
 * * **主区**：群头（模式 / 停止 / 清空）+ 时间线 + 带 @ 补全的输入框
 * * **检查器**：群设置 + 成员编辑（默认折叠，见外壳）
 * * **状态栏**：群数量 / 正在跑的轮次
 *
 * 复用 assistant 的聊天 CSS（`.rd-assistant-*`），群组特有的部分用 `.rd-group-*`。
 * ⚠️ 检查器里的小控件（＋成员、删除、探测）都挂了 `data-testid`，
 * `ui-regressions.spec.ts` 会量它们的命中区。
 */

import {
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

import { platform } from '../../shared/platform';
import { useModalKeys } from '../../shared/ui/useModalKeys';
import type { ChatMessage, MemberRun } from './core/chat';
import {
  KIND_HINT,
  KIND_LABEL,
  PERMISSION_HINT,
  PERMISSION_LABEL,
  formatExtraArgs,
  parseExtraArgs,
} from './core/config';
import {
  applyMention,
  filterCandidates,
  mentionQuery,
  parseMentions,
} from './core/mention';
import type { CliKind, CliProbe, MemberConfig, Permission } from './services/types';
import { groupStore } from './state/store';

function useGroup() {
  return useSyncExternalStore(groupStore.subscribe, groupStore.getSnapshot);
}

/** 成员色条/名字的颜色（按成员位置取）。不用 CSS 变量以外的状态。 */
const MEMBER_COLORS = ['#7aa2f7', '#9ece6a', '#e0af68', '#bb9af7', '#7dcfff', '#f7768e'];

function memberColor(memberId: string | null, members: MemberConfig[]): string {
  if (memberId === null) return MEMBER_COLORS[0] ?? '#7aa2f7';
  const index = members.findIndex((m) => m.id === memberId);
  const palette = MEMBER_COLORS;
  return palette[(index >= 0 ? index : 0) % palette.length] ?? '#7aa2f7';
}

const RUN_LABEL: Record<MemberRun['phase'], string> = {
  queued: '排队中',
  thinking: '思考中',
  tool: '用工具',
  done: '完成',
  failed: '失败',
  cancelled: '已停止',
};
const IDLE_LABEL = '空闲';

// ---------------------------------------------------------------- 侧栏

export function GroupSidebar(): ReactNode {
  const state = useGroup();
  const [creating, setCreating] = useState(false);

  return (
    <div className="rd-panel rd-group-sidebar" data-testid="group-sidebar">
      <div className="rd-group-side-head">
        <span className="rd-panel-title">群组</span>
        <button
          type="button"
          className="rd-group-icon-btn"
          data-testid="group-new"
          title="新建群"
          aria-label="新建群"
          onClick={() => setCreating(true)}
        >
          ＋
        </button>
      </div>

      {state.groups.length === 0 ? (
        <div className="rd-group-empty">
          <p className="rd-hint">还没有群。建一个，把本机的 claude / codex / csc 拉进来。</p>
          <button
            type="button"
            className="rd-btn-primary"
            data-testid="group-new-empty"
            onClick={() => setCreating(true)}
          >
            新建群
          </button>
        </div>
      ) : (
        <div className="rd-group-list">
          {state.groups.map((g) => {
            const selected = state.selectedId === g.id;
            return (
              <button
                key={g.id}
                type="button"
                className={`rd-group-row${selected ? ' is-selected' : ''}`}
                data-testid="group-row"
                data-group-name={g.name}
                onClick={() => void groupStore.selectGroup(g.id)}
              >
                <span className="rd-group-row-name">{g.name}</span>
                <span className="rd-muted">{g.memberCount} 人</span>
                {state.runningGroups[g.id] === true && (
                  <span className="rd-group-live-dot" title="有一轮在跑" />
                )}
              </button>
            );
          })}
        </div>
      )}

      {state.detail !== null && state.detail.members.length > 0 && (
        <div className="rd-group-member-rail" data-testid="group-member-rail">
          {state.detail.members.map((m) => {
            const run = state.runs[m.id];
            const phase = run?.phase ?? null;
            return (
              <div
                key={m.id}
                className={`rd-group-member-line${m.enabled ? '' : ' is-disabled'}`}
                data-testid="group-member-status-row"
              >
                <span
                  className="rd-group-member-dot"
                  style={{ background: memberColor(m.id, state.detail?.members ?? []) }}
                />
                <span className="rd-group-member-line-name">{m.name || '（未命名）'}</span>
                <span
                  className={`rd-group-member-status is-${phase ?? 'idle'}`}
                  data-testid="group-member-status"
                  data-phase={phase ?? 'idle'}
                >
                  {phase === null ? IDLE_LABEL : RUN_LABEL[phase]}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {creating && <NewGroupDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

function NewGroupDialog({ onClose }: { onClose: () => void }): ReactNode {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useModalKeys({ ref });

  const submit = (): void => {
    const trimmed = name.trim();
    if (trimmed === '' || busy) return;
    setBusy(true);
    void (async () => {
      await groupStore.createGroup(trimmed);
      onClose();
    })();
  };

  return (
    <div className="rd-modal-backdrop">
      <div className="rd-modal" ref={ref} role="dialog" aria-modal="true" aria-labelledby="group-new-title">
        <h2 className="rd-modal-title" id="group-new-title">
          新建群
        </h2>
        <p className="rd-hint">
          群里的成员是本机的 CLI（claude / codex / csc）。建好之后在右侧检查器里
          添加成员、选共享工作目录。
        </p>
        <input
          className="rd-rename-input"
          data-testid="group-new-name"
          autoFocus
          value={name}
          placeholder="例如：项目评审群"
          aria-label="群名"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
            e.stopPropagation();
          }}
        />
        <div className="rd-modal-actions">
          <button type="button" data-testid="group-new-cancel" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="rd-btn-primary"
            data-testid="group-new-confirm"
            disabled={name.trim() === '' || busy}
            onClick={submit}
          >
            建好
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 主区

export function GroupMain(): ReactNode {
  const state = useGroup();
  const detail = state.detail;

  if (!state.ready) {
    return (
      <div className="rd-main-panel" data-testid="group-main-loading">
        <p className="rd-hint">正在打开群组…</p>
      </div>
    );
  }

  if (detail === null) {
    return (
      <div className="rd-main-panel rd-group-empty-main" data-testid="group-main">
        <h3>群组协作</h3>
        <p className="rd-hint">
          把本机的 claude、codex、csc 拉进一个群：<strong>不 @ 就是全员回答</strong>，
          <strong>@ 谁就只有谁回答</strong>；顺序模式下后发言的成员能看到前面成员的
          回答。所有成员共享一个工作目录，可以改那里的文件。
        </p>
        <button
          type="button"
          className="rd-btn-primary"
          data-testid="group-create-first"
          onClick={() => void groupStore.createGroup('我的群')}
        >
          先建一个群
        </button>
      </div>
    );
  }

  const running = state.runningGroups[detail.id] === true;
  const enabled = detail.members.filter((m) => m.enabled);

  return (
    <div className="rd-group-chat" data-testid="group-main">
      <div className="rd-group-bar">
        <span className="rd-group-title" data-testid="group-title">
          {detail.name}
        </span>
        <span className="rd-muted">{enabled.length} 位成员</span>
        <span className="rd-spacer" />
        <select
          className="rd-group-mode"
          data-testid="group-mode"
          value={detail.mode}
          disabled={running}
          title="顺序接力：后发言者能看到前面的回答；并行：本轮互不可见"
          onChange={(e) => {
            groupStore.patchDetail({ mode: e.target.value as 'sequential' | 'parallel' });
            void groupStore.persist();
          }}
        >
          <option value="sequential">顺序接力</option>
          <option value="parallel">并行</option>
        </select>
        {running ? (
          <button
            type="button"
            className="rd-danger"
            data-testid="group-stop"
            onClick={() => void groupStore.stop()}
          >
            停止
          </button>
        ) : (
          <button
            type="button"
            data-testid="group-clear"
            disabled={state.messages.length === 0}
            onClick={() => {
              void (async () => {
                const ok = await platform.confirm(
                  `清空「${detail.name}」的全部对话记录？不能撤销。`,
                  '清空对话',
                );
                if (ok) await groupStore.clearHistory();
              })();
            }}
          >
            清空对话
          </button>
        )}
      </div>

      <div className="rd-group-stream" data-testid="group-stream">
        {state.messages.length === 0 ? (
          <EmptyChat />
        ) : (
          state.messages.map((m) => (
            <MessageRow key={m.key} message={m} members={detail.members} />
          ))
        )}
        {running && (
          <div className="rd-group-running" data-testid="group-running">
            这一轮还在跑…（可以先切走，回来用「清空对话」旁边的状态确认）
          </div>
        )}
      </div>

      <Composer
        members={enabled}
        running={running || state.sending}
        error={state.error}
      />
    </div>
  );
}

function EmptyChat(): ReactNode {
  return (
    <div className="rd-group-empty-chat" data-testid="group-empty-chat">
      <p className="rd-hint">
        说一句话。群里所有成员都会回答；用 <code>@名字</code> 只叫某几个。
      </p>
      <p className="rd-hint rd-muted">
        顺序模式下，后发言的成员能看到本轮前面成员的完整回答 —— 这是「看到彼此」的默认形态。
      </p>
    </div>
  );
}

function MessageRow({
  message,
  members,
}: {
  message: ChatMessage;
  members: MemberConfig[];
}): ReactNode {
  if (message.role === 'user') {
    return (
      <div className="rd-group-msg is-user" data-testid="group-msg-user">
        <div className="rd-group-bubble">{message.text}</div>
      </div>
    );
  }
  if (message.role === 'system') {
    return (
      <div className="rd-group-msg is-system" data-testid="group-msg-system">
        {message.text}
      </div>
    );
  }

  const color = memberColor(message.memberId, members);
  const status = message.status;
  return (
    <div
      className="rd-group-msg is-member"
      data-testid="group-msg-member"
      data-member-name={message.speakerName}
      style={{ ['--rd-member-color' as string]: color }}
    >
      <div className="rd-group-msg-head">
        <span className="rd-group-member-dot" style={{ background: color }} />
        <span className="rd-group-member-name">{message.speakerName}</span>
        {status === 'queued' && <span className="rd-muted">排队中…</span>}
        {status === 'streaming' && <span className="rd-muted">正在回复…</span>}
        {status === 'failed' && <span className="rd-danger">失败</span>}
        {status === 'cancelled' && <span className="rd-muted">已停止</span>}
      </div>
      {message.text !== '' && <div className="rd-group-bubble">{message.text}</div>}
      {message.tools.map((tool, index) => (
        <div
          key={`${message.key}-tool-${index}`}
          className={`rd-assistant-tool${tool.isError === true ? ' is-error' : ''}`}
          data-testid="group-tool"
        >
          <span className="rd-assistant-tool-mark">
            {tool.isError === null ? '·' : tool.isError ? '✗' : '✓'}
          </span>
          <span>{tool.display}</span>
        </div>
      ))}
      {message.error !== null && message.error !== '' && (
        <div className="rd-group-error" data-testid="group-msg-error">
          {message.error}
        </div>
      )}
    </div>
  );
}

function Composer({
  members,
  running,
  error,
}: {
  members: MemberConfig[];
  running: boolean;
  error: string | null;
}): ReactNode {
  const [draft, setDraft] = useState('');
  const [caret, setCaret] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const composing = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const mentionMembers = useMemo(
    () => members.map((m) => ({ memberId: m.id, name: m.name })),
    [members],
  );
  const query = mentionQuery(draft, caret);
  const candidates = query === null ? [] : filterCandidates(mentionMembers, query.query);
  const open = query !== null && candidates.length > 0 && dismissedAt !== query.start;
  const parsed = parseMentions(draft, mentionMembers);
  const unknown = parsed.unknown;

  const syncCaret = (): void => {
    setCaret(inputRef.current?.selectionStart ?? 0);
  };

  const submit = (): void => {
    if (draft.trim() === '' || running || unknown.length > 0) return;
    const text = draft;
    void (async () => {
      const ok = await groupStore.send(text);
      if (ok) {
        setDraft('');
        setCaret(0);
      }
    })();
  };

  const choose = (name: string): void => {
    const next = applyMention(draft, caret, name);
    setDraft(next.text);
    setCaret(next.caret);
    // 选中之后**先把面板关掉**（光标还紧跟着 @片段，否则它会立刻重新弹出来）；
    // 用户继续打字时 onChange 会把 dismissedAt 清掉。
    setDismissedAt(query?.start ?? null);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el !== null) {
        el.focus();
        el.setSelectionRange(next.caret, next.caret);
      }
    });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    // 输入法组合期间不抢键（Enter 是「选字」，不是发送）。
    if (e.nativeEvent.isComposing || composing.current) return;

    if (open) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex((i) => (i + 1) % candidates.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex((i) => (i - 1 + candidates.length) % candidates.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const hit = candidates[activeIndex];
        if (hit !== undefined) choose(hit.name);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setDismissedAt(query?.start ?? null);
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="rd-group-composer">
      {open && query !== null && (
        <div
          className="rd-group-mention-panel"
          data-testid="group-mention-panel"
          role="listbox"
          aria-label="选择成员"
        >
          {candidates.map((c, index) => (
            <button
              key={c.memberId}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              className={`rd-group-mention-item${index === activeIndex ? ' is-active' : ''}`}
              data-testid="group-mention-item"
              onMouseDown={(e) => {
                // mousedown 而不是 click：click 之前 textarea 会先 blur
                e.preventDefault();
                choose(c.name);
              }}
            >
              {c.name}
            </button>
          ))}
        </div>
      )}

      {unknown.length > 0 && (
        <div className="rd-group-unknown" data-testid="group-unknown-mention">
          群里没有这些成员：{unknown.map((n) => `@${n}`).join('、')}
        </div>
      )}
      {error !== null && (
        <div className="rd-group-error" data-testid="group-error">
          {error}
        </div>
      )}

      <div className="rd-group-composer-row">
        <textarea
          ref={inputRef}
          className="rd-assistant-input"
          data-testid="group-input"
          placeholder="说点什么，或用 @名字 点名…"
          value={draft}
          rows={2}
          onChange={(e) => {
            setDraft(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
            setDismissedAt(null);
            setActiveIndex(0);
          }}
          onKeyDown={onKeyDown}
          onSelect={syncCaret}
          onClick={syncCaret}
          onKeyUp={syncCaret}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
            syncCaret();
          }}
        />
        {running ? (
          <button
            type="button"
            className="rd-danger"
            data-testid="group-send"
            onClick={() => void groupStore.stop()}
          >
            停止
          </button>
        ) : (
          <button
            type="button"
            className="rd-btn-primary"
            data-testid="group-send"
            disabled={draft.trim() === '' || unknown.length > 0}
            onClick={submit}
          >
            发送
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 检查器

export function GroupInspector(): ReactNode {
  const state = useGroup();
  const detail = state.detail;
  if (detail === null) {
    return (
      <div className="rd-panel rd-group-inspector" data-testid="group-inspector">
        <p className="rd-hint">先在左边选一个群。</p>
      </div>
    );
  }

  return (
    <div className="rd-panel rd-group-inspector" data-testid="group-inspector">
      <div className="rd-group-inspector-body">
        <h4 className="rd-agent-section-title">群设置</h4>
        <label className="rd-group-field">
          <span>群名</span>
          <input
            className="rd-rename-input"
            data-testid="group-name"
            value={detail.name}
            onChange={(e) => groupStore.patchDetail({ name: e.target.value })}
            onBlur={() => void groupStore.persist()}
          />
        </label>

        <div className="rd-group-field">
          <span>共享工作目录</span>
          <div className="rd-group-inline">
            <code className="rd-group-path" data-testid="group-workspace-path">
              {detail.workspace === '' ? '（未选择）' : detail.workspace}
            </code>
            <button
              type="button"
              className="rd-group-icon-btn"
              data-testid="group-workspace-pick"
              onClick={() => {
                void (async () => {
                  const picked = await platform.pickWorkspace();
                  if (picked !== null) {
                    groupStore.patchDetail({ workspace: picked });
                    await groupStore.persist();
                  }
                })();
              }}
            >
              选择…
            </button>
          </div>
          <p className="rd-hint rd-muted">
            ⚠️ 所有成员共享这个目录；可写档位下它们会**真的改这里的文件**。
          </p>
        </div>

        <label className="rd-group-field">
          <span>上下文</span>
          <div className="rd-group-inline">
            <input
              className="rd-rename-input rd-group-num"
              data-testid="group-context-turns"
              type="number"
              min={1}
              max={50}
              value={detail.contextTurns}
              onChange={(e) =>
                groupStore.patchDetail({ contextTurns: Number(e.target.value) })
              }
              onBlur={() => void groupStore.persist()}
            />
            <span className="rd-muted">轮 /</span>
            <input
              className="rd-rename-input rd-group-num"
              data-testid="group-context-chars"
              type="number"
              min={1000}
              max={200000}
              step={1000}
              value={detail.contextChars}
              onChange={(e) =>
                groupStore.patchDetail({ contextChars: Number(e.target.value) })
              }
              onBlur={() => void groupStore.persist()}
            />
            <span className="rd-muted">字</span>
          </div>
        </label>

        <label className="rd-group-field">
          <span>单个成员超时（秒）</span>
          <input
            className="rd-rename-input rd-group-num"
            data-testid="group-timeout"
            type="number"
            min={10}
            max={3600}
            value={detail.timeoutSecs}
            onChange={(e) => groupStore.patchDetail({ timeoutSecs: Number(e.target.value) })}
            onBlur={() => void groupStore.persist()}
          />
        </label>

        <div className="rd-group-inspector-actions">
          <button
            type="button"
            className="rd-danger"
            data-testid="group-delete"
            onClick={() => {
              void (async () => {
                const ok = await platform.confirm(
                  `删除群「${detail.name}」？群里的对话记录会一起删掉，不能撤销。`,
                  '删除群',
                );
                if (ok) await groupStore.deleteGroup(detail.id);
              })();
            }}
          >
            删除这个群
          </button>
          <span className="rd-spacer" />
          <span className="rd-muted" data-testid="group-save-state">
            {state.saving ? '保存中…' : state.notice ?? ''}
          </span>
        </div>

        <h4 className="rd-agent-section-title">
          成员
          <button
            type="button"
            className="rd-group-icon-btn"
            data-testid="group-member-add"
            title="加一个成员"
            aria-label="加一个成员"
            disabled={state.saving}
            onClick={() => void groupStore.addMember()}
          >
            ＋
          </button>
        </h4>

        {detail.members.length === 0 ? (
          <p className="rd-hint" data-testid="group-member-empty">
            还没有成员。点上面的 ＋ 加一个（默认是 claude）。
          </p>
        ) : (
          detail.members.map((m) => (
            <MemberCard key={m.id === '' ? `new-${m.position}` : m.id} member={m} />
          ))
        )}
      </div>
    </div>
  );
}

function MemberCard({ member }: { member: MemberConfig }): ReactNode {
  const [argDraft, setArgDraft] = useState<string | null>(null);
  const [probe, setProbe] = useState<CliProbe | null>(null);
  const saving = useGroup().saving;

  const patch = (p: Partial<MemberConfig>): void => {
    if (member.id === '') return; // 还没落库（addMember 会等它）
    groupStore.patchMember(member.id, p);
  };

  return (
    <div className="rd-group-member-card" data-testid="group-member-card">
      <div className="rd-group-member-card-head">
        <input
          className="rd-rename-input"
          data-testid="group-member-name"
          value={member.name}
          aria-label="成员名字"
          onChange={(e) => patch({ name: e.target.value })}
          onBlur={() => void groupStore.persist()}
        />
        <label className="rd-group-check" title="停用的成员不会被 @ 到，也不参加广播">
          <input
            type="checkbox"
            data-testid="group-member-enabled"
            checked={member.enabled}
            onChange={(e) => {
              patch({ enabled: e.target.checked });
              void groupStore.persist();
            }}
          />
          启用
        </label>
        <button
          type="button"
          className="rd-danger rd-group-icon-btn"
          data-testid="group-member-delete"
          title="删除成员"
          aria-label={`删除成员 ${member.name}`}
          onClick={() => {
            void (async () => {
              const ok = await platform.confirm(
                `删除成员「${member.name}」？历史消息会保留。`,
                '删除成员',
              );
              if (ok) await groupStore.removeMember(member.id);
            })();
          }}
        >
          ✕
        </button>
      </div>

      <label className="rd-group-field">
        <span>工具</span>
        <select
          className="rd-group-select"
          data-testid="group-member-kind"
          value={member.kind}
          onChange={(e) => {
            patch({ kind: e.target.value as CliKind });
            void groupStore.persist();
          }}
        >
          {(Object.keys(KIND_LABEL) as CliKind[]).map((kind) => (
            <option key={kind} value={kind}>
              {KIND_LABEL[kind]}
            </option>
          ))}
        </select>
        <p className="rd-hint rd-muted">{KIND_HINT[member.kind]}</p>
      </label>

      <label className="rd-group-field">
        <span>命令（空 = 默认）</span>
        <input
          className="rd-rename-input"
          data-testid="group-member-command"
          value={member.command}
          placeholder={
            member.kind === 'custom' ? '必填，例如 /usr/local/bin/my-agent' : '空 = 用默认程序'
          }
          onChange={(e) => patch({ command: e.target.value })}
          onBlur={() => void groupStore.persist()}
        />
      </label>

      <label className="rd-group-field">
        <span>模型（空 = CLI 默认）</span>
        <input
          className="rd-rename-input"
          data-testid="group-member-model"
          value={member.model}
          onChange={(e) => patch({ model: e.target.value })}
          onBlur={() => void groupStore.persist()}
        />
      </label>

      <label className="rd-group-field">
        <span>权限</span>
        <select
          className="rd-group-select"
          data-testid="group-member-permission"
          value={member.permission}
          onChange={(e) => {
            patch({ permission: e.target.value as Permission });
            void groupStore.persist();
          }}
        >
          {(Object.keys(PERMISSION_LABEL) as Permission[]).map((p) => (
            <option key={p} value={p}>
              {PERMISSION_LABEL[p]}
            </option>
          ))}
        </select>
        <p className={`rd-hint${member.permission === 'full' ? ' rd-danger' : ' rd-muted'}`}>
          {PERMISSION_HINT[member.permission]}
        </p>
      </label>

      <label className="rd-group-field">
        <span>角色提示词</span>
        <textarea
          className="rd-rename-input rd-group-textarea"
          data-testid="group-member-role"
          value={member.rolePrompt}
          rows={2}
          placeholder="例如：你负责后端与数据库设计"
          onChange={(e) => patch({ rolePrompt: e.target.value })}
          onBlur={() => void groupStore.persist()}
        />
      </label>

      <label className="rd-group-field">
        <span>额外参数（一行一个）</span>
        <textarea
          className="rd-rename-input rd-group-textarea"
          data-testid="group-member-args"
          value={argDraft ?? formatExtraArgs(member.extraArgs)}
          rows={2}
          placeholder="例如：--bare"
          onChange={(e) => setArgDraft(e.target.value)}
          onBlur={() => {
            if (argDraft !== null) {
              patch({ extraArgs: parseExtraArgs(argDraft) });
              setArgDraft(null);
              void groupStore.persist();
            }
          }}
        />
      </label>

      <div className="rd-group-inline">
        <button
          type="button"
          data-testid="group-member-probe"
          disabled={saving}
          onClick={() => {
            void (async () => {
              const result = await groupStore.probe(
                member.kind,
                member.command === '' ? null : member.command,
              );
              setProbe(result);
            })();
          }}
        >
          探测
        </button>
        <span className="rd-muted" data-testid="group-member-probe-result">
          {probe === null
            ? ''
            : probe.available
              ? (probe.version ?? '可用')
              : (probe.error ?? '不可用')}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 状态栏

export function GroupStatusItems(): ReactNode {
  const state = useGroup();
  const running = Object.values(state.runningGroups).filter(Boolean).length;
  return (
    <span className="rd-muted" data-testid="group-status">
      {state.groups.length} 个群{running > 0 ? ` · ${running} 轮在跑` : ''}
    </span>
  );
}
