import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 终端实例归 hub 管，而 hub 要用真实的 xterm（需要真实布局才能量尺寸），
 * node 环境里跑不了 —— 所以这里把它换成一个记账用的替身。
 * 「终端真的画出来了吗」那类问题归 e2e（真实 Chromium）。
 */
/** 调用先后顺序的流水。有些约束只体现在「谁先谁后」上，别处看不出来 */
const log = vi.hoisted(() => [] as string[]);

const hub = vi.hoisted(() => ({
  create: vi.fn(async (id: string, _cols: number, _rows: number) => {
    log.push(`建终端:${id}`);
  }),
  attach: vi.fn(),
  detach: vi.fn(),
  feed: vi.fn(),
  note: vi.fn(),
  dispose: vi.fn(),
  has: vi.fn(() => true),
  size: vi.fn(() => 0),
  snapshot: vi.fn(() => null),
  onInput: (() => {}) as (id: string, data: Uint8Array) => void,
  onResize: (() => {}) as (id: string, cols: number, rows: number) => void,
}));
vi.mock('../../src/modules/agents/core/terminalHub', () => ({ agentHub: hub }));

const fakePlatform = vi.hoisted(() => ({
  pickWorkspace: vi.fn(),
  confirm: vi.fn(),
}));
vi.mock('../../src/shared/platform', () => ({ platform: fakePlatform }));

import type { EventFile } from '../../src/modules/agents/services/types';
import type {
  AgentsClient,
  AgentsServices,
  IntegrationClient,
  IntegrationOutcome,
  IntegrationStatus,
  IntegrationTarget,
  PtyOpenRequest,
} from '../../src/modules/agents/services/types';
import { AgentsStore } from '../../src/modules/agents/state/store';
import { panesOf, rectsOf } from '../../src/modules/agents/core/layout';
import { MAX_SESSIONS_PER_KIND } from '../../src/modules/agents/core/types';
import type { ShellApi } from '../../src/shell/types';
import { __resetIdsForTest } from '../../src/shared/ids';

const encoder = new TextEncoder();

/**
 * 事件文件的时间戳。
 *
 * ⚠️ **必须是真实量级**（`Date.now()` 附近），不能图省事写 `1000` / `2000`：
 * store 会丢掉「比会话当前状态还早」的事件（那是为了挡住「文件删不掉被重读」
 * 那条路），而会话的 `statusAt` 是 `Date.now()` —— 用小数字的话所有事件都会被
 * 当成十几年前的旧事丢掉，测试就变成假的绿。
 */
const stamp = (offsetMs: number): number => Date.now() + offsetMs;


/** 记账用的假客户端：它不跑进程，但把每一次调用**如实记下来** */
class FakeClient implements AgentsClient {
  opened: PtyOpenRequest[] = [];
  written: Array<{ id: string; text: string }> = [];
  resized: Array<{ id: string; cols: number; rows: number }> = [];
  closed: string[] = [];
  closeAllCount = 0;
  events: EventFile[] = [];
  failOpen: Error | null = null;
  failEvents: Error | null = null;
  /**
   * 写的时候**在返回之前**先吐点东西出来。
   *
   * 真进程就是这样：用户按下 Enter，它往往立刻就开始输出 —— 而输出里可能
   * 带着终端通知序列。这个钩子用来把那个时序压出来。
   */
  onWrite: ((id: string) => void) | null = null;

  async open(request: PtyOpenRequest): Promise<void> {
    if (this.failOpen !== null) throw this.failOpen;
    log.push(`开进程:${request.id}`);
    this.opened.push(request);
  }
  async write(id: string, data: Uint8Array): Promise<void> {
    this.written.push({ id, text: new TextDecoder().decode(data) });
    this.onWrite?.(id);
  }
  async resize(id: string, cols: number, rows: number): Promise<void> {
    this.resized.push({ id, cols, rows });
  }
  async close(id: string): Promise<void> {
    this.closed.push(id);
  }
  async closeAll(): Promise<void> {
    this.closeAllCount += 1;
  }
  async takeEvents(): Promise<EventFile[]> {
    if (this.failEvents !== null) throw this.failEvents;
    const taken = this.events;
    this.events = [];
    return taken;
  }
  async eventsDir(): Promise<string> {
    return 'C:\\Users\\me\\AppData\\Roaming\\devtoolkit\\agents-events';
  }

  /** 假装进程吐了字节 */
  emit(id: string, text: string): void {
    this.requestOf(id).onEvent({ kind: 'data', bytes: encoder.encode(text) });
  }

  /** 假装进程退出了 */
  emitExit(id: string, code: number | null): void {
    this.requestOf(id).onEvent({ kind: 'exit', code });
  }

  /** 假装用户在窗格里敲了键 */
  emitInput(id: string, text: string): void {
    hub.onInput(id, encoder.encode(text));
  }

  private requestOf(id: string): PtyOpenRequest {
    const request = this.opened.find((r) => r.id === id);
    if (request === undefined) throw new Error(`没有这个会话：${id}`);
    return request;
  }
}

class FakeIntegration implements IntegrationClient {
  states: Record<IntegrationTarget, IntegrationStatus['state']> = {
    claude: 'missing',
    codex: 'missing',
  };
  applied: IntegrationTarget[] = [];
  reverted: IntegrationTarget[] = [];
  failWith: Error | null = null;

  async status(target: IntegrationTarget): Promise<IntegrationStatus> {
    return {
      target,
      path: `/home/me/.${target}/config`,
      state: this.states[target],
      preview: '',
    };
  }
  async apply(target: IntegrationTarget): Promise<IntegrationOutcome> {
    if (this.failWith !== null) throw this.failWith;
    this.applied.push(target);
    this.states[target] = 'installed';
    return { target, path: '', backupPath: null, preview: '' };
  }
  async revert(target: IntegrationTarget): Promise<IntegrationOutcome> {
    this.reverted.push(target);
    this.states[target] = 'absent';
    return { target, path: '', backupPath: null, preview: '' };
  }
}

