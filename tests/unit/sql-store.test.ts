import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetIdsForTest } from '../../src/shared/ids';
import { SqlStore } from '../../src/modules/sql/state/store';
import type { ProfileStore } from '../../src/shared/connections/types';
import type { SqlClient } from '../../src/modules/sql/services/types';
import type {
  QueryResult,
  ServerInfo,
  SqlProfile,
  TableInfo,
} from '../../src/modules/sql/core/types';
import type { ShellApi } from '../../src/shell/types';

beforeEach(() => __resetIdsForTest());

const OK_RESULT: QueryResult = {
  columns: [{ name: 'n', typeName: 'int4' }],
  rows: [[{ text: '1' }]],
  affected: null,
  truncated: false,
  elapsedMs: 3,
};

interface Harness {
  store: SqlStore;
  saved: SqlProfile[][];
  errors: string[];
  statuses: string[];
  client: {
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    query: ReturnType<typeof vi.fn>;
    databases: ReturnType<typeof vi.fn>;
    tables: ReturnType<typeof vi.fn>;
    useDatabase: ReturnType<typeof vi.fn>;
  };
}

function harness(options: { stored?: SqlProfile[] } = {}): Harness {
  let stored: SqlProfile[] = options.stored ?? [];
  const saved: SqlProfile[][] = [];
  const errors: string[] = [];
  const statuses: string[] = [];

  const info: ServerInfo = {
    address: '127.0.0.1:5432',
    kind: 'postgres',
    version: '16.4',
    database: 'postgres',
  };

  // 假 client 必须**把方法都实现全**：这几条路径各自有 try/catch，
  // 少一个方法的话错误会被吞掉，测试照样绿 —— 那就是「绿得没有意义」
  const client = {
    connect: vi.fn(async () => ({ ...info })),
    disconnect: vi.fn(async () => {}),
    query: vi.fn(async (): Promise<QueryResult> => OK_RESULT),
    databases: vi.fn(async () => ['postgres', 'demo']),
    tables: vi.fn(async (): Promise<TableInfo[]> => [
      { name: '用户', schema: 'public', kind: 'table' },
      { name: '订单', schema: 'public', kind: 'table' },
    ]),
    useDatabase: vi.fn(async (_id: string, database: string) => ({ ...info, database })),
  };

  const profiles: ProfileStore<SqlProfile> = {
    load: async () => stored,
    save: async (next) => {
      stored = [...next];
      saved.push([...next]);
    },
  };

  const store = new SqlStore({ client: client as unknown as SqlClient, profiles });
  const shell: ShellApi = {
    setStatus: (msg) => statuses.push(String(msg)),
    reportError: (e) => errors.push(String(e)),
  };
  store.attachShell(shell);

  return { store, saved, errors, statuses, client };
}

describe('SQL 档案管理', () => {
  it('新建之后档案进了列表并被选中', async () => {
    const { store } = harness();
    const id = await store.createProfile();

    expect(store.getSnapshot().profiles.map((p) => p.id)).toEqual([id]);
    expect(store.getSnapshot().selectedId).toBe(id);
    expect(store.selectedProfile()?.id).toBe(id);
  });

  it('新建会落盘', async () => {
    const { store, saved } = harness();
    await store.createProfile();
    expect(saved).toHaveLength(1);
  });

  it('切引擎会把端口/用户名/库名的默认值跟着换', async () => {
    const { store } = harness();
    const id = await store.createProfile('postgres');

    await store.switchKind(id, 'mysql');

    const profile = store.selectedProfile();
    expect(profile?.kind).toBe('mysql');
    expect(profile?.port).toBe(3306);
    expect(profile?.username).toBe('root');
  });

  it('删除已连接的会先断开', async () => {
    const { store, client } = harness();
    const id = await store.createProfile();
    await store.connect(id);

    await store.deleteProfile(id);

    expect(client.disconnect).toHaveBeenCalledWith(id);
    expect(store.getSnapshot().profiles).toEqual([]);
  });
});

