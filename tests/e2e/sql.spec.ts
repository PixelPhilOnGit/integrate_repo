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

async function connectNew(page: Page): Promise<void> {
  await page.getByTestId('btn-new-sql-connection').click();
  await expect(page.getByTestId('sql-name')).toHaveValue('新建 PostgreSQL 连接');
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

test('新建连接、连上、侧栏列出库和表', async ({ page }) => {
  await expect(page.getByTestId('sql-conn-list')).toContainText('还没有连接');

  await connectNew(page);

  // 连上就该看到东西 —— 不用再点任何按钮
  await expect(page.getByTestId('sql-db-demo')).toBeVisible();
  await expect(page.getByTestId('sql-table-用户')).toBeVisible();
  await expect(page.getByTestId('sql-table-订单')).toBeVisible();
});

test('连不上时给出提示', async ({ page }) => {
  await page.getByTestId('btn-new-sql-connection').click();
  await page.getByTestId('sql-host').fill('unreachable.invalid');
  await page.getByTestId('btn-sql-conn-toggle').click();

  await expect(page.getByTestId('sql-conn-error')).toContainText('连接数据库');
  await expect(page.getByTestId('sql-status')).toContainText('连接出错');
});

test('PostgreSQL 不填库名时不让连', async ({ page }) => {
  await page.getByTestId('btn-new-sql-connection').click();
  await page.getByTestId('sql-database').fill('');

  await expect(page.getByTestId('sql-inspector')).toContainText('必须指定库名');
  // 参数不合法时「连接」按钮是禁用的
  await expect(page.getByTestId('btn-sql-conn-toggle')).toBeDisabled();
});

test('切引擎会把端口和用户名跟着换', async ({ page }) => {
  await page.getByTestId('btn-new-sql-connection').click();
  await expect(page.getByTestId('sql-port')).toHaveValue('5432');
  await expect(page.getByTestId('sql-username')).toHaveValue('postgres');

  await page.getByTestId('sql-kind').selectOption('mysql');

  await expect(page.getByTestId('sql-port')).toHaveValue('3306');
  await expect(page.getByTestId('sql-username')).toHaveValue('root');
  // MySQL 可以不填库名，错误提示也该消失
  await expect(page.getByTestId('sql-inspector')).not.toContainText('必须指定库名');
});

test('删除连接会从列表里消失', async ({ page }) => {
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
