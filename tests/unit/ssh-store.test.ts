import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 终端实例归 hub 管，而 hub 要用真实的 xterm（需要真实布局才能量尺寸），
 * node 环境里跑不了 —— 所以这里把它换成一个记账用的替身。
 *
 * 替身只需要**如实记账**：谁被创建、谁被销毁、往谁那里灌了字节。
 * 「终端真的画出来了吗」那类问题归 e2e（真实 Chromium）。
 */
const hub = vi.hoisted(() => ({
  create: vi.fn(async () => {}),
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

vi.mock('../../src/modules/ssh/core/terminalHub', () => ({ terminalHub: hub }));

import type { KnownHost, SshProfile } from '../../src/modules/ssh/core/types';
import type {
  LocalClient,
  LocalOpenRequest,
  SshClient,
  SshServices,
} from '../../src/modules/ssh/services/types';
import { SshStore } from '../../src/modules/ssh/state/store';
import type { ShellApi } from '../../src/shell/types';
import { __resetIdsForTest } from '../../src/shared/ids';

beforeEach(() => {
  __resetIdsForTest();
  vi.clearAllMocks();
});

function profile(patch: Partial<SshProfile> = {}): SshProfile {
  return {
    id: 'p1',
    name: '本地',
    host: '127.0.0.1',
    port: 22,
    username: 'root',
    // 旧档案里没有这两个字段 —— 夹具也按「读进来默认是 ssh」来写
    kind: 'ssh',
    localShell: '',
    authKind: 'password',
    password: 'secret',
    privateKeyPath: '',
    passphrase: '',
    ...patch,
  };
}

const READY = {
  kind: 'ready' as const,
  address: '127.0.0.1:22',
  username: 'root',
  fingerprint: 'SHA256:NEW',
  algorithm: 'ssh-ed25519',
};

interface Harness {
  store: SshStore;
  client: SshClient;
  /** 本地终端那边收到过的 open 请求（和 savedProfiles 一个路子：记账而不是断言 mock） */
  localOpened: LocalOpenRequest[];
  /** 本地终端那份假 client。断言「走的是本地那条路」用它 */
  local: LocalClient;
  savedProfiles: SshProfile[][];
  savedHosts: KnownHost[][];
  errors: string[];
  statuses: (string | null)[];
  ready(): void;
}

function harness(
  options: { stored?: SshProfile[]; hosts?: KnownHost[] } = {},
): Harness {
  let storedProfiles = options.stored ?? [];
  let storedHosts = options.hosts ?? [];

  const savedProfiles: SshProfile[][] = [];
  const localOpened: LocalOpenRequest[] = [];
  const savedHosts: KnownHost[][] = [];
  const errors: string[] = [];
  const statuses: (string | null)[] = [];

  // 假 client 必须**把方法都实现全**：这几条路径各自有 try/catch，
  // 少一个方法的话错误会被吞掉，测试照样绿 —— 那就是「绿得没有意义」
  const client: SshClient = {
    open: vi.fn(async () => READY),
    write: vi.fn(async () => {}),
    resize: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    closeAll: vi.fn(async () => {}),
  };

  // 本地终端那份也要**实现全**（同一条理由：少一个方法错误会被 try/catch 吞掉）
  const local: LocalClient = {
    open: vi.fn(async (request: LocalOpenRequest) => {
      localOpened.push(request);
    }),
    write: vi.fn(async () => {}),
    resize: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    closeAll: vi.fn(async () => {}),
  };

  const services: SshServices = {
    client,
    local,
    profiles: {
      load: async () => storedProfiles,
      save: async (next) => {
        storedProfiles = [...next];
        savedProfiles.push([...next]);
      },
    },
    knownHosts: {
      load: async () => storedHosts,
      save: async (next) => {
        storedHosts = [...next];
        savedHosts.push([...next]);
      },
    },
  };

  const store = new SshStore(services);
  const shell: ShellApi = {
    setStatus: (msg) => statuses.push(msg),
    reportError: (e) => errors.push(String(e)),
  };
  store.attachShell(shell);

  return {
    store,
    client,
    local,
    localOpened,
    savedProfiles,
    savedHosts,
    errors,
    statuses,
    ready() {
      store.init();
    },
  };
}

/** 走到「已经连上」那一步 */
async function connected(h: Harness): Promise<string> {
  await h.store.init();
  await h.store.connect('p1');
  return h.store.getSnapshot().sessions[0]?.id ?? '';
}

describe('init', () => {
  it('把档案和已知主机读回来，每个档案一份 idle 运行时', async () => {
    const h = harness({
      stored: [profile(), profile({ id: 'p2', name: '两台' })],
      hosts: [{ host: 'a.com', port: 22, algorithm: 'ssh-ed25519', fingerprint: 'S', addedAt: '' }],
    });
    await h.store.init();

    const state = h.store.getSnapshot();
    expect(state.ready).toBe(true);
    expect(state.profiles).toHaveLength(2);
    expect(state.knownHosts).toHaveLength(1);
    expect(state.runtime['p1']?.status).toBe('idle');
    expect(state.selectedId).toBe('p1');
  });

  it('⚠️ 收掉 Rust 侧的孤儿会话 —— webview 重载后前端认不得它们了', async () => {
    const h = harness({ stored: [profile()] });
    await h.store.init();

    expect(h.client.closeAll).toHaveBeenCalledTimes(1);
  });

  it('读盘失败不该让界面卡住，但要说一声', async () => {
    const h = harness();
    vi.mocked(h.store as unknown as { services: SshServices }).services;
    // 换一个会抛的 profiles
    const broken = new SshStore({
      client: h.client,
      local: h.local,
      profiles: {
        load: async () => {
          throw new Error('磁盘坏了');
        },
        save: async () => {},
      },
      knownHosts: { load: async () => [], save: async () => {} },
    });
    await broken.init();

    expect(broken.getSnapshot().ready).toBe(true);
  });

  it('init 是幂等的 —— 切模块来回不该重复收会话', async () => {
    const h = harness({ stored: [profile()] });
    await Promise.all([h.store.init(), h.store.init()]);
    await h.store.init();

    expect(h.client.closeAll).toHaveBeenCalledTimes(1);
  });
});

describe('connect：主机密钥', () => {
  it('没见过的机器会弹 TOFU，会话留着等用户拍板', async () => {
    const h = harness({ stored: [profile()] });
    vi.mocked(h.client.open).mockResolvedValue({
      kind: 'hostKeyUnknown',
      host: '127.0.0.1',
      port: 22,
      algorithm: 'ssh-ed25519',
      fingerprint: 'SHA256:NEW',
    });
    await h.store.init();
    await h.store.connect('p1');

    const state = h.store.getSnapshot();
    expect(state.trustPrompt?.fingerprint).toBe('SHA256:NEW');
    // 会话留着（还是 starting），终端也留着 —— 用户点了信任就在同一个标签里接着连
    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0]?.status).toBe('starting');
    expect(hub.dispose).not.toHaveBeenCalled();
  });

  it('从来没连过时传的 expectedFingerprint 是 null', async () => {
    const h = harness({ stored: [profile()] });
    await h.store.init();
    await h.store.connect('p1');

    expect(vi.mocked(h.client.open).mock.calls[0]?.[0].expectedFingerprint).toBeNull();
    expect(vi.mocked(h.client.open).mock.calls[0]?.[0].acceptNewHostKey).toBe(false);
  });

  it('已经信任过就把指纹传下去', async () => {
    const h = harness({
      stored: [profile()],
      hosts: [
        { host: '127.0.0.1', port: 22, algorithm: 'ssh-ed25519', fingerprint: 'SHA256:NEW', addedAt: '' },
      ],
    });
    await h.store.init();
    await h.store.connect('p1');

    expect(vi.mocked(h.client.open).mock.calls[0]?.[0].expectedFingerprint).toBe('SHA256:NEW');
  });

  it('点「信任并继续」会先记指纹再重连，第二次带 acceptNewHostKey', async () => {
    const h = harness({ stored: [profile()] });
    vi.mocked(h.client.open).mockResolvedValueOnce({
      kind: 'hostKeyUnknown',
      host: '127.0.0.1',
      port: 22,
      algorithm: 'ssh-ed25519',
      fingerprint: 'SHA256:NEW',
    });
    await h.store.init();
    await h.store.connect('p1');
    await h.store.trustAndReconnect();

    // 指纹落盘了
    expect(h.savedHosts.at(-1)?.[0]?.fingerprint).toBe('SHA256:NEW');
    // 第二次是带着「用户同意了」去的
    const second = vi.mocked(h.client.open).mock.calls[1]?.[0];
    expect(second?.acceptNewHostKey).toBe(true);
    expect(second?.expectedFingerprint).toBe('SHA256:NEW');
    // 而且**复用同一个会话**，不是又开一个标签
    expect(h.store.getSnapshot().sessions).toHaveLength(1);
    expect(h.store.getSnapshot().sessions[0]?.status).toBe('open');
    expect(h.store.getSnapshot().trustPrompt).toBeNull();
  });

  it('⚠️ 指纹变了：硬停、丢掉会话、把新旧都记下来', async () => {
    const h = harness({
      stored: [profile()],
      hosts: [
        { host: '127.0.0.1', port: 22, algorithm: 'ssh-ed25519', fingerprint: 'SHA256:OLD', addedAt: '' },
      ],
    });
    vi.mocked(h.client.open).mockResolvedValue({
      kind: 'hostKeyMismatch',
      host: '127.0.0.1',
      port: 22,
      algorithm: 'ssh-ed25519',
      expected: 'SHA256:OLD',
      actual: 'SHA256:NEW',
    });
    await h.store.init();
    await h.store.connect('p1');

    const state = h.store.getSnapshot();
    // 没有「就这样继续」的路径：会话被丢掉了，用户得先去解信任
    expect(state.sessions).toHaveLength(0);
    expect(hub.dispose).toHaveBeenCalled();
    expect(state.mismatch['p1']).toEqual({
      expected: 'SHA256:OLD',
      actual: 'SHA256:NEW',
      algorithm: 'ssh-ed25519',
    });
    expect(state.runtime['p1']?.status).toBe('error');
    // **不弹外壳错误条** —— 它是一次往返得出的结论，显示在检查器里
    expect(h.errors).toEqual([]);
  });

  it('取消信任会把那个半死不活的会话收掉', async () => {
    const h = harness({ stored: [profile()] });
    vi.mocked(h.client.open).mockResolvedValue({
      kind: 'hostKeyUnknown',
      host: '127.0.0.1',
      port: 22,
      algorithm: 'ssh-ed25519',
      fingerprint: 'SHA256:NEW',
    });
    await h.store.init();
    await h.store.connect('p1');
    h.store.dismissTrustPrompt();

    expect(h.store.getSnapshot().trustPrompt).toBeNull();
    expect(h.store.getSnapshot().sessions).toHaveLength(0);
  });

  it('「忘记这台主机」删掉记录、清掉告警，然后**重新走一次 TOFU**', async () => {
    const h = harness({
      stored: [profile()],
      hosts: [
        { host: '127.0.0.1', port: 22, algorithm: 'ssh-ed25519', fingerprint: 'SHA256:OLD', addedAt: '' },
      ],
    });
    // 解信任之后这台机器对我们是**全新的**，所以重连时服务端会被当成没见过的
    vi.mocked(h.client.open).mockResolvedValue({
      kind: 'hostKeyUnknown',
      host: '127.0.0.1',
      port: 22,
      algorithm: 'ssh-ed25519',
      fingerprint: 'SHA256:NEW',
    });
    await h.store.init();
    await h.store.forgetAndReconnect('p1');

    // 记录删掉了
    expect(h.savedHosts.at(-1)).toEqual([]);
    expect(h.store.getSnapshot().mismatch['p1']).toBeUndefined();
    // 解信任之后按「没见过的机器」重连，不带 expectedFingerprint
    expect(vi.mocked(h.client.open).mock.calls[0]?.[0].expectedFingerprint).toBeNull();
    // 于是又要用户确认一次 —— 这正是我们要的：换了一把密钥就重新确认一次，
    // 而不是因为我们「刚删过记录」就默默接受
    expect(h.store.getSnapshot().trustPrompt?.fingerprint).toBe('SHA256:NEW');
  });
});

describe('connect：传输层失败', () => {
  it('连不上：丢掉会话、把错误放进运行时、不弹外壳错误条', async () => {
    const h = harness({ stored: [profile()] });
    vi.mocked(h.client.open).mockRejectedValue(new Error('连接 SSH（127.0.0.1:22）失败：拒绝连接'));
    await h.store.init();
    await h.store.connect('p1');

    const state = h.store.getSnapshot();
    expect(state.sessions).toHaveLength(0);
    expect(state.runtime['p1']?.status).toBe('error');
    expect(state.runtime['p1']?.error).toContain('拒绝连接');
    expect(h.errors).toEqual([]);
  });

  it('参数不合法时**连试都不试**，直接把第一个错误摆出来', async () => {
    const h = harness({ stored: [profile({ username: '' })] });
    await h.store.init();
    await h.store.connect('p1');

    expect(h.client.open).not.toHaveBeenCalled();
    expect(h.store.getSnapshot().runtime['p1']?.error).toContain('用户名');
  });
});

describe('connect：成功', () => {
  it('会话变成 open，运行时记下服务端信息', async () => {
    const h = harness({ stored: [profile()] });
    const sessionId = await connected(h);

    const state = h.store.getSnapshot();
    expect(h.store.sessionById(sessionId)?.status).toBe('open');
    expect(state.runtime['p1']?.status).toBe('connected');
    expect(state.runtime['p1']?.server?.fingerprint).toBe('SHA256:NEW');
    expect(state.activeSessionId).toBe(sessionId);
  });

  it('首次信任的指纹会被记下来（连上之后）', async () => {
    const h = harness({ stored: [profile()] });
    vi.mocked(h.client.open).mockResolvedValue({
      kind: 'hostKeyUnknown',
      host: '127.0.0.1',
      port: 22,
      algorithm: 'ssh-ed25519',
      fingerprint: 'SHA256:NEW',
    });
    await h.store.init();
    await h.store.connect('p1');
    vi.mocked(h.client.open).mockResolvedValue(READY);
    await h.store.trustAndReconnect();

    expect(h.store.getSnapshot().knownHosts[0]?.fingerprint).toBe('SHA256:NEW');
  });

  it('⚠️ 终端**先建好再连** —— 反过来的话先到的横幅没有终端接得住', async () => {
    const h = harness({ stored: [profile()] });
    await connected(h);

    expect(hub.create).toHaveBeenCalledTimes(1);
    const createOrder = hub.create.mock.invocationCallOrder[0] ?? 0;
    const openOrder = vi.mocked(h.client.open).mock.invocationCallOrder[0] ?? 0;
    expect(createOrder).toBeLessThan(openOrder);
  });

  it('多个标签：一个档案可以同时开好几个会话', async () => {
    const h = harness({ stored: [profile()] });
    await connected(h);
    await h.store.connect('p1');

    const state = h.store.getSnapshot();
    expect(state.sessions).toHaveLength(2);
    expect(new Set(state.sessions.map((s) => s.id)).size).toBe(2);
    expect(state.sessions.map((s) => s.title)).toEqual(['root@127.0.0.1', 'root@127.0.0.1 2']);
  });
});

describe('会话流', () => {
  it('远端退出：状态、退出码、终端里的一行提示都到位', async () => {
    const h = harness({ stored: [profile()] });
    const sessionId = await connected(h);

    const request = vi.mocked(h.client.open).mock.calls[0]?.[0];
    request?.onEvent({ kind: 'exit', code: 0, reason: '已退出' });

    const session = h.store.sessionById(sessionId);
    expect(session?.status).toBe('closed');
    expect(session?.exitCode).toBe(0);
    expect(hub.note).toHaveBeenCalledWith(sessionId, '[已退出：退出码 0]');
    // **退出是个结果，不是故障** —— 弹错误条的话，敲一个 exit 就会红一片
    expect(h.errors).toEqual([]);
  });

  it('数据事件直接喂给 hub，不进 store', async () => {
    const h = harness({ stored: [profile()] });
    const sessionId = await connected(h);
    const bytes = new TextEncoder().encode('你好');

    vi.mocked(h.client.open).mock.calls[0]?.[0].onEvent({ kind: 'data', bytes });

    expect(hub.feed).toHaveBeenCalledWith(sessionId, bytes);
    // 快照里不该出现任何字节相关的东西
    expect(JSON.stringify(h.store.getSnapshot())).not.toContain('你好');
  });

  it('关掉会话之后不再往里写 —— 用户正在打字时对面退出是常事', async () => {
    const h = harness({ stored: [profile()] });
    const sessionId = await connected(h);
    vi.mocked(h.client.open).mock.calls[0]?.[0].onEvent({
      kind: 'exit',
      code: 0,
      reason: '已退出',
    });

    await h.store.writeTo(sessionId, new Uint8Array([1]));
    expect(h.client.write).not.toHaveBeenCalled();
  });

  it('hub 报来的输入会转给 client', async () => {
    const h = harness({ stored: [profile()] });
    const sessionId = await connected(h);

    await h.store.writeTo(sessionId, new TextEncoder().encode('ls\r'));
    expect(h.client.write).toHaveBeenCalledWith(sessionId, expect.any(Uint8Array));
  });

  it('hub 报来的尺寸会转给 client，并更新状态栏用的尺寸', async () => {
    const h = harness({ stored: [profile()] });
    const sessionId = await connected(h);

    hub.onResize(sessionId, 120, 40);
    await vi.waitFor(() => expect(h.client.resize).toHaveBeenCalledWith(sessionId, 120, 40));
    expect(h.store.sessionById(sessionId)?.cols).toBe(120);
  });
});

describe('关会话', () => {
  it('先告诉后端再收拾本地状态', async () => {
    const h = harness({ stored: [profile()] });
    const sessionId = await connected(h);
    await h.store.closeSession(sessionId);

    expect(h.client.close).toHaveBeenCalledWith(sessionId);
    expect(h.store.getSnapshot().sessions).toHaveLength(0);
    expect(hub.dispose).toHaveBeenCalledWith(sessionId);
  });

  it('后端关不掉也要把本地状态清掉 —— 用户点了关闭，界面就该关掉', async () => {
    const h = harness({ stored: [profile()] });
    const sessionId = await connected(h);
    vi.mocked(h.client.close).mockRejectedValue(new Error('早没了'));

    await h.store.closeSession(sessionId);
    expect(h.store.getSnapshot().sessions).toHaveLength(0);
  });

  it('关掉当前标签会切到剩下那个，而不是留一个空的 active', async () => {
    const h = harness({ stored: [profile()] });
    const first = await connected(h);
    await h.store.connect('p1');
    h.store.setActiveSession(first);
    await h.store.closeSession(first);

    expect(h.store.getSnapshot().activeSessionId).not.toBe(first);
  });
});

describe('侧栏状态', () => {
  it('状态是从会话列表推出来的，不另存一份', async () => {
    const h = harness({ stored: [profile()] });
    expect(h.store.statusOf('p1')).toBe('idle');

    const sessionId = await connected(h);
    expect(h.store.statusOf('p1')).toBe('connected');

    await h.store.closeSession(sessionId);
    expect(h.store.statusOf('p1')).toBe('idle');
  });

  it('连着的时候改参数会标 stale，但不自动重连', async () => {
    const h = harness({ stored: [profile()] });
    await connected(h);
    await h.store.updateProfile('p1', { host: '别的机器' });

    expect(h.store.getSnapshot().runtime['p1']?.stale).toBe(true);
    // 会话还在，没有被偷偷换掉
    expect(h.store.getSnapshot().sessions).toHaveLength(1);
    expect(h.store.getSnapshot().sessions[0]?.status).toBe('open');
  });

  it('只改名字不算改了连接参数', async () => {
    const h = harness({ stored: [profile()] });
    await connected(h);
    await h.store.updateProfile('p1', { name: '换个名字' });

    expect(h.store.getSnapshot().runtime['p1']?.stale).toBeFalsy();
  });
});

describe('删连接', () => {
  it('把它名下的会话全关掉再删', async () => {
    const h = harness({ stored: [profile()] });
    const sessionId = await connected(h);
    await h.store.deleteProfile('p1');

    expect(h.client.close).toHaveBeenCalledWith(sessionId);
    expect(h.store.getSnapshot().profiles).toHaveLength(0);
    expect(h.store.getSnapshot().sessions).toHaveLength(0);
    expect(h.savedProfiles.at(-1)).toEqual([]);
  });
});

// ------------------------------------------------------------------ 本地终端

describe('本地终端', () => {
  const localProfile = (patch: Partial<SshProfile> = {}): SshProfile =>
    profile({ id: 'p1', name: '本地终端', kind: 'local', localShell: '', ...patch });

  it('⚠️ 本地档案走 local client，**一次都不碰 SSH 那条路**', async () => {
    const h = harness({ stored: [localProfile({ localShell: 'cmd' })] });
    await h.store.init();
    h.ready();
    await h.store.connect('p1');

    expect(h.localOpened).toHaveLength(1);
    expect(h.localOpened[0]!.shell).toBe('cmd');
    // 碰了的话会弹「这台机器没见过，要不要信任」—— 而本地终端没有那回事
    expect(h.client.open).not.toHaveBeenCalled();
    expect(h.store.getSnapshot().trustPrompt).toBeNull();
    expect(h.store.statusOf('p1')).toBe('connected');
  });

  it('本地终端不写已知主机表（没有指纹可记）', async () => {
    const h = harness({ stored: [localProfile()] });
    await h.store.init();
    h.ready();
    await h.store.connect('p1');

    expect(h.savedHosts).toEqual([]);
    expect(h.store.getSnapshot().knownHosts).toEqual([]);
  });

  it('标签标题用连接名（不是 `@` 这种拼不出来的东西）', async () => {
    const h = harness({ stored: [localProfile({ name: '随手终端' })] });
    await h.store.init();
    h.ready();
    await h.store.connect('p1');

    expect(h.store.getSnapshot().sessions[0]!.title).toBe('随手终端');
  });

  it('shell 起不来：会话收掉，原因写在 runtime 里', async () => {
    const h = harness({ stored: [localProfile()] });
    await h.store.init();
    h.ready();
    vi.mocked(h.local.open).mockRejectedValueOnce(new Error('启动 cmd 失败：找不到'));

    await h.store.connect('p1');

    expect(h.store.getSnapshot().sessions).toHaveLength(0);
    expect(h.store.getSnapshot().runtime['p1']!.status).toBe('error');
    expect(h.store.statusOf('p1')).toBe('error');
  });

  it('⚠️ init 时两份会话表都要收（刷新页面不留孤儿本地 shell）', async () => {
    const h = harness();
    await h.store.init();
    expect(h.client.closeAll).toHaveBeenCalledTimes(1);
    expect(h.local.closeAll).toHaveBeenCalledTimes(1);
  });

  it('远端档案照旧走 SSH 那条路（本地这条不该抢过去）', async () => {
    const h = harness({ stored: [profile({ id: 'p1' })] });
    await h.store.init();
    h.ready();
    await h.store.connect('p1');

    expect(h.client.open).toHaveBeenCalledTimes(1);
    expect(h.localOpened).toHaveLength(0);
  });
});
