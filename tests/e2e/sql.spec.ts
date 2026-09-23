/**
 * SQL 模块的端到端测试。
 *
 * 跑在普通 Chromium 上，驱动的是**浏览器版的假 SQL 引擎**（`core/fakeSql.ts`）。
 * 假引擎刻意做得足够真：`SELECT * FROM 用户` 真的回那几行，所以这里断言的是
 * 「连接 → 查询 → 展示结果」这条完整链路。
 *
 * 引擎协议层的正确性不在这里 —— 那是 Rust 侧打真 PostgreSQL / MySQL 的集成测试。
 */

import { expect, test, type Page } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/');
  await expect(page.getByTestId('app-shell')).toBeVisible();
  await page.getByTestId('module-sql').click();
  await expect(page.getByTestId('sql-main')).toBeVisible();
});

/** 新建一个连接（不连）。点「新建」弹一个对话框，引擎是里面第一格 */
type EngineName = 'PostgreSQL' | 'MySQL' | 'ClickHouse' | 'MongoDB';

/** 界面上的引擎名 → `select` 的 value（弹框里那一格用的是后者）。 */
const ENGINE_VALUE: Record<EngineName, string> = {
  PostgreSQL: 'postgres',
  MySQL: 'mysql',
  ClickHouse: 'clickhouse',
  MongoDB: 'mongodb',
};

async function newConnection(page: Page, engine: EngineName = 'PostgreSQL'): Promise<void> {
  await page.getByTestId('btn-new-sql-connection').click();
  // ⚠️ 引擎原来是一个右键菜单（`menu-<引擎名>`），现在进了弹框的第一格。
  await page.getByTestId('sql-new-kind').selectOption(ENGINE_VALUE[engine]);
  await page.getByTestId('sql-new-confirm').click();
  await expect(page.getByTestId('sql-name')).toHaveValue(`新建 ${engine} 连接`);
}

/** 新建并连上 */
async function connectNew(page: Page, engine: EngineName = 'PostgreSQL'): Promise<void> {
  await newConnection(page, engine);
  await page.getByTestId('btn-sql-conn-toggle').click();
  await expect(page.getByTestId('sql-status')).toContainText('已连接');
}

/** 在编辑器里写 SQL 并等结果回来 */
async function run(page: Page, sql: string): Promise<void> {
  await page.getByTestId('sql-editor').fill(sql);
  await page.getByTestId('btn-sql-run').click();
  // 执行完按钮文字会从「执行中…」恢复
  await expect(page.getByTestId('btn-sql-run')).toHaveText('执行');
}

// ------------------------------------------------------------------ 连接

test('新建时可以选引擎，端口默认值当场跟着换', async ({ page }) => {
  await page.getByTestId('btn-new-sql-connection').click();

  // 引擎是弹框里的第一格，而不是建完再去属性面板里改
  await page.getByTestId('sql-new-kind').selectOption('mysql');

  // ⚠️ 联动要在**弹框里**就发生：用户先选引擎再填端口，不该填完 5432 之后
  // 才发现引擎是 MySQL。`applyNewDialogKindSwitch` 负责这件事。
  await expect(page.getByTestId('sql-new-port')).toHaveValue('3306');

  await page.getByTestId('sql-new-confirm').click();

  // 建出来的档案确实是 MySQL
  await expect(page.getByTestId('sql-kind')).toHaveValue('mysql');
  await expect(page.getByTestId('sql-port')).toHaveValue('3306');
});

test('新建连接、连上、侧栏列出库和表', async ({ page }) => {
  await expect(page.getByTestId('sql-conn-list')).toContainText('还没有连接');

  await connectNew(page);

  // 连上就该看到东西 —— 不用再点任何按钮
  await expect(page.getByTestId('sql-db-postgres')).toBeVisible();
  await expect(page.getByTestId('sql-table-用户')).toBeVisible();
  await expect(page.getByTestId('sql-table-订单')).toBeVisible();
});

/**
 * 表属于库 —— 界面上必须看得出这层包含关系。
 *
 * 之前写成了「库」和「表」两个并排的小节标题，看起来像两个并列的列表，
 * 用户根本看不出这些表是哪个库的。
 */