describe('SQL 连接', () => {
  it('连上之后自动加载库和表', async () => {
    const { store, client } = harness();
    const id = await store.createProfile();

    await store.connect(id);

    expect(store.getSnapshot().runtime[id]?.status).toBe('connected');
    expect(client.databases).toHaveBeenCalledWith(id);
    expect(client.tables).toHaveBeenCalledWith(id);
    expect(store.getSnapshot().databases[id]).toEqual(['postgres', 'demo']);
    expect(store.getSnapshot().tables[id]).toHaveLength(2);
    expect(store.getSnapshot().expanded[id]).toBe(true);
  });

  it('连不上时错误留在 runtime 里', async () => {
    const { store, client } = harness();
    client.connect.mockRejectedValueOnce(new Error('连接数据库（x）失败：拒绝连接'));
    const id = await store.createProfile();

    await store.connect(id);

    expect(store.getSnapshot().runtime[id]?.status).toBe('error');
    expect(store.getSnapshot().runtime[id]?.error).toContain('拒绝连接');
  });

  it('PostgreSQL 没填库名时不往后端发请求', async () => {
    const { store, client } = harness();
    const id = await store.createProfile();
    await store.updateProfile(id, { database: '' });

    await store.connect(id);

    expect(client.connect).not.toHaveBeenCalled();
    expect(store.getSnapshot().runtime[id]?.status).toBe('error');
  });

  it('断开之后库和表都清掉', async () => {
    const { store, id } = await connected();

    await store.disconnect(id);

    expect(store.getSnapshot().databases[id]).toBeUndefined();
    expect(store.getSnapshot().tables[id]).toBeUndefined();
  });

  it('库/表读不到时走状态栏，不弹错误条', async () => {
    const h = harness();
    const id = await h.store.createProfile();
    h.client.databases.mockRejectedValueOnce(new Error('权限不够'));

    await h.store.connect(id);

    expect(h.errors).toEqual([]);
    expect(h.statuses.some((s) => s.includes('权限不够'))).toBe(true);
    // 连接本身是好的
    expect(h.store.getSnapshot().runtime[id]?.status).toBe('connected');
  });

  it('已经加载过的连接再展开不会重复请求', async () => {
    const { store, client, id } = await connected();
    const before = client.databases.mock.calls.length;

    await store.toggleExpanded(id); // 折叠
    await store.toggleExpanded(id); // 再展开

    expect(client.databases).toHaveBeenCalledTimes(before);
  });
});

async function connected() {
  const h = harness();
  const id = await h.store.createProfile();
  await h.store.connect(id);
  return { ...h, id };
}

describe('SQL 换库', () => {
  it('换库会调后端并刷新表列表', async () => {
    const { store, client, id } = await connected();
    client.tables.mockClear();

    await store.useDatabase(id, 'demo');

    expect(client.useDatabase).toHaveBeenCalledWith(id, 'demo');
    expect(client.tables).toHaveBeenCalledWith(id);
    expect(store.getSnapshot().runtime[id]?.server?.database).toBe('demo');
  });

  it('换库失败时弹错误条（那是真的出错了，不是引擎拒绝一条查询）', async () => {
    const { store, client, id, errors } = await connected();
    client.useDatabase.mockRejectedValueOnce(new Error('Unknown database'));

    await store.useDatabase(id, 'nope');

    expect(errors.some((e) => e.includes('Unknown database'))).toBe(true);
  });

  it('点一张表会生成一句查询塞进编辑器', async () => {
    const { store } = await connected();
    store.insertTableQuery({ name: '用户', schema: 'public', kind: 'table' });
    // `public` 是默认 schema → 不带前缀；名字**一律加引号**
    // （大小写混写的表名不加引号选不中，统一加省得「有时候行有时候不行」）
    expect(store.getSnapshot().editor).toBe('SELECT * FROM "用户" LIMIT 100');
  });

  it('⚠️ 非默认 schema 的表要带上 schema —— 否则 PG 报 relation 不存在', async () => {
    // 真机上的报错：能看到表、能连上，点一下生成的却是裸表名，
    // 执行报 `ERROR: relation "account_api" does not exist`
    // （PostgreSQL 解析裸表名只看 search_path，表在别的 schema 里就找不到）
    const { store } = await connected();
    store.insertTableQuery({ name: 'account_api', schema: 'account', kind: 'table' });
    expect(store.getSnapshot().editor).toBe('SELECT * FROM "account"."account_api" LIMIT 100');
  });
});

