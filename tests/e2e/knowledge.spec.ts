/**
 * 知识库模块的 e2e（跑在浏览器假实现上，见 services/web.ts）。
 *
 * 覆盖「文件是真相」这套形态在界面上的可观测行为：卡片墙/阅读器/评审工作流/
 * 搜索/生成/删来源的两种语义。真落盘、真提取、真 CLI 归 Rust 那组测试
 * （`src-tauri/knowledge/`），这里不假装测过它们。
 */

import { expect, test, type Page } from '@playwright/test';

async function enterKnowledge(page: Page): Promise<void> {
  await page.getByTestId('module-knowledge').click();
  await expect(page.getByTestId('kb-sidebar')).toBeVisible();
  await expect(page.getByTestId('kb-wall')).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/');
  await expect(page.getByTestId('app-shell')).toBeVisible();
});

test('种子库：卡片墙、筛选计数、归档单独一档', async ({ page }) => {
  await enterKnowledge(page);

  // 全部 = 未归档的两张；旧笔记在归档档里
  await expect(page.getByTestId('kb-wall-登录流程.md')).toBeVisible();
  await expect(page.getByTestId('kb-wall-架构备忘.md')).toBeVisible();
  await expect(page.getByTestId('kb-wall-旧笔记.md')).toHaveCount(0);

  await page.getByTestId('kb-filter-archived').click();
  await expect(page.getByTestId('kb-wall-旧笔记.md')).toBeVisible();
  await page.getByTestId('kb-filter-all').click();
  await expect(page.getByTestId('kb-wall-登录流程.md')).toBeVisible();
});

test('阅读器：markdown 渲染（wikilink/内嵌图片）＋ seq 围栏画成图', async ({ page }) => {
  await enterKnowledge(page);

  // 登录流程卡里有 seq 围栏 → 画成真的顺序图（只读）
  await page.getByTestId('kb-wall-登录流程.md').click();
  await expect(page.getByTestId('kb-reader')).toBeVisible();
  await expect(page.getByTestId('kb-seq')).toBeVisible();
  await expect(page.getByTestId('kb-md')).toContainText('客户端拿到 token');

  // 架构备忘：wikilink 跳卡、断链样式、图片角标
  await page.getByTestId('kb-back').click();
  await page.getByTestId('kb-wall-架构备忘.md').click();
  await expect(page.getByTestId('kb-md')).toContainText('服务端不存明文');
  await expect(page.getByTestId('kb-image-架构图.png')).toBeVisible();

  // 存在的目标：点了跳过去（阅读器换成了目标卡片）
  await page.getByTestId('kb-wiki-登录流程').click();
  await expect(page.getByTestId('kb-reader-title')).toHaveText('登录流程');
});

test('评审工作流：标为已评审 → 自动跳下一张未评审', async ({ page }) => {
  await enterKnowledge(page);

  // 先造出两张未评审：挂资料 + 生成
  await page.getByTestId('kb-source-add').click();
  await expect(page.getByTestId('kb-source-_sources/示例资料1.md')).toBeVisible();
  await page.getByTestId('kb-generate-_sources/示例资料1.md').click();
  await page.getByTestId('kb-gen-start').click();
  await expect(page.getByTestId('kb-gen-done')).toBeVisible();

  // 未评审 = 两张生成的 + 登录流程。可见序是「未评审在前、新的在前」，
  // 所以点第一张生成的（它后面还有一张《续》）——评审后应该自动跳过去
  await page.getByTestId('kb-wall-整理：示例资料1.md').click();
  await page.getByTestId('kb-review-next').click();
  await expect(page.getByTestId('kb-reader-title')).toHaveText('整理：示例资料1（续）');
});

