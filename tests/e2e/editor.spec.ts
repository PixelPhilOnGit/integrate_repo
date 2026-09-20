import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });
  await page.goto('/');
  await expect(page.getByTestId('canvas-svg')).toBeVisible();
  // 画布挂载 ≠ 文档加载完成（init 是异步的）。不等这一刻，后续测量到的
  // 可能是初始空文档的尺寸，产生难以复现的亚像素偏差。
  await expect(page.getByTestId('current-path')).toContainText('示例');
});

/** 读出一个下载文件的内容 */
async function downloadText(page: Page, trigger: () => Promise<void>): Promise<string> {
  const [download] = await Promise.all([page.waitForEvent('download'), trigger()]);
  const path = await download.path();
  if (!path) throw new Error('下载没有落地到磁盘');
  return readFileSync(path, 'utf8');
}

async function downloadBytes(page: Page, trigger: () => Promise<void>): Promise<Buffer> {
  const [download] = await Promise.all([page.waitForEvent('download'), trigger()]);
  const path = await download.path();
  if (!path) throw new Error('下载没有落地到磁盘');
  return readFileSync(path);
}

/**
 * 参与者在文档坐标系里的横坐标。
 *
 * 特意读 .rd-hit 的 x 属性而不是 getBoundingClientRect：选中状态会给参与者
 * 加一圈 3px 的选中高亮框，把 <g> 的视觉包围盒撑大 —— 拿它做断言会得到一个
 * 随选中状态漂移的值，而不是元素的真实位置。
 */
async function participantX(page: Page, index: number): Promise<number> {
  const attr = await page
    .locator('[data-participant-id]')
    .nth(index)
    .locator('.rd-hit')
    .getAttribute('x');
  return Number(attr);
}

// ---------------------------------------------------------------- 内联编辑

test('双击参与者可以改名，中文输入正常', async ({ page }) => {
  const first = page.locator('[data-participant-id]').first();
  await first.dblclick();

  const editor = page.locator('[data-inline-editor]');
  await expect(editor).toBeVisible();

  await editor.fill('');
  // 逐字输入，模拟真实中文录入路径
  await editor.pressSequentially('认证服务');
  await page.keyboard.press('Enter');

  await expect(editor).toHaveCount(0);
  await expect(page.locator('.rd-participant-label').first()).toHaveText('认证服务');
});

test('Esc 放弃编辑，名称保持不变', async ({ page }) => {
  const before = await page.locator('.rd-participant-label').first().textContent();

  await page.locator('[data-participant-id]').first().dblclick();
  const editor = page.locator('[data-inline-editor]');
  await editor.fill('不该被保存');
  await page.keyboard.press('Escape');

  await expect(editor).toHaveCount(0);
  await expect(page.locator('.rd-participant-label').first()).toHaveText(before ?? '');
});

test('双击消息可以编辑消息文字', async ({ page }) => {
  await page.getByTestId('btn-add-sync').click();
  await page.locator('[data-message-id]').first().dblclick();

  const editor = page.locator('[data-inline-editor]');
  await editor.fill('校验令牌');
  await page.keyboard.press('Enter');

  await expect(page.locator('.rd-message-label').first()).toContainText('校验令牌');
});

// ---------------------------------------------------------------- 拖拽

test('拖动参与者会改变它的横向位置', async ({ page }) => {
  const target = page.locator('[data-participant-id]').nth(1);
  const box = await target.boundingBox();
  const before = await participantX(page, 1);

  await page.mouse.move(box!.x + box!.width / 2, box!.y + 20);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2 + 140, box!.y + 20, { steps: 12 });
  await page.mouse.up();

  expect(await participantX(page, 1)).toBeGreaterThan(before + 100);
});

test('拖动消息会改变它的纵向位置，且激活条跟着走', async ({ page }) => {
  await page.getByTestId('btn-add-sync').click();

  const activation = page.locator('[data-activation-id]').first();
  await expect(activation).toHaveCount(1);
  const actBefore = await activation.boundingBox();

  const msg = page.locator('[data-message-id]').first();
  const mb = await msg.boundingBox();
  await page.mouse.move(mb!.x + mb!.width / 2, mb!.y + mb!.height / 2);
  await page.mouse.down();
  await page.mouse.move(mb!.x + mb!.width / 2, mb!.y + mb!.height / 2 + 90, { steps: 12 });
  await page.mouse.up();

  const actAfter = await activation.boundingBox();
  expect(actAfter!.y).toBeGreaterThan(actBefore!.y + 60);
});

test('点击空白处取消选择，属性面板回到文档视图', async ({ page }) => {
  await page.locator('[data-participant-id]').first().click();
  await expect(page.getByTestId('participant-name')).toBeVisible();

  const canvas = await page.locator('.rd-canvas').boundingBox();
  await page.mouse.click(canvas!.x + canvas!.width - 70, canvas!.y + canvas!.height - 70);
  await expect(page.getByTestId('doc-title')).toBeVisible();
});

// ---------------------------------------------------------------- 撤销重做

test('撤销能回退拖拽，一次撤销回退整段拖动而不是一步步退', async ({ page }) => {
  const target = page.locator('[data-participant-id]').nth(1);
  const box = await target.boundingBox();
  const before = await participantX(page, 1);

  await page.mouse.move(box!.x + box!.width / 2, box!.y + 20);
  await page.mouse.down();
  for (let i = 1; i <= 10; i += 1) {
    await page.mouse.move(box!.x + box!.width / 2 + i * 14, box!.y + 20);
  }
  await page.mouse.up();

  expect(await participantX(page, 1)).toBeGreaterThan(before + 100);

  await page.getByTestId('btn-undo').click();
  // 一次撤销就该回到原位，而不是退 10 步
  expect(await participantX(page, 1)).toBe(before);

  await page.getByTestId('btn-redo').click();
  expect(await participantX(page, 1)).toBeGreaterThan(before + 100);
});

test('Ctrl+Z 与 Ctrl+Shift+Z 快捷键可用', async ({ page }) => {
  await page.getByTestId('btn-add-actor').click();
  await expect(page.locator('[data-participant-id]')).toHaveCount(3);

  await page.keyboard.press('Control+z');
  await expect(page.locator('[data-participant-id]')).toHaveCount(2);

  await page.keyboard.press('Control+Shift+z');
  await expect(page.locator('[data-participant-id]')).toHaveCount(3);
});

test('Delete 删除选中的消息', async ({ page }) => {
  await page.getByTestId('btn-add-sync').click();
  await expect(page.locator('[data-message-id]')).toHaveCount(1);

  await page.locator('[data-message-id]').first().click();
  await page.keyboard.press('Delete');
  await expect(page.locator('[data-message-id]')).toHaveCount(0);
});