interface Harness {
  store: AgentsStore;
  client: FakeClient;
  integration: FakeIntegration;
  shell: ShellApi & { errors: unknown[]; status: string[] };
}

function harness(): Harness {
  const client = new FakeClient();
  const integration = new FakeIntegration();
  const services: AgentsServices = { client, integration };
  const store = new AgentsStore(services);

  const errors: unknown[] = [];
  const status: string[] = [];
  const shell = {
    errors,
    status,
    setStatus: (msg: string | null) => {
      if (msg !== null) status.push(msg);
    },
    reportError: (e: unknown) => {
      errors.push(e);
    },
  };
  store.attachShell(shell);

  return { store, client, integration, shell };
}

/** 建一个工作目录并返回它的 id */
async function withWorkspace(h: Harness, path = 'D:\\work\\api'): Promise<string> {
  fakePlatform.pickWorkspace.mockResolvedValueOnce(path);
  const id = await h.store.addWorkspace();
  if (id === null) throw new Error('工作目录没加上');
  return id;
}

let current: Harness | null = null;

function make(): Harness {
  current = harness();
  return current;
}

beforeEach(() => {
  __resetIdsForTest();
  vi.clearAllMocks();
  log.length = 0;
  fakePlatform.confirm.mockResolvedValue(true);
  // kv 的浏览器实现落在 localStorage 上；node 里没有它，
  // 给个最小替身，持久化那几条才测得到
  const memory = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => memory.get(k) ?? null,
    setItem: (k: string, v: string) => void memory.set(k, v),
  };
});

afterEach(() => {
  current?.store.stopPolling();
  current = null;
});

describe('初始化', () => {
  it('起来先把后台可能挂着的旧会话收掉', async () => {
    // webview 刷新之后前端认不得 Rust 侧还活着的会话了 —— 不收的话它们
    // 会一直在后台跑着烧 token，用户在界面上看不见也关不掉
    const h = make();
    await h.store.init();
    expect(h.client.closeAllCount).toBe(1);
    expect(h.store.getSnapshot().ready).toBe(true);
  });

  it('重复调只会真正跑一次', async () => {
    const h = make();
    await Promise.all([h.store.init(), h.store.init(), h.store.init()]);
    expect(h.client.closeAllCount).toBe(1);
  });

  it('读回上次存的工作目录', async () => {
    localStorage.setItem(
      'devtoolkit.agents.v1',
      JSON.stringify({
        workspaces: [{ id: 'ws_1', path: 'D:\\work\\web', name: 'web' }],
      }),
    );
    const h = make();
    await h.store.init();
    expect(h.store.getSnapshot().workspaces).toEqual([
      { id: 'ws_1', path: 'D:\\work\\web', name: 'web' },
    ]);
  });

  it('⚠️ 存坏了的条目丢掉，不让整份作废', async () => {
    // 手改过的、旧版本的文件都要能读 —— 一条坏了就整份读不出来，
    // 用户看到的是「我的工作目录全没了」，而他只是手滑改错了一个字符
    localStorage.setItem(
      'devtoolkit.agents.v1',
      JSON.stringify({
        workspaces: [
          { id: 'ok', path: 'D:\\work', name: 'work' },
          { id: '', path: 'D:\\坏', name: '坏' },
          { path: 'D:\\没有 id' },
          '压根不是对象',
          null,
        ],
      }),
    );
    const h = make();
    await h.store.init();
    expect(h.store.getSnapshot().workspaces.map((w) => w.id)).toEqual(['ok']);
  });
});

describe('工作目录', () => {
  it('弹目录框加一个，名字取路径最后一段', async () => {
    const h = make();
    const id = await withWorkspace(h, 'D:\\work\\api');
    const ws = h.store.getSnapshot().workspaces;
    expect(ws).toHaveLength(1);
    expect(ws[0]!.path).toBe('D:\\work\\api');
    expect(ws[0]!.name).toBe('api');
    expect(id).toBe(ws[0]!.id);
  });

  it('用户取消就什么都不加', async () => {
    const h = make();
    fakePlatform.pickWorkspace.mockResolvedValueOnce(null);
    expect(await h.store.addWorkspace()).toBeNull();
    expect(h.store.getSnapshot().workspaces).toEqual([]);
  });

  it('同一个目录不重复加（Windows 路径不区分大小写）', async () => {
    const h = make();
    await withWorkspace(h, 'D:\\work\\api');
    fakePlatform.pickWorkspace.mockResolvedValueOnce('d:\\WORK\\API');
    await h.store.addWorkspace();
    expect(h.store.getSnapshot().workspaces).toHaveLength(1);
    expect(h.shell.status.join()).toContain('已经在列表里');
  });

  it('删带会话的工作目录要先问过 —— 那些会话会被一并关掉', async () => {
    const h = make();
    const ws = await withWorkspace(h);
    const session = await h.store.createSession(ws, 'claude');

    fakePlatform.confirm.mockResolvedValueOnce(false);
    await h.store.removeWorkspace(ws);
    expect(h.store.getSnapshot().workspaces).toHaveLength(1);
    expect(h.client.closed).toEqual([]); // 用户点了取消，会话不该被关

    fakePlatform.confirm.mockResolvedValueOnce(true);
    await h.store.removeWorkspace(ws);
    expect(h.store.getSnapshot().workspaces).toEqual([]);
    expect(h.client.closed).toEqual([session]);
  });
});

