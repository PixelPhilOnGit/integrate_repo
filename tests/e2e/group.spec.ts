/**
 * 群组协作的端到端测试。
 *
 * 浏览器里跑的是 `services/web.ts` 的内存假实现 —— 它的事件顺序和真正
 * Rust 侧一字不差（`turnStarted → memberQueued… → memberStarted → memberText →
 * memberTool… → memberFinished → turnFinished`），所以这里验的是**界面链路**：
 * 建群、加成员、@ 路由、顺序/并行、工具行、停止、失败、切群/切模块。
 *
 * 真 CLI（claude / codex / csc）的行为归 Rust 的桩程序集成测试 + 真机清单。
 */

import { expect, test, type Page } from '@playwright/test';

/** 检查器默认折叠：要碰它里面的东西，先点开右边的把手 */
async function openInspector(page: Page): Promise<void> {
  const toggle = page.getByTestId('inspector-toggle');
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute('aria-pressed')) === 'false') {
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  }
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/');
  await expect(page.getByTestId('app-shell')).toBeVisible();
  await page.getByTestId('module-group').click();
  await expect(page.getByTestId('group-main')).toBeVisible();
});

async function createGroup(page: Page, name: string): Promise<void> {
  const empty = page.getByTestId('group-new-empty');
  if ((await empty.count()) > 0) await empty.click();
  else await page.getByTestId('group-new').click();

  await page.getByTestId('group-new-name').fill(name);
  await page.getByTestId('group-new-confirm').click();
  await expect(page.getByTestId('group-title')).toHaveText(name);
  // 建群会请出检查器（新群还没成员，这是最可能的下一步）
  await openInspector(page);
}

async function addMember(page: Page, name: string): Promise<void> {
  const cards = page.getByTestId('group-member-card');
  const before = await cards.count();
  await page.getByTestId('group-member-add').click();
  await expect(cards).toHaveCount(before + 1);

  const card = cards.last();
  const input = card.getByTestId('group-member-name');
  await input.fill(name);
  await input.blur();
  await expect(input).toHaveValue(name);
}

/** 建群 + 两个成员 + 选好共享工作目录。 */
async function readyGroup(page: Page, name = '评审群'): Promise<void> {
  await createGroup(page, name);
  await addMember(page, '甲');
  await addMember(page, '乙');

  await page.getByTestId('group-workspace-pick').click();
  await expect(page.getByTestId('group-workspace-path')).not.toHaveText('（未选择）');
}

async function send(page: Page, text: string): Promise<void> {
  await page.getByTestId('group-input').fill(text);
  await page.getByTestId('group-send').click();
}

async function waitIdle(page: Page): Promise<void> {
  await expect(page.getByTestId('group-running')).toHaveCount(0);
}

test('建群、加两个成员：不 @ 时全员回答，顺序模式下后来的能看到前面的', async ({ page }) => {
  await readyGroup(page);

  await send(page, '各自说说这个仓库');
  await expect(page.getByTestId('group-msg-user')).toContainText('各自说说这个仓库');
  await expect(page.getByTestId('group-msg-member')).toHaveCount(2);
  await waitIdle(page);

  const first = page.getByTestId('group-msg-member').nth(0);
  const second = page.getByTestId('group-msg-member').nth(1);
  await expect(first).toContainText('甲');
  await expect(second).toContainText('乙');
  // 「看到彼此」：第二个成员的回复里带第一个的发言片段
  await expect(second).toContainText('看到');
  await expect(second).toContainText('甲');
  // 工具行也渲染了，并且收尾成 ✓
  await expect(page.getByTestId('group-tool').first()).toContainText('✓');
});

test('并行模式：本轮互相看不到', async ({ page }) => {
  await readyGroup(page);
  await page.getByTestId('group-mode').selectOption('parallel');

  await send(page, '各说各的');
  await expect(page.getByTestId('group-msg-member')).toHaveCount(2);
  await waitIdle(page);

  await expect(page.getByTestId('group-msg-member').nth(1)).not.toContainText('看到');
});

test('@ 谁就只有谁回答', async ({ page }) => {
  await readyGroup(page);

  await send(page, '@乙 你来说说');
  await expect(page.getByTestId('group-msg-member')).toHaveCount(1);
  await waitIdle(page);
  await expect(page.getByTestId('group-msg-member').first()).toContainText('乙');
});

test('@ 未知成员：提示并禁止发送（不静默退化成全员）', async ({ page }) => {
  await readyGroup(page);

  await page.getByTestId('group-input').fill('@张三 你说');
  await expect(page.getByTestId('group-unknown-mention')).toContainText('@张三');
  await expect(page.getByTestId('group-send')).toBeDisabled();
  // 一个字都没发出去
  await expect(page.getByTestId('group-msg-user')).toHaveCount(0);
});

test('@ 候选面板：上下键选、回车写入、点击也能选', async ({ page }) => {
  await readyGroup(page);

  const input = page.getByTestId('group-input');
  await input.fill('@');
  const panel = page.getByTestId('group-mention-panel');
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('group-mention-item')).toHaveCount(2);

  // 上下键选择 + 回车
  await input.press('ArrowDown');
  await input.press('Enter');
  await expect(input).toHaveValue('@乙 ');
  await expect(panel).toHaveCount(0);

  // 点击选择（清空重来）
  await input.fill('@');
  await expect(panel).toBeVisible();
  await page.getByTestId('group-mention-item').first().click();
  await expect(input).toHaveValue('@甲 ');
});

test('成员状态：排队 → 完成（侧栏）', async ({ page }) => {
  await readyGroup(page);
  await send(page, '你好');
  await expect(page.getByTestId('group-msg-member')).toHaveCount(2);
  await waitIdle(page);

  const statuses = page.getByTestId('group-member-status');
  await expect(statuses).toHaveCount(2);
  await expect(statuses.nth(0)).toHaveAttribute('data-phase', 'done');
  await expect(statuses.nth(1)).toHaveAttribute('data-phase', 'done');
});

test('停止：这一轮收尾，成员标成已停止', async ({ page }) => {
  await readyGroup(page);
  await send(page, '慢慢说');
  // 假实现遇到「慢」会放慢节奏，来得及点停止
  await expect(page.getByTestId('group-running')).toBeVisible();
  await page.getByTestId('group-stop').click();
  await waitIdle(page);

  const phases = await page
    .getByTestId('group-member-status')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-phase')));
  expect(phases.every((p) => p === 'cancelled' || p === 'done')).toBe(true);
});

test('单个成员失败：其他成员照常完成，失败行有红字', async ({ page }) => {
  await readyGroup(page);

  await send(page, '失败一下');
  await expect(page.getByTestId('group-msg-member')).toHaveCount(2);
  await waitIdle(page);

  await expect(page.getByTestId('group-msg-error')).toHaveCount(1);
  await expect(page.getByTestId('group-msg-error')).toContainText('失败');
});

test('切模块再回来：时间线还在', async ({ page }) => {
  await readyGroup(page);
  await send(page, '留个记录');
  await expect(page.getByTestId('group-msg-member')).toHaveCount(2);
  await waitIdle(page);

  await page.getByTestId('module-tasks').click();
  await page.getByTestId('module-group').click();
  await expect(page.getByTestId('group-msg-user')).toContainText('留个记录');
  await expect(page.getByTestId('group-msg-member')).toHaveCount(2);
});

test('删除群：先确认，确认后回到空态', async ({ page }) => {
  await readyGroup(page);

  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByTestId('group-delete').click();

  await expect(page.getByTestId('group-new-empty')).toBeVisible();
  await expect(page.getByTestId('group-row')).toHaveCount(0);
});
