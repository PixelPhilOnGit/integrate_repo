/**
 * 侧栏那两件事的纯逻辑：**会话按状态筛**、**工作目录置顶**。
 *
 * 两件都「只是换个显示顺序 / 挑一部分」，一个字都不该动 `state` ——
 * 所以它们能做纯函数、能在这儿钉死。
 */

import { describe, expect, it } from 'vitest';
import {
  matchesSessionFilter,
  sessionCounts,
  SESSION_FILTERS,
  sortWorkspaces,
  withPin,
} from '../../src/modules/agents/core/workspaces';
import type {
  AgentSession,
  AgentWorkspace,
  SessionStatus,
} from '../../src/modules/agents/core/types';

function session(status: SessionStatus, patch: Partial<AgentSession> = {}): AgentSession {
  return {
    id: `s-${status}`,
    workspaceId: 'w1',
    title: 'claude #1',
    kind: 'claude',
    command: 'claude',
    status,
    statusAt: 0,
    statusDetail: null,
    exitCode: null,
    history: [],
    ackAt: null,
    worktree: null,
    ...patch,
  };
}

function ws(id: string, name: string, pinned?: boolean): AgentWorkspace {
  return { id, path: `/home/me/${name}`, name, ...(pinned === true ? { pinned: true } : {}) };
}

describe('matchesSessionFilter', () => {
  it('「全部」什么状态都收', () => {
    const all: SessionStatus[] = ['starting', 'idle', 'working', 'waiting', 'done', 'exited'];
    for (const status of all) {
      expect(matchesSessionFilter(status, 'all')).toBe(true);
    }
  });

  it('「需要你」只收 waiting', () => {
    expect(matchesSessionFilter('waiting', 'waiting')).toBe(true);
    for (const status of ['starting', 'idle', 'working', 'done', 'exited'] as SessionStatus[]) {
      expect(matchesSessionFilter(status, 'waiting')).toBe(false);
    }
  });

  it('「在跑」把 starting 也算上', () => {
    // 用户问「哪个还在动」的时候，「正在启动」和「正在干活」是同一个答案 ——
    // 反正都不用他管。少算了这个的话，刚开的一批会话会从这一档里凭空消失
    expect(matchesSessionFilter('working', 'active')).toBe(true);
    expect(matchesSessionFilter('starting', 'active')).toBe(true);

    for (const status of ['idle', 'waiting', 'done', 'exited'] as SessionStatus[]) {
      expect(matchesSessionFilter(status, 'active')).toBe(false);
    }
  });

  it('终态（已完成 / 已退出）两个档都不收', () => {
    // 这两个档是**行动导向**的：「谁在等我」要我去处理、「谁在跑」我还得等。
    // 已经结束的会话用户不会去「找」它 —— 所以刻意没做「已完成」那一档
    for (const status of ['done', 'exited'] as SessionStatus[]) {
      expect(matchesSessionFilter(status, 'waiting')).toBe(false);
      expect(matchesSessionFilter(status, 'active')).toBe(false);
    }
  });
});

describe('sessionCounts', () => {
  it('三个档各数各的', () => {
    const counts = sessionCounts([
      session('working'),
      session('starting'),
      session('waiting'),
      session('done'),
      session('idle'),
    ]);

    expect(counts.all).toBe(5);
    expect(counts.waiting).toBe(1);
    expect(counts.active).toBe(2); // working + starting
  });

  it('一个会话都没有时全是 0（不是 NaN 也不是漏字段）', () => {
    const counts = sessionCounts([]);
    for (const filter of SESSION_FILTERS) {
      expect(counts[filter]).toBe(0);
    }
  });
});

describe('sortWorkspaces', () => {
  it('置顶的排前面', () => {
    const sorted = sortWorkspaces([ws('a', 'a'), ws('b', 'b', true), ws('c', 'c')]);
    expect(sorted.map((w) => w.id)).toEqual(['b', 'a', 'c']);
  });

  it('⚠️ 同档内**保持原顺序**（靠 sort 的稳定性）', () => {
    // 置顶只是「把这几条拎到上面」，不该顺手把用户自己摆的顺序也打乱
    const sorted = sortWorkspaces([
      ws('a', 'a'),
      ws('b', 'b', true),
      ws('c', 'c'),
      ws('d', 'd', true),
      ws('e', 'e'),
    ]);
    expect(sorted.map((w) => w.id)).toEqual(['b', 'd', 'a', 'c', 'e']);
  });

  it('不改原来那个数组（store 里是拿它算新的）', () => {
    const original = [ws('a', 'a'), ws('b', 'b', true)];
    sortWorkspaces(original);
    expect(original.map((w) => w.id)).toEqual(['a', 'b']);
  });
});

describe('withPin', () => {
  it('置顶时写字段', () => {
    expect(withPin(ws('a', 'a'), true).pinned).toBe(true);
  });

  it('取消时把字段**真的删掉**，而不是留一个 false', () => {
    // 留 `pinned: false` 的话存进 JSON 又多一种形状，下次读出来还得处理两遍
    const next = withPin(ws('a', 'a', true), false);
    expect(next.pinned).toBeUndefined();
    expect(Object.hasOwn(next, 'pinned')).toBe(false);
  });
});
