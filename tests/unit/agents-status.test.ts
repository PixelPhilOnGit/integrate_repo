/**
 * 会话状态机。
 *
 * 这是整个模块的立身之本：用户开着四个会话，靠的就是「谁在等我」这一眼。
 * 状态点撒谎比没有状态点更糟 —— 所以这里除了正常路径，重点盖三样：
 * 五路信号打架时的取舍、去抖（同一个信号被两个来源各报一次）、
 * 以及几条真踩过的回归。
 */
import { describe, expect, it } from 'vitest';
import {
  attentionQueue,
  isBusy,
  needsYou,
  reduceSignal,
  statusLine,
  type AgentSignal,
} from '../../src/modules/agents/core/status';
import type { AgentSession } from '../../src/modules/agents/core/types';

function session(patch: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 's1',
    workspaceId: 'w1',
    title: 'claude #1',
    kind: 'claude',
    command: 'claude',
    status: 'starting',
    statusAt: 0,
    statusDetail: null,
    exitCode: null,
    history: [],
    ackAt: null,
    worktree: null,
    ...patch,
  };
}

/** 把一串信号依次吃掉，返回最后的会话 */
function run(start: AgentSession, ...signals: AgentSignal[]): AgentSession {
  return signals.reduce((s, sig, i) => reduceSignal(s, sig, (i + 1) * 1000), start);
}

describe('正常路径：每条转移', () => {
  it('进程起来 → idle（活着、没在干活、也没在等）', () => {
    const s = reduceSignal(session(), { kind: 'started' }, 1000);
    expect(s.status).toBe('idle');
    expect(s.statusAt).toBe(1000);
  });

  it('提交提示 → working', () => {
    const s = run(session(), { kind: 'started' }, { kind: 'prompt-submitted' });
    expect(s.status).toBe('working');
  });

  it('回合结束 → done', () => {
    const s = run(
      session(),
      { kind: 'started' },
      { kind: 'prompt-submitted' },
      { kind: 'turn-finished', detail: '改完并跑通了测试' },
    );
    expect(s.status).toBe('done');
    expect(s.statusDetail).toBe('改完并跑通了测试');
  });

  it('需要介入 → waiting', () => {
    const s = run(
      session(),
      { kind: 'started' },
      { kind: 'prompt-submitted' },
      { kind: 'needs-attention', detail: '等待授权：Bash' },
    );
    expect(s.status).toBe('waiting');
    expect(statusLine(s)).toBe('等待授权：Bash');
  });

  it('进程退出 → exited，并带上退出码', () => {
    const s = run(session(), { kind: 'started' }, { kind: 'exited', code: 0 });
    expect(s.status).toBe('exited');
    expect(s.exitCode).toBe(0);
  });
});

describe('取信号时的取舍', () => {
  it('⚠️ 回归：done 之后又来 needs-attention，必须回到 waiting', () => {
    // 「干完了」不是终态。Claude 完全可能在你还没去看结果的时候又抛出
    // 一个问题（或者弹权限确认）。把 done 当终态吞掉后续信号，
    // 表现就是「它明明在等我，状态点却写着已完成」。
    // 这个模块的全部价值就在那个点上，所以这条要钉死。
    const s = run(
      session(),
      { kind: 'started' },
      { kind: 'prompt-submitted' },
      { kind: 'turn-finished' },
      { kind: 'needs-attention', detail: '等待授权：Edit' },
    );
    expect(s.status).toBe('waiting');
    expect(s.statusDetail).toBe('等待授权：Edit');
  });

  it('⚠️ 回归：Ctrl+C 打断能从 working 里出来', () => {
    // Claude Code 的 Stop hook 在用户按 Esc/Ctrl+C 打断时**不触发**。
    // 不收尾的话状态会永远卡在「正在工作」，用户会一直等一个已经停下来了的会话
    const s = run(session(), { kind: 'started' }, { kind: 'prompt-submitted' }, { kind: 'user-interrupted' });
    expect(s.status).toBe('idle');
  });

  it('用户在 idle 的窗格里敲键**不**改成 working —— 那可能只是个普通 shell', () => {
    // 把一个「你在里面敲 ls」的窗格标成「正在工作」，下一次你就不会信状态点了
    const s = run(session(), { kind: 'started' });
    expect(reduceSignal(s, { kind: 'user-typed' }, 2000)).toBe(s);
  });

  it('在 working 里再敲键也不改状态', () => {
    const s = run(session(), { kind: 'started' }, { kind: 'prompt-submitted' });
    expect(reduceSignal(s, { kind: 'user-typed' }, 3000)).toBe(s);
  });

  it('它在等你的时候你敲键 → working（你在答它）', () => {
    const s = run(session(), { kind: 'started' }, { kind: 'needs-attention' });
    const after = reduceSignal(s, { kind: 'user-typed' }, 3000);
    expect(after.status).toBe('working');
  });

  it('刚干完你就去敲键 → working（你在接着使唤它）', () => {
    const s = run(session(), { kind: 'started' }, { kind: 'turn-finished' });
    expect(reduceSignal(s, { kind: 'user-typed' }, 3000).status).toBe('working');
  });

  it('进程退出是终态：之后什么信号都不改它', () => {
    const s = run(session(), { kind: 'started' }, { kind: 'exited', code: 1 });
    const signals: AgentSignal[] = [
      { kind: 'started' },
      { kind: 'prompt-submitted' },
      { kind: 'turn-finished' },
      { kind: 'needs-attention' },
      { kind: 'user-typed' },
      { kind: 'user-interrupted' },
    ];
    for (const sig of signals) {
      expect(reduceSignal(s, sig, 9000), `${sig.kind} 不该改变已退出的会话`).toBe(s);
    }
  });
});