// ---------------------------------------------------------------- 消息类型

test('四种消息类型都能加出来，且外观不同', async ({ page }) => {
  await page.getByTestId('btn-add-sync').click();
  await page.getByTestId('btn-add-async').click();
  await page.getByTestId('btn-add-return').click();

  await expect(page.locator('[data-message-id]')).toHaveCount(3);

  // 返回消息应当是虚线
  await expect(page.locator('.rd-message-line--return')).toHaveCount(1);
  // 同步消息的箭头是实心三角（带 Z 闭合），异步是空心折线
  const heads = page.locator('.rd-arrow-head');
  await expect(heads).toHaveCount(3);

  await page.screenshot({ path: 'test-results/10-message-types.png' });
});

test('同步消息会在接收方生成激活条，返回消息会把它闭合', async ({ page }) => {
  await page.getByTestId('btn-add-sync').click();
  await expect(page.locator('[data-activation-id]')).toHaveCount(1);

  // 手工把消息改成「返回」，自动激活逻辑应当随之调整
  await page.locator('[data-message-id]').first().click();
  await page.getByTestId('message-kind').selectOption('return');
  await expect(page.locator('[data-activation-id]')).toHaveCount(0);
});

// ---------------------------------------------------------------- 工作区

test('新建图会出现在文件树里并被自动打开', async ({ page }) => {
  await page.getByTestId('btn-new-diagram').click();

  await expect(page.getByTestId('tree-file-未命名.seq.json')).toBeVisible();
  await expect(page.getByTestId('status-text')).toContainText('已新建');

  // 下面三条才是重点：必须**真的打开**了，而不是只建了个文件。
  // 回归背景：后端 create_diagram 只建 0 字节占位文件，前端建完立刻去解析内容
  // 就会 JSON.parse('') 抛异常 —— 表现为"文件建出来了，但报错、图打不开"。
  // 因为浏览器版当初顺手把内容也写了，这条路径两边不一致，e2e 一直测不到。
  await expect(page.getByTestId('error-banner')).toHaveCount(0);
  await expect(page.getByTestId('current-path')).toContainText('未命名.seq.json');
  await expect(page.getByTestId('doc-title')).toHaveValue('未命名');
  // 新图默认带两个参与者，canvas 上要画出来
  await expect(page.locator('[data-participant-id]')).toHaveCount(2);
});

test('重命名文件后标题跟着变', async ({ page }) => {
  await page.getByTestId('btn-new-diagram').click();
  const row = page.getByTestId('tree-file-未命名.seq.json');
  await row.dblclick();

  const input = page.getByLabel('重命名');
  await input.fill('支付流程');
  await page.keyboard.press('Enter');

  await expect(page.getByTestId('tree-file-支付流程.seq.json')).toBeVisible();
});

test('删除文件需要确认，确认后从树里消失', async ({ page }) => {
  await page.getByTestId('btn-new-diagram').click();
  const row = page.getByTestId('tree-file-未命名.seq.json');
  await expect(row).toBeVisible();

  // 删除现在在右键菜单里（不再是一排常驻按钮中的一项）
  await row.click({ button: 'right' });
  await expect(page.getByTestId('context-menu')).toBeVisible();

  // 浏览器实现用 window.confirm
  page.on('dialog', (d) => void d.accept());
  await page.getByTestId('menu-删除').click();

  await expect(row).toHaveCount(0);
});

test('文件夹可以展开折叠', async ({ page }) => {
  const archive = page.getByTestId('tree-dir-归档');
  await expect(archive).toBeVisible();
  await expect(page.getByTestId('tree-file-归档/旧版.seq.json')).toHaveCount(0);

  await archive.click();
  await expect(page.getByTestId('tree-file-归档/旧版.seq.json')).toBeVisible();
});

// ---------------------------------------------------------------- 导出

test('导出 Mermaid：内容以 sequenceDiagram 开头，含参与者与消息', async ({ page }) => {
  await page.getByTestId('btn-add-sync').click();

  const text = await downloadText(page, () => page.getByTestId('btn-export-mermaid').click());

  expect(text.startsWith('sequenceDiagram')).toBe(true);
  expect(text).toContain('participant');
  expect(text).toContain('用户');
  expect(text).toContain('->>');
  // 自动创建的激活条必须成对闭合，否则 Mermaid 会报错
  const activates = (text.match(/^\s*activate /gm) ?? []).length;
  const deactivates = (text.match(/^\s*deactivate /gm) ?? []).length;
  expect(activates).toBe(deactivates);
  expect(activates).toBeGreaterThan(0);
});

test('导出 SVG：是独立可打开的文件，样式已内联', async ({ page }) => {
  await page.getByTestId('btn-add-sync').click();

  const svg = await downloadText(page, () => page.getByRole('button', { name: 'SVG', exact: true }).click());

  expect(svg).toContain('<?xml');
  expect(svg).toContain('<svg');
  expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
  // 主题样式必须在 SVG 内部，脱离程序后仍然生效
  expect(svg).toContain('<style');
  expect(svg).toContain('.rd-root');
  // 中文内容要带上
  expect(svg).toContain('用户');
  // 选中高亮是编辑态的东西，不能在标记里出现（CSS 规则里出现是正常的）
  expect(svg).not.toContain('class="rd-selection"');
  // 样式必须只有一份 —— 曾经因为先剥离 data-* 再找 style，导致重复插入
  expect((svg.match(/<style/g) ?? []).length).toBe(1);
  // 交互用的辅助属性应当被剥离
  expect(svg).not.toContain('data-message-id');
});

test('导出 PNG：产出真实的 PNG 文件', async ({ page }) => {
  await page.getByTestId('btn-add-sync').click();

  const png = await downloadBytes(page, () => page.getByTestId('btn-export-png').click());

  // PNG magic number
  expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  // 有实际内容，不是空图
  expect(png.length).toBeGreaterThan(3000);
});

// ---------------------------------------------------------------- 主题

test('切换预设主题会改写整个文档配色', async ({ page }) => {
  const before = await page.locator('.rd-root').getAttribute('class');
  expect(before).toContain('rd-root');

  await page.getByTestId('theme-select').selectOption('dark');

  // 背景色写进了 SVG 内部的 style
  const style = await page.locator('style[data-rd-theme]').textContent();
  expect(style).toContain('#1a2029');
});

test('样式面板改颜色会立刻反映到画布', async ({ page }) => {
  await page.getByTestId('tab-style').click();
  await page.getByTestId('theme-lineColor').fill('#ff0000');

  const style = await page.locator('style[data-rd-theme]').textContent();
  expect(style).toContain('--rd-line: #ff0000');
});

// ---------------------------------------------------------------- 缩放

