/**
 * 会话状态机。
 *
 * # 为什么单独抽出来
 *
 * 「谁在等我」是这个模块存在的唯一理由，而信号有五个来源、质量参差不齐
 * （Claude 的 hook 很准，Codex 只有「回合完成」，终端转义序列是零配置兜底）。
 * 五路信号汇进同一个状态机，规则写在一处、能被单测盖满 ——
 * 散在各个面板的 `if` 里是没法审的。
 *
 * # 一条贯穿全篇的原则
 *
 * **不确定就不改状态。** 状态点撒谎比没有状态点更糟：用户会照着它决定
 * 先看哪个会话。拿不准的时候保持原状，让用户自己去看那个窗格。
 *
 * 唯一的例外见 `reduceSignal` 里 `user-typed` 那条 —— 那是**用户的动作**，
 * 不是对 agent 内部状态的猜测。
 */

import { STATUS_LABEL, type AgentSession, type SessionStatus, type StatusChange } from './types';

/** 检查器里保留几条状态变化 */
const HISTORY_LIMIT = 8;

/**
 * 能喂给状态机的信号。
 *
 * 每一条都标了它从哪来 —— 加新信号的时候要想清楚「这条可靠吗」，
 * 不可靠的宁可不加。
 */
export type AgentSignal =
  /** 进程起来了（PTY 报 ready）。★ 我们自己发的 */
  | { kind: 'started' }
  /** 用户提交了一个提示。★ 键盘输入 或 Claude 的 UserPromptSubmit hook */
  | { kind: 'prompt-submitted'; detail?: string | null }
  /** 这一回合干完了。★ Claude 的 Stop hook / Codex 的 notify / OSC 9 */
  | { kind: 'turn-finished'; detail?: string | null }
  /** 需要你介入：等授权、等回答、闲在那儿等你。★ Claude 的 Notification hook / OSC */
  | { kind: 'needs-attention'; detail?: string | null }
  /** 用户在窗格里敲了键。★ 键盘输入（不是猜的，是用户的真实动作） */
  | { kind: 'user-typed' }
  /** 用户在窗格里按了 Ctrl+C。★ 键盘输入 */
  | { kind: 'user-interrupted' }
  /**
   * 进程没了。★ PTY 报的退出
   *
   * `detail` 用来带**退出原因**（比如「起不来：目录不存在」）——
   * 光有一个退出码，用户不知道该去改什么
   */
  | { kind: 'exited'; code: number | null; detail?: string | null };

function change(status: SessionStatus, at: number, detail: string | null): StatusChange {
  return { status, at, detail };
}

/**
 * 吃一个信号，吐出新的会话（或者原样返回，表示「什么都没变」）。
 *
 * **返回同一个对象**是有意义的：store 和 React 都按引用比较，
 * 没变就不该触发重渲染，也不该往历史里记一条什么也没说明的流水账。
 */
export function reduceSignal(
  session: AgentSession,
  signal: AgentSignal,
  at: number,
): AgentSession {
  // 进程已经没了，之后什么信号都不改它 —— 再改就是在编造事实
  if (session.status === 'exited') return session;

  switch (signal.kind) {
    case 'exited':
      return next(session, 'exited', at, signal.detail ?? null, signal.code);

    case 'started':
      // 进程起来了，但我们对它内部一无所知。**这就是 idle 的含义**：
      // 活着、没在干活、也没在等。不要在这里「乐观地」标成 working
      return next(session, 'idle', at, null);

    case 'prompt-submitted':
      return next(session, 'working', at, signal.detail);

    case 'turn-finished':
      return next(session, 'done', at, signal.detail);

    case 'needs-attention':
      // ⚠️ 回归：**从 done 也要能回到 waiting**。
      // 「干完了」不是终态 —— Claude 完全可能在你还没去看结果的时候
      // 又抛出一个问题（或者弹权限确认）。把 done 当成终态吞掉后续信号，
      // 表现就是「它明明在等我，状态点却一直显示已完成」，而这个模块的
      // 全部价值就在那个点上
      return next(session, 'waiting', at, signal.detail);

    case 'user-typed':
      // 只在「它在等我」和「它干完了」两种状态下，用户敲键才意味着
      // 「我来处理了」。**idle 时敲键不改成 working** —— 用户可能只是在
      // 一个普通 shell 里敲命令，那跟「agent 在干活」是两回事，
      // 标成 working 就是撒谎
      if (session.status === 'waiting' || session.status === 'done') {
        return next(session, 'working', at, null);
      }
      return session;

    case 'user-interrupted':
      // 打断之后 agent 回到等你输入的状态。这条专门为了兜 Claude 的一个坑：
      // **用户按 Esc/Ctrl+C 打断时它的 Stop hook 不触发**，不收尾的话
      // 状态会永远卡在 working
      return next(session, 'idle', at, null);
  }
}

