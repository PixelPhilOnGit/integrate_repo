/**
 * 事件文件：外部程序（Claude Code 的 hook、Codex 的 notify）告诉我们会话状态的通道。
 *
 * # 约定
 *
 * 一个会话一个文件，**状态写在文件名里**：`waiting.<会话 id>`。
 *
 * 为什么状态在文件名而不是内容里：写文件的是一段**纯 shell 脚本**
 * （理由见模块方案：Tauri 二进制启动要 200ms+，而 hook 是同步阻塞 agent 的）。
 * shell 里生成时间戳要面对 `%TIME%` 的 locale 差异，写内容要面对引号和换行 ——
 * 而「把状态编进文件名」只需要一句重定向。时间戳用**文件的 mtime**，
 * 由操作系统替我们记。
 *
 * 所以这个文件里的解析逻辑只有一件事：**文件名 → 信号**。
 *
 * # 防伪造
 *
 * 能往这个目录里写文件的人，就能让界面上某个会话显示「需要你」。
 * 两道防线：
 * 1. 目录在应用自己的数据目录下（单用户，别人写不进来）；
 * 2. **文件名里的会话 id 必须对得上一个活着的会话** —— 这一条由 store 做，
 *    因为会话表在它手里。光看文件名是判断不了真假的，所以这里只负责
 *    「格式对不对」，「是不是我们自己发的」交给调用方。
 *
 * 会话 id 是随机生成的（`newId`），所以外面想蒙一个也得先猜中那串随机数。
 */

import type { AgentSignal } from './status';
import type { SessionStatus } from './types';

/**
 * 允许出现在文件名里的状态。
 *
 * 刻意**只有三个**，而且和 `SessionStatus` 不是一个东西：
 * - 没有 `starting` —— 那是我们自己的进程刚建出来的中间态，外部无从知道
 * - 没有 `exited` —— 进程退出由 pty 自己报，比脚本可靠得多
 * - 没有 `idle` —— 没有哪个 hook 对应它。让脚本能写 idle 只会多出一堆
 *   含义模糊的状态，真需要的话由「用户按了 Ctrl+C」那条路来报
 */
export const EVENT_STATES = ['working', 'waiting', 'done'] as const;

export type EventState = (typeof EVENT_STATES)[number];

/** 一个从磁盘上读回来的事件 */
export interface AgentEvent {
  paneId: string;
  state: EventState;
  /** 文件的 mtime（毫秒） */
  at: number;
}

/** 状态那一段不区分大小写（Windows 上文件名本来就不区分），会话 id 区分 */
const NAME_RE = /^([A-Za-z]+)\.([A-Za-z0-9_-]{1,64})$/;

/**
 * 解析一个事件文件名。不是我们的事件就返回 null。
 *
 * 目录里出现别的东西是正常的（临时文件、编辑器留下的 `.swp`、
 * 用户手动扔进去的垃圾），**一律静静忽略**，不报错、不弹错误条。
 */
export function parseEventName(name: string, at: number): AgentEvent | null {
  const m = NAME_RE.exec(name);
  if (m === null) return null;

  const state = (m[1] ?? '').toLowerCase();
  if (!isEventState(state)) return null;

  return { paneId: m[2] ?? '', state, at };
}

export function isEventState(value: string): value is EventState {
  return (EVENT_STATES as readonly string[]).includes(value);
}

/**
 * 事件 → 状态机的信号。
 *
 * `working` 映射到 `prompt-submitted` 而不是「一个 working 信号」：
 * 在状态机里，「开始干活」这件事只有一个来源（用户提交了提示），
 * 没必要为它多开一个含义重叠的信号。
 */
export function signalOf(event: AgentEvent): AgentSignal {
  switch (event.state) {
    case 'working':
      return { kind: 'prompt-submitted' };
    case 'waiting':
      return { kind: 'needs-attention' };
    case 'done':
      return { kind: 'turn-finished' };
  }
}

/**
 * 状态名 → 状态机里的状态。
 *
 * 只用来给「这个事件说的是什么」写文案（比如集成向导里的自检报告），
 * **不要**拿它直接改会话状态 —— 那条路必须走状态机（`reduceSignal`）。
 */
export function statusOfEvent(state: EventState): SessionStatus {
  switch (state) {
    case 'working':
      return 'working';
    case 'waiting':
      return 'waiting';
    case 'done':
      return 'done';
  }
}