describe('SQL 执行', () => {
  it('执行会记下结果', async () => {
    const { store, id } = await connected();
    void id;
    store.setEditor('SELECT 1');

    await store.run();

    expect(store.getSnapshot().result).toEqual(OK_RESULT);
    expect(store.getSnapshot().running).toBe(false);
  });

  it('把编辑器里的 SQL 原样发给后端', async () => {
    const { store, client, id } = await connected();
    store.setEditor('  SELECT * FROM 用户  ');

    await store.run();

    expect(client.query).toHaveBeenCalledWith(id, 'SELECT * FROM 用户');
  });

  /**
   * **引擎报错是一条查询结果，不是执行失败。**
   * 判反了的话，表名写错就会把连接显示成断开。
   */
  it('引擎报错记成结果，连接不受影响', async () => {
    const { store, client, id, errors } = await connected();
    client.query.mockResolvedValueOnce({
      columns: [],
      rows: [],
      affected: null,
      truncated: false,
      elapsedMs: 1,
      error: "Table 'demo.nope' doesn't exist",
    });

    await store.run();

    expect(store.getSnapshot().result?.error).toContain("doesn't exist");
    expect(store.getSnapshot().runtime[id]?.status).toBe('connected');
    expect(errors).toEqual([]);
  });

  it('传输层失败把连接标成 error 并清掉元数据', async () => {
    const { store, client, id } = await connected();
    client.query.mockRejectedValueOnce(new Error('连接 “x” 已中断'));

    await store.run();

    expect(store.getSnapshot().runtime[id]?.status).toBe('error');
    expect(store.getSnapshot().databases[id]).toBeUndefined();
    expect(store.getSnapshot().result?.error).toContain('已中断');
  });

  it('空 SQL 不执行', async () => {
    const { store, client } = await connected();
    store.setEditor('   ');

    await store.run();

    expect(client.query).not.toHaveBeenCalled();
  });

  it('执行期间 running 为真，跑完恢复', async () => {
    const { store, client } = await connected();
    let release = (): void => {};
    client.query.mockImplementationOnce(
      () => new Promise<QueryResult>((resolve) => (release = () => resolve(OK_RESULT))),
    );

    const running = store.run();
    expect(store.getSnapshot().running).toBe(true);
    release();
    await running;
    expect(store.getSnapshot().running).toBe(false);
  });

  it('上一次还在飞的时候不重复发', async () => {
    const { store, client } = await connected();
    let release = (): void => {};
    client.query.mockImplementationOnce(
      () => new Promise<QueryResult>((resolve) => (release = () => resolve(OK_RESULT))),
    );

    const first = store.run();
    await store.run();
    release();
    await first;

    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it('执行过的 SQL 进历史，Alt+上下能翻', async () => {
    const { store } = await connected();
    store.setEditor('SELECT 1');
    await store.run();
    store.setEditor('SELECT 2');
    await store.run();

    store.setEditor('SELECT 3');
    store.historyPrev();
    expect(store.getSnapshot().editor).toBe('SELECT 2');
    store.historyPrev();
    expect(store.getSnapshot().editor).toBe('SELECT 1');
    store.historyNext();
    expect(store.getSnapshot().editor).toBe('SELECT 2');
    store.historyNext();
    // 翻到底回到原来没敲完的内容
    expect(store.getSnapshot().editor).toBe('SELECT 3');
  });
});

describe('SQL 初始化', () => {
  it('读回档案并默认选中第一个', async () => {
    const stored: SqlProfile[] = [
      {
        id: 'a',
        name: '已有的连接',
        kind: 'mysql',
        host: '10.0.0.9',
        port: 3306,
        username: 'root',
        database: 'demo',
        password: '',
      },
    ];
    const { store } = harness({ stored });

    await store.init();

    expect(store.getSnapshot().ready).toBe(true);
    expect(store.selectedProfile()?.name).toBe('已有的连接');
    expect(store.getSnapshot().runtime.a?.status).toBe('idle');
  });

  it('init 幂等 —— 切模块回来不该把结果重置掉', async () => {
    const { store } = await connected();
    store.setEditor('SELECT 1');
    await store.run();
    const result = store.getSnapshot().result;

    await store.init();
    await store.init();

    expect(store.getSnapshot().result).toEqual(result);
    expect(store.getSnapshot().profiles).toHaveLength(1);
  });
});
