/**
 * 视觉回归基准：截图一套固定流程下的界面。
 *
 * 用途：重构/改样式之后，跑一遍这个脚本，和之前的图对比。
 * 肉眼可见的差异就说明改坏了 —— 这是"只改了内部结构、界面不该变"类改动
 * 唯一靠谱的验收方式（测试全绿也可能界面已经坏了）。
 *
 *   node scripts/baseline-screenshots.mjs [输出目录]
 *
 * 前置：另开一个终端跑 `npm run dev`。
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const OUT = process.argv[2] ?? '/tmp/baseline';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.addInitScript(() => localStorage.clear());
await page.goto('http://localhost:5173/');
await page.getByTestId('current-path').waitFor();

// 等字体加载完、布局稳定下来再开始截。
// 不等的话，dev server 刚重启时第一帧可能拍到字体回退的状态，
// 结果和后续跑出来的差几十个像素 —— 那会让人误以为改坏了代码。
// （实测：同代码连跑两次 0 像素差异；冷启动那一次差 69 像素。）
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(400);

const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png` });
const clickP = async (i) => {
  const b = await page.locator('[data-participant-id]').nth(i).boundingBox();
  await page.mouse.click(b.x + b.width / 2, b.y + 8);
};

// 1. 刚打开
await shot('01-initial');

// 2. 三个参与者 + 四种消息类型
await page.getByTestId('btn-add-object').click();
await page.locator('[data-participant-id]').nth(2).click();
await page.getByTestId('participant-name').fill('支付网关');
await clickP(0);
await page.getByTestId('btn-add-sync').click();
await page.getByTestId('message-label').fill('提交订单');
await page.locator('[data-message-id]').first().click();
await page.getByTestId('btn-add-async').click();
await page.getByTestId('message-label').fill('发通知（不等结果）');
await page.locator('[data-message-id]').nth(1).click();
await page.getByTestId('btn-add-self').click();
await page.getByTestId('message-label').fill('记录日志');
await page.locator('[data-message-id]').nth(1).click();
await page.getByTestId('btn-add-return').click();
await page.getByTestId('message-label').fill('返回结果');
await page.mouse.click(1300, 800);
await shot('02-diagram');

// 3. 画布右键菜单（要在切到别的图之前做，否则当前图是空的）
await page.locator('[data-message-id]').first().click();
const box = await page.locator('[data-message-id]').first().boundingBox();
await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
await page.waitForTimeout(300);
await shot('03-menu');
await page.keyboard.press('Escape');

// 4. 样式面板
await page.getByTestId('tab-style').click();
await page.waitForTimeout(250);
await shot('04-style');
await page.getByTestId('tab-props').click();

// 5. 文件树：新建文件夹 + 往里建图 + 展开归档
await page.getByTestId('btn-new-folder-in-tree').click();
await page.waitForTimeout(400);
await page.getByTestId('btn-new-diagram-in-tree').click();
await page.waitForTimeout(500);
await page.getByTestId('tree-dir-归档').click();
await page.waitForTimeout(300);
await shot('05-tree');

await browser.close();
console.log(`基准截图已写入 ${OUT}`);
