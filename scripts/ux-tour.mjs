/**
 * UI 巡检截图：把每个模块的代表性状态拍成一套图 + 一份 manifest。
 *
 * 用途：体验评审 / 改界面之前之后各跑一遍。跑完在两套图之间做 diff
 * （`compare -metric AE a.png b.png null:`），或让评审者直接看图。
 *
 *   node scripts/ux-tour.mjs [输出目录=/tmp/ux-audit/before]        # 浅色全量
 *   node scripts/ux-tour.mjs [输出目录=/tmp/ux-audit/before] --dark # 深色，每模块只拍终态
 *
 * 前置：另开一个终端跑 `npm run dev`（playwright.config.ts 里那份 webServer
 * 只管 `npx playwright test`，不覆盖这个脚本）。
 *
 * ⚠️ 每个模块一笔「扫」：清空 localStorage → 进模块 → 拍空状态 → 逐步驱动 →
 * 拍有数据状态。模块之间互不影响，某一笔失败也只废那一笔（记进 manifest）。
 * 驱动步骤的选择器全部来自 tests/e2e/*.spec.ts，别自己发明。
 */
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

const OUT = process.argv[2] ?? '/tmp/ux-audit/before';
const DARK = process.argv.includes('--dark');
const PREFIX = DARK ? 'dark-' : '';
mkdirSync(OUT, { recursive: true });

const VIEWPORT = { width: 1440, height: 900 };
const manifest = [];
let seq = 0;

const browser = await chromium.launch();

/** 等字体 + 布局稳定。理由同 baseline-screenshots.mjs 头部 */
async function settle(page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(350);
}

function makeShot(page) {
  return async (name, desc) => {
    seq += 1;
    const file = `${PREFIX}${String(seq).padStart(2, '0')}-${name}.png`;
    await settle(page);
    await page.screenshot({ path: `${OUT}/${file}` });
    manifest.push({ file, desc: desc ?? '' });
    return file;
  };
}

/** 开一个新的干净工作区（清 localStorage）并等应用外壳出来 */
async function freshPage(colorScheme, viewport = VIEWPORT) {
  const ctx = await browser.newContext({ viewport, colorScheme });
  const page = await ctx.newPage();
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto('http://localhost:5173/');
  await page.getByTestId('app-shell').waitFor();
  await settle(page);
  return { ctx, page };
}

const ENTRY = {
  diagram: 'canvas-svg',
  redis: 'redis-main',
  sql: 'sql-main',
  ssh: 'ssh-main',
  agents: 'agents-main',
  tasks: 'task-sidebar',
  assistant: 'assistant-inspector',
  request: 'request-main',
  group: 'group-main',
};

async function goModule(page, id) {
  await page.getByTestId(`module-${id}`).click();
  const entry = ENTRY[id];
  if (entry) await page.getByTestId(entry).waitFor({ timeout: 10_000 });
  await page.waitForTimeout(250);
}

const vis = (page, testid, timeout = 10_000) =>
  page.getByTestId(testid).waitFor({ state: 'visible', timeout });

/* ------------------------------------------------------------------ 扫描笔 */