test('表缩进在它所属的库底下，而且只有当前库展开', async ({ page }) => {
  await connectNew(page);

  const activeDb = page.getByTestId('sql-db-postgres');
  const table = page.getByTestId('sql-table-用户');

  await expect(activeDb).toHaveAttribute('data-active', 'true');
  await expect(table).toBeVisible();

  // 表的文字必须在库的文字右边（缩进了一级）。
  // 注意要量**里面那个 span**，不能量按钮本身 —— 缩进是按钮内部的 padding，
  // 两个按钮的盒子左边界是一样的，量盒子会得出「没有缩进」的错误结论。
  const dbText = await activeDb.locator('.rd-db-name').boundingBox();
  const tableText = await table.locator('.rd-db-name').boundingBox();
  expect(tableText?.x ?? 0).toBeGreaterThan(dbText?.x ?? 0);

  // 没在看的库不该展开它的表
  await expect(page.getByTestId('sql-db-information_schema')).toHaveAttribute(
    'data-active',
    'false',
  );
});

test('切库之后表列表跟着换', async ({ page }) => {
  await connectNew(page);
  await expect(page.getByTestId('sql-table-用户')).toBeVisible();

  await page.getByTestId('sql-db-information_schema').click();

  // 那个库是空的 —— 表没了，而且明确说了为什么
  await expect(page.getByTestId('sql-table-用户')).toHaveCount(0);
  await expect(page.getByTestId('sql-db-information_schema')).toHaveAttribute('data-active', 'true');
  await expect(page.getByTestId('sql-dbs-' + (await activeConnId(page)))).toContainText(
    '这个库里没有表',
  );
});

/** 侧栏里那一行的连接 id（testid 里带着它，但它是随机生成的，只能查出来） */
async function activeConnId(page: Page): Promise<string> {
  const testid = await page.locator('[data-testid^="sql-dbs-"]').first().getAttribute('data-testid');
  return (testid ?? '').replace('sql-dbs-', '');
}

test('右键连接能删除（删除不该只藏在属性面板最底下）', async ({ page }) => {
  await connectNew(page);

  await page.locator('[data-conn-name]').first().click({ button: 'right' });
  await expect(page.getByTestId('context-menu')).toBeVisible();
  await page.getByTestId('menu-删除').click();

  await expect(page.getByTestId('sql-conn-list')).toContainText('还没有连接');
});

test('连不上时给出提示', async ({ page }) => {
  await newConnection(page);
  await page.getByTestId('sql-host').fill('unreachable.invalid');
  await page.getByTestId('btn-sql-conn-toggle').click();

  await expect(page.getByTestId('sql-conn-error')).toContainText('连接数据库');
  await expect(page.getByTestId('sql-status')).toContainText('连接出错');
});

test('PostgreSQL 不填库名时不让连', async ({ page }) => {
  await newConnection(page);
  await page.getByTestId('sql-database').fill('');

  await expect(page.getByTestId('sql-inspector')).toContainText('必须指定库名');
  // 参数不合法时「连接」按钮是禁用的
  await expect(page.getByTestId('btn-sql-conn-toggle')).toBeDisabled();
});

test('建完之后在属性面板里切引擎，默认值也跟着换', async ({ page }) => {
  await newConnection(page);
  await expect(page.getByTestId('sql-port')).toHaveValue('5432');
  await expect(page.getByTestId('sql-username')).toHaveValue('postgres');

  await page.getByTestId('sql-kind').selectOption('mysql');

  await expect(page.getByTestId('sql-port')).toHaveValue('3306');
  await expect(page.getByTestId('sql-username')).toHaveValue('root');
  // MySQL 可以不填库名，错误提示也该消失
  await expect(page.getByTestId('sql-inspector')).not.toContainText('必须指定库名');
});

test('属性面板里的删除按钮同样有效', async ({ page }) => {
  await connectNew(page);
  await page.getByTestId('btn-sql-conn-delete').click();

  await expect(page.getByTestId('sql-conn-list')).toContainText('还没有连接');
  await expect(page.getByTestId('sql-status')).toContainText('没有连接');
});

// ------------------------------------------------------------------ 查询

test('执行 SELECT 1 显示成表格', async ({ page }) => {
  await connectNew(page);

  await run(page, 'SELECT 1');

  const result = page.getByTestId('sql-result');
  await expect(result).toHaveAttribute('data-kind', 'rows');
  await expect(page.getByTestId('sql-table')).toBeVisible();
  await expect(result).toContainText('1 行');
});

test('点侧栏的表会生成查询，执行后看到数据', async ({ page }) => {
  await connectNew(page);

  await page.getByTestId('sql-table-用户').click();
  // ⚠️ 名字**带双引号**（大小写混写的表名不加引号选不中，统一加对普通名字无害）；
  // 表在非默认 schema 里时前面还会带 `"schema".` —— 见 `core/query.ts`
  await expect(page.getByTestId('sql-editor')).toHaveValue('SELECT * FROM "用户" LIMIT 100');

  await page.getByTestId('btn-sql-run').click();

  const result = page.getByTestId('sql-result');
  await expect(result).toHaveAttribute('data-kind', 'rows');
  await expect(result).toContainText('张三');
  await expect(result).toContainText('李四');
  // 列名和类型都在表头上
  await expect(page.getByTestId('sql-table')).toContainText('姓名');
  await expect(page.getByTestId('sql-table')).toContainText('varchar');
});

