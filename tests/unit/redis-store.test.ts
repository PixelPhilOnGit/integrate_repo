import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetIdsForTest } from '../../src/shared/ids';
import { RedisStore } from '../../src/modules/redis/state/store';
import type { ConnectionGroup, ProfileStore } from '../../src/shared/connections/types';
import type { RedisClient, RedisServices } from '../../src/modules/redis/services/types';
import type {
  ConnectionProfile,
  DbInfo,
  KeyDetail,
  KeyMeta,
  RedisReply,
  ScanPage,
} from '../../src/modules/redis/core/types';
import type { ShellApi } from '../../src/shell/types';

beforeEach(() => __resetIdsForTest());

const OK: RedisReply = { type: 'status', text: 'OK' };

interface Harness {
  store: RedisStore;
  saved: ConnectionProfile[][];
  savedGroups: ConnectionGroup[][];
  errors: string[];
  /** 状态栏消息（浏览相关的失败走这里，不弹错误条） */
  statuses: string[];
  setStored(profiles: ConnectionProfile[]): void;
  client: {
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    exec: ReturnType<typeof vi.fn>;
    keyspace: ReturnType<typeof vi.fn>;
    select: ReturnType<typeof vi.fn>;
    scan: ReturnType<typeof vi.fn>;
    keyDetail: ReturnType<typeof vi.fn>;
  };
}