describe('去抖', () => {
  it('同一个信号被两个来源各报一次（Claude 的 hook + 终端转义序列），只留一条', () => {
    // 这也是**返回同一个对象**的意义：store 和 React 都按引用比较，
    // 没变就不重渲染，也不往历史里记一条什么也没说明的流水账
    const s = run(session(), { kind: 'started' }, { kind: 'prompt-submitted' });
    const once = reduceSignal(s, { kind: 'needs-attention', detail: '等待授权：Bash' }, 5000);
    const twice = reduceSignal(once, { kind: 'needs-attention', detail: '等待授权：Bash' }, 5100);

    expect(twice).toBe(once);
    // idle（进程起来）、working、waiting 各一条，重复报的那次没有留下痕迹
    expect(once.history.map((h) => h.status)).toEqual(['waiting', 'working', 'idle']);
    // 重复的那次不该刷新 statusAt —— 否则「等了多少秒」会一直归零
    expect(once.statusAt).toBe(5000);
  });

  it('但说明**变了**就是新事实，要记一条', () => {
    const s = run(session(), { kind: 'started' }, { kind: 'needs-attention', detail: '等待授权：Bash' });
    const after = reduceSignal(s, { kind: 'needs-attention', detail: '已经闲了 60 秒' }, 5000);

    expect(after).not.toBe(s);
    expect(after.statusDetail).toBe('已经闲了 60 秒');
    expect(after.history[0]!.detail).toBe('已经闲了 60 秒');
  });

  it('历史只留最近 8 条，新的在前', () => {
    let s = session();
    for (let i = 0; i < 20; i += 1) {
      s = reduceSignal(s, i % 2 === 0 ? { kind: 'prompt-submitted' } : { kind: 'turn-finished' }, i);
    }
    expect(s.history).toHaveLength(8);
    expect(s.history[0]!.at).toBe(19);
  });
});

describe('需要你队列', () => {
  it('waiting 的进队列，别的状态不进', () => {
    expect(needsYou(session({ status: 'waiting' }))).toBe(true);
    for (const status of ['starting', 'idle', 'working', 'done', 'exited'] as const) {
      expect(needsYou(session({ status })), status).toBe(false);
    }
  });

  it('「我知道了」之后就离开队列', () => {
    const s = session({ status: 'waiting', statusAt: 1000, ackAt: 2000 });
    expect(needsYou(s)).toBe(false);
  });

  it('⚠️ 表示过已知晓之后它**再次**进入等待，要回到队列里', () => {
    // 不需要谁去重置标记：**状态一变，确认就作废**（见 `next()`）。
    // 忘了这条的话，一个会话提醒过你一次之后，这一整轮都不会再叫你了
    let s = session({ status: 'waiting', statusAt: 1000 });
    s = { ...s, ackAt: 2000 }; // 用户点了「我知道了」
    expect(needsYou(s)).toBe(false);

    s = reduceSignal(s, { kind: 'prompt-submitted' }, 3000); // 走开了
    s = reduceSignal(s, { kind: 'needs-attention' }, 4000); // 又需要你
    expect(s.ackAt).toBeNull();
    expect(needsYou(s)).toBe(true);
  });

  it('⚠️ 一次确认只对**这一次**等待有效，而且不看时间戳', () => {
    // 原来是「ackAt 比 statusAt 新就算已确认」，那要求两个时间戳同源 ——
    // 而 statusAt 有一部分来自**事件文件的 mtime**（外部程序写的、可能被复制
    // 过来、时钟还可能是偏的）。两个时钟对不上，要么永远不再提醒你，
    // 要么提醒个没完。现在只认状态变化，和时钟无关
    let s = session({ status: 'waiting' });
    s = { ...s, ackAt: 999999999 } as typeof s; // 一个荒唐的、未来的时间戳
    expect(needsYou(s)).toBe(false); // 已确认就是已确认

    s = reduceSignal(s, { kind: 'turn-finished' }, 5000);
    expect(s.ackAt).toBeNull(); // 状态一变，确认自动作废
  });

  it('还在等待时又来一条**新的说明**（比如「已经闲了 60 秒」），确认不作废', () => {
    // 它还是卡在同一个地方等你，你已经知道这件事了 —— 换个说法再提醒一遍
    // 只会让人把队列当成噪音
    let s = session({ status: 'waiting', statusDetail: '等待授权：Bash' });
    s = { ...s, ackAt: 2000 } as typeof s;
    s = reduceSignal(s, { kind: 'needs-attention', detail: '已经闲了 60 秒' }, 3000);

    expect(s.ackAt).toBe(2000);
    expect(needsYou(s)).toBe(false);
  });

  it('等得最久的排最前面', () => {
    const queue = attentionQueue([
      session({ id: '新', status: 'waiting', statusAt: 5000 }),
      session({ id: '老', status: 'waiting', statusAt: 1000 }),
      session({ id: '中', status: 'waiting', statusAt: 3000 }),
      session({ id: '干活的', status: 'working', statusAt: 0 }),
    ]);
    expect(queue.map((s) => s.id)).toEqual(['老', '中', '新']);
  });
});

describe('isBusy', () => {
  it('只有 working / starting 算在忙 —— waiting 是在等人，不是忙', () => {
    expect(isBusy('working')).toBe(true);
    expect(isBusy('starting')).toBe(true);
    expect(isBusy('waiting')).toBe(false);
    expect(isBusy('done')).toBe(false);
    expect(isBusy('idle')).toBe(false);
    expect(isBusy('exited')).toBe(false);
  });
});
