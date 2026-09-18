/**
 * 外壳的测试：模块注册、切换、状态隔离。
 *
 * 这一组不测任何具体模块的功能，测的是**外壳与模块之间的契约**：
 * 图标栏能不能列出模块、切换能不能生效、切走再切回模块状态还在不在。
 *
 * 最后一条是关键 —— 它验证的是"每个模块自己持有状态、外壳不掺和"这个设计
 * 真的成立。如果哪天有人把模块状态塞进外壳，这条会立刻挂。
 */

import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/');
  // 等外壳就绪（不再是"等画布可见" —— 画布只是顺序图模块的一部分）
  await expect(page.getByTestId('app-shell')).toBeVisible();
  await expect(page.getByTestId('canvas-svg')).toBeVisible();
});

test('图标栏列出所有注册的模块', async ({ page }) => {
  const rail = page.getByTestId('module-rail');
  await expect(rail).toBeVisible();

  // 有几个模块就有几个图标
  await expect(rail.getByRole('tab')).toHaveCount(5);
  await expect(page.getByTestId('module-diagram')).toBeVisible();
  await expect(page.getByTestId('module-redis')).toBeVisible();
  await expect(page.getByTestId('module-sql')).toBeVisible();
  await expect(page.getByTestId('module-ssh')).toBeVisible();
  await expect(page.getByTestId('module-devplaceholder')).toBeVisible();
});

test('点图标切换模块，主区域换成对应模块的内容', async ({ page }) => {
  // 一开始在顺序图模块
  await expect(page.getByTestId('canvas-svg')).toBeVisible();
  await expect(page.getByTestId('placeholder-main')).toHaveCount(0);

  await page.getByTestId('module-devplaceholder').click();

  await expect(page.getByTestId('placeholder-main')).toBeVisible();
  // 顺序图的东西整个不在了
  await expect(page.getByTestId('canvas-svg')).toHaveCount(0);
  await expect(page.getByTestId('file-tree')).toHaveCount(0);

  await page.getByTestId('module-diagram').click();
  await expect(page.getByTestId('canvas-svg')).toBeVisible();
});

test('当前模块在图标栏上有选中标记', async ({ page }) => {
  await expect(page.getByTestId('module-diagram')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('module-devplaceholder')).toHaveAttribute('aria-selected', 'false');

  await page.getByTestId('module-devplaceholder').click();

  await expect(page.getByTestId('module-devplaceholder')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('module-diagram')).toHaveAttribute('aria-selected', 'false');
});

test('Ctrl+1..5 也能切换模块', async ({ page }) => {
  // 序号就是注册表里的顺序
  await page.keyboard.press('Control+2');
  // 认主区的根节点，不是命令台 —— 命令台只是 Redis 模块里的一个页签
  await expect(page.getByTestId('redis-main')).toBeVisible();

  await page.keyboard.press('Control+3');
  await expect(page.getByTestId('sql-main')).toBeVisible();

  await page.keyboard.press('Control+4');
  await expect(page.getByTestId('ssh-main')).toBeVisible();

  await page.keyboard.press('Control+5');
  await expect(page.getByTestId('placeholder-main')).toBeVisible();

  await page.keyboard.press('Control+1');
  await expect(page.getByTestId('canvas-svg')).toBeVisible();
});

test('切走再切回，模块自己的状态不丢（架构关键）', async ({ page }) => {
  // 在顺序图里画一条消息
  await page.getByTestId('btn-add-sync').click();
  await expect(page.locator('[data-message-id]')).toHaveCount(1);
  await page.locator('[data-message-id]').first().click();
  await page.getByTestId('message-label').fill('切模块前写的');

  // 切到别的模块
  await page.getByTestId('module-devplaceholder').click();
  await expect(page.getByTestId('placeholder-main')).toBeVisible();

  // 切回来
  await page.getByTestId('module-diagram').click();

  // 消息还在，文字也在 —— 说明模块状态是自己持有的，没被切换清掉
  await expect(page.locator('[data-message-id]')).toHaveCount(1);
  await expect(page.locator('.rd-message-label').first()).toContainText('切模块前写的');
});

test('切换模块会清掉上一个模块留下的状态文字', async ({ page }) => {
  // 新建一张图，状态栏会显示"已新建 ..."
  await page.getByTestId('btn-new-diagram').click();
  await expect(page.getByTestId('status-text')).toContainText('已新建');

  await page.getByTestId('module-devplaceholder').click();

  // 新模块不该挂着上一条不相干的消息
  await expect(page.getByTestId('status-text')).toHaveText('');
  // 状态栏右侧属于模块的那部分也跟着换了
  await expect(page.getByTestId('current-path')).toHaveCount(0);
});

test('模块报的错显示在外壳的错误条里', async ({ page }) => {
  // 触发一个真实的错误：把新建的图改名成已存在的名字
  await page.getByTestId('btn-new-diagram').click();
  const row = page.getByTestId('tree-file-未命名.seq.json');
  await expect(row).toBeVisible();

  await row.click({ button: 'right' });
  await page.getByTestId('menu-重命名').click();
  await page.getByLabel('重命名').fill('示例');
  await page.keyboard.press('Enter');

  // 错误由模块报给外壳，外壳统一显示
  await expect(page.getByTestId('error-banner')).toBeVisible();
  await expect(page.getByTestId('error-banner')).toContainText('已存在');

  // 关掉之后错误条消失
  await page.getByTestId('error-banner').getByRole('button').click();
  await expect(page.getByTestId('error-banner')).toHaveCount(0);
});