describe('新建会话', () => {
  it('进程起在工作目录里，并且注入状态检测要用的两个环境变量', async () => {
    // ⚠️ 状态检测整条链路都挂着这两个变量：agent 继承它们，它拉起来的
    // hook 进程再继承一次。少一个，hook 脚本就静默退出，界面上永远是「空闲」
    const h = make();
    const ws = await withWorkspace(h, 'D:\\work\\api');
    const id = await h.store.createSession(ws, 'claude');

    const req = h.client.opened[0]!;
    expect(req.id).toBe(id);
    expect(req.cwd).toBe('D:\\work\\api');
    expect(req.command).toBe('claude');
    expect(req.env['DEVTOOLKIT_PANE_ID']).toBe(id);
    expect(req.env['DEVTOOLKIT_EVENT_DIR']).toBe(
      'C:\\Users\\me\\AppData\\Roaming\\devtoolkit\\agents-events',
    );
  });

  it('⚠️ 终端必须先建好，再开进程', async () => {
    // 反过来的话，进程吐出来的头几行字节到达时终端还不存在 ——
    // 那几行会掉在地上（或者需要另写一套缓冲，而缓冲本身又是竞态的来源）
    const h = make();
    const ws = await withWorkspace(h);
    const id = (await h.store.createSession(ws, 'claude'))!;

    const create = log.indexOf(`建终端:${id}`);
    const open = log.indexOf(`开进程:${id}`);
    expect(create).toBeGreaterThanOrEqual(0);
    expect(create).toBeLessThan(open);
  });

  it('⚠️ 回归：会话进 state 之前，终端必须已经在 hub 里了', async () => {
    // 会话一进 state，界面立刻把它那一格渲染出来，而那一格的 effect 会去 hub 里
    // 找终端 —— 找不到时 `attach` 是**静默空操作**（它按「会话可能已经关了」处理），
    // 于是终端永远留在屏幕外：侧栏、状态、退出码全对，只有画面是空的。
    // 这个 bug 是 e2e 抓出来的：store 单测里 hub 是替身，空操作看不出来
    const h = make();
    const ws = await withWorkspace(h);

    let logLenWhenVisible = -1;
    h.store.subscribe(() => {
      if (logLenWhenVisible === -1 && h.store.getSnapshot().sessions.length > 0) {
        logLenWhenVisible = log.length;
      }
    });

    const id = (await h.store.createSession(ws, 'claude'))!;
    expect(log.slice(0, logLenWhenVisible)).toContain(`建终端:${id}`);
  });

  it('新会话立刻上屏，聚焦也在它身上', async () => {
    const h = make();
    const ws = await withWorkspace(h);
    const id = await h.store.createSession(ws, 'claude');
    const s = h.store.getSnapshot();
    expect(h.store.activeLayout()).toEqual({ kind: 'leaf', sessionId: id });
    expect(s.focusedId).toBe(id);
  });

  it('已经有一块屏幕时，新会话**替换**它而不是又切一刀', async () => {
    // 用户点了「新建会话」是想看见它，不是想把屏幕切成两半
    const h = make();
    const ws = await withWorkspace(h);
    await h.store.createSession(ws, 'claude');
    const second = await h.store.createSession(ws, 'claude');
    const s = h.store.getSnapshot();
    expect(h.store.activeLayout()).toEqual({ kind: 'leaf', sessionId: second });
    expect(s.sessions).toHaveLength(2);
  });

  it('标题按类型编号', async () => {
    const h = make();
    const ws = await withWorkspace(h);
    await h.store.createSession(ws, 'claude');
    await h.store.createSession(ws, 'claude');
    await h.store.createSession(ws, 'codex');
    expect(h.store.getSnapshot().sessions.map((s) => s.title)).toEqual([
      'claude #1',
      'claude #2',
      'codex #1',
    ]);
  });

  it('进程起不来时：会话留在侧栏并写明原因，而不是「点了没反应」', async () => {
    const h = make();
    const ws = await withWorkspace(h);
    h.client.failOpen = new Error('目录不存在');

    const id = await h.store.createSession(ws, 'claude');
    const session = h.store.getSnapshot().sessions.find((s) => s.id === id)!;
    expect(session.status).toBe('exited');
    expect(session.statusDetail).toContain('目录不存在');
    // 不弹外壳错误条：它是「一条结果」，终端里/侧栏上显示出来就行
    expect(h.shell.errors).toEqual([]);
  });
});

