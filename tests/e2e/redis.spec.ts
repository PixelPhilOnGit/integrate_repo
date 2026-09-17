/**
 * Redis 模块的端到端测试。
 *
 * 跑在普通 Chromium 上，驱动的是**浏览器版的假 Redis**（`services/web.ts`）。
 * 假实现是刻意做得足够真的：`SET a 1` 之后再 `GET a` 真的能拿回 `1`，
 * 而且带一份演示数据（五种类型 + 一个公共前缀），所以「浏览」这条链路
 * 也能断言到真东西，而不是对着写死的假数据自欺。
 *
 * 协议层的正确性不在这里 —— 那是 Rust 侧打真 redis-server 的集成测试的职责。
 */

import { expect, test, type Page } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/');
  await expect(page.getByTestId('app-shell')).toBeVisible();
  await page.getByTestId('module-redis').click();
  // 主界面是「浏览」，不是命令台
  await expect(page.getByTestId('redis-main')).toBeVisible();
});

/** 新建一个连接并连上。连上之后会自动展开、列出库、加载默认库的 key */
async function connectNew(page: Page): Promise<void> {
  await page.getByTestId('btn-new-connection').click();
  await expect(page.getByTestId('conn-name')).toHaveValue('新建连接');

  await page.getByTestId('btn-conn-toggle').click();
  await expect(page.getByTestId('conn-status')).toContainText('已连接');
}

/** 切到命令台页签。幂等 —— 已经开着再点也没副作用 */
async function openConsole(page: Page): Promise<void> {
  await page.getByTestId('tab-console').click();
  await expect(page.getByTestId('redis-console')).toBeVisible();
}

/**
 * 敲一条命令并**等它跑完**。
 *
 * 必须等到跑完：命令是串行执行的，前一条还在飞的时候再敲一条会被直接丢掉
 * （`runCommand` 里的 running 守卫），不等的话测试会随机地少执行几条命令。
 * 判据是「回复行数 +1」—— 输入回显是同步写进去的，不能拿它当完成信号。
 */
async function run(page: Page, command: string): Promise<void> {
  await openConsole(page);

  const finished = page.locator(
    '[data-testid="console-line"][data-kind="reply"], [data-testid="console-line"][data-kind="transport"]',
  );
  const before = await finished.count();

  await page.getByTestId('console-input').fill(command);
  await page.getByTestId('console-input').press('Enter');

  await expect(finished).toHaveCount(before + 1);
}

/** 侧栏里某个库那一行 */
function dbRow(page: Page, db: number) {
  return page.locator(`[data-testid="conn-list"] [data-db="${db}"]`);
}

// ------------------------------------------------------------------ 连接

test('新建连接、连上、状态栏反映连接状态', async ({ page }) => {
  await expect(page.getByTestId('conn-list')).toContainText('还没有连接');

  await page.getByTestId('btn-new-connection').click();
  await expect(page.getByTestId('conn-list')).toContainText('新建连接');
  await expect(page.getByTestId('conn-status')).toContainText('未连接');

  await page.getByTestId('btn-conn-toggle').click();
  await expect(page.getByTestId('conn-status')).toContainText('已连接');
  await expect(page.getByTestId('conn-info')).toContainText('Redis 7');
});

test('连不上时给出提示', async ({ page }) => {
  await page.getByTestId('btn-new-connection').click();
  await page.getByTestId('conn-host').fill('unreachable.invalid');
  await page.getByTestId('btn-conn-toggle').click();

  await expect(page.getByTestId('conn-error')).toContainText('连接 Redis');
  await expect(page.getByTestId('conn-status')).toContainText('连接出错');

  // 没连上就敲不了命令
  await openConsole(page);
  await expect(page.getByTestId('console-input')).toBeDisabled();
});

test('改了连接参数会提示要重连', async ({ page }) => {
  await connectNew(page);
  await page.getByTestId('conn-port').fill('6380');
  await expect(page.getByTestId('conn-stale')).toContainText('重新连接才生效');
});

test('右键连接也能删除', async ({ page }) => {
  await connectNew(page);

  await page.locator('[data-conn-name]').first().click({ button: 'right' });
  await expect(page.getByTestId('context-menu')).toBeVisible();
  await page.getByTestId('menu-删除').click();

  await expect(page.getByTestId('conn-list')).toContainText('还没有连接');
});

test('删除连接会从列表里消失', async ({ page }) => {
  await connectNew(page);
  await page.getByTestId('btn-conn-delete').click();

  await expect(page.getByTestId('conn-list')).toContainText('还没有连接');
  await expect(page.getByTestId('conn-status')).toContainText('没有连接');
});

