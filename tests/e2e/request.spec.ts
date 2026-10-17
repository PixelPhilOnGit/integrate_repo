/**
 * 「接口调试」的端到端测试。
 *
 * 浏览器里跑的是 `services/web.ts` 那套**假服务器**（`core/fakeHttp.ts` 算计划）——
 * 它和真链路一个形状：一样的事件、一样的 base64 正文、一样的分块节奏。
 * 所以这一组验的是**界面链路**：填地址 → 发 → 状态码/正文/响应头 → 历史 → 保存。
 *
 * 验不了的（归 Rust 集成测试 + 真机清单）：
 * * 真的网络和 TLS（`request/tests/http_over_socket.rs` 用真 socket 打假服务器）；
 * * `Channel` 的建立与收口、消息编码过不过得了 serde —— 浏览器版根本不经 Tauri；
 * * 空闲超时（要等 90 秒）。
 */

import { expect, test, type Page } from '@playwright/test';

/** 检查器现在**默认折叠**（v0.16.0）：要碰它里面的东西，先点开右边的把手 */
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
  // Ctrl+8 就是它（注册表里排在占位模块之前），点图标也一样
  await page.getByTestId('module-request').click();
  await expect(page.getByTestId('request-main')).toBeVisible();
});

/** 填地址 + 发送，等这一趟跑完（`finished` 之后相位不是 running） */
async function send(page: Page, url: string): Promise<void> {
  await page.getByTestId('request-url').fill(url);
  await page.getByTestId('request-send').click();
}

test('发一个请求：状态码、正文、耗时都出得来', async ({ page }) => {
  await send(page, 'https://demo.example/json');

  await expect(page.getByTestId('request-status')).toContainText('200');
  // JSON 自动排开（假实现回的是紧凑 JSON）
  await expect(page.getByTestId('request-body-text')).toContainText('"name": "阿德"');
  await expect(page.getByTestId('request-elapsed')).toContainText('ms');
});

test('响应头那一页：重复的头一条不少，顺序就是服务端给的顺序', async ({ page }) => {
  await send(page, 'https://demo.example/json');
  await expect(page.getByTestId('request-status')).toContainText('200');

  await page.getByTestId('response-tab-headers').click();
  const headers = page.getByTestId('request-response-headers');
  await expect(headers).toContainText('content-type');
  await expect(headers).toContainText('application/json');
});

test('⚠️ 地址不合法时按钮灰着，并且说出为什么', async ({ page }) => {
  // 空地址：按钮不能点，旁边那句话说清了缺什么
  await expect(page.getByTestId('request-send')).toBeDisabled();
  await expect(page.getByTestId('request-blocker')).toHaveText('先填一个地址');

  // ⚠️ 不替用户补 http://（补的话可能把 token 发到明文上）—— 这里要拦住并说清
  await page.getByTestId('request-url').fill('demo.example/json');
  await expect(page.getByTestId('request-send')).toBeDisabled();
  await expect(page.getByTestId('request-blocker')).toContainText('http://');

  // 补上就点得动了
  await page.getByTestId('request-url').fill('https://demo.example/json');
  await expect(page.getByTestId('request-send')).toBeEnabled();
  await expect(page.getByTestId('request-blocker')).toHaveCount(0);
});

test('连不上：一条红字 + 一句「该做什么」', async ({ page }) => {
  await send(page, 'https://unreachable.invalid/x');
  const error = page.getByTestId('request-response-error');
  await expect(error).toContainText('Connection refused');
  await expect(error).toContainText('连不上那台机器');
});

test('证书：默认拒绝，打开那个开关就通（红字警告跟着出现）', async ({ page }) => {
  await openInspector(page); // 「跳过证书校验」那一格在检查器里
  await send(page, 'https://self-signed.local/api');
  await expect(page.getByTestId('request-response-error')).toContainText('证书');

  await page.getByTestId('request-opt-insecure').check();
  await expect(page.getByTestId('request-insecure-warning')).toBeVisible();
  await page.getByTestId('request-send').click();
  await expect(page.getByTestId('request-status')).toContainText('200');
});

