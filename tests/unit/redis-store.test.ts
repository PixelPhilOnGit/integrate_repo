import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetIdsForTest } from '../../src/shared/ids';
import { RedisStore } from '../../src/modules/redis/state/store';
import type {
  ProfileStore,
  RedisClient,
  RedisServices,
} from '../../src/modules/redis/services/types';
import type { ConnectionProfile, RedisReply } from '../../src/modules/redis/core/types';
import type { ShellApi } from '../../src/shell/types';

beforeEach(() => __resetIdsForTest());

const OK: RedisReply = { type: 'status', text: 'OK' };

interface Harness {
  store: RedisStore;
  saved: ConnectionProfile[][];
  errors: string[];
  setStored(profiles: ConnectionProfile[]): void;
  client: {
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    exec: ReturnType<typeof vi.fn>;
  };
}

function harness(options: { stored?: ConnectionProfile[] } = {}): Harness {
  let stored: ConnectionProfile[] = options.stored ?? [];
  const saved: ConnectionProfile[][] = [];
  const errors: string[] = [];

  const client = {
    connect: vi.fn(async () => ({ address: '127.0.0.1:6379', db: 0, version: '7.0.15' })),
    disconnect: vi.fn(async () => {}),
    exec: vi.fn(async (): Promise<RedisReply> => OK),
  };

  const profiles: ProfileStore = {
    load: async () => stored,
    save: async (next) => {
      stored = [...next];
      saved.push([...next]);
    },
  };

  const services: RedisServices = {
    client: client as unknown as RedisClient,
    profiles,
  };

  const store = new RedisStore(services);
  const shell: ShellApi = {
    setStatus: () => {},
    reportError: (e) => errors.push(String(e)),
  };
  store.attachShell(shell);

  return {
    store,
    saved,
    errors,
    setStored: (next) => {
      stored = next;
    },
    client,
  };
}

describe('连接档案管理', () => {
  it('新建之后档案真的进了列表，而且被选中', async () => {
    const { store } = harness();

    const id = await store.createProfile();

    // 这两条都断言：只设置 selectedId 而忘了加进 profiles 是个真发生过的 bug
    expect(store.getSnapshot().profiles.map((p) => p.id)).toEqual([id]);
    expect(store.getSnapshot().selectedId).toBe(id);
    expect(store.selectedProfile()?.id).toBe(id);
  });

  it('新建会落盘', async () => {
    const { store, saved } = harness();

    await store.createProfile();

    expect(saved).toHaveLength(1);
    expect(saved[0]).toHaveLength(1);
  });

  it('连新建两个名字不重复', async () => {
    const { store } = harness();

    await store.createProfile();
    await store.createProfile();

    expect(store.getSnapshot().profiles.map((p) => p.name)).toEqual(['新建连接', '新建连接 2']);
  });

  it('改档案会写进 state 并落盘', async () => {
    const { store, saved } = harness();
    const id = await store.createProfile();

    await store.updateProfile(id, { host: '10.0.0.9', port: 6380 });

    const profile = store.selectedProfile();
    expect(profile?.host).toBe('10.0.0.9');
    expect(profile?.port).toBe(6380);
    expect(saved.at(-1)?.[0]?.host).toBe('10.0.0.9');
  });

  it('改一个不存在的档案是无操作', async () => {
    const { store, saved } = harness();
    await store.createProfile();
    const before = saved.length;

    await store.updateProfile('nope', { host: 'x' });

    expect(saved).toHaveLength(before);
  });

  it('删除会把档案从列表里去掉，并落盘', async () => {
    const { store, saved } = harness();
    const id = await store.createProfile();

    await store.deleteProfile(id);

    expect(store.getSnapshot().profiles).toEqual([]);
    expect(store.getSnapshot().selectedId).toBeNull();
    expect(saved.at(-1)).toEqual([]);
  });

  it('删除已连接的会自动先断开，不留孤儿连接', async () => {
    const { store, client } = harness();
    const id = await store.createProfile();
    await store.connect(id);

    await store.deleteProfile(id);

    expect(client.disconnect).toHaveBeenCalledWith(id);
  });

  it('删除当前选中项之后，选中会落到剩下的第一个', async () => {
    const { store } = harness();
    const first = await store.createProfile();
    const second = await store.createProfile();

    await store.deleteProfile(second);

    expect(store.getSnapshot().selectedId).toBe(first);
  });
});

