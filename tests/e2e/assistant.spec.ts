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

// ---------------------------------------------------------------------- 对话
//
// 浏览器版跑的是 `services/web.ts` 里那个假 agent —— 它按 prompt 里有没有
// 「写」字决定要不要走那条**需要审批**的路（真机上改文件和跑命令都要问）。
//
// ⚠️ 这里验不了真链路：真 `Channel`、真 HTTP、真钥匙串、真文件系统。
// 那几样列在 HANDOFF 的「e2e 覆盖不到的那一截」里，只能真机过。

/** 把助手调到「能发消息」：配一把 key、选一个目录。 */
async function readyToChat(page: Page): Promise<void> {
  await page.getByTestId('assistant-key-input').fill('sk-test');
  await page.getByTestId('assistant-key-save').click();
  await expect(page.getByTestId('assistant-key-status')).toContainText('已配置');

  await page.getByTestId('assistant-pick-workspace').click();
  await expect(page.getByTestId('assistant-workspace')).not.toHaveText('还没选目录');
}

test('⚠️ 发不出去的时候，把缺的每一样都列出来，并且一条条消失', async ({ page }) => {
  // ⚠️ 这条盯的是**最难查的那种失败**：发送按钮有好几个禁用条件，任何一个不满足
  // 都是「灰的、点了完全没反应」。界面上一个字都不说的话，用户只能得出
  // 「它坏了」这个结论 —— 而这个模块是拿来干活的，那等于它没用了。
  //
  // 所以空状态要把**所有**拦住它的原因摆出来（不是随便挑一个），
  // 而且解决掉一条就该少一条。
  const blockers = page.getByTestId('assistant-blockers');

  // 一上来：key 没配、目录没选 —— 两条都得说
  await expect(blockers).toContainText('工作目录');
  await expect(blockers).toContainText('API key');
  await expect(page.getByTestId('assistant-send')).toBeDisabled();

  // 配一把 key：清单少一条，但**没有**变成「能发了」
  await page.getByTestId('assistant-key-input').fill('sk-test');
  await page.getByTestId('assistant-key-save').click();
  await expect(blockers).not.toContainText('API key');
  await expect(blockers).toContainText('工作目录');
  await expect(page.getByTestId('assistant-send')).toBeDisabled();

  // 选了目录才清空 —— 这时候才真的能发
  await page.getByTestId('assistant-pick-workspace').click();
  await expect(blockers).toHaveCount(0);
  await page.getByTestId('assistant-input').fill('你好');
  await expect(page.getByTestId('assistant-send')).toBeEnabled();
});

test('发一句话：回复边跑边出，工具调用留痕', async ({ page }) => {
  await readyToChat(page);

  await page.getByTestId('assistant-input').fill('看看这个项目');
  await page.getByTestId('assistant-send').click();

  // 用户那条立刻上屏（不等网络）
  await expect(page.getByTestId('assistant-msg-user')).toContainText('看看这个项目');
  // 助手那段（假 agent 分两次吐：「我看看」「这个文件。」）
  await expect(page.getByTestId('assistant-msg-assistant').first()).toContainText('我看看');
  // 工具痕迹。只读的工具**不该**弹审批
  await expect(page.getByTestId('assistant-tool').first()).toContainText('读 a.txt');
  await expect(page.getByTestId('assistant-approval')).toHaveCount(0);
  // 跑完就不再有「正在跑」那一行
  await expect(page.getByTestId('assistant-running')).toHaveCount(0);
});

test('要改文件时先弹审批，允许之后才动手', async ({ page }) => {
  await readyToChat(page);

  await page.getByTestId('assistant-input').fill('帮我写一个文件');
  await page.getByTestId('assistant-send').click();

  const sheet = page.getByTestId('assistant-approval');
  await expect(sheet).toBeVisible();
  // 弹层上要写清**具体要动什么** —— 用户是照着这一行做决定的
  await expect(page.getByTestId('assistant-approval-what')).toContainText('out.txt');

  await page.getByTestId('assistant-approval-allow').click();
  await expect(sheet).toHaveCount(0);
  await expect(page.getByTestId('assistant-running')).toHaveCount(0);
});

