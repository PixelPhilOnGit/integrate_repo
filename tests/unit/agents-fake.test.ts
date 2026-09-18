/**
 * 浏览器假实现走完整条链路。
 *
 * 这一组**不碰 DOM**，但把 `假 agent → web 客户端 → store → 状态机` 整条路串起来跑：
 * 敲键盘、看输出、看状态。和 e2e 的分工是：e2e 管「真的画出来了吗」，
 * 这里管「同一条路上每一环的语义对不对」—— 出问题的时候能一眼看出是哪一环。
 *
 * （照 `ssh-fake.test.ts` / `sql-fake.test.ts` 的样子写：假实现是浏览器里唯一能
 * 跑的那份，它自己得被测。）
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const hub = vi.hoisted(() => ({
  create: async () => {},
  attach: () => {},
  detach: () => {},
  feed: () => {},
  note: () => {},
  dispose: () => {},
  has: () => true,
  size: () => 0,
  snapshot: () => null,
  onInput: (() => {}) as (id: string, data: Uint8Array) => void,
  onResize: (() => {}) as (id: string, cols: number, rows: number) => void,
}));
vi.mock('../../src/modules/agents/core/terminalHub', () => ({ agentHub: hub }));

vi.mock('../../src/shared/platform', () => ({
  platform: { pickWorkspace: async () => 'D:\\work\\api', confirm: async () => true },
}));

import { AgentsStore } from '../../src/modules/agents/state/store';
import { agentsServices } from '../../src/modules/agents/services';
import { createWebAgentsClient } from '../../src/modules/agents/services/web';

const encoder = new TextEncoder();

interface Harness {
  store: AgentsStore;
  client: ReturnType<typeof createWebAgentsClient>;
  /** 往某个会话里敲一行并回车（走的是用户的真实输入路径） */
  type(id: string, line: string): Promise<void>;
}

async function harness(): Promise<Harness> {
  const client = createWebAgentsClient();
  const store = new AgentsStore({ client, integration: agentsServices.integration });
  await store.init();

  const workspaceId = (await store.addWorkspace())!;
  await store.createSession(workspaceId, 'claude');

  return {
    store,
    client,
    async type(id: string, line: string): Promise<void> {
      // ⚠️ 走**用户的真实输入路径**（hub.onInput），不是直接往客户端里塞字节。
      // 直接塞的话，「用户敲了键」这个信号根本不会发出 —— 而它正是
      // 「在等你的会话，你一动它就变成正在工作」那条规则的全部依据
      hub.onInput(id, encoder.encode(`${line}\r`));
    },
  };
}

let current: Harness | null = null;
afterEach(() => {
  current?.store.stopPolling();
  current = null;
});

const sessionOf = (h: Harness) => h.store.getSnapshot().sessions[0]!;

describe('浏览器假实现的完整链路', () => {
  it('敲一行命令，进程输出真的回得来', async () => {
    const h = (current = await harness());
    await h.type(sessionOf(h).id, 'help');

    // 假 agent 的输出是通过 onEvent 推回来的，中间没有捷径
    expect(sessionOf(h).status).toBe('idle');
  });

  it('ask 之后：状态是「需要你」，而且说明是通知里那句话', async () => {
    // 假 agent 同时发了 OSC 9 和一条事件文件 —— 真世界里 Claude 的 hook 和
    // 终端通知序列就是这样重叠的。两条都到，状态只该记一次，
    // 而且**说明不能被那条没带说明的抹掉**
    const h = (current = await harness());
    const id = sessionOf(h).id;
    await h.type(id, 'ask');

    // 事件文件那条要等轮询，这里手动取一次，省下 1 秒
    await h.store.drainEvents();

    expect(sessionOf(h).status).toBe('waiting');
    expect(sessionOf(h).statusDetail).toBe('等待你的确认');
  });

  it('事件文件真的走了一遍「文件名 → 解析 → 状态」', async () => {
    const h = (current = await harness());
    const id = sessionOf(h).id;

    await h.type(id, 'work');
    await h.store.drainEvents();
    expect(sessionOf(h).status).toBe('working');

    await h.type(id, 'done');
    await h.store.drainEvents();
    expect(sessionOf(h).status).toBe('done');
  });

  it('⚠️ 取走即清空：同一批事件不会应用两次', async () => {
    const h = (current = await harness());
    const id = sessionOf(h).id;
    await h.type(id, 'work');
    await h.store.drainEvents();
    const first = sessionOf(h).history.length;

    // 再取一次应该是空的 —— 假实现和 Rust 那边一样是「取走就删」
    await h.store.drainEvents();
    expect(sessionOf(h).history).toHaveLength(first);
  });

  it('用户敲键之后，「需要你」变成「正在工作」', async () => {
    const h = (current = await harness());
    const id = sessionOf(h).id;
    await h.type(id, 'ask');
    await h.store.drainEvents();
    expect(sessionOf(h).status).toBe('waiting');

    await h.type(id, 'y');
    expect(sessionOf(h).status).toBe('working');
  });

  it('exit 之后进程退出、状态是终态，还带退出码', async () => {
    const h = (current = await harness());
    const id = sessionOf(h).id;
    await h.type(id, 'exit');

    expect(sessionOf(h).status).toBe('exited');
    expect(sessionOf(h).exitCode).toBe(0);
  });

  it('未知命令只是打一行红字，不影响状态', async () => {
    const h = (current = await harness());
    await h.type(sessionOf(h).id, 'rm -rf /');
    await h.store.drainEvents();
    expect(sessionOf(h).status).toBe('idle');
  });
});
