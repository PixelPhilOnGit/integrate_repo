/**
 * 新建会话：一次定「各来几个」，最下面挂启动参数的入口。
 *
 * # 为什么是填数量，而不是点一次建一个
 *
 * 用户开工时的心智是「这个项目我要开两个 claude、一个 codex、一个终端」，
 * 而不是一个一个点四下。填完一次建完，**并且一次把网格摆好** —— 逐格摆屏
 * 中间那几帧是看得见的抖动（见 store 的 `createMany`）。
 *
 * # 启动参数为什么在这里
 *
 * 它是**全局**的（所有工作目录共用一套，见 `LaunchArgs`），所以既不属于某个
 * 工作目录的右键菜单，也不属于检查器。放在「新建会话」这一步最顺手：用户正是
 * 在这儿决定「接下来要起什么进程」的。入口固定在对话框最下面，不去挤数量那几行。
 *
 * # 两个对话框是「换页」不是「叠加」
 *
 * 点「启动参数」时**只渲染参数那个**（数量留在本组件的 state 里，回来还在）。
 * 叠两层背板会让背景暗两次，看着像出了重影。
 */

import { useState, type ReactNode } from 'react';
import { platform } from '../../../shared/platform';
import {
  KIND_LABEL,
  MAX_SESSIONS_PER_KIND,
  type AgentWorkspace,
  type LaunchArgs,
} from '../core/types';
import type { AgentsState, AgentsStore } from '../state/store';

/**
 * 对话框里能填的三类，**顺序就是网格里的顺序**（见 `SessionRequest`）。
 *
 * `custom` 不在里面：它连默认启动命令都还没有，界面上一直没暴露。
 */
const KINDS = ['claude', 'codex', 'shell'] as const;
type CountedKind = (typeof KINDS)[number];

interface Props {
  state: AgentsState;
  store: AgentsStore;
  workspace: AgentWorkspace;
  onClose: () => void;
}