test('拒绝：这一步不做了，但对话继续跑完', async ({ page }) => {
  await readyToChat(page);
  await page.getByTestId('assistant-input').fill('帮我写一个文件');
  await page.getByTestId('assistant-send').click();

  await page.getByTestId('assistant-approval-deny').click();
  await expect(page.getByTestId('assistant-approval')).toHaveCount(0);
  // ⚠️ 拒绝 ≠ 停止。停了的话模型连「那我换个法子」的机会都没有。
  await expect(page.getByTestId('assistant-running')).toHaveCount(0);
});

test('⚠️ 弹层里必须能「整个停掉」—— 它盖住了外面那个停止按钮', async ({ page }) => {
  // 审批**默认不超时**（它一直等）。弹层盖住主区域之后，如果里面没有停止，
  // 用户就只剩「允许」和「拒绝」两条路 —— 而「我不干了」是最正当的一种意图。
  await readyToChat(page);
  await page.getByTestId('assistant-input').fill('帮我写一个文件');
  await page.getByTestId('assistant-send').click();

  await expect(page.getByTestId('assistant-approval')).toBeVisible();
  await page.getByTestId('assistant-approval-stop').click();

  await expect(page.getByTestId('assistant-approval')).toHaveCount(0);
  await expect(page.getByTestId('assistant-running')).toHaveCount(0);
});

test('第二句接着上一句说 —— 不是每次都从零开始', async ({ page }) => {
  // ⚠️ 历史在 Rust 那边按 session 存（`AssistantRuntime::histories`）。
  // 不接的话每一句都是独立的问题，模型看不到上一句 —— 真机上症状是
  // 「它怎么不记得我刚才说的」。浏览器版的假 agent 把这件事变成了一句
  // 看得见的「（接着上面说）」。
  await readyToChat(page);

  await page.getByTestId('assistant-input').fill('第一句');
  await page.getByTestId('assistant-send').click();
  await expect(page.getByTestId('assistant-running')).toHaveCount(0);

  await page.getByTestId('assistant-input').fill('第二句');
  await page.getByTestId('assistant-send').click();
  await expect(page.getByTestId('assistant-msg-assistant').last()).toContainText(
    '接着上面说',
  );
});

test('清空之后是真的从零开始 —— 屏幕和模型一起清', async ({ page }) => {
  // ⚠️ 只清屏幕的话，界面上空了**而模型还记得** —— 下一句它接着说上一句的事，
  // 那比不清更让人困惑。所以「清空」要连 Rust 那边那个 session 一起换掉。
  await readyToChat(page);

  await page.getByTestId('assistant-input').fill('第一句');
  await page.getByTestId('assistant-send').click();
  await expect(page.getByTestId('assistant-running')).toHaveCount(0);

  await page.getByTestId('assistant-clear').click();
  await expect(page.getByTestId('assistant-stream')).toContainText('说点什么');

  await page.getByTestId('assistant-input').fill('清空之后的第一句');
  await page.getByTestId('assistant-send').click();

  // 先等回复真的出现（不然 `not.toContainText` 会在元素还不存在时空过）
  await expect(page.getByTestId('assistant-msg-assistant').last()).toContainText('我看看');
  await expect(page.getByTestId('assistant-msg-assistant').last()).not.toContainText(
    '接着上面说',
  );
});

test('等确认的时候图标栏上亮角标 —— 用户在别的模块里也看得见', async ({ page }) => {
  await readyToChat(page);
  await page.getByTestId('assistant-input').fill('帮我写一个文件');
  await page.getByTestId('assistant-send').click();

  await expect(page.getByTestId('assistant-approval')).toBeVisible();

  // 切走：这是关键 —— 弹层在主区域里，用户看不见了，角标是唯一剩下的提示
  await page.getByTestId('module-diagram').click();
  await expect(page.getByTestId('assistant-badge')).toBeVisible();
  await expect(page.getByTestId('assistant-badge')).toHaveAttribute(
    'data-reason',
    'waiting',
  );
});