describe('分屏', () => {
  it('向右分屏：新会话在右边，焦点跟着过去', async () => {
    const h = make();
    const ws = await withWorkspace(h);
    const first = await h.store.createSession(ws, 'claude');
    await h.store.splitWithNewSession('row');

    const s = h.store.getSnapshot();
    expect(h.store.activeLayout()).toEqual({
      kind: 'split',
      dir: 'row',
      ratio: 0.5,
      a: { kind: 'leaf', sessionId: first },
      b: { kind: 'leaf', sessionId: s.focusedId },
    });
  });

  it('把一个已有的会话摆到旁边（不是新建进程）', async () => {
    const h = make();
    const ws = await withWorkspace(h);
    const a = await h.store.createSession(ws, 'claude');
    const b = await h.store.createSession(ws, 'claude'); // b 现在占着唯一那块

    h.store.putOnScreen(a!, 'row');
    expect(h.store.activeLayout()).toEqual({
      kind: 'split',
      dir: 'row',
      ratio: 0.5,
      a: { kind: 'leaf', sessionId: b },
      b: { kind: 'leaf', sessionId: a },
    });
    expect(h.client.opened).toHaveLength(2); // 没有新起进程
  });

  it('关掉一块：会话还在，只是不在屏幕上了', async () => {
    const h = make();
    const ws = await withWorkspace(h);
    const a = await h.store.createSession(ws, 'claude');
    const b = await h.store.splitWithNewSession('row').then(() => h.store.getSnapshot().focusedId!);

    h.store.closePaneFor(b);
    const s = h.store.getSnapshot();
    expect(h.store.activeLayout()).toEqual({ kind: 'leaf', sessionId: a });
    expect(s.sessions.map((x) => x.id)).toContain(b); // 进程没被杀
    expect(h.client.closed).toEqual([]);
  });

  it('焦点排在后面时也能正确地把会话摆上去', async () => {
    // 聚焦的那块可能已经不在布局里了（上一帧的按钮），此时不该静默什么都不做
    const h = make();
    const ws = await withWorkspace(h);
    const a = await h.store.createSession(ws, 'claude');
    const b = await h.store.splitWithNewSession('row').then(() => h.store.getSnapshot().focusedId!);

    h.store.closePaneFor(b); // 布局回到只剩 a，但 focusedId 还指着 b
    const c = await h.store.createSession(ws, 'codex');
    expect(h.store.activeLayout()).toEqual({ kind: 'leaf', sessionId: c });
    expect(a).not.toBe(c);
  });

  it('方向键在窗格之间移动焦点', async () => {
    const h = make();
    const ws = await withWorkspace(h);
    const left = await h.store.createSession(ws, 'claude');
    await h.store.splitWithNewSession('row');
    const right = h.store.getSnapshot().focusedId!;

    h.store.focusDirection('left');
    expect(h.store.getSnapshot().focusedId).toBe(left);
    h.store.focusDirection('right');
    expect(h.store.getSnapshot().focusedId).toBe(right);
    h.store.focusDirection('right'); // 已经在最右边，不动
    expect(h.store.getSnapshot().focusedId).toBe(right);
  });
});

describe('状态事件（外部程序报进来的那一路）', () => {
  async function session(h: Harness): Promise<string> {
    const ws = await withWorkspace(h);
    return (await h.store.createSession(ws, 'claude'))!;
  }

  it('⚠️ 回归：删不掉的事件被重读时，不能把状态改回旧值', async () => {
    // Rust 那边「取走即删」在删不掉的时候（Windows 上文件被别的进程占着）
    // **不回滚也不重试**，宁可下次扫描再读一遍 —— 而那条重读带着**旧的 mtime**。
    // 不挡的话：会话已经跑到「已完成」，一条十秒前的「在等你」被重读一次，
    // 状态点就倒回去了，用户看到的是一个早就过去的状态
    const h = make();
    const id = await session(h);

    h.client.events.push({ name: `done.${id}`, at: stamp(1) });
    await h.store.drainEvents();
    expect(h.store.getSnapshot().sessions[0]!.status).toBe('done');

    // 重读的那条：十秒前写的
    h.client.events.push({ name: `waiting.${id}`, at: Date.now() - 10_000 });
    await h.store.drainEvents();
    expect(h.store.getSnapshot().sessions[0]!.status).toBe('done');
  });

  it('但刚写下的文件不能被误伤 —— 有些文件系统的 mtime 只精确到 2 秒', async () => {
    // exFAT / FAT32 的 mtime 粒度是 2 秒：文件确实是刚写的，mtime 却可能比
    // 上一次状态变化早上一秒多。误伤它比重复应用更糟 —— **提醒会凭空消失**，
    // 而用户完全无从察觉。所以宽限窗口就是照着最粗的 2 秒来的
    const h = make();
    const id = await session(h);

    h.client.events.push({ name: `working.${id}`, at: stamp(1) });
    await h.store.drainEvents();

    h.client.events.push({ name: `waiting.${id}`, at: Date.now() - 1_500 });
    await h.store.drainEvents();
    expect(h.store.getSnapshot().sessions[0]!.status).toBe('waiting');
  });

  it('事件文件把会话推进「需要你」，并进入队列', async () => {
    const h = make();
    const id = await session(h);
    h.client.events.push({ name: `waiting.${id}`, at: stamp(5) });
    await h.store.drainEvents();

    const s = h.store.getSnapshot().sessions[0]!;
    expect(s.status).toBe('waiting');
    expect(h.store.getSnapshot().lastEventAt).toBe(stamp(5));
  });

  it('⚠️ 认不出这个会话就丢掉 —— 这是防伪造那一道', async () => {
    // 能往事件目录里写文件的人（或者别的 Devtoolkit 实例留下的旧文件）
    // 不该能影响界面。会话 id 是我们随机生成的，外面得先猜中它
    const h = make();
    await session(h);
    h.client.events.push({ name: 'waiting.pane_别人编的', at: stamp(5) });
    await h.store.drainEvents();
    expect(h.store.getSnapshot().sessions[0]!.status).not.toBe('waiting');
  });

  it('目录里的杂物被静静忽略，不弹错误条', async () => {
    const h = make();
    const id = await session(h);
    h.client.events.push({ name: 'README.txt.swp', at: stamp(1) });
    h.client.events.push({ name: 'exited.abc', at: stamp(2) });
    h.client.events.push({ name: 'waiting.a/b', at: stamp(3) });
    await h.store.drainEvents();
    expect(h.shell.errors).toEqual([]);
    expect(h.store.getSnapshot().sessions[0]!.status).not.toBe('waiting');
    expect(id).toBe(h.store.getSnapshot().sessions[0]!.id);
  });

  it('攒了一堆只按最新的那条算', async () => {
    const h = make();
    const id = await session(h);
    h.client.events.push({ name: `working.${id}`, at: stamp(1) });
    h.client.events.push({ name: `done.${id}`, at: stamp(3) });
    h.client.events.push({ name: `waiting.${id}`, at: stamp(2) });
    await h.store.drainEvents();
    expect(h.store.getSnapshot().sessions[0]!.status).toBe('done');
  });

  it('⚠️ 回归：同一个批次里 working 紧跟 waiting，两条都要算数', async () => {
    // 曾经这里是「同一个会话只留最新那条」，于是「它离开过等待又回来了」这个
    // 事实就被压掉了 —— 而你确认过的会话正要靠这个事实**再次**提醒你。
    // 场景：它在等你 → 你点了「知道了」→ 它接着干 → 又停下等你
    const h = make();
    const id = await session(h);
    h.client.events.push({ name: `waiting.${id}`, at: stamp(1) });
    await h.store.drainEvents();
    h.store.acknowledge(id);
    expect(h.store.jumpToAttention()).toBe(false); // 确认过了，不在队列里

    h.client.events.push({ name: `working.${id}`, at: stamp(2) });
    h.client.events.push({ name: `waiting.${id}`, at: stamp(3) });
    await h.store.drainEvents();

    expect(h.store.jumpToAttention()).toBe(true);
  });

  it('事件目录读不了：安静记下来，不弹错误条（轮询一秒一次，会刷爆界面）', async () => {
    const h = make();
    await session(h);
    h.client.failEvents = new Error('目录不见了');
    await h.store.drainEvents();

    expect(h.shell.errors).toEqual([]);
    expect(h.store.getSnapshot().eventsError).toContain('目录不见了');

    h.client.failEvents = null;
    await h.store.drainEvents();
    expect(h.store.getSnapshot().eventsError).toBeNull();
  });
});