test('连接档案会写进本地存储，重开页面还在', async ({ page }) => {
  await page.getByTestId('btn-new-connection').click();
  await page.getByTestId('conn-name').fill('本地测试库');
  await expect(page.getByTestId('conn-list')).toContainText('本地测试库');

  // 开一张**新的 page**（同一个浏览器上下文，localStorage 是同一份），
  // 而不是 reload —— beforeEach 里的 addInitScript 会在每次导航时清掉 localStorage
  const fresh = await page.context().newPage();
  await fresh.goto('/');
  await fresh.getByTestId('module-redis').click();

  await expect(fresh.getByTestId('conn-list')).toContainText('本地测试库');
  await fresh.getByTestId('conn-list').getByText('本地测试库').click();
  await expect(fresh.getByTestId('conn-name')).toHaveValue('本地测试库');
});

// ------------------------------------------------------------------ 浏览

/** 这条是这个模块的主界面：连上就该看到库和 key，不用再点任何东西 */
test('连上之后自动列出库，默认停在 db0 并显示它的 key', async ({ page }) => {
  await connectNew(page);

  // 空库也要列出来 —— 用户明确要求「看得到 db0、db1 这些」
  for (const db of [0, 1, 2, 15]) {
    await expect(dbRow(page, db)).toBeVisible();
  }
  await expect(dbRow(page, 0)).toHaveAttribute('data-key-count', '6');
  await expect(dbRow(page, 1)).toHaveAttribute('data-key-count', '1');

  // db0 是默认选中的，key 列表直接就是它的内容
  await expect(dbRow(page, 0)).toHaveClass(/is-active/);
  await expect(page.getByTestId('key-user:1')).toBeVisible();
  await expect(page.getByTestId('key-标签')).toBeVisible();
});

test('key 列表带类型标签，一眼能看出是什么类型', async ({ page }) => {
  await connectNew(page);

  await expect(page.getByTestId('key-user:1')).toHaveAttribute('data-key-type', 'string');
  await expect(page.getByTestId('key-标签')).toHaveAttribute('data-key-type', 'set');
  await expect(page.getByTestId('key-排行榜')).toHaveAttribute('data-key-type', 'zset');
});

test('点另一个库，key 列表换成那个库的', async ({ page }) => {
  await connectNew(page);
  await expect(page.getByTestId('key-user:1')).toBeVisible();

  await dbRow(page, 1).click();

  await expect(dbRow(page, 1)).toHaveClass(/is-active/);
  await expect(page.getByTestId('key-来自db1')).toBeVisible();
  // 上一个库的 key 不在了
  await expect(page.getByTestId('key-user:1')).toHaveCount(0);
  // 状态栏也跟着换了库号
  await expect(page.getByTestId('conn-status')).toContainText('/1');
});

test('空的库给提示，而不是一片空白', async ({ page }) => {
  await connectNew(page);

  await dbRow(page, 3).click();

  await expect(page.getByTestId('key-list')).toContainText('这个库里没有 key');
});

test('点一个 key，右边显示它的值', async ({ page }) => {
  await connectNew(page);

  await page.getByTestId('key-user:1').click();

  await expect(page.getByTestId('value-key')).toHaveText('user:1');
  await expect(page.getByTestId('value-body')).toContainText('张三');
  // string 的 TTL 没设过，显示成人话而不是 -1
  await expect(page.getByTestId('value-view')).toContainText('永不过期');
  // 「张三」是 6 字节（UTF-8 下一个汉字 3 字节），不是 2
  await expect(page.getByTestId('value-view')).toContainText('6 字节');
});

test('不同类型的值按各自的形状渲染', async ({ page }) => {
  await connectNew(page);

  // hash → 两列表格
  await page.getByTestId('key-会话:1001').click();
  await expect(page.getByTestId('value-body').locator('table')).toBeVisible();
  await expect(page.getByTestId('value-body')).toContainText('登录时间');
  await expect(page.getByTestId('value-body')).toContainText('2026-09-17 09:12');

  // list → 有序列表
  await page.getByTestId('key-队列:待处理').click();
  await expect(page.getByTestId('value-body').locator('ol')).toBeVisible();
  await expect(page.getByTestId('value-body')).toContainText('发邮件');

  // zset → 成员和分数两列
  await page.getByTestId('key-排行榜').click();
  await expect(page.getByTestId('value-body')).toContainText('张三');
  await expect(page.getByTestId('value-body')).toContainText('98');
});

test('过滤框按 pattern 过滤', async ({ page }) => {
  await connectNew(page);
  await expect(page.getByTestId('key-标签')).toBeVisible();

  await page.getByTestId('key-filter').fill('user:*');
  await page.getByTestId('key-filter').press('Enter');

  await expect(page.getByTestId('key-user:1')).toBeVisible();
  await expect(page.getByTestId('key-user:2')).toBeVisible();
  await expect(page.getByTestId('key-标签')).toHaveCount(0);
});

test('过滤不到东西时给出提示，还带上 pattern', async ({ page }) => {
  await connectNew(page);

  await page.getByTestId('key-filter').fill('不存在的:*');
  await page.getByTestId('key-filter').press('Enter');

  await expect(page.getByTestId('key-list')).toContainText('没有匹配「不存在的:*」的 key');
});

