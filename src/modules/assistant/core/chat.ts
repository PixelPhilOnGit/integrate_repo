/**
 * 对话状态机：把内核推上来的一条条事件，变成界面上那一串消息。
 *
 * **纯函数** —— 不碰 store、不碰网络、不碰时间。所以「并行工具调用的结果该配到
 * 哪一条上」这种写错了也不报错的地方，可以在毫秒级单测里穷举。
 *
 * ⚠️ 这里**不做判读**，只做搬运：该不该问、拒绝之后怎么办、什么算失败，
 * 全在 Rust 那边（`tool.rs` 的审批判定、`session.rs` 的循环）。
 * 前端多一个判断，就多一处两边行为不一致的地方。
 *
 * ⚠️ 也**不看 `running`**：收尾完全由 `finished` 那条事件决定 ——
 * 它就是设计成「一定是最后一条」的。前端自作主张提前收尾的话，
 * 有一条事件晚到（重试、审批回答）就会在已经停下的界面上再冒出东西来。
 */

import type { ApprovalKey, AssistantEvent } from '../services/types';

/** 消息里出现过的一次工具调用（界面上显示成一行）。 */
export interface ToolTrace {
  /** 工具名。 */
  name: string;
  /** 给人看的那一行（Rust 侧算好的）。 */
  display: string;
  /** `null` = 还在跑。 */
  isError: boolean | null;
}

/** 一条消息。 */
export interface ChatMessage {
  /** 本地 id（只给 React 的 key 用）。 */
  id: string;
  /** 谁说的。 */
  role: 'user' | 'assistant';
  /** 正文。**流式追加**。 */
  text: string;
  /** 这条消息里发生过的工具调用。 */
  tools: ToolTrace[];
}

/** 正在等回答的那条审批。 */
export interface PendingApproval {
  /** 回答时要带回去。 */
  key: ApprovalKey;
  /** 工具名。 */
  tool: string;
  /** 给人看的那一行。 */
  display: string;
  /** 要不要给「记住」这个选项（Rust 说了算，见 `PreparedCall::needs_approval`）。 */
  canRemember: boolean;
}

/** 对话这一块的全部状态。 */
export interface ChatSlice {
  /** 消息流。 */
  messages: ChatMessage[];
  /**
   * 正在累积的那条助手消息的 id。`null` = 下一段文字该新起一条。
   *
   * 每轮（`iteration`）置回 `null`：一次 run 有好几轮，各说各的，
   * 糊成一条读起来分不清哪句是哪轮的。
   */
  openId: string | null;
  /** 正在等用户点确认的那条审批。 */
  pending: PendingApproval | null;
  /** 还在跑。 */
  running: boolean;
}

/** 从一个空对话开始。 */
export function emptyChat(): ChatSlice {
  return { messages: [], openId: null, pending: null, running: false };
}

/**
 * 吃进一条事件，返回新的切片。
 *
 * `nextId` 是个给新消息取 id 的函数，由调用方传进来 —— 这样单测里可以给
 * 一串确定的值，断言里就能直接写 `m1` / `m2`。
 */
export function reduceChat(
  slice: ChatSlice,
  event: AssistantEvent,
  nextId: () => string,
): ChatSlice {
  switch (event.kind) {
    case 'iteration':
      return { ...slice, openId: null };

    case 'textDelta':
      return appendText(slice, event.text, nextId);

    case 'thinkingDelta':
      // 一期不显示思考：它是模型的草稿，不是给用户看的东西。
      return slice;

    case 'toolRequested':
      return appendTool(slice, event.name, event.display, nextId);

    case 'toolFinished':
      return settleNextTool(slice, event.isError);

    case 'retrying':
      return appendTool(slice, 'retry', `连接断了，第 ${event.attempt} 次重试`, nextId);

    case 'approvalNeeded':
      return {
        ...slice,
        pending: {
          key: event.key,
          tool: event.tool,
          display: event.display,
          canRemember: event.canRemember,
        },
      };

    case 'approvalDecided':
      return { ...slice, pending: null };

    case 'turnFinished':
      // 这一轮的用量。**一期界面上不显示它** —— 要回答「哪个上下文策略划算」
      // 得攒够数据再看，而那份数据落在 `transcript.rs` 里，不是屏幕上。
      return slice;

    case 'finished':
      // ⚠️ `pending` 也要清 —— 取消的时候那条审批是挂着的，不清的话
      // 界面上会留一个永远点不出结果的弹层。
      return { ...slice, openId: null, pending: null, running: false };

    default: {
      // 穷尽检查：Rust 那边**加了新事件类型而这里没跟上**的话，这一行编译不过。
      // 少了它的话，新事件会被静默丢掉 —— 界面停在半路，而且不报错。
      const unhandled: never = event;
      void unhandled;
      return slice;
    }
  }
}

// ---------------------------------------------------------------------- 内部

/** 往当前那条助手消息上追加一段文字（没有就新起一条）。 */
function appendText(slice: ChatSlice, text: string, nextId: () => string): ChatSlice {
  const [messages, id] = ensureOpen(slice, nextId);
  return {
    ...slice,
    openId: id,
    messages: patch(messages, id, (m) => ({ ...m, text: m.text + text })),
  };
}

/** 往当前那条助手消息上加一条工具痕迹。 */
function appendTool(
  slice: ChatSlice,
  name: string,
  display: string,
  nextId: () => string,
): ChatSlice {
  const [messages, id] = ensureOpen(slice, nextId);
  return {
    ...slice,
    openId: id,
    messages: patch(messages, id, (m) => ({
      ...m,
      tools: [...m.tools, { name, display, isError: null }],
    })),
  };
}

/**
 * 把**下一条**还没结果的工具痕迹标上结果。
 *
 * ⚠️ **从前往后找**第一条还没结果的。模型可以在一轮里并行调好几个工具
 * （那是我们要的行为），而结果是**按请求顺序**回来的 —— 循环里是逐个执行、
 * 逐个发 `toolFinished` 的（见 `session.rs` 的 `run_tools`）。
 * 反过来从后往前找的话，第一个结果会写到**最后一条**痕迹上，
 * 两条工具的成败就对调了：界面上看起来完全正常，只是错了。
 *
 * 这条写反过一次，是 `tests/unit/assistant-chat.test.ts` 里那个
 * 「并行调用的结果要一条一条对上去」抓出来的。
 *
 * 找不到就什么都不做（`openId` 是 null、或者结果比痕迹先到）——
 * 那种情况宁可少显示一行，不要凭空造一条。
 */
function settleNextTool(slice: ChatSlice, isError: boolean): ChatSlice {
  const id = slice.openId;
  if (id === null) return slice;

  return {
    ...slice,
    messages: patch(slice.messages, id, (m) => {
      const tools = [...m.tools];
      for (let i = 0; i < tools.length; i += 1) {
        const t = tools[i];
        if (t !== undefined && t.isError === null) {
          tools[i] = { ...t, isError };
          break;
        }
      }
      return { ...m, tools };
    }),
  };
}

/** 保证有一条正在累积的助手消息，返回 `[消息数组, 它的 id]`。 */
function ensureOpen(slice: ChatSlice, nextId: () => string): [ChatMessage[], string] {
  if (slice.openId !== null) return [slice.messages, slice.openId];
  const id = nextId();
  return [
    [...slice.messages, { id, role: 'assistant', text: '', tools: [] }],
    id,
  ];
}

function patch(
  messages: ChatMessage[],
  id: string,
  fn: (m: ChatMessage) => ChatMessage,
): ChatMessage[] {
  return messages.map((m) => (m.id === id ? fn(m) : m));
}
