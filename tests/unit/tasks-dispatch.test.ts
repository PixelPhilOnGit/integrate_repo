/**
 * 「把任务派给某个 agent 会话」。
 *
 * 这一条跨了两个模块（任务 ↔ 智能体会话），走的是 `shared/agentBus.ts` 那个
 * 中立槽位。测试里用 `attachAgentBus` 塞一个假的进去 —— 那正是把它做成
 * 「可挂载的槽位」而不是直接 import 会话 store 的原因之一。
 *
 * 三条边界：
 * 1. 送进去的是**任务内容**（不是一句「去干这个活」），而且末尾补了回车。
 * 2. 会话不在了 → **返回 false**（调用方要能告诉用户没送出去）。
 * 3. 会话结束时**只记「结束了」这个事实**，不替用户改状态 ——
 *    干成没干成只有他知道。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { client } = vi.hoisted(() => ({
  client: {
    list: vi.fn<() => Promise<unknown[]>>(),
    create: vi.fn(),
    patch: vi.fn(),
    remove: vi.fn(),
    progressOf: vi.fn<() => Promise<unknown[]>>(),
    addProgress: vi.fn<(taskId: string, text: string) => Promise<unknown>>(),
    archiveCount: vi.fn(),
  },
}));

vi.mock('../../src/modules/tasks/services', () => ({ tasksClient: client }));

const { TasksStore } = await import('../../src/modules/tasks/state/store');
const { attachAgentBus } = await import('../../src/shared/agentBus');

import type { Task } from '../../src/modules/tasks/core/types';
import type { AgentBus, AgentTarget } from '../../src/shared/agentBus';

function task(patch: Partial<Task> = {}): Task {
  return {
    id: 't1',
    title: '修登录页那个 bug',
    body: '点提交之后偶尔不跳转',
    note: '',
    status: 'todo',
    createdAt: 0,
    updatedAt: 0,
    doneAt: null,
    archived: false,
    ...patch,
  };
}

/** 假的会话槽位：记下送进去的文本，而且能手动触发「会话结束」 */
function fakeBus(targets: AgentTarget[] = []): {
  bus: AgentBus;
  sent: Array<{ sessionId: string; text: string }>;
  exit(sessionId: string): void;
} {
  const sent: Array<{ sessionId: string; text: string }> = [];
  const listeners = new Set<(id: string) => void>();

  return {
    sent,
    exit: (sessionId) => {
      for (const cb of listeners) cb(sessionId);
    },
    bus: {
      list: () => targets,
      send: (sessionId, text) => {
        const ok = targets.some((t) => t.sessionId === sessionId);
        if (ok) sent.push({ sessionId, text });
        return ok;
      },
      onExit: (cb) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
    },
  };
}

const TARGET: AgentTarget = {
  sessionId: 's1',
  title: 'claude #1',
  workspace: 'alpha',
  kind: 'claude',
};

let added: Array<{ taskId: string; text: string }> = [];

beforeEach(() => {
  vi.clearAllMocks();
  added = [];
  client.list.mockResolvedValue([task()]);
  client.progressOf.mockResolvedValue([]);
  client.addProgress.mockImplementation(async (taskId, text) => {
    added.push({ taskId, text });
    return { id: 'p', taskId, at: 0, text };
  });
});

describe('派任务给会话', () => {
  it('把任务内容送进会话，并往进度里记一笔', async () => {
    const { bus, sent } = fakeBus([TARGET]);
    attachAgentBus(bus);
    const store = new TasksStore();
    await store.init();

    const ok = await store.dispatchTo('t1', 's1');

    expect(ok).toBe(true);
    // ⚠️ 送进去的是**内容本身**（会话那头是个 agent，它要的是能直接开干的提示），
    // 不是「去干这个活」
    expect(sent[0]?.text).toContain('修登录页那个 bug');
    expect(sent[0]?.text).toContain('点提交之后偶尔不跳转');

    // 进度里落了事实（过程，不是结论）
    expect(added).toHaveLength(1);
    expect(added[0]?.taskId).toBe('t1');
    expect(added[0]?.text).toContain('claude #1');
    expect(added[0]?.text).toContain('alpha');
  });

  it('没有描述时只送标题（不要留一段空行）', async () => {
    const { bus, sent } = fakeBus([TARGET]);
    attachAgentBus(bus);
    client.list.mockResolvedValue([task({ body: '' })]);
    const store = new TasksStore();
    await store.init();

    await store.dispatchTo('t1', 's1');

    expect(sent[0]?.text).toBe('任务：修登录页那个 bug');
  });

  it('⚠️ 那个会话不在了 → 返回 false（调用方要能告诉用户没送出去）', async () => {
    const { bus, sent } = fakeBus([TARGET]);
    attachAgentBus(bus);
    const store = new TasksStore();
    await store.init();

    const ok = await store.dispatchTo('t1', '已经不在了的会话');

    expect(ok).toBe(false);
    expect(sent).toHaveLength(0);
    expect(added).toHaveLength(0);
  });

  it('任务不存在时也是 false（不送、不记）', async () => {
    const { bus, sent } = fakeBus([TARGET]);
    attachAgentBus(bus);
    const store = new TasksStore();
    await store.init();

    expect(await store.dispatchTo('没有这条', 's1')).toBe(false);
    expect(sent).toHaveLength(0);
  });
});

describe('会话结束时的回写', () => {
  it('派出去的那个会话结束了 → 记一笔「结束了」', async () => {
    const h = fakeBus([TARGET]);
    attachAgentBus(h.bus);
    const store = new TasksStore();
    await store.init();

    await store.dispatchTo('t1', 's1');
    added = [];
    h.exit('s1');

    expect(added).toHaveLength(1);
    expect(added[0]?.text).toContain('结束');
  });

  it('⚠️ 只记事实，**不替用户改状态**（干成没干成只有他知道）', async () => {
    const h = fakeBus([TARGET]);
    attachAgentBus(h.bus);
    const store = new TasksStore();
    await store.init();

    await store.dispatchTo('t1', 's1');
    h.exit('s1');

    // 状态那条路一次都没被碰过
    expect(client.patch).not.toHaveBeenCalled();
  });

  it('没派过任务的会话结束时不瞎记（别的会话跟这条任务没关系）', async () => {
    const h = fakeBus([TARGET, { ...TARGET, sessionId: 's2', title: 'claude #2' }]);
    attachAgentBus(h.bus);
    const store = new TasksStore();
    await store.init();

    await store.dispatchTo('t1', 's1');
    added = [];
    h.exit('s2'); // 另一个会话结束了

    expect(added).toHaveLength(0);
  });

  it('同一个会话结束两次也只记一笔（退出事件可能重放）', async () => {
    const h = fakeBus([TARGET]);
    attachAgentBus(h.bus);
    const store = new TasksStore();
    await store.init();

    await store.dispatchTo('t1', 's1');
    added = [];
    h.exit('s1');
    h.exit('s1');

    expect(added).toHaveLength(1);
  });
});