function harness(
  options: { stored?: ConnectionProfile[]; groups?: ConnectionGroup[] } = {},
): Harness {
  let stored: ConnectionProfile[] = options.stored ?? [];
  let storedGroups: ConnectionGroup[] = options.groups ?? [];
  const saved: ConnectionProfile[][] = [];
  const savedGroups: ConnectionGroup[][] = [];
  const errors: string[] = [];
  const statuses: string[] = [];

  // 假 client 必须**把新方法都实现全**：浏览那几条路径各自有 try/catch，
  // 少一个方法的话错误会被吞掉，测试照样绿 —— 那就是「绿得没有意义」。
  const client = {
    connect: vi.fn(async () => ({ address: '127.0.0.1:6379', db: 0, version: '7.0.15' })),
    disconnect: vi.fn(async () => {}),
    exec: vi.fn(async (): Promise<RedisReply> => OK),
    keyspace: vi.fn(async (): Promise<DbInfo[]> => [
      { db: 0, keys: 2 },
      { db: 1, keys: 0 },
      { db: 2, keys: 5 },
    ]),
    select: vi.fn(async () => {}),
    scan: vi.fn(async (): Promise<ScanPage> => ({
      cursor: 0,
      keys: [
        { key: 'user:1', keyType: 'string' },
        { key: '计数器', keyType: 'hash' },
      ],
    })),
    keyDetail: vi.fn(async (): Promise<KeyDetail> => ({
      key: 'user:1',
      keyType: 'string',
      ttl: -1,
      size: 5,
      value: { type: 'bulk', text: 'hello', binary: false, bytes: 5 },
      truncated: false,
    })),
  };

  const profiles: ProfileStore<ConnectionProfile> = {
    load: async () => stored,
    save: async (next) => {
      stored = [...next];
      saved.push([...next]);
    },
  };

  const groups: ProfileStore<ConnectionGroup> = {
    load: async () => storedGroups,
    save: async (next) => {
      storedGroups = [...next];
      savedGroups.push([...next]);
    },
  };

  const services: RedisServices = {
    client: client as unknown as RedisClient,
    profiles,
    groups,
  };

  const store = new RedisStore(services);
  const shell: ShellApi = {
    setStatus: (msg) => statuses.push(String(msg)),
    reportError: (e) => errors.push(String(e)),
  };
  store.attachShell(shell);

  return {
    store,
    saved,
    savedGroups,
    errors,
    statuses,
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

describe('浏览', () => {
  async function connected() {
    const h = harness();
    const id = await h.store.createProfile();
    await h.store.connect(id);
    return { ...h, id };
  }

  it('连上之后自动加载库列表和默认库的 key', async () => {
    const { store, client, id } = await connected();

    expect(client.keyspace).toHaveBeenCalledWith(id);
    expect(store.getSnapshot().keyspace[id]).toHaveLength(3);

    // 默认看档案里配的那个库
    expect(store.getSnapshot().browse.db).toBe(0);
    expect(client.scan).toHaveBeenCalledWith(id, '*', 0, expect.any(Number));
    expect(store.getSnapshot().browse.keys.map((k) => k.key)).toEqual(['user:1', '计数器']);
  });

  it('连上之后这个连接是展开的', async () => {
    const { store, id } = await connected();
    expect(store.getSnapshot().expanded[id]).toBe(true);
  });

  it('没连上的连接展开只给提示，不发请求', async () => {
    const { store, client } = harness();
    const id = await store.createProfile();

    await store.toggleExpanded(id);

    expect(store.getSnapshot().expanded[id]).toBe(true);
    expect(client.keyspace).not.toHaveBeenCalled();
    expect(store.getSnapshot().browse.db).toBeNull();
  });

  /**
   * 这条盯着一个具体的坑：判断「加载过没有」如果用 `!keyspace[id]`，
   * 那空数组会被当成没加载过，于是每次展开都重新请求一遍。
   */
  it('已经加载过的连接再展开不会重复请求', async () => {
    const { store, client, id } = await connected();
    const before = client.keyspace.mock.calls.length;

    await store.toggleExpanded(id); // 折叠
    await store.toggleExpanded(id); // 再展开

    expect(client.keyspace).toHaveBeenCalledTimes(before);
  });

  it('切库会先 SELECT 再重新加载 key', async () => {
    const { store, client, id } = await connected();
    client.scan.mockClear();

    await store.openDb(id, 2);

    expect(client.select).toHaveBeenCalledWith(id, 2);
    expect(store.getSnapshot().browse.db).toBe(2);
    expect(client.scan).toHaveBeenCalledWith(id, '*', 0, expect.any(Number));
  });

  it('切库失败时错误记在浏览态里，连接不受影响', async () => {
    const { store, client, id } = await connected();
    client.select.mockRejectedValueOnce(new Error('服务器拒绝了这次操作：out of range'));

    await store.openDb(id, 9999);

    expect(store.getSnapshot().browse.keysError).toContain('out of range');
    expect(store.getSnapshot().runtime[id]?.status).toBe('connected');
  });

  it('翻页把新一页追加在后面', async () => {
    const { store, client, id } = await connected();
    client.scan
      .mockResolvedValueOnce({ cursor: 7, keys: [{ key: 'a', keyType: 'string' }] })
      .mockResolvedValueOnce({ cursor: 0, keys: [{ key: 'b', keyType: 'list' }] });

    await store.openDb(id, 0);
    expect(store.getSnapshot().browse.cursor).toBe(7);
    expect(store.getSnapshot().browse.keys.map((k) => k.key)).toEqual(['a']);

    await store.loadMoreKeys();
    expect(store.getSnapshot().browse.keys.map((k) => k.key)).toEqual(['a', 'b']);
    expect(store.getSnapshot().browse.cursor).toBe(0);
  });

  it('翻到底之后不再发请求', async () => {
    const { store, client } = await connected();
    const after = client.scan.mock.calls.length;

    // 默认 mock 返回 cursor 0（翻完了）
    await store.loadMoreKeys();
    await store.loadMoreKeys();

    expect(client.scan).toHaveBeenCalledTimes(after);
  });

  it('选中 key 取详情，并把列表里的类型作为提示传下去', async () => {
    const { store, client, id } = await connected();
    const meta = firstKey(store);

    await store.selectKey(meta);

    // 第四个参数是类型提示 —— 有它后端能少一次往返
    expect(client.keyDetail).toHaveBeenCalledWith(
      id,
      expect.any(Uint8Array),
      expect.any(Number),
      'string',
    );
    expect(store.getSnapshot().browse.detail?.value).toEqual({
      type: 'bulk',
      text: 'hello',
      binary: false,
      bytes: 5,
    });
  });

  it('二进制 key 用后端给的原始字节去查', async () => {
    const { store, client } = await connected();
    const meta = { key: '乱码', keyBytes: [0xff, 0xfe], keyType: 'string' };

    await store.selectKey(meta);

    const passed = client.keyDetail.mock.calls.at(-1)?.[1] as Uint8Array;
    expect(Array.from(passed)).toEqual([0xff, 0xfe]);
  });

  it('取详情时选中的 key 变了，迟到的结果会被丢掉', async () => {
    const { store, client } = await connected();
    const first = firstKey(store);
    const second = firstKey(store, 1);

    let release = (): void => {};
    client.keyDetail.mockImplementationOnce(
      () => new Promise<KeyDetail>((resolve) => (release = () => resolve(detailOf('stale')))),
    );

    const pending = store.selectKey(first);
    await store.selectKey(second); // 用户又点了别的
    release();
    await pending;

    expect(store.getSnapshot().browse.selected?.key).toBe(second.key);
    expect(store.getSnapshot().browse.detail?.key).toBe('user:1');
    expect(store.getSnapshot().browse.detail?.key).not.toBe('stale');
  });

  it('改过滤条件后重新加载，从第一页开始', async () => {
    const { store, client, id } = await connected();
    client.scan.mockClear();

    store.setPattern('user:*');
    await store.reloadKeys();

    expect(client.scan).toHaveBeenCalledWith(id, 'user:*', 0, expect.any(Number));
    expect(store.getSnapshot().browse.keys).toHaveLength(2);
  });

  it('断开之后库列表和 key 都清掉', async () => {
    const { store, id } = await connected();
    expect(store.getSnapshot().keyspace[id]).toBeDefined();

    await store.disconnect(id);

    expect(store.getSnapshot().keyspace[id]).toBeUndefined();
    expect(store.getSnapshot().browse.db).toBeNull();
    expect(store.getSnapshot().browse.keys).toEqual([]);
  });

  it('库列表读不到时走状态栏提示，不弹错误条', async () => {
    const h = harness();
    const id = await h.store.createProfile();
    h.client.keyspace.mockRejectedValueOnce(new Error('INFO 被禁用了'));

    await h.store.connect(id);

    expect(h.errors).toEqual([]); // 没弹错误条
    expect(h.statuses.some((s) => s.includes('INFO 被禁用了'))).toBe(true);
    // 但连接本身是好的，key 列表照常加载
    expect(h.store.getSnapshot().runtime[id]?.status).toBe('connected');
  });

  it('切到别的连接会重置浏览态', async () => {
    const { store, id } = await connected();
    const other = await store.createProfile();

    store.select(other);

    expect(store.getSnapshot().browse.db).toBeNull();
    expect(store.getSnapshot().browse.keys).toEqual([]);
    // 但原来那个连接的库列表还在（没必要丢）
    expect(store.getSnapshot().keyspace[id]).toBeDefined();
  });
});

/** 取夹具里第 n 个 key；没有就报错（免得测试在 undefined 上静静地过） */
function firstKey(store: RedisStore, index = 0): KeyMeta {
  const meta = store.getSnapshot().browse.keys[index];
  if (meta === undefined) throw new Error(`夹具里应该已经有第 ${index} 个 key 了`);
  return meta;
}

function detailOf(key: string): KeyDetail {
  return {
    key,
    keyType: 'string',
    ttl: -1,
    size: 5,
    value: { type: 'bulk', text: 'hello', binary: false, bytes: 5 },
    truncated: false,
  };
}

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
    const broken = store as unknown as { services: { profiles: ProfileStore<ConnectionProfile> } };
    broken.services.profiles.load = async () => {
      throw new Error('读不出来');
    };

    await store.init();

    expect(store.getSnapshot().ready).toBe(true);
    expect(errors.some((e) => e.includes('读不出来'))).toBe(true);
  });
});

