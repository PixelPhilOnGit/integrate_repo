/**
 * Redis 模块的端到端测试。
 *
 * 跑在普通 Chromium 上，驱动的是**浏览器版的假 Redis**（`services/web.ts`）。
 * 假实现是刻意做得足够真的：`SET a 1` 之后再 `GET a` 真的能拿回 `1`，
 * 所以这里断言的是「连接 → 执行 → 展示结果」这条完整链路，
 * 而不是对着写死的假数据自欺。
 *
 * 协议层的正确性不在这里 —— 那是 Rust 侧打真 redis-server 的集成测试的职责。
 */

import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/');
  await expect(page.getByTestId('app-shell')).toBeVisible();
  await page.getByTestId('module-redis').click();
  await expect(page.getByTestId('redis-console')).toBeVisible();
});

/** 新建一个连接并连上，返回后命令台就可以用了 */
async function connectNew(page: import('@playwright/test').Page): Promise<void> {
  await page.getByTestId('btn-new-connection').click();
  await expect(page.getByTestId('conn-name')).toHaveValue('新建连接');

  await page.getByTestId('btn-conn-toggle').click();
  await expect(page.getByTestId('conn-status')).toContainText('已连接');
}

/**
 * 敲一条命令并**等它跑完**。
 *
 * 必须等到跑完：命令是串行执行的，前一条还在飞的时候再敲一条会被直接丢掉
 * （`runCommand` 里的 running 守卫），不等的话测试会随机地少执行几条命令。
 * 判据是「回复行数 +1」—— 输入回显是同步写进去的，不能拿它当完成信号。
 */
async function run(page: import('@playwright/test').Page, command: string): Promise<void> {
  const finished = page.locator(
    '[data-testid="console-line"][data-kind="reply"], [data-testid="console-line"][data-kind="transport"]',
  );
  const before = await finished.count();

  await page.getByTestId('console-input').fill(command);
  await page.getByTestId('console-input').press('Enter');

  await expect(finished).toHaveCount(before + 1);
}

test('新建连接、连上、状态栏反映连接状态', async ({ page }) => {
  await expect(page.getByTestId('conn-list')).toContainText('还没有连接');

  await page.getByTestId('btn-new-connection').click();
  await expect(page.getByTestId('conn-list')).toContainText('新建连接');
  await expect(page.getByTestId('conn-status')).toContainText('未连接');

  await page.getByTestId('btn-conn-toggle').click();
  await expect(page.getByTestId('conn-status')).toContainText('已连接');
  // 连上之后状态栏会带上服务端信息
  await expect(page.getByTestId('conn-info')).toContainText('Redis 7');
});

test('执行命令并把结果渲染出来', async ({ page }) => {
  await connectNew(page);
  const output = page.getByTestId('console-output');

  await run(page, 'PING');
  await expect(output).toContainText('PONG');

  // 写进去再读回来 —— 这条才真正说明链路是通的（假 Redis 也是真存的）
  await run(page, 'SET greeting hello');
  await expect(output).toContainText('OK');

  await run(page, 'GET greeting');
  await expect(output).toContainText('"hello"');

  // 整数回复带 (integer) 前缀
  await run(page, 'DEL greeting');
  await expect(output).toContainText('(integer) 1');

  // 不存在的 key 是 nil
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

  // 关键：外壳的错误条不该出现
  await expect(page.getByTestId('error-banner')).toHaveCount(0);
  // 连接也没被这条错误弄坏
  await expect(page.getByTestId('conn-status')).toContainText('已连接');

  // 还能继续用
  await run(page, 'PING');
  await expect(output).toContainText('PONG');
});

test('↑ ↓ 回溯命令历史', async ({ page }) => {
  await connectNew(page);
  const input = page.getByTestId('console-input');

  await run(page, 'PING');
  await run(page, 'ECHO first');

  // 第一次 ↑ 拿到最新一条
  await input.press('ArrowUp');
  await expect(input).toHaveValue('ECHO first');

  // 再 ↑ 往前翻
  await input.press('ArrowUp');
  await expect(input).toHaveValue('PING');

  // ↓ 往回走
  await input.press('ArrowDown');
  await expect(input).toHaveValue('ECHO first');

  // 翻过最新一条就回到草稿
  await input.press('ArrowDown');
  await expect(input).toHaveValue('');
});

