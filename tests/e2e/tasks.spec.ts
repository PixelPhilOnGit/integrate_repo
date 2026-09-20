/**
 * 任务模块的端到端测试。
 *
 * 浏览器里跑的是 `services/web.ts` 那份内存假实现 —— 它和 Rust 那边**一个语义**
 * （patch 没提到的字段不动、标完成记时间、改回去清掉）。所以这一组验的是
 * **界面链路**：新建 → 编辑 → 改状态 → 搜 → 删。
 *
 * 验不了的（归 Rust 集成测试）：真落盘、结构迁移、并发写。
 */

import { expect, test, type Page } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('app-shell')).toBeVisible();
  await page.getByTestId('module-tasks').click();
  await expect(page.getByTestId('task-sidebar')).toBeVisible();
});

/** 侧栏里某一行的标题（按 id 选不稳，id 是随机生成的） */
function rows(page: Page) {
  return page.locator('[data-testid^="task-row-"]');
}

/** 建一条任务并把标题改成 `title`（标题框是自动聚焦的） */
async function newTask(page: Page, title: string): Promise<void> {
  await page.getByTestId('task-new').click();
  const titleBox = page.getByTestId('task-title');
  await expect(titleBox).toBeFocused(); // 新建之后光标就在标题上 —— 这是刻意的
  await titleBox.fill(title);
  await titleBox.press('Enter');
  await expect(rows(page).filter({ hasText: title })).toHaveCount(1);
}

test('记一条任务：新建 → 标题自动聚焦 → 改描述 → 标完成', async ({ page }) => {
  await expect(page.getByTestId('task-empty')).toBeVisible();

  await newTask(page, '写登录页');

  // 描述
  await page.getByTestId('task-body').fill('手机号 + 验证码，错误提示要具体');
  await page.getByTestId('task-body').blur();
  // 失焦之后存进了库 —— 再点回来读到的应该是刚写的那句
  await page.getByTestId('task-body').click();
  await expect(rows(page).first()).toHaveAttribute('data-task-status', 'todo');

  // 标完成
  await page.getByTestId('task-set-done').click();
  await expect(rows(page).first()).toHaveAttribute('data-task-status', 'done');
  await expect(page.getByTestId('task-done-at')).toBeVisible();

  // 改回进行中：那行「完成于」要消失（时间戳清了）
  await page.getByTestId('task-set-doing').click();
  await expect(rows(page).first()).toHaveAttribute('data-task-status', 'doing');
  await expect(page.getByTestId('task-done-at')).toHaveCount(0);
});

test('搜索：标题、描述、备注都搜得到，搜不到有提示和出口', async ({ page }) => {
  await newTask(page, '写登录页');
  await page.getByTestId('task-body').fill('要支持手机号');
  await page.getByTestId('task-body').blur();
  await newTask(page, '修连接池泄漏');
  await page.getByTestId('task-note').fill('是那个定时器没清');
  await page.getByTestId('task-note').blur();

  await expect(rows(page)).toHaveCount(2);

  // 搜标题
  await page.getByTestId('task-search').fill('登录');
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText('写登录页');

  // 搜描述（命中同一条）
  await page.getByTestId('task-search').fill('手机号');
  await expect(rows(page)).toHaveCount(1);

  // 搜备注（命中另一条）
  await page.getByTestId('task-search').fill('定时器');
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText('修连接池泄漏');

  // 搜不到：给提示 + 一个清筛选的出口
  await page.getByTestId('task-search').fill('根本没有这个词');
  await expect(page.getByTestId('task-nomatch')).toBeVisible();
  await expect(rows(page)).toHaveCount(0);

  await page.getByTestId('task-clear-filter').click();
  await expect(rows(page)).toHaveCount(2);
  await expect(page.getByTestId('task-search')).toHaveValue('');
});

test('状态筛选和搜索是「同时生效」，不是各算各的', async ({ page }) => {
  await newTask(page, '写登录页');
  await newTask(page, '修连接池泄漏');
  await page.getByTestId('task-set-done').click(); // 把当前这条（连接池）标完成

  await page.getByTestId('task-filter-done').click();
  await expect(rows(page)).toHaveCount(1);

  // 在「已完成」里搜一条待办的标题：**不该出现**
  await page.getByTestId('task-search').fill('登录');
  await expect(rows(page)).toHaveCount(0);

  await page.getByTestId('task-clear-filter').click();
  await expect(rows(page)).toHaveCount(2);
});

test('删除要确认；取消就不删', async ({ page }) => {
  await newTask(page, '别删我');
  await newTask(page, '删了吧');

  // 取消
  page.once('dialog', (d) => void d.dismiss());
  await page.getByTestId('task-delete').click();
  await expect(rows(page)).toHaveCount(2);

  // 确认
  page.once('dialog', (d) => void d.accept());
  await page.getByTestId('task-delete').click();
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText('别删我');
});

test('切到别的模块再回来，任务和筛选都还在', async ({ page }) => {
  await newTask(page, '跨模块还在');

  await page.getByTestId('module-redis').click();
  await expect(page.getByTestId('redis-main')).toBeVisible();
  await page.getByTestId('module-tasks').click();

  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText('跨模块还在');
});

test('图标栏角标数的是「还没做完的」', async ({ page }) => {
  await newTask(page, '一条待办');
  await expect(page.getByTestId('tasks-badge')).toHaveText('1');

  await newTask(page, '第二条');
  await expect(page.getByTestId('tasks-badge')).toHaveText('2');

  // 标完成之后角标退回去
  await page.getByTestId('task-set-done').click();
  await expect(page.getByTestId('tasks-badge')).toHaveText('1');
});

test('进度记录 + 归档：记几笔 → 归档 → 在归档档里连进度一起回顾', async ({ page }) => {
  // 用户的原话：「归档后最后回顾才能知道」—— 所以这条用例的重头戏是
  // **归档之后进度还在不在**
  await newTask(page, '重构连接池');

  await page.getByTestId('task-progress-input').fill('先看了一遍现有实现');
  await page.getByTestId('task-progress-add').click();
  await expect(page.getByTestId('task-progress-list')).toContainText('先看了一遍现有实现');

  // 回车也能记（连续记几笔时不该每次都去点按钮）
  await page.getByTestId('task-progress-input').fill('发现是定时器没清');
  await page.getByTestId('task-progress-input').press('Enter');
  await expect(page.getByTestId('task-progress-list')).toContainText('发现是定时器没清');
  // 记完输入框该空掉，接着记下一笔
  await expect(page.getByTestId('task-progress-input')).toHaveValue('');

  await page.getByTestId('task-set-done').click();
  await page.getByTestId('task-archive').click();

  // 常规列表里收起来了
  await expect(rows(page)).toHaveCount(0);
  await expect(page.getByTestId('task-filter-archived')).toBeVisible();

  // 归档那一档里能看到，**而且进度一笔不少**
  await page.getByTestId('task-filter-archived').click();
  await expect(rows(page)).toHaveCount(1);
  await rows(page).first().click();
  const timeline = page.getByTestId('task-progress-list');
  await expect(timeline).toContainText('先看了一遍现有实现');
  await expect(timeline).toContainText('发现是定时器没清');

  // 取消归档 → 回到常规列表
  await page.getByTestId('task-archive').click();
  await page.getByTestId('task-filter-all').click();
  await expect(rows(page)).toHaveCount(1);
});
