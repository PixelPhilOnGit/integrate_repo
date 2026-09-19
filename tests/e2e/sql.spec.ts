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

/** 新建一个连接（不连）。点「新建」会先弹引擎选择，选完才建 */
async function newConnection(page: Page, engine: 'PostgreSQL' | 'MySQL' = 'PostgreSQL'): Promise<void> {
  await page.getByTestId('btn-new-sql-connection').click();
  await page.getByTestId(`menu-${engine}`).click();
  await expect(page.getByTestId('sql-name')).toHaveValue(`新建 ${engine} 连接`);
}

/** 新建并连上 */
async function connectNew(page: Page, engine: 'PostgreSQL' | 'MySQL' = 'PostgreSQL'): Promise<void> {
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

test('新建时可以选引擎', async ({ page }) => {
  await page.getByTestId('btn-new-sql-connection').click();

  // 两种引擎都得能选，而不是建完再去属性面板里改
  await expect(page.getByTestId('menu-PostgreSQL')).toBeVisible();
  await expect(page.getByTestId('menu-MySQL')).toBeVisible();

  await page.getByTestId('menu-MySQL').click();
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
  await expect(page.getByTestId('sql-editor')).toHaveValue('SELECT * FROM 用户 LIMIT 100');

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