test('草稿不会被历史吃掉', async ({ page }) => {
  await connectNew(page);
  const input = page.getByTestId('console-input');

  await run(page, 'PING');

  // 敲半行命令，翻一下历史再翻回来
  await input.fill('GET half-typed');
  await input.press('ArrowUp');
  await expect(input).toHaveValue('PING');
  await input.press('ArrowDown');

  await expect(input).toHaveValue('GET half-typed');
});

/** 回显脱敏：AUTH 的密码不该被写进界面日志 */
test('AUTH 的密码在日志里被打码', async ({ page }) => {
  await connectNew(page);

  await run(page, 'AUTH my-super-secret');

  const output = page.getByTestId('console-output');
  await expect(output).toContainText('AUTH');
  await expect(output).not.toContainText('my-super-secret');
});

test('切到别的模块再切回来，连接和命令输出都还在', async ({ page }) => {
  await connectNew(page);
  await run(page, 'SET persist-me yes');
  await expect(page.getByTestId('console-output')).toContainText('OK');

  // 切走
  await page.getByTestId('module-diagram').click();
  await expect(page.getByTestId('canvas-svg')).toBeVisible();

  // 切回来 —— 模块状态是自己持有的，连接也没被断开
  await page.getByTestId('module-redis').click();
  await expect(page.getByTestId('conn-status')).toContainText('已连接');
  await expect(page.getByTestId('console-output')).toContainText('SET persist-me yes');

  // 连接真的还活着：数据还能读回来
  await run(page, 'GET persist-me');
  await expect(page.getByTestId('console-output')).toContainText('"yes"');
});

test('连不上时给出提示，并且不能执行命令', async ({ page }) => {
  await page.getByTestId('btn-new-connection').click();
  await page.getByTestId('conn-host').fill('unreachable.invalid');
  await page.getByTestId('btn-conn-toggle').click();

  // 失败提示出现在属性面板里
  await expect(page.getByTestId('conn-error')).toContainText('连接 Redis');
  await expect(page.getByTestId('conn-status')).toContainText('连接出错');

  // 没连上就不该能敲命令
  await expect(page.getByTestId('console-input')).toBeDisabled();
  await expect(page.getByTestId('btn-console-run')).toBeDisabled();
});

test('改了连接参数会提示要重连', async ({ page }) => {
  await connectNew(page);

  await page.getByTestId('conn-port').fill('6380');
  await expect(page.getByTestId('conn-stale')).toContainText('重新连接才生效');
});

test('删除连接会从列表里消失', async ({ page }) => {
  await connectNew(page);
  await expect(page.getByTestId('conn-list')).toContainText('新建连接');

  await page.getByTestId('btn-conn-delete').click();

  await expect(page.getByTestId('conn-list')).toContainText('还没有连接');
  await expect(page.getByTestId('conn-status')).toContainText('没有连接');
});

test('命令执行期间输入框禁用，跑完恢复', async ({ page }) => {
  await connectNew(page);
  const input = page.getByTestId('console-input');

  // DEBUG SLEEP 在假实现里是真等 —— 用它稳定地制造一个「执行中」的窗口
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

test('连接档案会写进本地存储，重开页面还在', async ({ page }) => {
  await page.getByTestId('btn-new-connection').click();
  await page.getByTestId('conn-name').fill('本地测试库');
  await page.getByTestId('conn-host').fill('127.0.0.1');
  await expect(page.getByTestId('conn-list')).toContainText('本地测试库');

  // 开一张**新的 page**（同一个浏览器上下文，所以 localStorage 是同一份），
  // 而不是 reload —— beforeEach 里的 addInitScript 会在每次导航时清掉 localStorage，
  // reload 会把要验证的东西一起清掉。
  const fresh = await page.context().newPage();
  await fresh.goto('/');
  await fresh.getByTestId('module-redis').click();

  await expect(fresh.getByTestId('conn-list')).toContainText('本地测试库');
  // 名字也跟着回来了，说明整个档案都落盘了
  await fresh.getByTestId('conn-list').getByText('本地测试库').click();
  await expect(fresh.getByTestId('conn-name')).toHaveValue('本地测试库');
});
