/**
 * 「场景」：业务数据的命名空间（今天团队 1、明天团队 2）。
 *
 * 浏览器版验证的正是分卷机制本身：KV 键后缀 → localStorage 的键带后缀 →
 * 切场景（写偏好 + 整窗重载）之后各模块读到的是各自那一份。真落盘的分卷
 * （任务库文件名、知识库目录）归 Rust 那组测试。
 */

import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  // ⚠️ 只在**第一次导航**清：这个 spec 的核心动作就是「切场景 = 整窗重载」
  // ——每跳一次都清的话，刚写下的场景名会被自己擦掉（第一版就这么挂的）
  await page.addInitScript(() => {
    if (sessionStorage.getItem('e2e-cleared') !== '1') {
      localStorage.clear();
      sessionStorage.setItem('e2e-cleared', '1');
    }
  });
  await page.goto('/');
  await expect(page.getByTestId('app-shell')).toBeVisible();
});

/** 在 redis 模块建一条连接（名字固定，方便断言） */
async function newRedisConnection(page: import('@playwright/test').Page, name: string): Promise<void> {
  await page.getByTestId('btn-new-connection').click();
  await page.getByTestId('redis-new-name').fill(name);
  await page.getByTestId('redis-new-confirm').click();
}

test('切场景 = 换一份数据；切回来原样（连接在默认、团队A 互不串）', async ({ page }) => {
  // 默认场景建一条
  await page.getByTestId('module-redis').click();
  await expect(page.getByTestId('redis-main')).toBeVisible();
  await newRedisConnection(page, '默认的连接');
  await expect(page.locator('[data-conn-name="默认的连接"]')).toHaveCount(1);

  // 新建场景「团队A」——建完直接切过去并重载
  await page.getByTestId('scenario-btn').click();
  await page.getByTestId('menu-新建场景…').click();
  await page.getByTestId('scenario-new-name').fill('团队A');
  await page.getByTestId('scenario-new-confirm').click();

  // 重载后：场景 chip 显示当前场景，redis 里是**空的**（另一份卷）
  await expect(page.getByTestId('app-shell')).toBeVisible();
  await expect(page.getByTestId('scenario-btn')).toContainText('团队A');
  await page.getByTestId('module-redis').click();
  await expect(page.getByTestId('redis-main')).toBeVisible();
  await expect(page.locator('[data-conn-name="默认的连接"]')).toHaveCount(0);

  // 在团队A 建一条（和默认同名，证明是两份独立的卷）
  await newRedisConnection(page, '默认的连接');
  await expect(page.locator('[data-conn-name="默认的连接"]')).toHaveCount(1);

  // 切回默认（切换有确认框）：默认那条还在，团队A 的看不到
  await page.getByTestId('scenario-btn').click();
  page.once('dialog', (d) => void d.accept());
  await page.getByTestId('menu-默认').click();
  await expect(page.getByTestId('app-shell')).toBeVisible();
  await expect(page.getByTestId('scenario-btn')).toContainText('默认');
  await page.getByTestId('module-redis').click();
  await expect(page.getByTestId('redis-main')).toBeVisible();
  await expect(page.locator('[data-conn-name="默认的连接"]')).toHaveCount(1); // 不是 2——两卷互不相加
});

test('场景菜单：当前场景有勾；同一个名字建两次会被拒', async ({ page }) => {
  await page.getByTestId('scenario-btn').click();
  // 默认场景是基线，在菜单里就该勾着
  await expect(page.getByTestId('menu-默认')).toBeVisible();
  await page.getByTestId('menu-新建场景…').click();
  await page.getByTestId('scenario-new-name').fill('团队A');
  await page.getByTestId('scenario-new-confirm').click();
  await expect(page.getByTestId('app-shell')).toBeVisible();
  await expect(page.getByTestId('scenario-btn')).toContainText('团队A');

  // 重名 → 拒绝（错误条，不重载）
  await page.getByTestId('scenario-btn').click();
  await page.getByTestId('menu-新建场景…').click();
  await page.getByTestId('scenario-new-name').fill('团队A');
  await page.getByTestId('scenario-new-confirm').click();
  await expect(page.getByTestId('error-banner')).toContainText('已经有了');
  await page.getByTestId('scenario-new-cancel').click();
});