describe('连接', () => {
  it('连上之后状态变成 connected 并带上服务端信息', async () => {
    const { store } = harness();
    const id = await store.createProfile();

    await store.connect(id);

    const runtime = store.getSnapshot().runtime[id];
    expect(runtime?.status).toBe('connected');
    expect(runtime?.server?.version).toBe('7.0.15');
    expect(runtime?.error).toBeNull();
  });

  it('连不上时状态变成 error，错误留在 runtime 里', async () => {
    const { store, client } = harness();
    client.connect.mockRejectedValueOnce(new Error('连接 Redis（x）失败：拒绝连接'));
    const id = await store.createProfile();

    await store.connect(id);

    const runtime = store.getSnapshot().runtime[id];
    expect(runtime?.status).toBe('error');
    expect(runtime?.error).toContain('拒绝连接');
    expect(runtime?.server).toBeNull();
  });

  it('参数不合法的档案不往后端发请求', async () => {
    const { store, client } = harness();
    const id = await store.createProfile();
    await store.updateProfile(id, { host: '' });

    await store.connect(id);

    expect(client.connect).not.toHaveBeenCalled();
    expect(store.getSnapshot().runtime[id]?.status).toBe('error');
  });

  it('断开之后回到 idle，并且不残留服务端信息', async () => {
    const { store } = harness();
    const id = await store.createProfile();
    await store.connect(id);

    await store.disconnect(id);

    const runtime = store.getSnapshot().runtime[id];
    expect(runtime?.status).toBe('idle');
    expect(runtime?.server).toBeNull();
    expect(runtime?.stale).toBe(false);
  });

  it('连上之后改连接参数会标 stale，只改名字不算', async () => {
    const { store } = harness();
    const id = await store.createProfile();
    await store.connect(id);

    await store.updateProfile(id, { name: '换个名字' });
    expect(store.getSnapshot().runtime[id]?.stale).toBe(false);

    await store.updateProfile(id, { port: 6380 });
    expect(store.getSnapshot().runtime[id]?.stale).toBe(true);
  });

  it('没连上的时候改参数不会标 stale', async () => {
    const { store } = harness();
    const id = await store.createProfile();

    await store.updateProfile(id, { port: 6380 });

    expect(store.getSnapshot().runtime[id]?.stale).toBe(false);
  });
});

describe('命令台', () => {
  async function connected() {
    const h = harness();
    const id = await h.store.createProfile();
    await h.store.connect(id);
    return h;
  }

  it('执行命令会记下回显和回复', async () => {
    const { store } = await connected();

    await store.runCommand('GET k');

    const log = store.getSnapshot().log;
    expect(log.map((e) => e.kind)).toEqual(['note', 'input', 'reply']);
    expect(log[1]).toMatchObject({ kind: 'input', text: 'GET k' });
    expect(log[2]).toMatchObject({ kind: 'reply', reply: OK });
  });

  it('执行时会把命令发给后端，token 数组是分好词的', async () => {
    const { store, client } = await connected();

    await store.runCommand('SET greeting "hello world"');

    expect(client.exec).toHaveBeenCalledWith(expect.any(String), [
      'SET',
      'greeting',
      'hello world',
    ]);
  });

  /** 守住「服务器错误是一条回复，不是执行失败」这条语义 */
  it('服务器返回的错误记成 reply，不弹外壳错误条', async () => {
    const { store, client, errors } = await connected();
    client.exec.mockResolvedValueOnce({ type: 'error', message: "ERR unknown command 'X'" });

    await store.runCommand('X');

    const log = store.getSnapshot().log;
    expect(log.at(-1)).toMatchObject({ kind: 'reply' });
    expect(log.some((e) => e.kind === 'transport')).toBe(false);
    expect(errors).toEqual([]);
  });

  it('传输层失败记成 transport，并把连接标成 error', async () => {
    const { store, client } = await connected();
    const id = store.getSnapshot().selectedId!;
    client.exec.mockRejectedValueOnce(new Error('连接 “x” 已中断'));

    await store.runCommand('PING');

    const log = store.getSnapshot().log;
    expect(log.at(-1)).toMatchObject({ kind: 'transport' });
    expect(store.getSnapshot().runtime[id]?.status).toBe('error');
  });

  it('分词失败只记一条本地提示，根本不往后端发', async () => {
    const { store, client } = await connected();

    await store.runCommand('SET k "没闭合');

    expect(client.exec).not.toHaveBeenCalled();
    const last = store.getSnapshot().log.at(-1);
    expect(last).toMatchObject({ kind: 'note' });
  });

  it('空白命令什么也不做', async () => {
    const { store, client } = await connected();

    await store.runCommand('   ');

    expect(client.exec).not.toHaveBeenCalled();
    expect(store.getSnapshot().log.filter((e) => e.kind === 'input')).toEqual([]);
  });

  it('AUTH 的回显被打码', async () => {
    const { store } = await connected();

    await store.runCommand('AUTH hunter2');

    const input = store.getSnapshot().log.find((e) => e.kind === 'input');
    expect(input?.kind === 'input' && input.text).toContain('AUTH');
    expect(input?.kind === 'input' && input.text).not.toContain('hunter2');
  });

  it('执行完会把输入框清空、把命令记进历史', async () => {
    const { store } = await connected();

    await store.setDraft('PING');
    await store.runCommand('PING');

    expect(store.getSnapshot().draft).toBe('');
    expect(store.getSnapshot().history).toEqual(['PING']);
  });

  it('执行期间 running 为真，跑完恢复', async () => {
    const { store, client } = await connected();
    let release = (): void => {};
    client.exec.mockImplementationOnce(
      () => new Promise<RedisReply>((resolve) => (release = () => resolve(OK))),
    );

    const running = store.runCommand('PING');
    expect(store.getSnapshot().running).toBe(true);

    release();
    await running;
    expect(store.getSnapshot().running).toBe(false);
  });

  it('执行期间再敲命令会被丢掉（串行执行）', async () => {
    const { store, client } = await connected();
    let release = (): void => {};
    client.exec.mockImplementationOnce(
      () => new Promise<RedisReply>((resolve) => (release = () => resolve(OK))),
    );

    const first = store.runCommand('PING');
    await store.runCommand('ECHO second');
    release();
    await first;

    expect(client.exec).toHaveBeenCalledTimes(1);
  });

  it('清空日志', async () => {
    const { store } = await connected();
    await store.runCommand('PING');

    store.clearLog();

    expect(store.getSnapshot().log).toEqual([]);
  });

  it('没有选中连接时执行命令什么也不做', async () => {
    const h = harness();
    const { store, client } = h;

    await store.runCommand('PING');

    expect(client.exec).not.toHaveBeenCalled();
  });
});