test('断开之后库和 key 都清掉', async ({ page }) => {
  await connectNew(page);
  await expect(dbRow(page, 0)).toBeVisible();

  await page.getByTestId('btn-conn-toggle').click();

  await expect(page.getByTestId('conn-status')).toContainText('未连接');
  await expect(dbRow(page, 0)).toHaveCount(0);
  await expect(page.getByTestId('key-user:1')).toHaveCount(0);
});

// ------------------------------------------------------------------ 命令台

test('命令台还在，执行命令并把结果渲染出来', async ({ page }) => {
  await connectNew(page);
  await run(page, 'PING');

  const output = page.getByTestId('console-output');
  await expect(output).toContainText('PONG');

  // 写进去再读回来 —— 这条才真正说明链路是通的
  await run(page, 'SET greeting hello');
  await run(page, 'GET greeting');
  await expect(output).toContainText('"hello"');

  await run(page, 'DEL greeting');
  await expect(output).toContainText('(integer) 1');
  await run(page, 'GET greeting');
  await expect(output).toContainText('(nil)');
});

/**
 * 这条是**语义守门测试**：服务器报错是一条正常的回复，不是执行失败。
 *
 * 如果哪天有人把 `exec` 的错误处理搞反了（把服务端错误也 reject 掉），
 * 用户敲错一个命令就会看到顶部弹红色错误条 —— 这条会立刻挂。
 */
test('敲错命令时错误内联在日志里，不弹外壳错误条', async ({ page }) => {
  await connectNew(page);
  await run(page, 'FLY_TO_MARS');

  const output = page.getByTestId('console-output');
  await expect(output).toContainText('(error)');
  await expect(output).toContainText('unknown command');
  await expect(page.getByTestId('error-banner')).toHaveCount(0);
  await expect(page.getByTestId('conn-status')).toContainText('已连接');

  await run(page, 'PING');
  await expect(output).toContainText('PONG');
});

test('↑ ↓ 回溯命令历史', async ({ page }) => {
  await connectNew(page);
  await run(page, 'PING');
  await run(page, 'ECHO first');

  const input = page.getByTestId('console-input');
  await input.press('ArrowUp');
  await expect(input).toHaveValue('ECHO first');
  await input.press('ArrowUp');
  await expect(input).toHaveValue('PING');
  await input.press('ArrowDown');
  await expect(input).toHaveValue('ECHO first');
  await input.press('ArrowDown');
  await expect(input).toHaveValue('');
});

test('草稿不会被历史吃掉', async ({ page }) => {
  await connectNew(page);
  await run(page, 'PING');

  const input = page.getByTestId('console-input');
  await input.fill('GET half-typed');
  await input.press('ArrowUp');
  await expect(input).toHaveValue('PING');
  await input.press('ArrowDown');
  await expect(input).toHaveValue('GET half-typed');
});

test('AUTH 的密码在日志里被打码', async ({ page }) => {
  await connectNew(page);
  await run(page, 'AUTH my-super-secret');

  const output = page.getByTestId('console-output');
  await expect(output).toContainText('AUTH');
  await expect(output).not.toContainText('my-super-secret');
});

test('命令执行期间输入框禁用，跑完恢复', async ({ page }) => {
  await connectNew(page);
  await openConsole(page);

  const input = page.getByTestId('console-input');
  await input.fill('DEBUG SLEEP 700');
  await input.press('Enter');

  await expect(input).toBeDisabled();
  await expect(input).toBeEnabled({ timeout: 5000 });
  await expect(page.getByTestId('console-output')).toContainText('OK');
});

test('清空按钮把日志清掉', async ({ page }) => {
  await connectNew(page);
  await run(page, 'PING');
  await expect(page.getByTestId('console-output')).toContainText('PONG');

  await page.getByTestId('btn-console-clear').click();
  await expect(page.getByTestId('console-output')).not.toContainText('PONG');
});

// ------------------------------------------------------------------ 模块契约

test('切到别的模块再切回来，连接、浏览位置和命令输出都还在', async ({ page }) => {
  await connectNew(page);
  await dbRow(page, 1).click();
  await expect(page.getByTestId('key-来自db1')).toBeVisible();

  await page.getByTestId('module-diagram').click();
  await expect(page.getByTestId('canvas-svg')).toBeVisible();

  await page.getByTestId('module-redis').click();

  await expect(page.getByTestId('conn-status')).toContainText('已连接');
  // 浏览位置没丢
  await expect(page.getByTestId('key-来自db1')).toBeVisible();
  await expect(dbRow(page, 1)).toHaveClass(/is-active/);

  // 连接真的还活着
  await run(page, 'DBSIZE');
  await expect(page.getByTestId('console-output')).toContainText('(integer)');
});

test('连上之后看得到 key，用命令台写进去的立刻能读到', async ({ page }) => {
  await connectNew(page);

  await run(page, 'SET 新写进去的 值');
  await page.getByTestId('tab-browse').click();
  await page.getByTestId('btn-key-reload').click();

  await expect(page.getByTestId('key-新写进去的')).toBeVisible();
  await page.getByTestId('key-新写进去的').click();
  await expect(page.getByTestId('value-body')).toContainText('值');
});
