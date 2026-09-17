/**
 * 主区域：命令台。
 *
 * 上半是输出日志，下半是输入行。手感对齐 redis-cli：
 * Enter 执行、↑↓ 翻历史、Ctrl+L 清屏，输出用等宽字体。
 *
 * 命令**串行**执行（有命令在飞时输入框禁用）：和 redis-cli 一致，
 * 也免了「两条命令的输出交错在一起」这种看起来像 bug 的显示。
 */

import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { formatElapsed, renderReply } from '../core/render';
import type { LogEntry } from '../core/types';
import type { RedisState, RedisStore } from '../state/store';

interface Props {
  state: RedisState;
  store: RedisStore;
}

export function Console({ state, store }: Props): ReactNode {
  const profile = store.selectedProfile();
  const runtime = profile ? state.runtime[profile.id] : undefined;
  const connected = runtime?.status === 'connected';
  const disabled = !connected || state.running;

  const outputRef = useRef<HTMLDivElement>(null);
  // 默认贴着底走；用户往上翻看历史时别把他拽回去
  const stickToBottom = useRef(true);

  useEffect(() => {
    const el = outputRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [state.log.length, state.running]);

  const onScroll = (): void => {
    const el = outputRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void store.runCommand(state.draft);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      store.historyPrev();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      store.historyNext();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') {
      e.preventDefault();
      store.clearLog();
    }
  };

  return (
    <div className="rd-console" data-testid="redis-console">
      <div className="rd-console-output" ref={outputRef} onScroll={onScroll} data-testid="console-output">
        {state.log.length === 0 ? (
          <p className="rd-hint">
            {connected
              ? '连接好了，敲一条命令试试（比如 PING）。↑↓ 翻历史，Ctrl+L 清屏。'
              : '先在左边选一个连接并连上，然后在这里敲命令。'}
          </p>
        ) : (
          state.log.map((entry) => <LogLine key={entry.seq} entry={entry} />)
        )}
      </div>

      <div className="rd-console-input">
        <span className="rd-console-prompt" aria-hidden="true">
          {profile ? `${profile.name}>` : '>'}
        </span>
        <input
          type="text"
          data-testid="console-input"
          value={state.draft}
          disabled={disabled}
          spellCheck={false}
          autoComplete="off"
          placeholder={consolePlaceholder(connected, state.running, runtime?.error ?? null)}
          onChange={(e) => store.setDraft(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button
          type="button"
          data-testid="btn-console-run"
          disabled={disabled || state.draft.trim() === ''}
          onClick={() => void store.runCommand(state.draft)}
        >
          执行
        </button>
        <button type="button" data-testid="btn-console-clear" onClick={() => store.clearLog()}>
          清空
        </button>
      </div>
    </div>
  );
}

function consolePlaceholder(connected: boolean, running: boolean, error: string | null): string {
  if (running) return '正在执行…';
  if (error) return '连接出错了，重新连接之后再试';
  return connected ? '输入命令，回车执行' : '未连接';
}

function LogLine({ entry }: { entry: LogEntry }): ReactNode {
  switch (entry.kind) {
    case 'input':
      return (
        <div className="rd-console-line rd-console-cmd" data-testid="console-line" data-kind="input">
          <span className="rd-console-prompt">{entry.connection}&gt;</span> {entry.text}
        </div>
      );

    case 'reply':
      return (
        <div
          className={`rd-console-line${entry.reply.type === 'error' ? ' is-error' : ''}`}
          data-testid="console-line"
          data-kind="reply"
          data-reply-type={entry.reply.type}
        >
          {renderReply(entry.reply).map((line, i) => (
            // 回复的行没有稳定 id，用下标即可：这个列表是只增不减的
            <div key={i}>{line}</div>
          ))}
          <span className="rd-console-elapsed">{formatElapsed(entry.elapsedMs)}</span>
        </div>
      );

    case 'transport':
      return (
        <div className="rd-console-line is-error" data-testid="console-line" data-kind="transport">
          {entry.message}
        </div>
      );

    case 'note':
      return (
        <div className="rd-console-line rd-muted" data-testid="console-line" data-kind="note">
          {entry.message}
        </div>
      );
  }
}