/**
 * 造一个新的会话对象。
 *
 * 状态没变、说明也没变时**返回原对象** —— 这就是去抖：同一个信号在一个回合里
 * 来好几次（Claude 的 hook 和 OSC 可能同时报同一件事）只会留下一条记录。
 *
 * # `detail` 的三种取值是有区别的
 *
 * - 字符串：这条信号带了说明
 * - `null`：**明确地**没什么好说的
 * - `undefined`：这条信号**没带**说明
 *
 * 第三种要单独对待：状态没变时它保留原来的说明。
 * 不然会出现这样的事（e2e 抓到的）：终端通知序列先说了一句
 * 「等待你的确认」，紧接着 hook 那条不带说明的事件也到了 ——
 * 状态一样，但说明被后到的那条抹成了空，界面上就只剩一个光秃秃的「需要你」。
 * **信息少的那条不该覆盖信息多的那条。**
 */
function next(
  session: AgentSession,
  status: SessionStatus,
  at: number,
  detail: string | null | undefined,
  exitCode?: number | null,
): AgentSession {
  const code = exitCode === undefined ? session.exitCode : exitCode;
  const text =
    detail === undefined && status === session.status ? session.statusDetail : (detail ?? null);

  if (session.status === status && session.statusDetail === text && session.exitCode === code) {
    return session;
  }

  const history = [change(status, at, text), ...session.history].slice(0, HISTORY_LIMIT);
  return {
    ...session,
    status,
    statusAt: at,
    statusDetail: detail,
    exitCode: code,
    history,
    // **状态真的变了就清掉「我知道了」。** 一次确认只对**这一次**等待有效：
    // 它走开了（回去干活、或者退出了）再回到等待，那就是新的一次，你该被告知。
    //
    // 这里刻意不看时间戳，只认状态变化。原来写的是「ackAt 比 statusAt 新就算
    // 已确认」，那要求两个时间戳来自同一个时钟 —— 而 statusAt 有一部分来自
    // **事件文件的 mtime**（外部程序写的，可能是被复制过来的、时钟偏过的文件）。
    // 两个时钟对不上时，要么永远不再提醒你，要么提醒个没完。
    ackAt: status === session.status ? session.ackAt : null,
  };
}

/**
 * 这个会话要不要出现在「需要你」队列里。
 *
 * 规则只有一条：**正在等你，而且你还没表示过知道了**。
 * 状态一变 `ackAt` 就被清掉（见上面），所以「确认过之后它又需要我」这种情况
 * 不需要谁去手动重置什么标记。
 */
export function needsYou(session: AgentSession): boolean {
  return session.status === 'waiting' && session.ackAt === null;
}

/**
 * 「需要你」队列：等得最久的排最前面。
 *
 * 排最久的在前，是因为同时有三个 agent 在等的时候，你该先处理那个
 * 已经开始超时/卡住的一个 —— 而不是最近才叫你的那个。
 */
export function attentionQueue(sessions: readonly AgentSession[]): AgentSession[] {
  return sessions.filter(needsYou).sort((a, b) => a.statusAt - b.statusAt);
}

/** 状态点/边框要不要高亮（正在干活的和在等你的，视觉上不是一回事） */
export function isBusy(status: SessionStatus): boolean {
  return status === 'working' || status === 'starting';
}

/** 界面上显示的一行摘要：有具体说明就用说明，没有就用状态名 */
export function statusLine(session: AgentSession): string {
  return session.statusDetail ?? STATUS_LABEL[session.status];
}
