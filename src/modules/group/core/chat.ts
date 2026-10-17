/**
 * 「一轮事件 → 聊天时间线」的纯函数 reducer。
 *
 * 和 assistant 的 `core/chat.ts` 同一个切法（事件 → 切片，不碰 React/DOM），
 * 但群组是**多流**：一轮里多个成员各发各的，还可能并行交错。
 *
 * # 两条让界面稳定的设计
 *
 * 1. **`turnStarted` 时就把所有成员的占位气泡按配置顺序插进去**。并行模式下
 *    成员按完成先后落库，如果等事件来了再追加，气泡会按完成顺序跳来跳去。
 * 2. **`turnFinished` 是硬边界**：它之后的事件一律忽略；它一到，还没收尾的
 *    占位气泡统一标成「已停止」（否则界面会永远转圈）。
 *
 * 消息文本以 `memberFinished.text` 为**权威值**（覆盖流式拼接的结果）——
 * 和 Rust 侧「终稿覆盖增量」的语义一致。
 */

import type { GroupEvent, MemberActivity, ToolTrace } from '../services/types';

export interface ChatMessage {
  /** React key：`db:<id>` 或 `pending:<turnId>:<memberId>` */
  key: string;
  /** 落库后的消息 id（没有就是 null） */
  id: number | null;
  turnId: string;
  role: 'user' | 'member' | 'system';
  memberId: string | null;
  speakerName: string;
  memberPosition: number;
  text: string;
  tools: ToolTrace[];
  status: 'queued' | 'streaming' | 'done' | 'failed' | 'cancelled';
  error: string | null;
  usage: string | null;
}

export interface MemberRun {
  memberId: string;
  phase: 'queued' | 'thinking' | 'tool' | 'done' | 'failed' | 'cancelled';
  activity: MemberActivity | null;
  startedAt: number | null;
  elapsedMs: number | null;
}

export interface ChatSlice {
  messages: ChatMessage[];
  runs: Record<string, MemberRun>;
  activeTurnId: string | null;
  /** 已经应用过的最大 seq（重复/迟到事件直接丢） */
  lastSeq: number;
}

export function emptyChat(): ChatSlice {
  return { messages: [], runs: {}, activeTurnId: null, lastSeq: 0 };
}

/**
 * 吃一条事件。
 *
 * `nameOf` 用来给占位气泡取名字（`turnStarted` 只带 id）。
 */