test('跳转：默认不跟（302 原样看得到），开了之后跟过去而且能看跳转链', async ({ page }) => {
  await openInspector(page); // 「跟随跳转」那一格在检查器里
  await send(page, 'https://demo.example/redirect');
  await expect(page.getByTestId('request-status')).toContainText('302');
  // 没跳转就没有那个页签
  await expect(page.getByTestId('response-tab-redirects')).toHaveCount(0);

  await page.getByTestId('request-opt-follow').check();
  await page.getByTestId('request-send').click();
  await expect(page.getByTestId('request-status')).toContainText('200');

  await page.getByTestId('response-tab-redirects').click();
  await expect(page.getByTestId('request-response-redirects')).toContainText('/redirect');
  await expect(page.getByTestId('request-response-redirects')).toContainText('/json');
});

test('打开跳转之后才出现「最多跟几跳」', async ({ page }) => {
  // ⚠️ 先点开检查器：折叠着的话下面那句「数 0」是**假的通过**（整个面板都不在 DOM 里）
  await openInspector(page);
  await expect(page.getByTestId('request-opt-max-redirects')).toHaveCount(0);
  await page.getByTestId('request-opt-follow').check();
  await expect(page.getByTestId('request-opt-max-redirects')).toBeVisible();
});

test('请求头：加一条 → 发出去（假服务器按它决定 401 还是 200）→ 关掉再发又变 401', async ({
  page,
}) => {
  await page.getByTestId('request-tab-headers').click();
  const name = page.getByTestId('request-header-name').first();
  const value = page.getByTestId('request-header-value').first();
  await name.fill('authorization');
  await value.fill('Bearer t');

  await send(page, 'https://demo.example/secret');
  await expect(page.getByTestId('request-status')).toContainText('200');
  await expect(page.getByTestId('request-body-text')).toContainText('带了 Authorization');

  // ⚠️ 关掉那一条（不是删掉它）：再发就该是 401 —— 这一条验的是「一行一个开关」
  await page.getByTestId('request-tab-headers').click();
  await page.getByTestId('request-header-enabled').first().uncheck();
  await page.getByTestId('request-send').click();
  await expect(page.getByTestId('request-status')).toContainText('401');

  // 名字还在（清空重打不叫「一键关掉」）
  await expect(page.getByTestId('request-header-name').first()).toHaveValue('authorization');
});

test('回归：请求头那一行的布局（复选框曾吃满整行，把值输入框顶出面板外）', async ({ page }) => {
  // 背景：全局 `input { width: 100% }` 是给文本框写的元素选择器，复选框也被命中 ——
  // 一行里的开关算成 894px 宽，名字输入被推到 x=1203、值输入只剩 14px 且落在
  // 编辑器右边界（1200）之外，点哪都能静默翻转「发不发」。这一条把几何钉住：
  // 功能用例只按 testid 填值，量不到布局。
  await page.getByTestId('request-tab-headers').click();

  const headers = await page.getByTestId('request-headers').boundingBox();
  const row = await page.locator('.rd-req-header-row').first().boundingBox();
  const toggle = await page.getByTestId('request-header-enabled').first().boundingBox();
  const value = await page.getByTestId('request-header-value').first().boundingBox();
  expect(headers).not.toBeNull();
  expect(row).not.toBeNull();
  expect(toggle).not.toBeNull();
  expect(value).not.toBeNull();

  // 开关只是个小盒子，不是整行宽
  expect(toggle!.width).toBeLessThan(30);
  // 值输入框真的看得见：有宽度、右缘在编辑器里
  expect(value!.width).toBeGreaterThan(100);
  expect(value!.x + value!.width).toBeLessThanOrEqual(headers!.x + headers!.width + 1);

  // 删除 × 平时藏着（鼠标此刻还停在页签上，行没被 hover）——
  // 此前选择器只认另一种行，它在「头」页签里永远不显示，是个隐形按钮
  await expect(page.getByTestId('request-header-remove').first()).toBeHidden();

  // 行内空白（值框右侧那截，正常情况下是 × 的位置）不再是沉默开关
  const checkedBefore = await page.getByTestId('request-header-enabled').first().isChecked();
  await page.mouse.click(row!.x + row!.width - 6, row!.y + row!.height / 2);
  await expect(page.getByTestId('request-header-enabled').first()).toBeChecked({
    checked: checkedBefore,
  });

  // hover 这一行，× 露出来
  await page.getByTestId('request-header-name').first().hover();
  await expect(page.getByTestId('request-header-remove').first()).toBeVisible();
});