describe('终端转义序列（零配置那一路）', () => {
  it('OSC 9 让会话进入「需要你」，说明就是通知正文', async () => {
    const h = make();
    const ws = await withWorkspace(h);
    const id = (await h.store.createSession(ws, 'codex'))!;
    h.client.emit(id, '\x1b]9;等你确认一下\x07');

    const s = h.store.getSnapshot().sessions[0]!;
    expect(s.status).toBe('waiting');
    expect(s.statusDetail).toBe('等你确认一下');
  });

  it('⚠️ 扫描序列**不吃字节** —— 原封不动喂给终端', async () => {
    // OSC 里还有设置窗口标题、超链接这些东西，顺手把认出来的序列删掉
    // 会把它们一起弄坏，而且坏得很隐蔽
    const h = make();
    const ws = await withWorkspace(h);
    const id = (await h.store.createSession(ws, 'codex'))!;
    const raw = '\x1b]9;在的\x07普通输出';

    h.client.emit(id, raw);
    expect(hub.feed).toHaveBeenCalledWith(id, encoder.encode(raw));
  });

  it('同一个会话的扫描器是分开的：两个会话的字节不会拼到一起', async () => {
    const h = make();
    const ws = await withWorkspace(h);
    const a = (await h.store.createSession(ws, 'codex'))!;
    const b = (await h.store.splitWithNewSession('row').then(() => h.store.getSnapshot().focusedId!))!;

    // 一条序列被切成两半，但喂给了**不同的会话**
    h.client.emit(a, '\x1b]9;半条');
    h.client.emit(b, '半条\x07');
    expect(h.store.getSnapshot().sessions.every((s) => s.status !== 'waiting')).toBe(true);

    h.client.emit(a, '整条\x07');
    expect(h.store.getSnapshot().sessions.find((s) => s.id === a)!.status).toBe('waiting');
  });
});

describe('用户的键盘', () => {
  async function waiting(h: Harness): Promise<string> {
    const ws = await withWorkspace(h);
    const id = (await h.store.createSession(ws, 'claude'))!;
    h.client.events.push({ name: `waiting.${id}`, at: stamp(5) });
    await h.store.drainEvents();
    return id;
  }

  it('敲了键就当他已经在处理了：离开「需要你」', async () => {
    const h = make();
    const id = await waiting(h);
    h.client.emitInput(id, 'y');
    await vi.waitFor(() => {
      expect(h.store.getSnapshot().sessions[0]!.status).toBe('working');
    });
    expect(h.client.written.map((w) => w.text)).toEqual(['y']);
  });

  it('⚠️ 回归：Ctrl+C 能从「正在工作」里出来', async () => {
    // Claude Code 的 Stop hook 在用户按 Esc/Ctrl+C 打断时**不触发**，
    // 不补这一下状态会永远卡在「正在工作」，用户一直等一个已经停下来的会话
    const h = make();
    const ws = await withWorkspace(h);
    const id = (await h.store.createSession(ws, 'claude'))!;
    h.client.events.push({ name: `working.${id}`, at: stamp(1) });
    await h.store.drainEvents();
    expect(h.store.getSnapshot().sessions[0]!.status).toBe('working');

    h.client.emitInput(id, '\x03');
    await vi.waitFor(() => {
      expect(h.store.getSnapshot().sessions[0]!.status).toBe('idle');
    });
  });

  it('⚠️ 回归：按键的信号要在写之前生效，不能被进程的回话反超', async () => {
    // 真实时序：用户按下 Enter → 我们把这一下发给进程 → 进程**立刻**开始输出，
    // 输出里带着终端通知序列「等待你的确认」。
    //
    // 曾经是先 `await` 写、再记「用户敲了键」，于是那条信号落在了进程回话
    // **之后** —— 刚收到的「需要你」当场被改回「正在工作」，通知里那句话也没了。
    // e2e 抓到的（单测当时漏了，因为假客户端的 write 不吐字节）
    const h = make();
    const ws = await withWorkspace(h);
    const id = (await h.store.createSession(ws, 'claude'))!;

    h.client.onWrite = (sessionId) => h.client.emit(sessionId, '\x1b]9;等待你的确认\x07');
    h.client.emitInput(id, '\r');

    await vi.waitFor(() => {
      expect(h.store.getSnapshot().sessions[0]!.status).toBe('waiting');
    });
    expect(h.store.getSnapshot().sessions[0]!.statusDetail).toBe('等待你的确认');
  });

  it('普通 shell 窗格里敲键不会把它标成「正在工作」', async () => {
    const h = make();
    const ws = await withWorkspace(h);
    const id = (await h.store.createSession(ws, 'shell'))!;
    h.client.emitInput(id, 'ls\r');
    await vi.waitFor(() => {
      expect(h.client.written).toHaveLength(1);
    });
    expect(h.store.getSnapshot().sessions[0]!.status).toBe('idle');
  });
});