test('搜索下推到库搜索_清空恢复', async ({ page }) => {
  await enterKnowledge(page);
  await page.getByTestId('kb-search').fill('架构图');
  // 去抖 250ms
  await expect(page.getByTestId('kb-wall-架构备忘.md')).toBeVisible();
  await expect(page.getByTestId('kb-wall-登录流程.md')).toHaveCount(0);

  await page.getByTestId('kb-search').fill('');
  await expect(page.getByTestId('kb-wall-登录流程.md')).toBeVisible();
});

test('生成：进度面板有现场_新卡入墙未评审', async ({ page }) => {
  await enterKnowledge(page);
  await page.getByTestId('kb-source-add').click();
  await page.getByTestId('kb-generate-_sources/示例资料1.md').click();

  // 假生成器只有 claude 装（codex 键禁用 —— 「没装的键别能点」）
  await expect(page.locator('[data-testid="kb-gen-cli"] input[value="codex"]')).toBeDisabled();
  await page.getByTestId('kb-gen-note').fill('重点提取接口约定');
  await page.getByTestId('kb-gen-start').click();

  await expect(page.getByTestId('kb-gen-notes')).toContainText('按你的要求整理：重点提取接口约定');
  await expect(page.getByTestId('kb-gen-done')).toContainText('写了 2 张卡片');
  await expect(page.getByTestId('kb-status-unreviewed')).toContainText('3 张待评审');
  await page.getByTestId('kb-gen-dismiss').click();
  await expect(page.getByTestId('kb-wall-整理：示例资料1.md')).toBeVisible();
});

test('删来源：保留卡片=断链；连带=卡片一起走（强确认）', async ({ page }) => {
  await enterKnowledge(page);
  await page.getByTestId('kb-source-add').click();
  await page.getByTestId('kb-generate-_sources/示例资料1.md').click();
  await page.getByTestId('kb-gen-start').click();
  await expect(page.getByTestId('kb-gen-done')).toBeVisible();
  await page.getByTestId('kb-gen-dismiss').click();

  // ① 保留卡片：来源没了，卡片还在（链接断开）
  page.once('dialog', (d) => void d.accept()); // 「保留卡片」的确认
  await page.getByTestId('kb-source-menu-_sources/示例资料1.md').click();
  await page.getByTestId('menu-删除这份资料（保留卡片）').click();
  await expect(page.getByTestId('kb-source-_sources/示例资料1.md')).toHaveCount(0);
  await expect(page.getByTestId('kb-wall-整理：示例资料1.md')).toBeVisible();

  // ② 再来一轮、这次连带删。注意假实现的编号按当前数量算 —— 删完又是
  // 「示例资料1」（rel 同名是刻意的：正好压一压同名去重那条路）
  await page.getByTestId('kb-source-add').click();
  await page.getByTestId('kb-generate-_sources/示例资料1.md').click();
  await page.getByTestId('kb-gen-start').click();
  await expect(page.getByTestId('kb-gen-done')).toBeVisible();
  await page.getByTestId('kb-gen-dismiss').click();

  // 新一轮的两张卡因为重名去了序号（和 Rust 的 unique_card_rel 同口径）
  await expect(page.getByTestId('kb-wall-整理：示例资料1 (2).md')).toBeVisible();

  page.once('dialog', (d) => void d.accept());
  await page.getByTestId('kb-source-menu-_sources/示例资料1.md').click();
  await page.getByTestId('menu-连生成的卡片一起删…').click();
  // 连带走的是**引用这份来源的**卡片：第二轮的两张没了，第一轮断链的那张留着
  await expect(page.getByTestId('kb-wall-整理：示例资料1 (2).md')).toHaveCount(0);
  await expect(page.getByTestId('kb-wall-整理：示例资料1.md')).toBeVisible();
});

test('新建知识库：空库空态、切库互不串', async ({ page }) => {
  await enterKnowledge(page);
  await page.getByTestId('kb-new-vault').click();
  await page.getByTestId('kb-new-vault-name').fill('团队A');
  await page.getByTestId('kb-new-vault-confirm').click();

  // 新库空态
  await expect(page.getByTestId('kb-wall-empty')).toBeVisible();
  // 切回示例库内容还在（隔离）
  await page.getByTestId('kb-vault-select').selectOption('示例库');
  await expect(page.getByTestId('kb-wall-登录流程.md')).toBeVisible();
});