/** 造一条**预置**的连接档案（id 固定，方便断言）。普通用例走 `store.createProfile()` */
function profileOf(id: string): ConnectionProfile {
  return {
    id,
    name: `连接 ${id}`,
    host: '127.0.0.1',
    port: 6379,
    db: 0,
    username: '',
    password: '',
  };
}

describe('分组', () => {
  it('新建分组：进 state、也落盘', async () => {
    const { store, savedGroups } = harness();
    await store.init();

    const id = await store.createGroup();

    expect(store.getSnapshot().groups.map((g) => g.id)).toEqual([id]);
    expect(savedGroups.at(-1)?.map((g) => g.id)).toEqual([id]);
  });

  it('把连接放进分组，再移出来', async () => {
    const { store } = harness({ stored: [profileOf('a')] });
    await store.init();
    const gid = await store.createGroup();

    await store.moveToGroup('a', gid);
    expect(store.getSnapshot().profiles[0]?.groupId).toBe(gid);

    await store.moveToGroup('a', null);
    expect(store.getSnapshot().profiles[0]?.groupId).toBeUndefined();
  });

  it('⚠️ 删分组**一条连接都不删**，成员落回未分组', async () => {
    // 用户点「删除分组」十有八九是想拆掉一层目录，不是想把连接全干掉 ——
    // 所以这个操作不带确认弹窗也安全。这条边界要是破了，那是数据丢失级别的 bug
    const { store, saved } = harness({ stored: [profileOf('a'), profileOf('b')] });
    await store.init();
    const gid = await store.createGroup();
    await store.moveToGroup('a', gid);

    const savedBefore = saved.length;
    await store.deleteGroup(gid);

    const after = store.getSnapshot();
    expect(after.groups).toEqual([]);
    // 两条连接都还在
    expect(after.profiles.map((p) => p.id)).toEqual(['a', 'b']);
    // 成员落回未分组（字段被真的删掉）
    expect(Object.hasOwn(after.profiles[0] ?? {}, 'groupId')).toBe(false);
    // 有成员，所以连接档案也重写过一次
    expect(saved.length).toBeGreaterThan(savedBefore);
  });

  it('空分组被删时不重写连接档案（少一次没必要的写盘）', async () => {
    const { store, saved } = harness({ stored: [profileOf('a')] });
    await store.init();
    const gid = await store.createGroup();

    const before = saved.length;
    await store.deleteGroup(gid);

    expect(saved.length).toBe(before);
  });

  it('改分组名；空名字直接忽略', async () => {
    const { store } = harness();
    await store.init();
    const gid = await store.createGroup();

    await store.renameGroup(gid, '生产环境');
    expect(store.getSnapshot().groups[0]?.name).toBe('生产环境');

    await store.renameGroup(gid, '   ');
    expect(store.getSnapshot().groups[0]?.name).toBe('生产环境');
  });

  it('分组读不出来时不连累连接档案', async () => {
    const h = harness({ stored: [profileOf('a')] });
    const broken = h.store as unknown as {
      services: { groups: { load: () => Promise<never> } };
    };
    broken.services.groups.load = async () => {
      throw new Error('分组坏了');
    };

    await h.store.init();

    const state = h.store.getSnapshot();
    expect(state.ready).toBe(true);
    expect(state.profiles).toHaveLength(1); // 连接照样能用
    expect(state.groups).toEqual([]);
  });
});