/** NULL 和空串在视觉上必须分得开 —— 演示数据里特意留了一个 NULL */
test('NULL 显示成 (NULL) 而不是空的', async ({ page }) => {
  await connectNew(page);
  await run(page, 'SELECT * FROM 用户');

  const nullCells = page.getByTestId('sql-table').locator('td.is-null');
  await expect(nullCells).toHaveCount(1);
  await expect(nullCells).toHaveText('(NULL)');
});

/**
 * 这条是**语义守门测试**：引擎拒绝一条 SQL 是「一条结果」，不是「连接故障」。
 *
 * 判反了的话，表名写错一个字母就会弹外壳错误条、把连接显示成断开。
 */
test('表名写错时错误显示在结果区里，不弹外壳错误条', async ({ page }) => {
  await connectNew(page);

  await run(page, 'SELECT * FROM 不存在的表');

  const result = page.getByTestId('sql-result');
  await expect(result).toHaveAttribute('data-kind', 'error');
  await expect(result).toContainText("doesn't exist");
  await expect(page.getByTestId('error-banner')).toHaveCount(0);
  // 连接还好好的
  await expect(page.getByTestId('sql-status')).toContainText('已连接');

  // 还能接着查
  await run(page, 'SELECT 1');
  await expect(page.getByTestId('sql-result')).toHaveAttribute('data-kind', 'rows');
});

test('写操作显示影响行数', async ({ page }) => {
  await connectNew(page);

  await run(page, "INSERT INTO 用户 VALUES (4, '赵六', '广州', '2026-09-17')");

  const result = page.getByTestId('sql-result');
  await expect(result).toHaveAttribute('data-kind', 'affected');
  await expect(result).toContainText('影响 1 行');
});

test('Ctrl+Enter 也能执行', async ({ page }) => {
  await connectNew(page);

  await page.getByTestId('sql-editor').fill('SELECT 1');
  await page.getByTestId('sql-editor').press('Control+Enter');

  await expect(page.getByTestId('sql-result')).toHaveAttribute('data-kind', 'rows');
});

test('Alt+上下翻执行历史', async ({ page }) => {
  await connectNew(page);
  await run(page, 'SELECT 1');
  await run(page, 'SELECT 2');

  const editor = page.getByTestId('sql-editor');
  await editor.fill('');
  await editor.press('Alt+ArrowUp');
  await expect(editor).toHaveValue('SELECT 2');
  await editor.press('Alt+ArrowUp');
  await expect(editor).toHaveValue('SELECT 1');
  await editor.press('Alt+ArrowDown');
  await expect(editor).toHaveValue('SELECT 2');
});

test('没连上时不能执行', async ({ page }) => {
  await page.getByTestId('btn-new-sql-connection').click();
  await page.getByTestId('sql-new-confirm').click();

  await expect(page.getByTestId('btn-sql-run')).toBeDisabled();
  await expect(page.getByTestId('sql-editor')).toHaveAttribute('placeholder', '先连上一个数据库');
});

// ------------------------------------------------------------------ 模块契约

test('切到别的模块再切回来，连接和查询结果都还在', async ({ page }) => {
  await connectNew(page);
  await run(page, 'SELECT 1');
  await expect(page.getByTestId('sql-result')).toHaveAttribute('data-kind', 'rows');

  await page.getByTestId('module-diagram').click();
  await expect(page.getByTestId('canvas-svg')).toBeVisible();

  await page.getByTestId('module-sql').click();

  await expect(page.getByTestId('sql-status')).toContainText('已连接');
  // 结果没被重置
  await expect(page.getByTestId('sql-result')).toHaveAttribute('data-kind', 'rows');
  // 连接真的还活着
  await run(page, 'SELECT * FROM 订单');
  await expect(page.getByTestId('sql-result')).toContainText('199.00');
});