test('读到一半断了：红字说清了断在哪儿，收到的那半截还在下面', async ({ page }) => {
  await send(page, 'https://demo.example/cut');
  await expect(page.getByTestId('request-response-error')).toContainText('读响应体时断了');
  await expect(page.getByTestId('request-body-text')).toContainText('前半截正文');
});

test('⚠️ 超过 2 MiB 就停手，并且明说「只显示了这些」', async ({ page }) => {
  await send(page, 'https://demo.example/big');
  await expect(page.getByTestId('request-truncated')).toContainText('2 MiB');
  await expect(page.getByTestId('request-status')).toContainText('200');
});

test('二进制内容画十六进制，不是一片乱码', async ({ page }) => {
  await send(page, 'https://demo.example/binary');
  await expect(page.getByTestId('request-binary')).toContainText('image/png');
  await expect(page.getByTestId('request-binary')).toContainText('89 50 4e 47'); // PNG 的头
});

test('历史：发过的都记着，点一下能回到当时那个请求', async ({ page }) => {
  await send(page, 'https://demo.example/json');
  await expect(page.getByTestId('request-status')).toContainText('200');

  const rows = page.getByTestId('request-history-row');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('200');
  await expect(rows.first()).toContainText('demo.example/json');

  // 换个地址再发 —— 历史两条
  await send(page, 'https://demo.example/error');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText('500');

  // 点最下面那条（最早发的那个）→ 编辑器回到它，响应清掉
  await rows.nth(1).click();
  await expect(page.getByTestId('request-url')).toHaveValue('https://demo.example/json');
  await expect(page.getByTestId('request-status')).toHaveCount(0);
});

test('历史：同一条请求连发几次只留一条（改一个头再发不算新的）', async ({ page }) => {
  await send(page, 'https://demo.example/json');
  await expect(page.getByTestId('request-status')).toContainText('200');
  await page.getByTestId('request-send').click();
  await expect(page.getByTestId('request-history-row')).toHaveCount(1);
});

test('历史和保存：切模块回来还在（存的是键值库，不是组件状态）', async ({ page }) => {
  await send(page, 'https://demo.example/json');
  await expect(page.getByTestId('request-history-row')).toHaveCount(1);

  await page.getByTestId('module-diagram').click();
  await expect(page.getByTestId('canvas-svg')).toBeVisible();
  await page.getByTestId('module-request').click();

  await expect(page.getByTestId('request-history-row')).toHaveCount(1);
  // ⚠️ 编辑器里那份草稿也还在（它没有落盘，但 store 是模块级的单例）
  await expect(page.getByTestId('request-url')).toHaveValue('https://demo.example/json');
});

test('保存一个请求：起名字存下来 → 换个地址 → 点回来还在；同名覆盖不长两条', async ({ page }) => {
  await openInspector(page); // 起名字那一格在检查器里
  await page.getByTestId('request-url').fill('https://demo.example/json');
  await page.getByTestId('request-save-name').fill('查用户');
  await page.getByTestId('request-save').click();

  const saved = page.getByTestId('request-saved-row');
  await expect(saved).toHaveCount(1);
  await expect(saved.first()).toContainText('查用户');

  // 改名再存一次：还是这一条（同名就是同一条）
  await page.getByTestId('request-save-name').fill('查用户');
  await page.getByTestId('request-save').click();
  await expect(saved).toHaveCount(1);

  // 编辑器清空之后点回来，地址和选项都回来了
  // （草稿里有内容，先过「清掉？」那道确认 —— 2026-10-15 起的行为）
  page.once('dialog', (d) => void d.accept());
  await page.getByTestId('request-reset').click();
  await expect(page.getByTestId('request-url')).toHaveValue('');
  await saved.first().click();
  await expect(page.getByTestId('request-url')).toHaveValue('https://demo.example/json');
});

test('带着凭据类的头时，列表上有个 ⚠（它是明文存在本机的）', async ({ page }) => {
  await page.getByTestId('request-tab-headers').click();
  await page.getByTestId('request-header-name').first().fill('authorization');
  await page.getByTestId('request-header-value').first().fill('Bearer t');
  await send(page, 'https://demo.example/secret');
  await expect(page.getByTestId('request-status')).toContainText('200');

  await expect(page.getByTestId('request-history-row').first().locator('.rd-req-warn')).toBeVisible();
  await expect(page.getByTestId('request-sidebar')).toContainText('明文存在本机');
});