test('缩放会改变 viewBox 而不是 CSS 缩放（保证文字不糊）', async ({ page }) => {
  const svg = page.getByTestId('canvas-svg');
  const before = await svg.getAttribute('viewBox');

  await page.getByRole('button', { name: '+' }).click();

  const after = await svg.getAttribute('viewBox');
  expect(after).not.toBe(before);
  // CSS 上没有 transform 缩放
  const style = await svg.getAttribute('style');
  expect(style ?? '').not.toContain('transform');
});

// ---------------------------------------------------------------- 属性面板

test('属性面板能改消息的收发方', async ({ page }) => {
  await page.getByTestId('btn-add-actor').click();
  await page.getByTestId('btn-add-sync').click();

  await page.locator('[data-message-id]').first().click();
  const options = await page.getByTestId('message-to').locator('option').allTextContents();
  expect(options).toContain('服务端');
  await page.getByTestId('message-to').selectOption({ label: '服务端' });

  // 端点应当落到「系统」那条生命线上
  const svg = page.getByTestId('canvas-svg');
  await expect(svg).toBeVisible();
});

test('手动输入序号会覆盖自动编号', async ({ page }) => {
  await page.getByTestId('btn-add-sync').click();
  await page.locator('[data-message-id]').first().click();

  // 消息表单里有两个数字输入：序号在前、纵坐标在后
  const seqInput = page.locator('.rd-form input[type=number]').nth(0);
  await seqInput.fill('42');
  await expect(page.locator('.rd-message-label').first()).toContainText('42');
});

// ------------------------------------------------- 工具栏动作跟随选中（回归）

/**
 * 消息箭头的起点（文档坐标）。
 * 从 path 的 d 里读，而不是 getBoundingClientRect —— 后者会被选中高亮框撑大。
 */
async function messageStart(page: Page, index: number): Promise<{ x: number; y: number }> {
  const d = await page
    .locator('[data-message-id]')
    .nth(index)
    .locator('.rd-message-line')
    .getAttribute('d');
  const m = d?.match(/M\s+(-?[\d.]+)\s+(-?[\d.]+)/);
  if (!m) throw new Error(`无法解析消息路径：${d}`);
  return { x: Number(m[1]), y: Number(m[2]) };
}

/** 注释左上角的文档坐标 */
async function notePos(page: Page, index: number): Promise<{ x: number; y: number }> {
  const d = await page
    .locator('[data-note-id]')
    .nth(index)
    .locator('.rd-note')
    .first()
    .getAttribute('d');
  const m = d?.match(/M\s+(-?[\d.]+)\s+(-?[\d.]+)/);
  if (!m) throw new Error(`无法解析注释路径：${d}`);
  return { x: Number(m[1]), y: Number(m[2]) };
}

/** 点某个参与者的头部把它选中 */
async function clickParticipant(page: Page, index: number): Promise<void> {
  const box = await page.locator('[data-participant-id]').nth(index).boundingBox();
  await page.mouse.click(box!.x + box!.width / 2, box!.y + 8);
}

test('选中第二个参与者后加自调用，消息落在它身上而不是第一个（回归）', async ({ page }) => {
  const firstX = await participantX(page, 0);
  const secondX = await participantX(page, 1);

  await clickParticipant(page, 1);
  await expect(page.getByTestId('participant-name')).toHaveValue('服务端');

  await page.getByTestId('btn-add-self').click();

  const start = await messageStart(page, 0);
  // 归属第二个参与者，而不是永远贴第一个
  expect(Math.abs(start.x - secondX)).toBeLessThan(Math.abs(start.x - firstX));
});

test('选中参与者后加同步消息，以它为发送方', async ({ page }) => {
  await clickParticipant(page, 1);
  await page.getByTestId('btn-add-sync').click();

  await page.locator('[data-message-id]').first().click();
  await expect(page.getByTestId('message-from')).toHaveValue(await participantIdOf(page, 1));
});

/** 读某个参与者的 id（属性面板的 select 用的是 id） */
async function participantIdOf(page: Page, index: number): Promise<string> {
  const v = await page
    .locator('[data-participant-id]')
    .nth(index)
    .getAttribute('data-participant-id');
  return v ?? '';
}

test('选中一条消息后新增的消息插在它后面，而不是追加到末尾（回归）', async ({ page }) => {
  await page.getByTestId('btn-add-sync').click();
  await page.getByTestId('btn-add-sync').click();
  await page.getByTestId('btn-add-sync').click();
  await expect(page.locator('[data-message-id]')).toHaveCount(3);

  const y0 = (await messageStart(page, 0)).y;
  const y1 = (await messageStart(page, 1)).y;
  const y2 = (await messageStart(page, 2)).y;
  expect(y0).toBeLessThan(y1);
  expect(y1).toBeLessThan(y2);

  // 选中第一条，在它后面插入
  await page.locator('[data-message-id]').first().click();
  await page.getByTestId('btn-add-async').click();
  await expect(page.locator('[data-message-id]')).toHaveCount(4);

  const [n0, n1, n2, n3] = [
    (await messageStart(page, 0)).y,
    (await messageStart(page, 1)).y,
    (await messageStart(page, 2)).y,
    (await messageStart(page, 3)).y,
  ] as [number, number, number, number];

  // 第一条没动，新的一条紧跟在它后面，原来的第二三条被整体推下去
  expect(n0).toBe(y0);
  expect(n1).toBeGreaterThan(y0);
  expect(n1).toBeLessThan(n2);
  expect(n3).toBeGreaterThan(y2);
});

test('新建注释跟随选中的参与者，而不是永远贴第一个（回归）', async ({ page }) => {
  const firstX = await participantX(page, 0);
  const secondX = await participantX(page, 1);

  await clickParticipant(page, 1);
  await page.getByTestId('btn-add-note').click();
  await page.keyboard.press('Escape'); // 退出新建后的编辑态

  const pos = await notePos(page, 0);
  expect(Math.abs(pos.x - secondX)).toBeLessThan(Math.abs(pos.x - firstX));
});

test('没有选中时，新注释落在鼠标刚点过的位置', async ({ page }) => {
  const canvas = await page.locator('.rd-canvas').boundingBox();
  const clickX = canvas!.x + canvas!.width - 120;
  const clickY = canvas!.y + canvas!.height - 120;

  await page.mouse.click(clickX, clickY);
  await page.getByTestId('btn-add-note').click();
  await page.keyboard.press('Escape');

  // 注释出现在点击处附近（而不是图的左上角或第一个参与者那里）
  const box = await page.locator('[data-note-id]').first().boundingBox();
  expect(Math.abs(box!.x - clickX)).toBeLessThan(60);
  expect(Math.abs(box!.y - clickY)).toBeLessThan(60);
});