export function reduceEvent(
  slice: ChatSlice,
  event: GroupEvent,
  nameOf: (memberId: string) => string,
): ChatSlice {
  // 重复 / 乱序的旧事件：忽略。
  // ⚠️ `turnStarted` 例外：**seq 每一轮从 1 重新开始**（Rust 的 EventSink 是
  // 每轮一个），拿上一轮的 lastSeq 去挡它，第二轮开始就再也收不到事件了。
  if (event.kind !== 'turnStarted' && event.seq <= slice.lastSeq) return slice;

  if (event.kind === 'turnStarted') {
    // 上一轮还没收尾就来了新的：把旧的占位收成「已停止」，避免永远转圈。
    const messages = slice.messages.map((m) =>
      m.status === 'queued' || m.status === 'streaming'
        ? { ...m, status: 'cancelled' as const }
        : m,
    );
    const runs: Record<string, MemberRun> = { ...slice.runs };
    for (const [id, run] of Object.entries(runs)) {
      if (run.phase === 'queued' || run.phase === 'thinking' || run.phase === 'tool') {
        runs[id] = { ...run, phase: 'cancelled' };
      }
    }

    messages.push({
      key: `db:${event.userMessageId}`,
      id: event.userMessageId,
      turnId: event.turnId,
      role: 'user',
      memberId: null,
      speakerName: '你',
      memberPosition: -1,
      text: event.userText,
      tools: [],
      status: 'done',
      error: null,
      usage: null,
    });
    event.memberIds.forEach((memberId, index) => {
      messages.push({
        key: `pending:${event.turnId}:${memberId}`,
        id: null,
        turnId: event.turnId,
        role: 'member',
        memberId,
        speakerName: nameOf(memberId),
        memberPosition: index,
        text: '',
        tools: [],
        status: 'queued',
        error: null,
        usage: null,
      });
      runs[memberId] = {
        memberId,
        phase: 'queued',
        activity: null,
        startedAt: null,
        elapsedMs: null,
      };
    });

    return { messages, runs, activeTurnId: event.turnId, lastSeq: event.seq };
  }

  // 没有活跃轮次时，除了 turnStarted 一概不认（迟到的旧事件）。
  if (slice.activeTurnId === null) return slice;

  switch (event.kind) {
    case 'memberQueued':
      return {
        ...slice,
        lastSeq: event.seq,
        runs: {
          ...slice.runs,
          [event.memberId]: {
            ...(slice.runs[event.memberId] ?? emptyRun(event.memberId)),
            phase: 'queued',
          },
        },
      };

    case 'memberStarted':
      return {
        ...slice,
        lastSeq: event.seq,
        runs: {
          ...slice.runs,
          [event.memberId]: {
            ...(slice.runs[event.memberId] ?? emptyRun(event.memberId)),
            phase: 'thinking',
            startedAt: event.startedAt,
          },
        },
      };

    case 'memberText': {
      const messages = patchMember(slice.messages, event.memberId, (m) => ({
        ...m,
        status: m.status === 'queued' ? 'streaming' : m.status,
        text: m.text + event.text,
      }));
      return {
        ...slice,
        messages,
        lastSeq: event.seq,
        runs: {
          ...slice.runs,
          [event.memberId]: {
            ...(slice.runs[event.memberId] ?? emptyRun(event.memberId)),
            phase: 'thinking',
            activity: 'thinking',
          },
        },
      };
    }

    case 'memberActivity':
      return {
        ...slice,
        lastSeq: event.seq,
        runs: {
          ...slice.runs,
          [event.memberId]: {
            ...(slice.runs[event.memberId] ?? emptyRun(event.memberId)),
            phase: event.activity === 'tool' ? 'tool' : 'thinking',
            activity: event.activity,
          },
        },
      };

    case 'memberTool': {
      const messages = patchMember(slice.messages, event.memberId, (m) => {
        const tools = [...m.tools];
        if (event.state === 'started') {
          tools.push({
            toolId: event.toolId,
            name: event.name,
            display: event.display,
            isError: null,
          });
        } else {
          // 按 toolId 找；没有 id 就找最后一条还没结果的。
          let index = -1;
          if (event.toolId !== null) {
            index = tools.findIndex(
              (t) => t.toolId === event.toolId && t.isError === null,
            );
          }
          if (index < 0) {
            for (let i = tools.length - 1; i >= 0; i -= 1) {
              if (tools[i]?.isError === null) {
                index = i;
                break;
              }
            }
          }
          const current = index >= 0 ? tools[index] : undefined;
          if (current !== undefined) {
            tools[index] = {
              ...current,
              isError: event.state === 'failed',
              display: event.display || current.display,
            };
          }
        }
        return { ...m, tools };
      });
      return {
        ...slice,
        messages,
        lastSeq: event.seq,
        runs: {
          ...slice.runs,
          [event.memberId]: {
            ...(slice.runs[event.memberId] ?? emptyRun(event.memberId)),
            phase: event.state === 'started' ? 'tool' : 'thinking',
            activity: event.state === 'started' ? 'tool' : null,
          },
        },
      };
    }

    case 'memberFinished': {
      const messages = patchMember(slice.messages, event.memberId, (m) => ({
        ...m,
        id: event.messageId,
        text: event.text, // 权威终稿，覆盖流式拼接
        status: event.status,
        error: event.error,
        usage: event.usage,
      }));
      return {
        ...slice,
        messages,
        lastSeq: event.seq,
        runs: {
          ...slice.runs,
          [event.memberId]: {
            ...(slice.runs[event.memberId] ?? emptyRun(event.memberId)),
            phase: event.status,
            activity: null,
            elapsedMs: event.elapsedMs,
          },
        },
      };
    }

    case 'turnFinished': {
      // 硬边界：还在排队/流式中的成员统一收成「已停止」。
      const messages = slice.messages.map((m) =>
        m.turnId === event.turnId &&
        (m.status === 'queued' || m.status === 'streaming')
          ? { ...m, status: 'cancelled' as const }
          : m,
      );
      const runs: Record<string, MemberRun> = { ...slice.runs };
      for (const [id, run] of Object.entries(runs)) {
        if (run.phase === 'queued' || run.phase === 'thinking' || run.phase === 'tool') {
          runs[id] = { ...run, phase: 'cancelled' };
        }
      }
      return {
        messages,
        runs,
        activeTurnId: null,
        lastSeq: event.seq,
      };
    }

    default: {
      // 穷尽检查：Rust 加了新事件而这里没跟上时，编译不过。
      const unhandled: never = event;
      void unhandled;
      return slice;
    }
  }
}

function emptyRun(memberId: string): MemberRun {
  return {
    memberId,
    phase: 'queued',
    activity: null,
    startedAt: null,
    elapsedMs: null,
  };
}

/** 更新当前轮里某个成员的消息（找不到就原样返回）。 */
function patchMember(
  messages: ChatMessage[],
  memberId: string,
  patch: (m: ChatMessage) => ChatMessage,
): ChatMessage[] {
  let index = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m !== undefined && m.role === 'member' && m.memberId === memberId) {
      index = i;
      break;
    }
  }
  const current = index >= 0 ? messages[index] : undefined;
  if (current === undefined) return messages;
  const next = [...messages];
  next[index] = patch(current);
  return next;
}

/**
 * 把数据库里的历史消息转成界面消息（选中群 / 对账时用）。
 *
 * 成员已删除时 `speakerName` 用的是**当时的快照**（Rust 侧存的），所以历史
 * 仍然读得懂。
 */
export function messagesFromDb(
  rows: ReadonlyArray<{
    id: number;
    turnId: string;
    speakerKind: 'user' | 'member' | 'system';
    memberId: string | null;
    speakerName: string;
    memberPosition: number;
    text: string;
    tools: ToolTrace[];
    status: 'done' | 'failed' | 'cancelled';
    error: string;
    usage: string | null;
  }>,
): ChatMessage[] {
  return rows.map((r) => ({
    key: `db:${r.id}`,
    id: r.id,
    turnId: r.turnId,
    role: r.speakerKind,
    memberId: r.memberId,
    speakerName: r.speakerName,
    memberPosition: r.memberPosition,
    text: r.text,
    tools: r.tools,
    status: r.status,
    error: r.error === '' ? null : r.error,
    usage: r.usage,
  }));
}