test('侧栏搜索：按名字/引擎过滤，清空之后原样回来', async ({ page }) => {
  await newConnection(page, 'PostgreSQL');
  await newConnection(page, 'MySQL');
  await expect(page.locator('[data-conn-name]')).toHaveCount(2);

  // 搜引擎名就该只剩那一条（地址串里带着引擎名，用户按这个找很自然）
  await page.getByTestId('sql-conn-search').fill('mysql');
  await expect(page.locator('[data-conn-name]')).toHaveCount(1);
  await expect(page.locator('[data-conn-name="新建 MySQL 连接"]')).toBeVisible();

  // 大小写不敏感：没人会老老实实按着 Shift 搜
  await page.getByTestId('sql-conn-search').fill('MYSQL');
  await expect(page.locator('[data-conn-name]')).toHaveCount(1);

  await page.getByTestId('sql-conn-search').fill('zzzz');
  await expect(page.getByTestId('sql-conn-nomatch')).toBeVisible();

  await page.getByTestId('sql-conn-search-clear').click();
  await expect(page.locator('[data-conn-name]')).toHaveCount(2);
});

test('侧栏按引擎分组：连接挂在它那个种类下面', async ({ page }) => {
  // 用户要的：「新建 pg，那这个连接属于 pg，也就是连接最好有一个 tag」
  await page.getByTestId('btn-new-sql-connection').click();
  await page.getByTestId('sql-new-kind').selectOption('postgres');
  await page.getByTestId('sql-new-confirm').click();
  await page.getByTestId('btn-new-sql-connection').click();
  await page.getByTestId('sql-new-kind').selectOption('mysql');
  await page.getByTestId('sql-new-confirm').click();

  // 两个组都在，各自一个连接
  await expect(page.getByTestId('sql-kind-postgres')).toBeVisible();
  await expect(page.getByTestId('sql-kind-mysql')).toBeVisible();
  await expect(page.getByTestId('sql-kind-count-postgres')).toHaveText('1');
  await expect(page.getByTestId('sql-kind-count-mysql')).toHaveText('1');

  // 折叠之后它下面的连接不画了
  // ⚠️ 用 `.rd-conn-row` 而不是 `[data-testid^="conn-"]`：后者会把行里的
  // 展开箭头 / 状态点 / 连接按钮（`conn-expand-` / `conn-dot-` / `conn-toggle-`）
  // 一起算进来，一行会数成 4 个
  await page.getByTestId('sql-kind-head-postgres').getByRole('button', { name: '收起' }).click();
  await expect(page.getByTestId('sql-kind-postgres').locator('.rd-conn-row')).toHaveCount(0);
  await expect(page.getByTestId('sql-kind-mysql').locator('.rd-conn-row')).toHaveCount(1);

  // 组头上那个 ＋ 开弹框，而且**引擎已经预选好** —— 它的原意就是
  //「在这一组里加一条」，预选正好保住那个意思（不用再去引擎那一格选一次）
  await page.getByTestId('sql-kind-new-mysql').click();
  await expect(page.getByTestId('sql-new-dialog')).toBeVisible();
  await expect(page.getByTestId('sql-new-kind')).toHaveValue('mysql');

  await page.getByTestId('sql-new-confirm').click();
  await expect(page.getByTestId('sql-kind-count-mysql')).toHaveText('2');
});


// ------------------------------------------------------------------ 四种引擎

test('新建时可以选四种引擎，端口默认值跟着引擎走', async ({ page }) => {
  await page.getByTestId('btn-new-sql-connection').click();

  // 四种都能在弹框里选到，而且端口当场跟着换
  for (const [kind, port] of [
    ['postgres', '5432'],
    ['mysql', '3306'],
    ['clickhouse', '8123'], // HTTP 口，不是 9000
    ['mongodb', '27017'],
  ] as const) {
    await page.getByTestId('sql-new-kind').selectOption(kind);
    await expect(page.getByTestId('sql-new-port')).toHaveValue(port);
  }

  await page.getByTestId('sql-new-kind').selectOption('clickhouse');
  await page.getByTestId('sql-new-confirm').click();
  await expect(page.getByTestId('sql-kind')).toHaveValue('clickhouse');
  await expect(page.getByTestId('sql-port')).toHaveValue('8123');

  // ⚠️ 下面这条是**建完之后**在右侧表单里换引擎 —— 和弹框里那条不是一回事：
  // 那边名字也跟着换，这边不换（用户可能已经起好名字了）。
  await page.getByTestId('sql-kind').selectOption('mongodb');
  await expect(page.getByTestId('sql-port')).toHaveValue('27017');
  // ⚠️ 切换引擎时**用户没动过的字段**才跟着换（改过的不能抢方向盘）
});