describe('历史导航', () => {
  it('上下键在 store 里也能用', async () => {
    const { store } = harness();
    const id = await store.createProfile();
    await store.connect(id);

    await store.runCommand('PING');
    await store.runCommand('ECHO hi');

    store.historyPrev();
    expect(store.getSnapshot().draft).toBe('ECHO hi');

    store.historyPrev();
    expect(store.getSnapshot().draft).toBe('PING');

    store.historyNext();
    expect(store.getSnapshot().draft).toBe('ECHO hi');
  });

  it('手动改输入框会退出历史浏览', async () => {
    const { store } = harness();
    const id = await store.createProfile();
    await store.connect(id);
    await store.runCommand('PING');

    store.historyPrev();
    expect(store.getSnapshot().historyIndex).toBe(0);

    store.setDraft('GET k');
    expect(store.getSnapshot().historyIndex).toBeNull();
  });

  /**
   * 这条守着一个真出过的 bug：翻历史的过程本身就在改 `draft`，
   * 如果按 ↓ 翻到底时拿「当前 draft」当草稿还回去，还给用户的是历史里那一条，
   * 他自己没敲完的半行命令就没了。
   */
  it('翻到底还回来的是用户自己的草稿，不是历史里的命令', async () => {
    const { store } = harness();
    const id = await store.createProfile();
    await store.connect(id);
    await store.runCommand('PING');

    await store.setDraft('GET half-typed');

    store.historyPrev();
    expect(store.getSnapshot().draft).toBe('PING');

    store.historyNext();
    expect(store.getSnapshot().draft).toBe('GET half-typed');
  });

  it('翻好几条再一路翻回来，草稿也不丢', async () => {
    const { store } = harness();
    const id = await store.createProfile();
    await store.connect(id);
    await store.runCommand('PING');
    await store.runCommand('ECHO hi');

    await store.setDraft('DBSIZE 还没敲完');

    store.historyPrev();
    store.historyPrev();
    store.historyPrev(); // 已经在最老一条，停住
    expect(store.getSnapshot().draft).toBe('PING');

    store.historyNext();
    expect(store.getSnapshot().draft).toBe('ECHO hi');
    store.historyNext();

    expect(store.getSnapshot().draft).toBe('DBSIZE 还没敲完');
    expect(store.getSnapshot().historyIndex).toBeNull();
  });
});

describe('初始化', () => {
  it('从存储里读回档案并默认选中第一个', async () => {
    const { store, setStored } = harness();
    setStored([
      {
        id: 'a',
        name: '第一个',
        host: '127.0.0.1',
        port: 6379,
        db: 0,
        username: '',
        password: '',
      },
    ]);

    await store.init();

    expect(store.getSnapshot().ready).toBe(true);
    expect(store.selectedProfile()?.name).toBe('第一个');
  });

  it('init 是幂等的 —— 切模块回来不该把输出重置掉', async () => {
    const { store } = harness();
    const id = await store.createProfile();
    await store.connect(id);
    await store.runCommand('PING');

    const logLength = store.getSnapshot().log.length;
    await store.init();
    await store.init();

    expect(store.getSnapshot().log).toHaveLength(logLength);
    expect(store.getSnapshot().profiles).toHaveLength(1);
  });

  it('读盘失败也会把 ready 置上，并把错误交给外壳', async () => {
    const { store, errors } = harness();
    // 让 load 抛错
    const broken = store as unknown as { services: { profiles: ProfileStore } };
    broken.services.profiles.load = async () => {
      throw new Error('读不出来');
    };

    await store.init();

    expect(store.getSnapshot().ready).toBe(true);
    expect(errors.some((e) => e.includes('读不出来'))).toBe(true);
  });
});