test('注释可以用鼠标拖动，横向和纵向都生效（回归）', async ({ page }) => {
  await page.getByTestId('btn-add-note').click();
  await page.keyboard.press('Escape');

  const before = await notePos(page, 0);
  const box = await page.locator('[data-note-id]').first().boundingBox();
  const startX = box!.x + box!.width / 2;
  const startY = box!.y + box!.height / 2;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 170, startY + 100, { steps: 12 });
  await page.mouse.up();

  const after = await notePos(page, 0);
  // 横向必须真的动了 —— 曾经 attachTo 会覆盖 x，拖了纹丝不动
  expect(after.x).toBeGreaterThan(before.x + 20);
  expect(after.y).toBeGreaterThan(before.y + 15);
});

test('拖动注释一次撤销就能回到原位', async ({ page }) => {
  await page.getByTestId('btn-add-note').click();
  await page.keyboard.press('Escape');
  const before = await notePos(page, 0);

  const box = await page.locator('[data-note-id]').first().boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2 + 150, box!.y + box!.height / 2 + 80, { steps: 10 });
  await page.mouse.up();
  expect((await notePos(page, 0)).x).toBeGreaterThan(before.x + 20);

  await page.getByTestId('btn-undo').click();
  expect(await notePos(page, 0)).toEqual(before);
});

// ------------------------------------------------- 直接操作：拖拽画消息 / 截断激活条

/** 生命线上某一点的屏幕坐标，用来按下/松开 */
async function lifelinePoint(
  page: Page,
  index: number,
  yFraction = 0.4,
): Promise<{ x: number; y: number }> {
  const box = await page.locator('.rd-lifeline').nth(index).boundingBox();
  if (!box) throw new Error(`找不到第 ${index} 条生命线`);
  return { x: box.x + box.width / 2, y: box.y + box.height * yFraction };
}

/** 读激活条的高度（几何值，不是屏幕像素） */
async function activationHeight(page: Page, index: number): Promise<number> {
  const h = await page
    .locator('[data-activation-id] .rd-activation')
    .nth(index)
    .getAttribute('height');
  return Number(h);
}

test('从一条生命线拖到另一条，直接把消息画出来', async ({ page }) => {
  const from = await lifelinePoint(page, 0);
  const to = await lifelinePoint(page, 1);

  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, from.y, { steps: 8 });

  // 拖动过程中要有实时预览和操作提示
  await expect(page.getByTestId('pending-message')).toBeVisible();
  await expect(page.getByTestId('draw-hint')).toContainText('正在创建');

  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();

  await expect(page.locator('[data-message-id]')).toHaveCount(1);
  // 松手后预览和提示都要消失
  await expect(page.getByTestId('pending-message')).toHaveCount(0);
  await expect(page.getByTestId('draw-hint')).toHaveCount(0);

  // 方向正确：从第一条生命线出发
  const start = await messageStart(page, 0);
  const l0 = await participantX(page, 0);
  const l1 = await participantX(page, 1);
  expect(Math.abs(start.x - l0)).toBeLessThan(Math.abs(start.x - l1));

  // 松手后自动选中，右侧能直接改
  await expect(page.getByTestId('message-label')).toBeVisible();
});

test('拖动中按住 Alt，画出来的是异步消息', async ({ page }) => {
  const from = await lifelinePoint(page, 0);
  const to = await lifelinePoint(page, 1);

  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  // 先拖出一段，确认默认是同步。
  // 注意不能停在两条生命线的**正中间**：等距时吸附取前一条，等于拖回了起点，
  // 会被当成自调用。真实用户是瞄准目标生命线拖的，这里也照做。
  await page.mouse.move(from.x + (to.x - from.x) * 0.7, from.y, { steps: 6 });
  await expect(page.getByTestId('draw-hint')).toContainText('同步');

  // 按住 Alt 后**再移动一下**：类型是在指针移动时重算的，
  // 提示要实时切换，而不是只在松手时才生效
  await page.keyboard.down('Alt');
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await expect(page.getByTestId('draw-hint')).toContainText('异步');

  await page.mouse.up();
  await page.keyboard.up('Alt');

  // 异步箭头是空心的（没有 Z 闭合），同步是实心三角
  const head = await page.locator('[data-message-id] .rd-arrow-head').first().getAttribute('d');
  expect(head).not.toContain('Z');
});

test('拖动中按住 Shift，画出来的是返回消息', async ({ page }) => {
  const from = await lifelinePoint(page, 0);
  const to = await lifelinePoint(page, 1);

  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + (to.x - from.x) * 0.7, from.y, { steps: 6 });
  await page.keyboard.down('Shift');
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await expect(page.getByTestId('draw-hint')).toContainText('返回');
  await page.mouse.up();
  await page.keyboard.up('Shift');

  await expect(page.locator('.rd-message-line--return')).toHaveCount(1);
});

test('拖回原来那条生命线，画出来的是自调用', async ({ page }) => {
  const p = await lifelinePoint(page, 0);

  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(p.x + 130, p.y, { steps: 6 }); // 先拖出去
  await page.mouse.move(p.x, p.y, { steps: 6 }); // 再拖回来
  await page.mouse.up();

  await expect(page.locator('[data-message-id]')).toHaveCount(1);
  // 自调用是折线：M x y H … V … H …
  const d = await page.locator('[data-message-id] .rd-message-line').first().getAttribute('d');
  expect(d).toContain('V');
});

test('单纯点击生命线只是选中参与者，不会误画出一条消息（回归）', async ({ page }) => {
  const p = await lifelinePoint(page, 1, 0.5);
  await page.mouse.click(p.x, p.y);

  await expect(page.locator('[data-message-id]')).toHaveCount(0);
  await expect(page.getByTestId('participant-name')).toHaveValue('服务端');
});

test('新画的消息会插在拖到的那个高度上，而不是追加到末尾', async ({ page }) => {
  // 先造两条消息，再在它们**中间**拖一条
  await page.getByTestId('btn-add-async').click();
  await page.getByTestId('btn-add-async').click();
  const y0 = (await messageStart(page, 0)).y;
  const y1 = (await messageStart(page, 1)).y;

  // 取两条消息**屏幕位置的中点** —— 不能拿生命线的中点，
  // 生命线比消息的范围长得多，它的中点算出来在第一条消息上方
  const m0 = await page.locator('[data-message-id]').nth(0).boundingBox();
  const m1 = await page.locator('[data-message-id]').nth(1).boundingBox();
  const midScreenY = (m0!.y + m0!.height / 2 + m1!.y + m1!.height / 2) / 2;

  const from = await lifelinePoint(page, 0);
  const to = await lifelinePoint(page, 1);
  await page.mouse.move(from.x, midScreenY);
  await page.mouse.down();
  await page.mouse.move(to.x, midScreenY, { steps: 8 });
  await page.mouse.up();

  await expect(page.locator('[data-message-id]')).toHaveCount(3);
  const [n0, n1, n2] = [
    (await messageStart(page, 0)).y,
    (await messageStart(page, 1)).y,
    (await messageStart(page, 2)).y,
  ] as [number, number, number];

  // 严格递增，且原来两条位置没动 —— 新画的夹在它们中间
  expect(n0).toBeLessThan(n1);
  expect(n1).toBeLessThan(n2);
  expect(n0).toBe(y0);
  expect(n2).toBe(y1);
});