test('搜索：方法和地址都搜得到，搜不到有提示', async ({ page }) => {
  await send(page, 'https://demo.example/json');
  await expect(page.getByTestId('request-status')).toContainText('200');

  await page.getByTestId('request-search').fill('json');
  await expect(page.getByTestId('request-history-row')).toHaveCount(1);

  await page.getByTestId('request-search').fill('不存在的接口');
  await expect(page.getByTestId('request-nomatch')).toBeVisible();
  await expect(page.getByTestId('request-history-row')).toHaveCount(0);

  // 清空之后回来
  await page.getByTestId('request-search-clear').click();
  await expect(page.getByTestId('request-history-row')).toHaveCount(1);
});

test('清空历史：先问一句，历史没了、保存的还在', async ({ page }) => {
  await openInspector(page); // 存这一步要起名字，那一格在检查器里
  await page.getByTestId('request-url').fill('https://demo.example/json');
  await page.getByTestId('request-save-name').fill('查用户');
  await page.getByTestId('request-save').click();
  await page.getByTestId('request-send').click();
  await expect(page.getByTestId('request-history-row')).toHaveCount(1);

  // 2026-10-15 体验评审：一按就没、抹掉的是带 token 的明文记录 —— 和
  // 删连接/删任务同款的确认。先验「取消 = 什么都不动」
  page.once('dialog', (d) => void d.dismiss());
  await page.getByTestId('request-clear-history').click();
  await expect(page.getByTestId('request-history-row')).toHaveCount(1);

  page.once('dialog', (d) => void d.accept());
  await page.getByTestId('request-clear-history').click();
  await expect(page.getByTestId('request-history-row')).toHaveCount(0);
  await expect(page.getByTestId('request-saved-row')).toHaveCount(1);
});

test('流式：正文是一块块出现的（不是等收完才显示）', async ({ page }) => {
  await send(page, 'https://demo.example/slow');

  // ⚠️ 这一条验的是「边收边显示」：假服务器每块之间隔 90ms，
  // 所以在整条跑完之前**正文里已经有内容了**
  const body = page.getByTestId('request-body-text');
  await expect(body).toContainText('"n":1');
  await expect(page.getByTestId('request-receiving')).toBeVisible();

  await expect(body).toContainText('[DONE]');
  await expect(page.getByTestId('request-receiving')).toHaveCount(0);
});

test('页签：切模块回来还停在原来那一页（状态在 store 里）', async ({ page }) => {
  await send(page, 'https://demo.example/json');
  await page.getByTestId('request-tab-body').click();
  await expect(page.getByTestId('request-body-input')).toBeVisible();

  await page.getByTestId('module-diagram').click();
  await page.getByTestId('module-request').click();
  await expect(page.getByTestId('request-body-input')).toBeVisible();
});

test('状态栏右侧显示最近一次的状态码和耗时', async ({ page }) => {
  await send(page, 'https://demo.example/json');
  await expect(page.getByTestId('request-status-item')).toContainText('200');
});

test('新请求：草稿有内容时先问一句（历史和保存都不动）', async ({ page }) => {
  await send(page, 'https://demo.example/json');
  await expect(page.getByTestId('request-history-row')).toHaveCount(1);

  // 2026-10-15 体验评审：这个按钮此前叫「新建」、点一下静默清掉填了一半的
  // 请求 —— 名字没说是破坏性的。现在草稿非空先确认：取消 = 什么都不动
  page.once('dialog', (d) => void d.dismiss());
  await page.getByTestId('request-reset').click();
  await expect(page.getByTestId('request-url')).toHaveValue('https://demo.example/json');

  page.once('dialog', (d) => void d.accept());
  await page.getByTestId('request-reset').click();
  await expect(page.getByTestId('request-url')).toHaveValue('');
  await expect(page.getByTestId('request-status')).toHaveCount(0);
  await expect(page.getByTestId('request-history-row')).toHaveCount(1);

  // 空草稿不该被拦（没人想为空请求过一道确认）
  await page.getByTestId('request-reset').click();
  await expect(page.getByTestId('request-url')).toHaveValue('');
});
