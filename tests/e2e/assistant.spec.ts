/**
 * 助手模块的端到端测试。
 *
 * 现在这个模块**只有配置是能用的**（对话那部分还没接），所以这一组验的就是
 * 配置这条链路：填 → 校验 → 保存 → 存 key。
 *
 * 浏览器里跑的是 `services/web.ts` 那份内存假实现 —— 它和 Rust 那边一个语义
 * （空 key = 删掉、两家的 key 分开、没配过和用不了是两件事）。
 *
 * ⚠️ **验不了的**：真钥匙串。浏览器里没有钥匙串，所以 `available` 恒为 false ——
 * 这一条本身也是要验的行为（界面必须**明说**，而不是假装存上了）。
 * 真钥匙串的读写要到 Windows / macOS 上手工过一次。
 */

import { expect, test, type Page } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/');
  await expect(page.getByTestId('app-shell')).toBeVisible();
  await page.getByTestId('module-assistant').click();
  await expect(page.getByTestId('assistant-inspector')).toBeVisible();
});

/** 当前显示的是哪一家 */
async function kind(page: Page): Promise<string> {
  return await page.getByTestId('assistant-kind').inputValue();
}

test('默认是 Anthropic，地址已经填好', async ({ page }) => {
  expect(await kind(page)).toBe('anthropic');
  await expect(page.getByTestId('assistant-base-url')).toHaveValue(
    'https://api.anthropic.com',
  );
  await expect(page.getByTestId('assistant-model')).not.toHaveValue('');
  // 没有配置问题 → 不该有错误行
  await expect(page.getByTestId('assistant-config-error')).toHaveCount(0);
});

test('切到 OpenAI 兼容：地址被清空，并且说清为什么必须自己填', async ({ page }) => {
  // ⚠️ OpenAI 兼容那一路**故意不给默认地址** —— DeepSeek / vLLM / 内网网关
  // 各不相同，预填一个只会让人以为请求该往那儿发。
  await page.getByTestId('assistant-kind').selectOption('openai');

  await expect(page.getByTestId('assistant-base-url')).toHaveValue('');
  await expect(page.getByTestId('assistant-kind-hint')).toContainText('自己填');
  // 空地址是要拦下来的
  await expect(page.getByTestId('assistant-config-error')).toContainText('没有默认值');
});

test('地址填错时给出能照着改的提示，并且存不下去', async ({ page }) => {
  await page.getByTestId('assistant-kind').selectOption('openai');
  await page.getByTestId('assistant-base-url').fill('api.deepseek.com');

  const err = page.getByTestId('assistant-config-error');
  await expect(err).toContainText('http');

  // 点保存也不该把它存下去：再切回来还是那份没保存的编辑值
  await page.getByTestId('assistant-save-config').click();
  await expect(err).toBeVisible();
  await expect(page.getByTestId('assistant-notice')).toHaveCount(0);
});

test('填齐之后能保存，按钮从「保存」变成「已保存」', async ({ page }) => {
  // ⚠️ 要真的改一个**不一样**的值：填回默认值的话配置没变、按钮不会亮，
  // 那样这个用例就在测一个没发生的事
  await page.getByTestId('assistant-model').fill('claude-sonnet-5');
  await expect(page.getByTestId('assistant-save-config')).toHaveText('保存');

  await page.getByTestId('assistant-save-config').click();

  await expect(page.getByTestId('assistant-save-config')).toHaveText('已保存');
  await expect(page.getByTestId('assistant-notice')).toContainText('已保存');
});

test('浏览器版明说没有钥匙串 —— 不能假装存上了', async ({ page }) => {
  // 「没配过」和「这台机器存不住」是两件事。这里验的是后者**被说出来**了。
  await expect(page.getByTestId('assistant-no-keychain')).toBeVisible();
  await expect(page.getByTestId('assistant-key-status')).toContainText('没有钥匙串');
});

test('存 key → 显示已配置 → 换一把 → 删除', async ({ page }) => {
  await expect(page.getByTestId('assistant-key-status')).toHaveText(/还没配|没配/);

  await page.getByTestId('assistant-key-input').fill('sk-test-123');
  await page.getByTestId('assistant-key-save').click();
  await expect(page.getByTestId('assistant-key-status')).toContainText('已配置');

  // 存过之后输入框就不该再摆在那儿（key 不该留在屏幕上）
  await expect(page.getByTestId('assistant-key-input')).toHaveCount(0);

  // 换一把：输入框回来，可以取消
  await page.getByTestId('assistant-key-replace').click();
  await expect(page.getByTestId('assistant-key-input')).toBeVisible();
  await page.getByTestId('assistant-key-cancel').click();
  await expect(page.getByTestId('assistant-key-input')).toHaveCount(0);
  await expect(page.getByTestId('assistant-key-status')).toContainText('已配置');

  // 删除
  await page.getByTestId('assistant-key-clear').click();
  await expect(page.getByTestId('assistant-key-status')).toContainText('没配');
});

test('两家的 key 分开：换了提供方，状态跟着变', async ({ page }) => {
  // ⚠️ 共用一条的话，来回切会互相覆盖 —— 症状是「我明明填过，怎么又要填」。
  await page.getByTestId('assistant-key-input').fill('sk-ant');
  await page.getByTestId('assistant-key-save').click();
  await expect(page.getByTestId('assistant-key-status')).toContainText('已配置');

  await page.getByTestId('assistant-kind').selectOption('openai');
  // 换成 openai 之后是**另一条凭据**，还没配
  await expect(page.getByTestId('assistant-key-status')).toHaveText(/还没配|没配/);

  await page.getByTestId('assistant-kind').selectOption('anthropic');
  // 切回来，anthropic 那把还在
  await expect(page.getByTestId('assistant-key-status')).toContainText('已配置');
});

test('没配 key 时角标亮着 —— 用户在别的模块里也看得见', async ({ page }) => {
  await expect(page.getByTestId('assistant-badge')).toBeVisible();

  await page.getByTestId('assistant-key-input').fill('sk-test');
  await page.getByTestId('assistant-key-save').click();

  await expect(page.getByTestId('assistant-badge')).toHaveCount(0);
});
