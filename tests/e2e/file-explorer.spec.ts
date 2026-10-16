/**
 * 智能体会话的「文件」标签（文件浏览器）。
 *
 * 浏览器版跑的是**虚拟工作区**（`devtoolkit.workspace.v1`）：`pickWorkspace`
 * 在浏览器里恒返回 `/工作区`，而 web 版的 `listDir` 忽略 root、永远读那棵树 ——
 * 所以这里种的树就是「工作目录的内容」。真列真磁盘的那半归 Rust 那组测试
 * （`core/tests/file_browser.rs`），预览上限/FIFO 那种也在那边。
 */

import { expect, test, type Page } from '@playwright/test';

interface VNode {
  name: string;
  kind: 'file' | 'dir';
  content?: string;
  children?: VNode[];
}

const dir = (name: string, children: VNode[] = []): VNode => ({ name, kind: 'dir', children });
const file = (name: string, content: string): VNode => ({ name, kind: 'file', content });

/** 种一棵虚拟工作区树（devtoolkit.workspace.v1 的形状照 web.ts 的 VNode） */
async function seedWorkspace(page: Page): Promise<void> {
  const tree: VNode = dir('', [
    dir('src', [file('app.ts', 'const answer = 42;\nexport default answer;')]),
    file('.env', 'SECRET=1'),
    file('logo.png', 'not-a-real-png'),
    file('README.md', '# 标题'),
  ]);
  await page.addInitScript((t) => {
    localStorage.setItem('devtoolkit.workspace.v1', JSON.stringify(t));
  }, tree);
}

/** 进 agents 模块、加一个工作目录，切到「文件」标签 */
async function openFilesTab(page: Page): Promise<void> {
  await page.getByTestId('module-agents').click();
  await page.getByTestId('agent-add-workspace-empty').click();
  await page.getByTestId('agent-tab-files').click();
  await expect(page.getByTestId('agent-explorer')).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
  await seedWorkspace(page);
  await page.goto('/');
  await expect(page.getByTestId('app-shell')).toBeVisible();
});

test('「文件」默认不展示，点了才出现（用户拍板的形态）', async ({ page }) => {
  await page.getByTestId('module-agents').click();
  await page.getByTestId('agent-add-workspace-empty').click();

  // 默认停在「会话」：文件面板**一点都看不到**
  await expect(page.getByTestId('agent-tab-session')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('agent-explorer')).toHaveCount(0);
  // 会话详情还在（老样子）
  await expect(page.getByTestId('agent-inspector')).toBeVisible();

  await page.getByTestId('agent-tab-files').click();
  await expect(page.getByTestId('agent-explorer')).toBeVisible();
  await expect(page.getByTestId('agent-tab-files')).toHaveAttribute('aria-selected', 'true');

  // 切回会话又收起来
  await page.getByTestId('agent-tab-session').click();
  await expect(page.getByTestId('agent-explorer')).toHaveCount(0);
});

test('树：目录在前、隐藏项也在；展开目录、点文件出预览', async ({ page }) => {
  await openFilesTab(page);

  const tree = page.getByTestId('agent-explorer-tree');
  const rows = tree.locator('.rd-tree-row');
  // 排序口径和 Rust 侧一致：目录在前 → 忽略大小写 → 原文（'.env' 在 logo 前）
  await expect(rows).toHaveText([/src/, /\.env/, /logo\.png/, /README\.md/]);

  // 展开 src → 懒加载出 app.ts
  await page.getByTestId('agent-dir-src').click();
  await expect(page.getByTestId('agent-file-src/app.ts')).toBeVisible();

  // 点文件 → 预览
  await page.getByTestId('agent-file-src/app.ts').click();
  await expect(page.getByTestId('agent-preview')).toContainText('const answer = 42;');
});

test('图片后缀给二进制提示（不假装能显示）', async ({ page }) => {
  await openFilesTab(page);
  await page.getByTestId('agent-file-logo.png').click();
  await expect(page.getByTestId('agent-preview-binary')).toBeVisible();
});

test('点刷新重列：在别处改了目录（比如 agent 刚写了文件）之后能看到', async ({ page }) => {
  await openFilesTab(page);
  await expect(page.getByTestId('agent-file-README.md')).toBeVisible();

  // 模拟「agent 在这期间写了个新文件」：直接改虚拟工作区
  await page.evaluate(() => {
    const key = 'devtoolkit.workspace.v1';
    const tree = JSON.parse(localStorage.getItem(key) ?? '{}') as VNode;
    tree.children?.push({ name: 'NEW.md', kind: 'file', content: '新来的' });
    localStorage.setItem(key, JSON.stringify(tree));
  });

  await page.getByTestId('agent-explorer-refresh').click();
  await expect(page.getByTestId('agent-file-NEW.md')).toBeVisible();
});

test('Ctrl+Shift+F 直接请出「文件」标签', async ({ page }) => {
  await page.getByTestId('module-agents').click();
  await page.getByTestId('agent-add-workspace-empty').click();
  await expect(page.getByTestId('agent-explorer')).toHaveCount(0);

  await page.keyboard.press('Control+Shift+F');
  await expect(page.getByTestId('agent-explorer')).toBeVisible();
});

test('点会话行（任何路径）把人带回「会话」标签', async ({ page }) => {
  await page.getByTestId('module-agents').click();
  await page.getByTestId('agent-add-workspace-empty').click();
  // 开一个会话再切到文件标签
  await page.getByTestId('agent-new-session-empty').click();
  await page.getByTestId('agent-tab-files').click();
  await expect(page.getByTestId('agent-explorer')).toBeVisible();

  // ⚠️ 侧栏里的会话行**默认收起**，先展开工作目录才能点到它
  const head = page.locator('[data-testid^="agent-ws-head-"]').first();
  const caret = head.getByRole('button', { name: '展开' });
  if ((await caret.count()) > 0) await caret.click();

  // 点一个**已经选中**的会话行也算 —— 用户同样是要看它
  await page.locator('[data-testid^="agent-session-"]').first().click();
  await expect(page.getByTestId('agent-tab-session')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('agent-explorer')).toHaveCount(0);
});