export function NewSessionDialog({ state, store, workspace, onClose }: Props): ReactNode {
  // 默认一个 claude：侧栏那个「＋」以前就是直接开一个 claude，
  // 用户的手感是「点一下 = 来一个」，别让他在对话框里再点一次
  const [counts, setCounts] = useState<Record<CountedKind, number>>({
    claude: 1,
    codex: 0,
    shell: 0,
  });
  const [argsOpen, setArgsOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const total = KINDS.reduce((sum, kind) => sum + counts[kind], 0);

  const setCount = (kind: CountedKind, raw: string): void => {
    const parsed = Number.parseInt(raw, 10);
    // 解析不出来就当 0：数字框允许中途是空的（用户全选删掉再打下一个数）
    const value = Number.isFinite(parsed)
      ? Math.max(0, Math.min(parsed, MAX_SESSIONS_PER_KIND))
      : 0;
    setCounts((c) => ({ ...c, [kind]: value }));
  };

  const submit = (): void => {
    if (total === 0 || busy) return;
    setBusy(true);
    void store
      .createMany(
        workspace.id,
        KINDS.map((kind) => ({ kind, count: counts[kind] })),
      )
      .finally(onClose);
  };

  if (argsOpen) {
    return <LaunchArgsDialog state={state} store={store} onClose={() => setArgsOpen(false)} />;
  }

  return (
    <div className="rd-modal-backdrop" data-testid="agent-new-dialog">
      <div className="rd-modal" role="dialog" aria-modal="true" aria-labelledby="agent-new-title">
        <h2 className="rd-modal-title" id="agent-new-title">
          新建会话
        </h2>
        <p className="rd-hint">
          在 <span className="rd-mono">{workspace.name}</span> 里一次开几个：
        </p>

        {KINDS.map((kind) => (
          <label className="rd-field rd-count" key={kind}>
            <span>{KIND_LABEL[kind]}</span>
            <input
              type="number"
              min={0}
              max={MAX_SESSIONS_PER_KIND}
              inputMode="numeric"
              data-testid={`agent-new-count-${kind}`}
              value={counts[kind]}
              onChange={(e) => setCount(kind, e.target.value)}
            />
          </label>
        ))}

        <p className="rd-hint rd-muted" data-testid="agent-new-summary">
          {total === 0 ? '还没填数量' : `一共 ${total} 个，建成后铺成网格`}
        </p>

        <div className="rd-modal-actions">
          {/* 固定在最下面、最左边：参数是「设一次管很久」的东西，
              不该跟着每次新建的节奏走 */}
          <button
            type="button"
            className="rd-modal-actions-left"
            data-testid="agent-new-args"
            onClick={() => setArgsOpen(true)}
          >
            启动参数…
          </button>
          <button type="button" data-testid="agent-new-cancel" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="rd-btn-primary"
            data-testid="agent-new-confirm"
            disabled={total === 0 || busy}
            onClick={submit}
          >
            {busy ? '正在开…' : `新建 ${total} 个`}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * 启动参数：claude / codex 各一行，**原样追加**到启动命令后面。
 *
 * 保存后只影响**之后新建**的会话 —— 已经在跑的进程，命令行是操作系统持有的，
 * 谁也改不了。这句话必须写在界面上，否则用户会以为改完立刻生效。
 */
function LaunchArgsDialog({
  state,
  store,
  onClose,
}: {
  state: AgentsState;
  store: AgentsStore;
  onClose: () => void;
}): ReactNode {
  // 先放草稿再保存：打一半就想取消是最常见的事，直接写 store 就撤不回来了
  const [draft, setDraft] = useState<LaunchArgs>({ ...state.launchArgs });
  const [draftGitBash, setDraftGitBash] = useState(state.gitBashPath);

  const save = (): void => {
    store.setLaunchArgs(draft);
    store.setGitBashPath(draftGitBash);
    onClose();
  };

  /**
   * 「浏览…」选 bash.exe。
   *
   * 选不了（浏览器版、或者用户取消）就当没点 —— 手填那条路一直在，
   * 不用为它弹什么错误。
   */
  const browseGitBash = async (): Promise<void> => {
    try {
      const picked = await platform.pickFile('选择 bash.exe');
      if (picked !== null) setDraftGitBash(picked);
    } catch {
      // 见上：不打断用户
    }
  };

  return (
    <div className="rd-modal-backdrop" data-testid="agent-args-dialog">
      <div className="rd-modal" role="dialog" aria-modal="true" aria-labelledby="agent-args-title">
        <h2 className="rd-modal-title" id="agent-args-title">
          启动参数
        </h2>
        <p className="rd-hint">
          会原样追加到启动命令后面。比如{' '}
          <code className="rd-mono">--dangerously-skip-permissions</code> 会让 Claude Code
          不再逐次征求你的同意就动手 —— 这类参数改的是它能自己做多少事，填之前想清楚。
        </p>

        <label className="rd-field">
          <span>{KIND_LABEL.claude}</span>
          <input
            type="text"
            data-testid="agent-args-claude"
            placeholder="例如 --dangerously-skip-permissions"
            value={draft.claude}
            onChange={(e) => setDraft((d) => ({ ...d, claude: e.target.value }))}
          />
        </label>

        <label className="rd-field">
          <span>{KIND_LABEL.codex}</span>
          <input
            type="text"
            data-testid="agent-args-codex"
            placeholder="例如 --full-auto"
            value={draft.codex}
            onChange={(e) => setDraft((d) => ({ ...d, codex: e.target.value }))}
          />
        </label>

        <p className="rd-hint rd-muted">
          只影响之后新建的会话。已经在跑的那些改不了 —— 命令行在进程起来之后就定死了。
        </p>

        {/* Windows 上老版 claude 要的 Git Bash。单独一节，因为它不是「参数」，
            而且**找不到时是它报错**（用户得知道这儿有个地方能填） */}
        <h3 className="rd-modal-subtitle">Windows 上的 Git Bash</h3>
        <p className="rd-hint">
          老版 Claude Code 在 Windows 上一定要 Git Bash（新版可以用 PowerShell，
          那就留空）。**留空 = 自动找**：先问注册表、再看 PATH 里的 git、最后看
          几个标准位置。装在别处（比如 D 盘的某个目录）就填在这儿。
        </p>
        <p className="rd-hint rd-muted">
          ⚠️ 要填到 <code className="rd-mono">bin\bash.exe</code> —— 不是 Git 根目录
          那个 <code className="rd-mono">git-bash.exe</code>（那是开窗口的启动器，
          claude 不认）。
        </p>

        <label className="rd-field">
          <span>bash.exe 路径</span>
          <span className="rd-agent-path-row">
            <input
              type="text"
              data-testid="agent-args-gitbash"
              placeholder="留空 = 自动找，例如 D:\software\git\install\Git\bin\bash.exe"
              value={draftGitBash}
              onChange={(e) => setDraftGitBash(e.target.value)}
            />
            <button
              type="button"
              data-testid="agent-args-gitbash-browse"
              onClick={() => void browseGitBash()}
            >
              浏览…
            </button>
          </span>
        </label>
        {draftGitBash.trim() !== '' && (
          <p className="rd-hint" data-testid="agent-args-gitbash-set">
            会原样交给 claude（不验证存在）—— 路径不对的话它会报
            <code className="rd-mono"> unable to find</code>，回来改这个框就行。
          </p>
        )}

        <div className="rd-modal-actions">
          <button type="button" data-testid="agent-args-cancel" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="rd-btn-primary"
            data-testid="agent-args-save"
            onClick={save}
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