describe('进程退出', () => {
  it('退出码记下来，状态是终态', async () => {
    const h = make();
    const ws = await withWorkspace(h);
    const id = (await h.store.createSession(ws, 'claude'))!;
    h.client.emitExit(id, 3);

    const s = h.store.getSnapshot().sessions[0]!;
    expect(s.status).toBe('exited');
    expect(s.exitCode).toBe(3);
    expect(hub.note).toHaveBeenCalled();
  });
});

describe('关会话', () => {
  it('杀进程、从布局摘掉、释放终端', async () => {
    const h = make();
    const ws = await withWorkspace(h);
    const id = (await h.store.createSession(ws, 'claude'))!;
    await h.store.closeSession(id);

    expect(h.client.closed).toEqual([id]);
    expect(hub.dispose).toHaveBeenCalledWith(id);
    expect(h.store.getSnapshot().sessions).toEqual([]);
    expect(h.store.activeLayout()).toBeNull();
  });

  it('关掉一块之后，布局里剩下的那一块顶上', async () => {
    const h = make();
    const ws = await withWorkspace(h);
    const a = (await h.store.createSession(ws, 'claude'))!;
    const b = (await h.store.splitWithNewSession('row').then(() => h.store.getSnapshot().focusedId!))!;

    await h.store.closeSession(b);
    expect(h.store.activeLayout()).toEqual({ kind: 'leaf', sessionId: a });
    expect(h.store.getSnapshot().focusedId).toBe(a);
  });
});

describe('「需要你」队列', () => {
  async function threeWaiting(h: Harness): Promise<string[]> {
    const ws = await withWorkspace(h);
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      ids.push((await h.store.createSession(ws, 'claude'))!);
    }
    // 先等的最后一个建，所以给它们错开的时间
    h.client.events.push({ name: `waiting.${ids[0]}`, at: stamp(3) });
    h.client.events.push({ name: `waiting.${ids[1]}`, at: stamp(1) });
    h.client.events.push({ name: `waiting.${ids[2]}`, at: stamp(2) });
    await h.store.drainEvents();
    return ids;
  }

  it('跳到等得最久的那个，并把它摆到屏幕上', async () => {
    const h = make();
    const ids = await threeWaiting(h);
    // 屏幕上现在只有最后一个建的（ids[2]）
    expect(h.store.jumpToAttention()).toBe(true);
    expect(h.store.getSnapshot().focusedId).toBe(ids[1]); // at=1000，等得最久
  });

  it('跳过去之后它就不在队列里了', async () => {
    const h = make();
    await threeWaiting(h);
    h.store.jumpToAttention();
    h.store.jumpToAttention();
    h.store.jumpToAttention();
    // 三个都在队列里，跳三次之后队列空
    expect(h.store.jumpToAttention()).toBe(false);
    expect(h.shell.status.join()).toContain('没有在等你');
  });

  it('⚠️ 表示过已知晓之后它**再次**进入等待，要重新回到队列里', async () => {
    // 忘了这条的话，一个会话提醒过你一次之后，这一整轮都不会再叫你了
    const h = make();
    const ws = await withWorkspace(h);
    const id = (await h.store.createSession(ws, 'claude'))!;

    h.client.events.push({ name: `waiting.${id}`, at: stamp(1) });
    await h.store.drainEvents();
    h.store.acknowledge(id);

    expect(h.store.jumpToAttention()).toBe(false); // 队列空

    h.client.events.push({ name: `working.${id}`, at: stamp(2) });
    h.client.events.push({ name: `waiting.${id}`, at: stamp(3) });
    await h.store.drainEvents();
    expect(h.store.jumpToAttention()).toBe(true);
  });
});

describe('集成向导', () => {
  it('查状态、写入、撤销', async () => {
    const h = make();
    await h.store.refreshIntegration('claude');
    expect(h.store.getSnapshot().integration.claude?.state).toBe('missing');

    await h.store.applyIntegration('claude');
    expect(h.integration.applied).toEqual(['claude']);
    expect(h.store.getSnapshot().integration.claude?.state).toBe('installed');

    await h.store.revertIntegration('claude');
    expect(h.integration.reverted).toEqual(['claude']);
    expect(h.store.getSnapshot().integration.claude?.state).toBe('absent');
  });

  it('写失败时把原因交给外壳统一处理，而且不卡住「进行中」', async () => {
    const h = make();
    h.integration.failWith = new Error('配置文件不是合法的 JSON');
    await h.store.applyIntegration('claude');

    expect(h.shell.errors).toHaveLength(1);
    expect(h.store.getSnapshot().integrating).toBe(false);
  });

  it('状态文案：五个状态都要说人话，而且 missing 和 absent 不能糊成一个', async () => {
    // 「还没建过配置文件」和「配置在，但状态检测没开」对用户是两件事：
    // 前者他可能压根没装那个工具，后者是开了开关就行
    const h = make();
    const label = async (state: IntegrationStatus['state']): Promise<string> => {
      h.integration.states.claude = state;
      await h.store.refreshIntegration('claude');
      return h.store.integrationLabel('claude');
    };

    expect(await label('missing')).toBe('未启用');
    expect(await label('absent')).toBe('未启用');
    expect(await label('installed')).toBe('已启用');
    expect(await label('modified')).toBe('已启用（被改过）');
    expect(await label('unusable')).toBe('配置文件读不了');
  });
});