test('拖激活条的下边缘可以把它截断', async ({ page }) => {
  // 一条同步消息（生成激活条）+ 两条异步（不生成），让激活条从第一条一路延伸到底
  await page.getByTestId('btn-add-sync').click();
  await page.getByTestId('btn-add-async').click();
  await page.getByTestId('btn-add-async').click();
  await expect(page.locator('[data-activation-id]')).toHaveCount(1);

  const before = await activationHeight(page, 0);
  const box = await page.locator('[data-activation-id]').first().boundingBox();

  // 抓住下边缘往上拖
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height - 3);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height - 110, { steps: 12 });
  await page.mouse.up();

  const after = await activationHeight(page, 0);
  expect(after).toBeLessThan(before);
  // 截断后终点落在某条消息上（不再是自动延伸）
  await page.locator('[data-activation-id]').first().click();
  await expect(page.getByTestId('activation-split-at')).toBeVisible();
});

test('把激活条的下边缘拖到最下面，恢复自动延伸', async ({ page }) => {
  await page.getByTestId('btn-add-sync').click();
  await page.getByTestId('btn-add-async').click();
  await page.getByTestId('btn-add-async').click();

  const origHeight = await activationHeight(page, 0);

  // 先截断
  let box = await page.locator('[data-activation-id]').first().boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height - 3);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height - 110, { steps: 10 });
  await page.mouse.up();
  const truncated = await activationHeight(page, 0);
  expect(truncated).toBeLessThan(origHeight);

  // 再拖到最下面 → 长回去
  box = await page.locator('[data-activation-id]').first().boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height - 3);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height + 300, { steps: 12 });
  await page.mouse.up();

  expect(await activationHeight(page, 0)).toBeGreaterThan(truncated);
});

test('属性面板可以截断并新开一段', async ({ page }) => {
  await page.getByTestId('btn-add-sync').click();
  await page.getByTestId('btn-add-async').click();
  await page.getByTestId('btn-add-async').click();
  await expect(page.locator('[data-activation-id]')).toHaveCount(1);

  await page.locator('[data-activation-id]').first().click();
  await page.getByTestId('activation-split-at').selectOption({ index: 1 });
  await page.getByTestId('btn-split-activation').click();

  // 变成两段
  await expect(page.locator('[data-activation-id]')).toHaveCount(2);

  // 而且中间真的有间隔 —— 这正是"分段执行"要看出来的东西
  const h0 = await activationHeight(page, 0);
  const h1 = await activationHeight(page, 1);
  expect(h0).toBeGreaterThan(0);
  expect(h1).toBeGreaterThan(0);

  const first = await page.locator('[data-activation-id] .rd-activation').nth(0).boundingBox();
  const second = await page.locator('[data-activation-id] .rd-activation').nth(1).boundingBox();
  expect(second!.y).toBeGreaterThan(first!.y + first!.height);
});

test('在画布上拖动不会选中图上的文字（回归）', async ({ page }) => {
  await page.getByTestId('btn-add-async').click();

  // 拖一条消息
  const msg = page.locator('[data-message-id]').first();
  const mb = await msg.boundingBox();
  await page.mouse.move(mb!.x + mb!.width / 2, mb!.y + mb!.height / 2);
  await page.mouse.down();
  await page.mouse.move(mb!.x + mb!.width / 2, mb!.y + mb!.height / 2 + 80, { steps: 10 });
  await page.mouse.up();

  // 曾经：浏览器会把经过的 SVG 文字选中并画上蓝色选区，
  // 看起来像渲染坏了，而且拖完还留着
  const selected = await page.evaluate(() => window.getSelection()?.toString() ?? '');
  expect(selected).toBe('');
});

test('拖拽时高亮"松手会吸到哪条生命线"', async ({ page }) => {
  const from = await lifelinePoint(page, 0);
  const to = await lifelinePoint(page, 1);

  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });

  // 高亮的应该是目标那条，而不是起点
  await expect(page.locator('.rd-lifeline--target')).toHaveCount(1);
  const targetX = await page.locator('.rd-lifeline--target').getAttribute('x1');
  const targetLifelineX = await page.locator('.rd-lifeline').nth(1).getAttribute('x1');
  expect(targetX).toBe(targetLifelineX);

  await page.mouse.up();
  // 松手后高亮要撤掉
  await expect(page.locator('.rd-lifeline--target')).toHaveCount(0);
});

test('几乎不横向移动的拖拽会落成自调用，不需要精确拖回起点', async ({ page }) => {
  const p = await lifelinePoint(page, 0);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  // 只挪 10px：超过"算拖拽"的启动阈值，但远没到目标生命线
  await page.mouse.move(p.x + 10, p.y, { steps: 4 });

  await expect(page.getByTestId('draw-hint')).toContainText('自调用');
  await page.mouse.up();

  // 折线形状 = 自调用
  const d = await page.locator('[data-message-id] .rd-message-line').first().getAttribute('d');
  expect(d).toContain('V');
});

test('按住 Cmd/Meta 也能画异步消息（macOS 的顺手指法）', async ({ page }) => {
  const from = await lifelinePoint(page, 0);
  const to = await lifelinePoint(page, 1);

  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + (to.x - from.x) * 0.7, from.y, { steps: 6 });
  await page.keyboard.down('Meta');
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await expect(page.getByTestId('draw-hint')).toContainText('异步');
  await page.mouse.up();
  await page.keyboard.up('Meta');

  const head = await page.locator('[data-message-id] .rd-arrow-head').first().getAttribute('d');
  expect(head).not.toContain('Z');
});

/** 文档坐标 → 屏幕坐标（用 SVG 的 viewBox 换算，跟画布自身的映射一致） */
async function docToScreen(
  page: Page,
  x: number,
  y: number,
): Promise<{ x: number; y: number }> {
  const svg = await page.getByTestId('canvas-svg').boundingBox();
  const vb = await page.getByTestId('canvas-svg').getAttribute('viewBox');
  const [vx, vy, vw] = vb!.split(' ').map(Number) as [number, number, number, number];
  const zoom = svg!.width / vw;
  return { x: svg!.x + (x - vx) * zoom, y: svg!.y + (y - vy) * zoom };
}