const sweeps = [
  {
    module: 'diagram',
    async run(page, shot) {
      // 画布挂载 ≠ 文档加载完（init 是异步的），等文档路径出来再拍
      await page.getByTestId('current-path').waitFor({ timeout: 10_000 });
      await shot('diagram-default', '种子工作区：示例图自动打开');

      // 加一个参与者、四种消息 —— 和 baseline-screenshots.mjs 同一串动作
      await page.getByTestId('btn-add-object').click();
      await page.locator('[data-participant-id]').nth(2).click();
      await page.getByTestId('participant-name').fill('支付网关');
      const p0 = await page.locator('[data-participant-id]').nth(0).boundingBox();
      await page.mouse.click(p0.x + p0.width / 2, p0.y + 8);
      const addMsg = async (btn, label) => {
        await page.getByTestId(btn).click();
        await page.getByTestId('message-label').fill(label);
        await page.locator('[data-message-id]').last().click();
      };
      await addMsg('btn-add-sync', '提交订单');
      await addMsg('btn-add-async', '发通知（不等结果）');
      await page.locator('[data-message-id]').nth(1).click();
      await addMsg('btn-add-self', '记录日志');
      await page.locator('[data-message-id]').nth(1).click();
      await addMsg('btn-add-return', '返回结果');
      await page.mouse.click(1300, 800); // 点空白取消选中
      await shot('diagram-messages', '四种消息 + 新参与者的完整图');

      // 右键菜单（挂在第一条消息上）
      const box = await page.locator('[data-message-id]').first().boundingBox();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
      await page.waitForTimeout(300);
      await shot('diagram-menu', '消息的右键菜单');
      await page.keyboard.press('Escape');

      // 样式面板
      await page.getByTestId('tab-style').click();
      await page.waitForTimeout(250);
      await shot('diagram-style', '右侧样式页签');
      await page.getByTestId('tab-props').click();

      // 文件树：展开归档目录
      await page.getByTestId('tree-dir-归档').click();
      await page.waitForTimeout(300);
      await shot('diagram-tree', '文件树展开归档目录');
    },
  },
  {
    module: 'redis',
    async run(page, shot) {
      await vis(page, 'redis-main');
      await shot('redis-empty', '干净工作区：还没有连接');

      await page.getByTestId('btn-new-connection').click();
      await vis(page, 'redis-new-dialog');
      await page.getByTestId('redis-new-confirm').click();
      await page.getByTestId('btn-conn-toggle').click();
      await page.locator('[data-testid="conn-status"]').first().waitFor({ timeout: 10_000 });
      await page.waitForTimeout(400);
      await shot('redis-connected', '连上之后：库列表 + key 列表（含类型标签）');

      await page.getByTestId('key-user:1').click();
      await page.waitForTimeout(300);
      await shot('redis-value', '选中一个 string key 的值视图');

      await page.getByTestId('tab-console').click();
      await page.waitForTimeout(250);
      await page.getByTestId('console-input').fill('KEYS *');
      await page.getByTestId('console-input').press('Enter');
      await page.waitForTimeout(800);
      await shot('redis-console', '命令台跑了一条 KEYS *');
    },
  },
  {
    module: 'sql',
    async run(page, shot) {
      await vis(page, 'sql-main');
      await shot('sql-empty', '干净工作区：还没有连接');

      await page.getByTestId('btn-new-sql-connection').click();
      await vis(page, 'sql-new-dialog');
      await page.getByTestId('sql-new-kind').selectOption('postgres');
      await page.waitForTimeout(200);
      await page.getByTestId('sql-new-confirm').click();
      await page.getByTestId('btn-sql-conn-toggle').click();
      await page.locator('[data-testid="sql-status"]').first().waitFor({ timeout: 10_000 });
      await page.waitForTimeout(400);
      await shot('sql-connected', 'Postgres 连上：侧栏库表树');

      await page.getByTestId('sql-table-用户').click();
      await page.waitForTimeout(200);
      await page.getByTestId('btn-sql-run').click();
      // 等执行完：按钮文案从「执行中…」回到「执行」
      await page
        .getByTestId('btn-sql-run')
        .filter({ hasText: /^执行$/ })
        .waitFor({ timeout: 10_000 });
      await shot('sql-result', '查一张表：结果表格（rows）');

      // 再加一个 Mongo 连接，走它自己的工作台
      await page.getByTestId('btn-new-sql-connection').click();
      await vis(page, 'sql-new-dialog');
      await page.getByTestId('sql-new-kind').selectOption('mongodb');
      await page.waitForTimeout(200);
      await page.getByTestId('sql-new-confirm').click();
      await page.getByTestId('btn-sql-conn-toggle').last().click();
      await page.locator('[data-testid="sql-status"]').last().waitFor({ timeout: 10_000 });
      await page.waitForTimeout(400);
      await page.getByTestId('sql-table-用户').last().click();
      await page.waitForTimeout(200);
      await page.getByTestId('btn-sql-run').click();
      await page
        .getByTestId('btn-sql-run')
        .filter({ hasText: /^执行$/ })
        .waitFor({ timeout: 10_000 });
      await page.waitForTimeout(300);
      await shot('sql-mongo', 'Mongo：mongosh 查询 + 表格结果');
    },
  },
  {
    module: 'ssh',
    async run(page, shot) {
      await vis(page, 'ssh-main');
      await shot('ssh-empty', '干净工作区：还没有连接');

      await page.getByTestId('ssh-btn-new').click();
      await vis(page, 'ssh-new-dialog');
      await page.getByTestId('ssh-new-confirm').click();
      await page.getByTestId('ssh-field-password').fill('secret');
      await page.waitForTimeout(200);
      await page.getByTestId('ssh-btn-connect').click();
      await vis(page, 'ssh-trust-dialog');
      await shot('ssh-trust', '首次连接：主机指纹核对弹窗（TOFU）');
      await page.getByTestId('ssh-trust-accept').click();
      await page.locator('[data-testid="ssh-status"]').first().waitFor({ timeout: 10_000 });
      await page.waitForTimeout(500);

      const term = page.locator('[data-testid="ssh-term-host"] [data-testid^="ssh-term-"] textarea');
      await term.click();
      await page.keyboard.type('whoami');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(500);
      await shot('ssh-connected', '连上之后：终端跑了一条 whoami');

      await page.keyboard.type('echo 你好色条');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(700);
      await shot('ssh-band', '命令块（色条）');
    },
  },
  {
    module: 'agents',
    async run(page, shot) {
      await vis(page, 'agents-main');
      await vis(page, 'agent-empty');
      await shot('agents-empty', '干净工作区：还没有工作目录');

      await page.getByTestId('agent-add-workspace-empty').click();
      await page.waitForTimeout(600);
      const newSession = page.getByTestId('agent-new-session-empty');
      if (await newSession.isVisible().catch(() => false)) {
        await newSession.click();
      } else {
        await page.locator('[data-testid^="agent-new-session-"]').first().click();
      }
      await page.waitForTimeout(1200);

      const focused = page.locator('[data-testid="agent-split-root"] .rd-agent-pane.is-focused');
      const sid = await focused.getAttribute('data-session-id');
      const term = page.locator(`[data-testid="agents-term-host-${sid}"] textarea`);
      await term.click();
      await page.keyboard.type('help');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(700);
      await shot('agents-session', '开了一个 claude 会话（假 agent），跑过 help');

      await page.keyboard.type('ask');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(900);
      await shot('agents-waiting', '「需要你」状态：琥珀窗格 + 侧栏队列 + 角标');

      // 文件浏览器（2026-10-16）：默认不展示、点「文件」才出现。
      // 虚拟工作区自带 diagram 的种子（示例.seq.json + 归档/旧版.seq.json），
      // 展开一层就能看到「树 + 预览」的真实样子
      await page.getByTestId('agent-tab-files').click();
      await page.waitForTimeout(400);
      const anyDir = page.locator('[data-testid^="agent-dir-"]').first();
      if ((await anyDir.count()) > 0) await anyDir.click();
      await page.waitForTimeout(400);
      const anyFile = page.locator('[data-testid^="agent-file-"]').first();
      if ((await anyFile.count()) > 0) await anyFile.click();
      await page.waitForTimeout(400);
      await shot('agents-files', '检查器「文件」标签：目录树 + 文件预览（点开才有）');
      await page.getByTestId('agent-tab-session').click();
    },
  },
  {
    module: 'tasks',
    async run(page, shot) {
      await vis(page, 'task-sidebar');
      await vis(page, 'task-empty');
      await shot('tasks-empty', '干净工作区：还没有任务');

      await page.getByTestId('task-new').click();
      await page.getByTestId('task-title').fill('写登录页');
      await page.getByTestId('task-title').press('Enter');
      await page.waitForTimeout(400);
      await page.getByTestId('task-body').fill('原型图在共享盘，先做表单校验和错误提示。');
      await page.getByTestId('task-body').blur();
      await page.waitForTimeout(300);

      await page.getByTestId('task-progress-input').fill('先画原型');
      await page.getByTestId('task-progress-input').press('Enter');
      await page.waitForTimeout(300);
      await page.getByTestId('task-text-add').click();
      await vis(page, 'task-material-draft-input');
      await page.getByTestId('task-material-draft-input').fill('参考竞品的登录页交互');
      await page.getByTestId('task-material-draft-input').blur();
      await page.waitForTimeout(300);
      await page.getByTestId('task-file-add').click();
      await page.waitForTimeout(500);
      await shot('tasks-detail', '任务详情：正文 + 进度 + 资料（文字 + 文件缩略图）');

      await page.getByTestId('task-set-done').click();
      await page.waitForTimeout(400);
      await shot('tasks-done', '标记完成之后的列表与详情');
    },
  },
  {
    module: 'knowledge',
    async run(page, shot) {
      // 浏览器版自带种子库（示例库）：卡片墙 / 阅读器（含 seq 图）/ 生成面板
      await vis(page, 'kb-sidebar');
      await vis(page, 'kb-wall');
      await shot('kb-wall', '卡片墙：未评审在左缘带强调色，标签和状态就位');

      await page.getByTestId('kb-wall-登录流程.md').click();
      await page.waitForTimeout(400);
      await shot('kb-reader', '阅读器：markdown + 只读顺序图（seq 围栏）');

      await page.getByTestId('kb-back').click();
      await page.getByTestId('kb-source-add').click();
      await page.waitForTimeout(300);
      await page.getByTestId('kb-generate-_sources/示例资料1.md').click();
      await page.waitForTimeout(200);
      await shot('kb-generate-dialog', '生成对话框：挑 CLI + 可选补充要求');
      await page.getByTestId('kb-gen-start').click();
      await page.waitForTimeout(600);
      await shot('kb-generating', '生成进度面板（右下浮层）');
      await page.getByTestId('kb-gen-dismiss').click();
    },
  },
  {
    module: 'assistant',
    async run(page, shot) {
      await vis(page, 'assistant-inspector');
      await shot('assistant-empty', '干净工作区：缺 key 和目录时的初始态');

      await page.getByTestId('assistant-key-input').fill('sk-test');
      await page.getByTestId('assistant-key-save').click();
      await page.waitForTimeout(300);
      await page.getByTestId('assistant-pick-workspace').click();
      await page.waitForTimeout(400);

      await page.getByTestId('assistant-input').fill('看看这个项目');
      await page.getByTestId('assistant-send').click();
      await page.locator('[data-testid="assistant-msg-assistant"]').last().waitFor({ timeout: 15_000 });
      await page.waitForTimeout(600);
      await shot('assistant-chat', '一轮对话：工具调用过程（读 a.txt）');

      await page.getByTestId('assistant-input').fill('帮我写一个文件');
      await page.getByTestId('assistant-send').click();
      await vis(page, 'assistant-approval', 15_000);
      await page.waitForTimeout(300);
      await shot('assistant-approval', '改文件之前的审批弹条');
    },
  },
  {
    module: 'group',
    async run(page, shot) {
      await vis(page, 'group-main');
      await shot('group-empty', '还没有群：空态');

      await page.getByTestId('group-new-empty').click();
      await page.getByTestId('group-new-name').fill('评审群');
      await page.getByTestId('group-new-confirm').click();
      await page.getByTestId('group-title').waitFor({ timeout: 10_000 });

      // 建群会请出检查器：加两个成员、选工作目录
      for (const name of ['甲', '乙']) {
        const cards = page.getByTestId('group-member-card');
        const before = await cards.count();
        await page.getByTestId('group-member-add').click();
        const input = cards.nth(before).getByTestId('group-member-name');
        await input.fill(name);
        await input.blur();
      }
      await page.getByTestId('group-workspace-pick').click();
      await page.waitForTimeout(400);
      await shot('group-config', '群设置 + 成员编辑（检查器）');

      await page.getByTestId('group-input').fill('@');
      await page.getByTestId('group-mention-panel').waitFor({ timeout: 10_000 });
      await shot('group-mention', '@ 候选面板');

      await page.getByTestId('group-input').fill('@甲 先说说你的方案');
      await page.getByTestId('group-send').click();
      await page
        .locator('[data-testid="group-msg-member"]')
        .last()
        .waitFor({ timeout: 20_000 });
      await page.waitForTimeout(600);
      await shot('group-chat', '一轮群聊：成员回答 + 工具行');
    },
  },
  {
    module: 'request',
    async run(page, shot) {
      await vis(page, 'request-main');
      await shot('request-empty', '干净工作区：先填一个地址（按钮禁用）');

      await page.getByTestId('request-url').fill('https://demo.example/json');
      await page.getByTestId('request-send').click();
      await page.getByTestId('request-status').waitFor({ timeout: 10_000 });
      await page.waitForTimeout(300);
      await shot('request-response', '一次 200 响应：状态行 + 正文');

      await page.getByTestId('request-tab-headers').click();
      await page.waitForTimeout(250);
      await page.getByTestId('request-header-name').first().fill('authorization');
      await page.getByTestId('request-header-value').first().fill('Bearer t');
      await page.getByTestId('request-url').fill('https://demo.example/secret');
      await page.getByTestId('request-send').click();
      await page.waitForTimeout(600);
      await shot('request-headers', '请求头页签 + 带鉴权的请求');

      await page.getByTestId('request-save-name').fill('查用户');
      await page.getByTestId('request-save').click();
      await page.waitForTimeout(400);
      await shot('request-saved', '侧栏：保存的请求 + 历史');
    },
  },
  {
    module: 'devplaceholder',
    async run() {},
  },
];