describe('窗口：一个工作目录一套分屏', () => {
  it('两个目录各摆各的，切回去原样还在', async () => {
    const h = make();
    const a = await withWorkspace(h, 'D:\\work\\a');
    const b = await withWorkspace(h, 'D:\\work\\b');

    // a 里摆两块
    await h.store.createSession(a, 'claude');
    await h.store.splitWithNewSession('row');
    const layoutA = h.store.activeLayout();
    expect(panesOf(layoutA!)).toHaveLength(2);

    // 切到 b：它是空的（不是「继承了 a 的两块」）
    h.store.setActiveWorkspace(b);
    expect(h.store.activeLayout()).toBeNull();

    // b 里开一个 —— 会**自动切回 b**（用户刚建的会话得看得见）
    const b1 = (await h.store.createSession(b, 'shell'))!;
    expect(h.store.getSnapshot().activeWorkspaceId).toBe(b);
    expect(panesOf(h.store.activeLayout()!)).toEqual([b1]);

    // 切回 a：两块原样
    h.store.setActiveWorkspace(a);
    expect(h.store.activeLayout()).toEqual(layoutA);
  });

  it('切窗口时焦点落到新窗口的第一块（不然键盘指向上一个窗口）', async () => {
    const h = make();
    const a = await withWorkspace(h, 'D:\\work\\a');
    const b = await withWorkspace(h, 'D:\\work\\b');

    await h.store.createSession(a, 'claude');
    const b1 = (await h.store.createSession(b, 'claude'))!;
    h.store.setActiveWorkspace(a);

    const firstInA = panesOf(h.store.activeLayout()!)[0];
    expect(h.store.getSnapshot().focusedId).toBe(firstInA);
    expect(h.store.getSnapshot().focusedId).not.toBe(b1);
  });

  it('关掉会话只动它自己那个窗口', async () => {
    const h = make();
    const a = await withWorkspace(h, 'D:\\work\\a');
    const b = await withWorkspace(h, 'D:\\work\\b');

    await h.store.createSession(a, 'claude');
    await h.store.splitWithNewSession('row');
    const layoutA = h.store.activeLayout();

    const b1 = (await h.store.createSession(b, 'claude'))!;
    // 现在显示的是 b；把 b 里那个会话关掉，a 的两块不该被动
    await h.store.closeSession(b1);

    h.store.setActiveWorkspace(a);
    expect(h.store.activeLayout()).toEqual(layoutA);
  });

  it('跳到一个别的窗口里的会话：窗口跟着切过去', async () => {
    const h = make();
    const a = await withWorkspace(h, 'D:\\work\\a');
    const b = await withWorkspace(h, 'D:\\work\\b');

    await h.store.createSession(a, 'claude');
    const b1 = (await h.store.createSession(b, 'claude'))!;
    h.store.setActiveWorkspace(a);

    h.store.jumpTo(b1);
    expect(h.store.getSnapshot().activeWorkspaceId).toBe(b);
    expect(h.store.getSnapshot().focusedId).toBe(b1);
  });
});

describe('关掉一个窗口里的全部会话（目录留着）', () => {
  it('全关掉，目录还在', async () => {
    const h = make();
    const ws = await withWorkspace(h);
    await h.store.createSession(ws, 'claude');
    await h.store.splitWithNewSession('row');
    expect(h.store.getSnapshot().sessions).toHaveLength(2);

    const closed = await h.store.closeWorkspaceSessions(ws);

    expect(closed).toBe(2);
    expect(h.store.getSnapshot().sessions).toHaveLength(0);
    expect(h.store.getSnapshot().workspaces).toHaveLength(1); // 目录留着
    expect(h.store.activeLayout()).toBeNull();
  });

  it('⚠️ 有会话在跑就先问一句；用户说不就不关', async () => {
    const h = make();
    const ws = await withWorkspace(h);
    await h.store.createSession(ws, 'claude');

    fakePlatform.confirm.mockResolvedValueOnce(false);
    expect(await h.store.closeWorkspaceSessions(ws)).toBe(0);
    expect(h.store.getSnapshot().sessions).toHaveLength(1);
    // 而且是真的问过（不是默默跳过）
    expect(fakePlatform.confirm).toHaveBeenCalledTimes(1);
  });

  it('会话都已经跑完了就不问，直接收', async () => {
    const h = make();
    const ws = await withWorkspace(h);
    const id = (await h.store.createSession(ws, 'claude'))!;
    h.client.emitExit(id, 0);

    expect(await h.store.closeWorkspaceSessions(ws)).toBe(1);
    expect(fakePlatform.confirm).not.toHaveBeenCalled();
  });

  it('一个会话都没有时什么都不做', async () => {
    const h = make();
    const ws = await withWorkspace(h);
    expect(await h.store.closeWorkspaceSessions(ws)).toBe(0);
  });
});

describe('删掉工作目录', () => {
  it('窗口跟着收掉，当前窗口换到剩下的那个', async () => {
    const h = make();
    const a = await withWorkspace(h, 'D:\\work\\a');
    const b = await withWorkspace(h, 'D:\\work\\b');
    await h.store.createSession(a, 'claude');
    await h.store.createSession(b, 'claude');

    // 现在显示的是 b
    await h.store.removeWorkspace(b);

    const snap = h.store.getSnapshot();
    expect(snap.workspaces.map((w) => w.id)).toEqual([a]);
    expect(snap.activeWorkspaceId).toBe(a);
    expect(Object.keys(snap.layouts)).toEqual([a]); // b 那套布局没了
  });
});