test('卡片图片：内嵌显示、点击放大、Esc 关闭、断链回落角标', async ({ page }) => {
  await enterKnowledge(page);
  await page.getByTestId('kb-wall-架构备忘.md').click();

  // 种子库里 `_files/架构图.png` 有真字节 → 内嵌 <img>（blob URL）
  const image = page.getByTestId('kb-image-架构图.png');
  await expect(image).toHaveAttribute('data-state', 'ready');
  await expect(image).toHaveAttribute('src', /^blob:/);

  // 点击放大 → 灯箱
  await image.click();
  const lightbox = page.getByTestId('kb-image-lightbox');
  await expect(lightbox).toBeVisible();

  // 放大 / 缩小 / 复位（用户要求「也要能放大缩小」）
  const big = page.getByTestId('kb-image-lightbox-img');
  await expect(big).toHaveAttribute('data-scale', '1');
  await page.getByTestId('kb-image-lightbox-zoom-in').click();
  await expect(big).toHaveAttribute('data-scale', '1.25');
  await page.getByTestId('kb-image-lightbox-zoom-out').click();
  await expect(big).toHaveAttribute('data-scale', '1');
  await page.getByTestId('kb-image-lightbox-zoom-in').click();
  await page.getByTestId('kb-image-lightbox-reset').click();
  await expect(big).toHaveAttribute('data-scale', '1');

  // Esc 关闭
  await page.keyboard.press('Escape');
  await expect(lightbox).toHaveCount(0);

  // 找不到的图片：回落成文字角标（data-state=error），阅读器不炸
  const missing = page.getByTestId('kb-image-缺失图.png');
  await expect(missing).toHaveAttribute('data-state', 'error');
  await expect(missing).toContainText('[图片]');
});

test('多选资料：默认勾当前、全选后综合生成、阅读器显示两个来源', async ({ page }) => {
  await enterKnowledge(page);
  await page.getByTestId('kb-source-add').click();
  await page.getByTestId('kb-source-add').click();
  await expect(page.getByTestId('kb-source-_sources/示例资料2.md')).toBeVisible();

  await page.getByTestId('kb-generate-_sources/示例资料1.md').click();
  const first = page
    .getByTestId('kb-gen-source-_sources/示例资料1.md')
    .locator('input');
  const second = page
    .getByTestId('kb-gen-source-_sources/示例资料2.md')
    .locator('input');
  // 默认只勾「点进来的那一份」
  await expect(first).toBeChecked();
  await expect(second).not.toBeChecked();

  await page.getByTestId('kb-gen-select-all').click();
  await expect(second).toBeChecked();
  await page.getByTestId('kb-gen-start').click();
  await expect(page.getByTestId('kb-gen-done')).toContainText('写了 2 张卡片');
  await page.getByTestId('kb-gen-dismiss').click();

  // 多份资料的卡：标题带「综合 N 份资料」，阅读器 meta 列出两个来源
  await page.getByTestId('kb-wall-整理：综合 2 份资料.md').click();
  const sources = page.getByTestId('kb-reader-sources');
  await expect(sources).toContainText('示例资料1.md');
  await expect(sources).toContainText('示例资料2.md');
});

test('来源菜单：重新提取图片（旧资料升级路径）并给出结果', async ({ page }) => {
  await enterKnowledge(page);
  await page.getByTestId('kb-source-add').click();
  await expect(page.getByTestId('kb-source-_sources/示例资料1.md')).toBeVisible();

  await page.getByTestId('kb-source-menu-_sources/示例资料1.md').click();
  await page.getByTestId('menu-重新提取图片').click();

  // 假实现里每份来源都有一张图 → 状态栏说清结果
  await expect(page.getByTestId('status-text')).toContainText('重新提取完成');
});