/** 读某条消息的箭头两端（文档坐标） */
async function messageEnds(
  page: Page,
  index: number,
): Promise<{ x1: number; y1: number; x2: number; y2: number }> {
  const d = await page
    .locator('[data-message-id]')
    .nth(index)
    .locator('.rd-message-line')
    .getAttribute('d');
  const m = d?.match(/M\s+(-?[\d.]+)\s+(-?[\d.]+)\s+L\s+(-?[\d.]+)\s+(-?[\d.]+)/);
  if (!m) throw new Error(`无法解析消息路径：${d}`);
  return { x1: Number(m[1]), y1: Number(m[2]), x2: Number(m[3]), y2: Number(m[4]) };
}

test('拖消息的右端可以改接收方，不用绕到属性面板', async ({ page }) => {
  // 加两个参与者，然后从第一个拖出消息 → 用户 → 服务端
  await page.getByTestId('btn-add-object').click();
  await page.getByTestId('btn-add-object').click();
  await clickParticipant(page, 0);
  await page.getByTestId('btn-add-async').click();

  await page.locator('[data-message-id]').first().click();
  const toBefore = await page.getByTestId('message-to').inputValue();
  const fromBefore = await page.getByTestId('message-from').inputValue();
  // 目标要挑一个**不是发送方**的人 —— 拖成 from === to 会被拒绝（那会变成零长度箭头）
  const destId = await participantIdOf(page, 3);
  expect(destId).not.toBe(toBefore);
  expect(destId).not.toBe(fromBefore);

  // 抓住箭头那一端，拖到最右边那条生命线
  const ends = await messageEnds(page, 0);
  const tip = await docToScreen(page, ends.x2, ends.y2);
  const dest = await docToScreen(page, await participantX(page, 3), ends.y2);

  await page.mouse.move(tip.x, tip.y);
  await page.mouse.down();
  await page.mouse.move(dest.x, dest.y, { steps: 12 });
  await page.mouse.up();

  await page.locator('[data-message-id]').first().click();
  expect(await page.getByTestId('message-to').inputValue()).toBe(destId);
  // 发送方没被误改
  expect(await page.getByTestId('message-from').inputValue()).toBe(fromBefore);
});

test('拖消息的左端可以改发送方', async ({ page }) => {
  // 先把消息改成从最右边那位发出，这样往左拖才有地方可去
  await page.getByTestId('btn-add-object').click();
  await page.getByTestId('btn-add-object').click();
  await clickParticipant(page, 3);
  await page.getByTestId('btn-add-async').click();

  await page.locator('[data-message-id]').first().click();
  const fromBefore = await page.getByTestId('message-from').inputValue();
  const toBefore = await page.getByTestId('message-to').inputValue();
  const destId = await participantIdOf(page, 1);
  expect(destId).not.toBe(fromBefore);
  expect(destId).not.toBe(toBefore);

  const ends = await messageEnds(page, 0);
  const tail = await docToScreen(page, ends.x1, ends.y1);
  const dest = await docToScreen(page, await participantX(page, 1), ends.y1);

  await page.mouse.move(tail.x, tail.y);
  await page.mouse.down();
  await page.mouse.move(dest.x, dest.y, { steps: 12 });
  await page.mouse.up();

  await page.locator('[data-message-id]').first().click();
  expect(await page.getByTestId('message-from').inputValue()).toBe(destId);
  // 接收方没被误改
  expect(await page.getByTestId('message-to').inputValue()).toBe(toBefore);
});

test('拖消息的中间仍然是改纵向位置（三个区互不干扰）', async ({ page }) => {
  await page.getByTestId('btn-add-async').click();
  await page.locator('[data-message-id]').first().click();
  const fromBefore = await page.getByTestId('message-from').inputValue();
  const toBefore = await page.getByTestId('message-to').inputValue();
  const yBefore = (await messageStart(page, 0)).y;

  const ends = await messageEnds(page, 0);
  const mid = await docToScreen(page, (ends.x1 + ends.x2) / 2, ends.y1);
  await page.mouse.move(mid.x, mid.y);
  await page.mouse.down();
  await page.mouse.move(mid.x, mid.y + 90, { steps: 12 });
  await page.mouse.up();

  expect((await messageStart(page, 0)).y).toBeGreaterThan(yBefore + 40);
  await page.locator('[data-message-id]').first().click();
  // 收发方一个都没变
  expect(await page.getByTestId('message-from').inputValue()).toBe(fromBefore);
  expect(await page.getByTestId('message-to').inputValue()).toBe(toBefore);
});

test('拖端点时不会把两端拖成同一个人（那会变成零长度箭头）', async ({ page }) => {
  await page.getByTestId('btn-add-async').click();
  const ends = await messageEnds(page, 0);
  const tip = await docToScreen(page, ends.x2, ends.y2);
  // 把箭头那端拖回起点那条生命线
  const dest = await docToScreen(page, ends.x1, ends.y1);

  await page.mouse.move(tip.x, tip.y);
  await page.mouse.down();
  await page.mouse.move(dest.x, dest.y, { steps: 12 });
  await page.mouse.up();

  // 拒绝这次改动，箭头仍然有长度
  const after = await messageEnds(page, 0);
  expect(Math.abs(after.x2 - after.x1)).toBeGreaterThan(20);
});

test('消息到达"正在执行中"的参与者时，自动嵌一条子激活条', async ({ page }) => {
  // 造一个真实的重入场景：用户→服务端（服务端开始执行），服务端→对象，
  // 然后对象又调回服务端 —— 此时服务端还在执行中，新的执行应当嵌进去
  await page.getByTestId('btn-add-object').click();

  await clickParticipant(page, 0);
  await page.getByTestId('btn-add-sync').click(); // 用户 → 服务端

  await page.locator('[data-message-id]').first().click();
  await page.getByTestId('btn-add-sync').click(); // 服务端 → 对象

  await page.locator('[data-message-id]').nth(1).click();
  await page.getByTestId('btn-add-sync').click(); // 对象 → 服务端（重入）

  await expect(page.locator('[data-activation-id]')).toHaveCount(3);

  const rects = await page.$$eval('[data-activation-id] .rd-activation', (els) =>
    els.map((e) => ({
      x: Number(e.getAttribute('x')),
      y: Number(e.getAttribute('y')),
      h: Number(e.getAttribute('height')),
    })),
  );

  // 三条激活条的横向位置应当互不相同：两条在不同生命线上，
  // 第三条（嵌套的那条）在服务端上向右错开了一个 nesting offset
  const xs = rects.map((r) => r.x).sort((p, q) => p - q);
  expect(new Set(xs).size).toBe(3);

  // 有一条正好比另一条右移 6px —— 那就是嵌套偏移
  const nested = xs.filter((x) => xs.includes(x - 6));
  expect(nested.length).toBeGreaterThanOrEqual(1);

  // 外层不被内层截断：嵌套那条的起点落在外层区间内
  const outer = rects.find((r) => r.x === xs[0]! && r.h > 60);
  const inner = rects.find((r) => r.x === xs[0]! + 6);
  if (outer && inner) {
    expect(inner.y).toBeGreaterThan(outer.y);
    expect(inner.y).toBeLessThan(outer.y + outer.h);
  }
});