for (const sweep of sweeps) {
  try {
    const { ctx, page } = await freshPage(DARK ? 'dark' : 'light');
    const shot = makeShot(page);
    await goModule(page, sweep.module);
    if (!DARK) {
      await shot(`${sweep.module}-initial`, `${sweep.module} · 首次进入`);
      await sweep.run(page, shot);
    } else {
      await sweep.run(page, async () => {}); // 借同一段流程驱动，不拍中间态
      await shot(`${sweep.module}-final`, `${sweep.module} · 有数据状态（深色）`);
    }
    await ctx.close();
  } catch (err) {
    manifest.push({ file: '', desc: `❌ ${sweep.module} 这一笔失败：${err.message}` });
  }
}

// 浅色那遍额外拍：外壳的外观菜单 + 窄窗口（视觉评审要看的两个面）
if (!DARK) {
  try {
    const { ctx, page } = await freshPage('light');
    const shot = makeShot(page);
    await page.getByTestId('theme-toggle').click();
    await page.waitForTimeout(250);
    await shot('shell-theme-menu', '外观切换菜单（跟随系统/浅色/深色）');
    await ctx.close();

    const narrow = await freshPage('light', { width: 1024, height: 700 });
    const shotN = makeShot(narrow.page);
    await shotN('narrow-diagram', '1024×700 窄窗口：顺序图');
    await goModule(narrow.page, 'agents');
    await shotN('narrow-agents', '1024×700 窄窗口：智能体会话空态');
    await goModule(narrow.page, 'tasks');
    await shotN('narrow-tasks', '1024×700 窄窗口：任务空态');
    await narrow.ctx.close();
  } catch (err) {
    manifest.push({ file: '', desc: `❌ 外壳/窄窗口那两笔失败：${err.message}` });
  }
}

await browser.close();

/* ------------------------------------------------------------------ 清单 */

const lines = [
  `# UI 巡检截图 · ${DARK ? '深色（每模块只拍终态）' : '浅色（全量）'}`,
  '',
  `视口 ${VIEWPORT.width}×${VIEWPORT.height} · dev server http://localhost:5173 · 目录 \`${OUT}\``,
  `另一套在 ${DARK ? 'manifest.md（浅色）' : 'manifest-dark.md（深色）'}。`,
  '',
  '每张图的场景（按拍摄顺序）：',
  '',
];
for (const m of manifest) {
  lines.push(`## ${m.file || '❌'}`, `场景：${m.desc}`, '');
}
writeFileSync(`${OUT}/${DARK ? 'manifest-dark.md' : 'manifest.md'}`, lines.join('\n'));
console.log(`共 ${manifest.length} 张 → ${OUT}（含 manifest${DARK ? '-dark' : ''}.md）`);