describe('启动参数（全局一份）', () => {
  it('没设过就是默认命令', async () => {
    const h = make();
    const ws = await withWorkspace(h);
    await h.store.createSession(ws, 'claude');
    expect(h.client.opened[0]!.command).toBe('claude');
  });

  it('设过之后新建的会话把参数接在命令后面', async () => {
    const h = make();
    const ws = await withWorkspace(h);
    h.store.setLaunchArgs({ claude: '--dangerously-skip-permissions', codex: '' });

    await h.store.createSession(ws, 'claude');
    expect(h.client.opened[0]!.command).toBe('claude --dangerously-skip-permissions');
  });

  it('参数只给 claude / codex 用：普通终端还是只起一个 shell', async () => {
    const h = make();
    const ws = await withWorkspace(h);
    h.store.setLaunchArgs({ claude: '--x', codex: '--y' });

    await h.store.createSession(ws, 'shell');
    // 空命令 = 「只起一个 shell」，这条判断别处依赖着（`command === ''`）
    expect(h.client.opened[0]!.command).toBe('');
  });

  it('两头的空白去掉；只剩空白等于没设', async () => {
    const h = make();
    await withWorkspace(h);
    h.store.setLaunchArgs({ claude: '  --x  ', codex: '   ' });
    expect(h.store.getSnapshot().launchArgs).toEqual({ claude: '--x', codex: '' });
  });

  it('⚠️ 改参数不影响已经在跑的会话 —— 命令行在进程起来那一刻就定死了', async () => {
    const h = make();
    const ws = await withWorkspace(h);
    const id = (await h.store.createSession(ws, 'claude'))!;

    h.store.setLaunchArgs({ claude: '--later', codex: '' });

    const session = h.store.getSnapshot().sessions.find((s) => s.id === id)!;
    expect(session.command).toBe('claude');
  });

  it('存下来的参数下次启动读得回来', async () => {
    localStorage.setItem(
      'devtoolkit.agents.v1',
      JSON.stringify({ launch_args: { claude: '--dangerously-skip-permissions', codex: '' } }),
    );
    const h = make();
    await h.store.init();
    expect(h.store.getSnapshot().launchArgs.claude).toBe('--dangerously-skip-permissions');
  });

  it('存的文件被手改坏了也不炸（按不可信输入处理）', async () => {
    localStorage.setItem('devtoolkit.agents.v1', JSON.stringify({ launch_args: 42 }));
    const h = make();
    await h.store.init();
    expect(h.store.getSnapshot().launchArgs).toEqual({ claude: '', codex: '' });
  });
});

describe('一次新建一批（createMany）', () => {
  it('按数量建出来，顺序就是对话框里那个顺序', async () => {
    const h = make();
    const ws = await withWorkspace(h);
    const n = await h.store.createMany(ws, [
      { kind: 'claude', count: 2 },
      { kind: 'codex', count: 1 },
      { kind: 'shell', count: 1 },
    ]);

    expect(n).toBe(4);
    expect(h.store.getSnapshot().sessions.map((s) => s.kind)).toEqual([
      'claude',
      'claude',
      'codex',
      'shell',
    ]);
  });

  it('全部铺在屏幕上，铺的顺序和建的顺序一致', async () => {
    const h = make();
    const ws = await withWorkspace(h);
    await h.store.createMany(ws, [{ kind: 'claude', count: 4 }]);

    const snap = h.store.getSnapshot();
    const ids = snap.sessions.map((s) => s.id);
    expect(panesOf(h.store.activeLayout()!)).toEqual(ids);
    // 4 个 → 2×2
    expect(rectsOf(h.store.activeLayout()!)[ids[0]!]!.w).toBeCloseTo(0.5, 9);
  });

  it('⚠️ 中途只动一次布局 —— 一格格地摆屏用户会看到抖动', async () => {
    const h = make();
    const ws = await withWorkspace(h);
    // 先摆一个把布局建起来（第一个会话上屏是「替换聚焦格」，也算一次变化）
    await h.store.createSession(ws, 'shell');

    let changes = 0;
    let last = h.store.activeLayout();
    h.store.subscribe(() => {
      const now = h.store.activeLayout();
      if (now !== last) {
        changes += 1;
        last = now;
      }
    });

    await h.store.createMany(ws, [{ kind: 'claude', count: 3 }]);
    expect(changes).toBe(1);
  });

  it('全是 0 就什么都不做', async () => {
    const h = make();
    const ws = await withWorkspace(h);
    expect(await h.store.createMany(ws, [{ kind: 'claude', count: 0 }])).toBe(0);
    expect(h.store.getSnapshot().sessions).toHaveLength(0);
  });

  it('每类夹在上限内（手改过的数据不该开出几十个进程）', async () => {
    const h = make();
    const ws = await withWorkspace(h);
    const n = await h.store.createMany(ws, [{ kind: 'claude', count: 999 }]);
    expect(n).toBe(MAX_SESSIONS_PER_KIND);
  });

  it('启动参数带在整批的命令上', async () => {
    const h = make();
    const ws = await withWorkspace(h);
    h.store.setLaunchArgs({ claude: '--dangerously-skip-permissions', codex: '' });

    await h.store.createMany(ws, [{ kind: 'claude', count: 2 }]);
    for (const req of h.client.opened) {
      expect(req.command).toBe('claude --dangerously-skip-permissions');
    }
  });
});
