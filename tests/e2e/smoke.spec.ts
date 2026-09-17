import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  // 每个用例从干净的虚拟工作区开始
  await page.addInitScript(() => {
    window.localStorage.clear();
  });
  await page.goto('/');
});

test('应用能加载，并且自动打开工作区里的第一张图', async ({ page }) => {
  await expect(page.getByTestId('canvas-svg')).toBeVisible();
  // 种子工作区里有一张「示例」图，应当被自动打开
  await expect(page.getByTestId('status-text')).toHaveText('');
  await expect(page.getByTestId('file-tree')).toBeVisible();
  await expect(page.getByTestId('inspector')).toBeVisible();

  // 画布上应该真的画出了参与者
  await expect(page.locator('[data-participant-id]')).toHaveCount(2);

  await page.screenshot({ path: 'test-results/01-initial.png' });
});

test('内置示例图能完整渲染出各种消息类型', async ({ page }) => {
  // 用工具栏加一条同步消息，验证基本闭环
  await page.getByTestId('btn-add-sync').click();
  await expect(page.locator('[data-message-id]')).toHaveCount(1);

  await page.screenshot({ path: 'test-results/02-first-message.png' });
});