test('用返回消息闭合之后，下一次调用是顺序执行（不嵌套）', async ({ page }) => {
  await clickParticipant(page, 0);
  await page.getByTestId('btn-add-sync').click(); // 用户 → 服务端

  await page.locator('[data-message-id]').first().click();
  await page.getByTestId('btn-add-return').click(); // 返回，闭合服务端的执行

  await page.locator('[data-message-id]').nth(1).click();
  await page.getByTestId('btn-add-sync').click(); // 再来一次

  // 服务端上是两段顺序执行，都在最外层 —— 横向位置相同，纵向首尾相接
  const rects = await page.$$eval('[data-activation-id] .rd-activation', (els) =>
    els.map((e) => ({
      x: Number(e.getAttribute('x')),
      y: Number(e.getAttribute('y')),
      h: Number(e.getAttribute('height')),
    })),
  );
  expect(rects).toHaveLength(2);
  expect(rects[0]!.x).toBe(rects[1]!.x); // 没有嵌套偏移
  const sorted = [...rects].sort((p, q) => p.y - q.y);
  expect(sorted[1]!.y).toBeGreaterThanOrEqual(sorted[0]!.y + sorted[0]!.h - 1);
});

// ------------------------------------------------- 文件树的层级与"新建到哪"

test('新建图会建到文件树里选中的文件夹里（回归）', async ({ page }) => {
  // 新建文件夹之后它会被自动选中
  await page.getByTestId('btn-new-folder-in-tree').click();
  await expect(page.getByTestId('tree-target')).toContainText('新建文件夹');

  // 工具栏的「新建图」应当建进这个文件夹，而不是堆在根目录
  await page.getByTestId('btn-new-diagram').click();

  await expect(page.getByTestId('tree-file-新建文件夹/未命名.seq.json')).toBeVisible();
  await expect(page.getByTestId('current-path')).toContainText('新建文件夹/未命名.seq.json');
  // 根目录下不应该多出一个
  await expect(page.getByTestId('tree-file-未命名.seq.json')).toHaveCount(0);
});

test('建到文件夹里之后文件夹自动展开，新图立刻可见（回归）', async ({ page }) => {
  await page.getByTestId('btn-new-folder-in-tree').click();
  await page.getByTestId('btn-new-diagram').click();

  // 关键：不需要手动点开文件夹就应该能看到 ——
  // 以前新建到折叠的文件夹里，图上什么都没有，用户以为没建成功
  await expect(page.getByTestId('tree-file-新建文件夹/未命名.seq.json')).toBeVisible();
});

test('选中一个文件时，新建落在它旁边（同一个目录）', async ({ page }) => {
  await page.getByTestId('btn-new-folder-in-tree').click();
  await page.getByTestId('btn-new-diagram').click();
  await expect(page.getByTestId('tree-file-新建文件夹/未命名.seq.json')).toBeVisible();

  // 选中那个文件
  await page.getByTestId('tree-file-新建文件夹/未命名.seq.json').click();
  await expect(page.getByTestId('tree-target')).toContainText('新建文件夹');

  await page.getByTestId('btn-new-diagram').click();
  await expect(page.getByTestId('tree-file-新建文件夹/未命名2.seq.json')).toBeVisible();
});

test('什么都没选中时，新建落在工作区根目录', async ({ page }) => {
  await expect(page.getByTestId('tree-target')).toContainText('工作区根目录');
  await page.getByTestId('btn-new-diagram').click();
  await expect(page.getByTestId('tree-file-未命名.seq.json')).toBeVisible();
});

test('树能看出层级：子项的缩进辅助线比根项多', async ({ page }) => {
  await page.getByTestId('btn-new-folder-in-tree').click();
  await page.getByTestId('btn-new-diagram').click();

  const rootIndents = await page
    .getByTestId('tree-file-示例.seq.json')
    .locator('.rd-tree-indent')
    .count();
  const nestedIndents = await page
    .getByTestId('tree-file-新建文件夹/未命名.seq.json')
    .locator('.rd-tree-indent')
    .count();

  expect(rootIndents).toBe(0);
  expect(nestedIndents).toBeGreaterThan(rootIndents);
});

test('文件夹和文件用不同的图标区分', async ({ page }) => {
  await page.getByTestId('btn-new-folder-in-tree').click();
  await page.getByTestId('btn-new-diagram').click();

  // 注意目录行有两个 svg：折叠箭头 + 类型图标，要指名道姓
  const dirIcon = await page
    .getByTestId('tree-dir-新建文件夹')
    .locator('.rd-tree-icon')
    .innerHTML();
  const fileIcon = await page
    .getByTestId('tree-file-新建文件夹/未命名.seq.json')
    .locator('.rd-tree-icon')
    .innerHTML();
  // 文件夹是一条闭合轮廓，文件带一个折角
  expect(dirIcon).not.toBe(fileIcon);
  expect(fileIcon).toContain('9.5 2.6v3h3');
});

// --------------------------------------------- 树的折叠指示器与右键菜单

test('文件夹的展开状态一眼可辨：箭头会转、图标会换（回归）', async ({ page }) => {
  const row = page.getByTestId('tree-dir-归档');
  const caret = row.locator('.rd-tree-caret');
  const icon = row.locator('.rd-tree-icon');

  // 折叠时：箭头不旋转
  await expect(caret).not.toHaveClass(/is-open/);
  const closedIcon = await icon.innerHTML();

  await row.click(); // 展开
  await expect(caret).toHaveClass(/is-open/);
  const openIcon = await icon.innerHTML();

  // 图标也要跟着换 —— 光靠一个十来像素的箭头，用户反馈"看不出打开还是关闭"
  expect(openIcon).not.toBe(closedIcon);

  await row.click(); // 再折叠回来
  await expect(caret).not.toHaveClass(/is-open/);
});

test('右键文件树上的条目会弹出操作菜单', async ({ page }) => {
  await page.getByTestId('tree-file-示例.seq.json').click({ button: 'right' });

  await expect(page.getByTestId('context-menu')).toBeVisible();
  await expect(page.getByTestId('menu-重命名')).toBeVisible();
  await expect(page.getByTestId('menu-删除')).toBeVisible();
  // 右键的那个条目会被选中
  await expect(page.getByTestId('tree-target')).toContainText('工作区根目录');
});