test('MongoDB：点集合生成 JSON 查询，结果是文档而不是表格', async ({ page }) => {
  await connectNew(page, 'MongoDB');

  // 侧栏：连接挂在它那个引擎组下面，集合标着「集合」（不是「表」）
  await expect(page.getByTestId('sql-kind-mongodb')).toBeVisible();
  await expect(page.getByTestId('sql-table-用户')).toBeVisible();
  await expect(page.getByTestId('sql-table-用户')).toContainText('集合');

  // 点一个集合 → 编辑器里填的是 **JSON 查询**（Mongo 没有 SQL）
  await page.getByTestId('sql-table-用户').click();
  await expect(page.getByTestId('sql-editor')).toHaveValue(/"collection": "用户"/);

  // 执行 → 一份份**文档**，不是结果表格
  await page.getByTestId('btn-sql-run').click();
  await expect(page.getByTestId('mongo-count')).toContainText('查到 2 份文档');
  await expect(page.getByTestId('mongo-doc-0')).toContainText('zhang@example.com');
  await expect(page.getByTestId('mongo-doc-1')).toContainText('李四');
  // 参差是文档的本性：第二份没有 email，界面不该因此空一格（那是表格的做法）
  await expect(page.getByTestId('sql-result-grid')).toHaveCount(0);

  // 引擎报的错**显示在结果区**（那是一次成功的往返，不是外壳的错误条）
  await run(page, '{"collection":"不存在的集合"}');
  await expect(page.getByTestId('mongo-error')).toContainText('没有这个集合');
});

// ------------------------------------------------------------------ 分组

test('分组：在引擎底下再分一层（引擎 → 分组 → 连接）', async ({ page }) => {
  await newConnection(page, 'PostgreSQL');
  await page.getByTestId('btn-new-group').click();

  // ⚠️ 分组头必须在**引擎那个节点里面**：「引擎在上、分组在下」是跟用户确认过的
  // 顺序。反过来的话，同一个引擎的连接会散在好几个分组里，
  // 「新建 pg，那这个连接属于 pg」这条心智就没了
  const groupInEngine = page
    .getByTestId('sql-kind-postgres')
    .locator('[data-group-name="新建分组"]');
  await expect(groupInEngine).toBeVisible();
  await expect(groupInEngine).toHaveAttribute('data-group-count', '0');

  await page
    .getByTestId('sql-kind-postgres')
    .locator('.rd-conn-row')
    .first()
    .click({ button: 'right' });
  await page.getByTestId('menu-移入「新建分组」').click();
  await expect(groupInEngine).toHaveAttribute('data-group-count', '1');

  // 分组是**全局的、不分引擎**：换个引擎它照样在（各是各的成员）。
  // ⚠️ 空的也要画 —— 用户建的组不该因为「这个引擎里还没放东西」就消失
  await newConnection(page, 'MySQL');
  const groupInMysql = page
    .getByTestId('sql-kind-mysql')
    .locator('[data-group-name="新建分组"]');
  await expect(groupInMysql).toBeVisible();
  await expect(groupInMysql).toHaveAttribute('data-group-count', '0');
});

test('结果表格列多时，滚的是表格自己，不是整个页面（回归）', async ({ page }) => {
  // 用户报的：「查询出的结果列多的情况下为啥是全局滑轮」。根因是外壳那三层
  // （`.rd-body` / `.rd-content` / `.rd-main`）只写了 `min-height: 0` ——
  // 它们是 **row 方向**的 flex，子项默认 `min-width: auto` 不会收缩，
  // 于是宽表格一路把它们撑开，滚的就不是小窗格而是整个页面。
  await connectNew(page);
  await run(page, 'SELECT * FROM 用户');
  await expect(page.getByTestId('sql-table')).toBeVisible();

  // 塞几十个宽列进去，把「一张很宽的表」造出来
  await page.evaluate(() => {
    const header = document.querySelector('.rd-sql-table tr');
    if (header === null) throw new Error('没有结果表格');
    for (let i = 0; i < 40; i += 1) {
      const th = document.createElement('th');
      th.textContent = `很宽很宽的列 ${i} ${'x'.repeat(30)}`;
      header.appendChild(th);
    }
  });

  // ⚠️ 表格那个小窗格**要能自己横向滚**
  const wrap = await page.evaluate(() => {
    const el = document.querySelector('.rd-sql-table-wrap');
    return el === null ? null : { scroll: el.scrollWidth, client: el.clientWidth };
  });
  expect(wrap).not.toBeNull();
  expect(wrap?.scroll ?? 0).toBeGreaterThan(wrap?.client ?? 0);

  // ⚠️ 而**整个文档不许被撑出横向滚动条** —— 那正是用户看到的「全局滑轮」
  const doc = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(doc.scroll).toBeLessThanOrEqual(doc.client);
});