test('悬停出现的「⋯」也能打开同一个菜单（右键不够容易被发现）', async ({ page }) => {
  await page.getByTestId('tree-more-示例.seq.json').click();
  await expect(page.getByTestId('context-menu')).toBeVisible();
  await expect(page.getByTestId('menu-删除')).toBeVisible();
});

test('菜单里可以重命名，效果和双击一样', async ({ page }) => {
  await page.getByTestId('tree-file-示例.seq.json').click({ button: 'right' });
  await page.getByTestId('menu-重命名').click();

  const input = page.getByLabel('重命名');
  await input.fill('改过名的');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('tree-file-改过名的.seq.json')).toBeVisible();
});

test('点菜单外面会关掉菜单', async ({ page }) => {
  await page.getByTestId('tree-file-示例.seq.json').click({ button: 'right' });
  await expect(page.getByTestId('context-menu')).toBeVisible();

  await page.mouse.click(700, 600);
  await expect(page.getByTestId('context-menu')).toHaveCount(0);
});

test('画布上右键消息，可以直接改类型和删除（不用绕到属性面板）', async ({ page }) => {
  await page.getByTestId('btn-add-sync').click();
  await expect(page.locator('[data-message-id]')).toHaveCount(1);

  const box = await page.locator('[data-message-id]').first().boundingBox();
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2, { button: 'right' });

  await expect(page.getByTestId('context-menu')).toBeVisible();
  // 当前类型打勾
  await expect(page.getByTestId('menu-同步消息')).toBeVisible();

  await page.getByTestId('menu-异步消息').click();
  await expect(page.locator('[data-message-id]')).toHaveCount(1);
  // 同步改成异步后，接收方的激活条被收回
  await expect(page.locator('[data-activation-id]')).toHaveCount(0);
});

test('画布上右键消息可以反转方向', async ({ page }) => {
  await page.getByTestId('btn-add-async').click();
  await page.locator('[data-message-id]').first().click();
  const from = await page.getByTestId('message-from').inputValue();
  const to = await page.getByTestId('message-to').inputValue();

  const box = await page.locator('[data-message-id]').first().boundingBox();
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2, { button: 'right' });
  await page.getByTestId('menu-反转方向').click();

  await page.locator('[data-message-id]').first().click();
  expect(await page.getByTestId('message-from').inputValue()).toBe(to);
  expect(await page.getByTestId('message-to').inputValue()).toBe(from);
});

test('画布上右键空白处可以加参与者和注释', async ({ page }) => {
  const canvas = await page.locator('.rd-canvas').boundingBox();
  await page.mouse.click(canvas!.x + canvas!.width - 80, canvas!.y + canvas!.height - 80, {
    button: 'right',
  });

  await expect(page.getByTestId('context-menu')).toBeVisible();
  await page.getByTestId('menu-添加参与者').click();
  await expect(page.locator('[data-participant-id]')).toHaveCount(3);
});

// ------------------------------------------------------------------ 文件树搜索

test('文件树搜索：按名字/路径过滤，祖先跟着留下并撑开', async ({ page }) => {
  // 假工作区里有两份图：根下的「示例」，和「归档/旧版」
  await expect(page.getByTestId('tree-file-示例.seq.json')).toBeVisible();
  await expect(page.getByTestId('tree-dir-归档')).toBeVisible();
  // 没搜的时候归档是**收起**的（默认），里面那个文件看不见
  await expect(page.getByTestId('tree-file-归档/旧版.seq.json')).toHaveCount(0);

  // 搜「旧版」：命中的文件要露出来，**而且是自动撑开的**（祖先一起留下）——
  // 不然用户搜到一个文件却看不见它，界面等于没反应
  await page.getByTestId('tree-search').fill('旧版');
  await expect(page.getByTestId('tree-file-归档/旧版.seq.json')).toBeVisible();
  await expect(page.getByTestId('tree-dir-归档')).toBeVisible(); // 祖先
  await expect(page.getByTestId('tree-file-示例.seq.json')).toHaveCount(0); // 不匹配的不显示

  // 清空之后全部回来，而且**树回到原来的形状**（归档仍然是收起的）
  await page.getByTestId('tree-search-clear').click();
  await expect(page.getByTestId('tree-file-示例.seq.json')).toBeVisible();
  await expect(page.getByTestId('tree-file-归档/旧版.seq.json')).toHaveCount(0);

  // 搜不到时说一句「没有匹配的」，别让侧栏空着像坏了
  await page.getByTestId('tree-search').fill('zzzz');
  await expect(page.getByTestId('tree-nomatch')).toBeVisible();

  // Esc 清空（搜索框的常规手势）
  await page.getByTestId('tree-search').press('Escape');
  await expect(page.getByTestId('tree-file-示例.seq.json')).toBeVisible();
});

test('把图移动到别的目录（右键 → 移动到…）', async ({ page }) => {
  await page.getByTestId('btn-new-diagram').click();
  await expect(page.getByTestId('tree-file-未命名.seq.json')).toBeVisible();

  // 先把目标文件夹展开（折叠着的目录里，子节点根本没渲染）
  await page.getByTestId('tree-dir-归档').click();

  await page.getByTestId('tree-file-未命名.seq.json').click({ button: 'right' });
  await page.getByTestId('menu-移动到…').click();
  await expect(page.getByTestId('tree-move-dialog')).toBeVisible();
  await page.getByTestId('tree-move-to-归档').click();

  // 树里的路径换了
  await expect(page.getByTestId('tree-file-归档/未命名.seq.json')).toHaveCount(1);
  await expect(page.getByTestId('tree-file-未命名.seq.json')).toHaveCount(0);
  await expect(page.getByTestId('status-text')).toContainText('已移动到 归档');

  // ⚠️ 而且**打开的还是它**：移动的是正在编辑的那张图，`currentPath` 要跟着走
  // （不跟的话下一次保存会写回**旧路径** —— 那个文件已经不在了，
  //  表现为「改了半天，重开发现没保存」）
  await expect(page.getByTestId('current-path')).toContainText('归档/未命名.seq.json');
});

test('移动到对话框里不会出现「自己那棵子树」（移进去也放不下）', async ({ page }) => {
  await page.getByTestId('tree-dir-归档').click({ button: 'right' });
  await page.getByTestId('menu-移动到…').click();

  await expect(page.getByTestId('tree-move-dialog')).toBeVisible();
  // 根目录和自己之外的目录照常列出，但它自己不在里面
  await expect(page.getByTestId('tree-move-to-__root__')).toBeVisible();
  await expect(page.getByTestId('tree-move-to-归档')).toHaveCount(0);
});
