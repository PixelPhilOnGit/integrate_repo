/**
 * 智能体会话模块的端到端测试。
 *
 * 浏览器里跑的是**假 agent**（`core/fakeAgent.ts`），它走的是和真实现同一条路：
 * 键盘 → xterm → 服务层 → 进程 → 输出/状态事件 → 状态机 → 界面。
 * 所以这一组能验的东西比看上去多：行规程、终端渲染、OSC 序列扫描、
 * 事件文件的解析和防伪造、状态机、分屏布局、队列，全都在真链路上。
 *
 * 验不了的（归 Rust 和真机）：真的起进程、ConPTY、杀进程树、写用户配置文件。
 */

import { expect, test, type Page } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  // 每个用例从干净的工作目录列表开始，否则上一个用例加过的目录会漏过来
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/');
  await expect(page.getByTestId('app-shell')).toBeVisible();
  await page.getByTestId('module-agents').click();
  await expect(page.getByTestId('agents-main')).toBeVisible();
});

// ------------------------------------------------------------------ 工具

/** 当前聚焦的那一格里的会话 id */
async function focusedId(page: Page): Promise<string> {
  const id = await page
    .locator('[data-testid="agent-split-root"] .rd-agent-pane.is-focused')
    .first()
    .getAttribute('data-session-id');
  return id ?? '';
}

/** 在**某个会话的终端**里敲一条命令并回车 */
async function typeIn(page: Page, sessionId: string, line: string): Promise<void> {
  const textarea = page.locator(`[data-testid="agents-term-host-${sessionId}"] textarea`);
  await textarea.focus();
  await page.keyboard.type(line);
  await page.keyboard.press('Enter');
}

/** 终端里已经显示出来的文本（读 xterm 的缓冲区，不是渲染出来的 DOM） */
async function termText(page: Page, sessionId: string): Promise<string> {
  return page.evaluate((id) => {
    const hub = (window as unknown as { __agentsHub?: { snapshot(id: string): string | null } })
      .__agentsHub;
    return hub?.snapshot(id) ?? '';
  }, sessionId);
}

/** 加一个工作目录并开一个会话，返回那个会话的 id */
async function newSession(page: Page, command = 'claude'): Promise<string> {
  if (await page.getByTestId('agent-empty').isVisible()) {
    // 空态里那个按钮直接开 Claude Code；要别的类型就走侧栏
    await page.getByTestId('agent-add-workspace-empty').click();
    if (command === 'claude') {
      await page.getByTestId('agent-new-session-empty').click();
      return await focusedId(page);
    }
  } else if ((await page.locator('[data-testid^="agent-ws-"]').count()) === 0) {
    await page.getByTestId('agent-add-workspace').click();
  }

  const ws = page.locator('[data-testid^="agent-ws-head-"]').first();
  await ws.click({ button: 'right' });
  const label = command === 'codex' ? '新开 Codex' : '新开 Claude Code';
  await page.getByTestId(`menu-${label}`).click();
  return await focusedId(page);
}

/**
 * 展开某个工作目录 —— 侧栏里的会话行**默认是收起的**。
 *
 * 侧栏第一眼只回答「我有几个窗口」（一个工作目录就是一个窗口）；要看窗口里的
 * 会话（状态行、右键菜单），得先把那一行的箭头点开。收起时那些信息由父行的
 * 汇总圆点和顶部的「需要你」队列负责。
 */
async function expandWorkspace(page: Page, wsId: string): Promise<void> {
  const head = page.getByTestId(`agent-ws-head-${wsId}`);
  const caret = head.getByRole('button', { name: '展开' });
  if ((await caret.count()) > 0) await caret.click();
  // 等它真的开了：紧接着的操作都打在那些会话行上
  await expect(head.getByRole('button', { name: '收起' })).toBeVisible();
}

/** 展开**第一个**工作目录（用例里九成只有一个） */
async function expandFirst(page: Page): Promise<void> {
  await expandWorkspace(page, await firstWorkspaceId(page));
}

// ------------------------------------------------------------------ 用例

test('从零开始：加一个工作目录、开一个会话、终端里跑起来', async ({ page }) => {
  await expect(page.getByTestId('agent-empty')).toBeVisible();
  await expect(page.getByTestId('agent-empty')).toContainText('还没有工作目录');

  await page.getByTestId('agent-add-workspace-empty').click();
  await expect(page.locator('[data-testid^="agent-ws-head-"]')).toHaveCount(1);

  await page.getByTestId('agent-new-session-empty').click();
  const id = await focusedId(page);

  // 假 agent 会画一个横幅出来
  await expect.poll(() => termText(page, id)).toContain('Devtoolkit 假 agent');
  // 侧栏里也出现了这个会话（它那个窗口已经在列表里，展开就能看见）
  await expandFirst(page);
  await expect(page.locator(`[data-testid="agent-session-${id}"]`)).toBeVisible();
});

test('新建会话之后键盘就在终端里 —— 用户不用先点一下', async ({ page }) => {
  // 这个缺口是**原生窗口验证**抓到的：终端的键盘输入走 xterm 那个隐藏的
  // textarea，而「点新建会话 → 直接打字」的时候 DOM 焦点还在按钮上，
  // 打进去的字哪儿都不去，看起来像键盘坏了。
  //
  // 之前抓不到是因为这一组里每个用例都显式 `textarea.focus()` ——
  // **测试代码替真实用户做了那一步**，于是那一步永远没被验过。
  const id = await newSession(page);

  await page.keyboard.type('help');
  await page.keyboard.press('Enter');

  await expect.poll(() => termText(page, id)).toContain('ask');
});

test('终端是**真的**终端：行规程、退格、命令回显都在', async ({ page }) => {
  const id = await newSession(page);
  await expect.poll(() => termText(page, id)).toContain('假 agent');

  // 打错一个字再退格改回来，最后提交 —— 退格如果没真的删掉字符，
  // 提交的就是一个不存在的命令，命令表就打不出来
  const textarea = page.locator(`[data-testid="agents-term-host-${id}"] textarea`);
  await textarea.focus();
  await page.keyboard.type('hell');
  await page.keyboard.press('Backspace');
  await page.keyboard.type('p');
  await page.keyboard.press('Enter');

  await expect.poll(() => termText(page, id)).toContain('ask');
});

test('状态点跟着状态走：正在工作 → 需要你 → 已完成', async ({ page }) => {
  const id = await newSession(page);
  await expandFirst(page); // 状态行在侧栏里，默认收起
  const dot = page.getByTestId(`agent-dot-${id}`);
  const row = page.locator(`[data-testid="agent-session-${id}"]`);

  // 起来之后是「空闲」（活着、没在干活、也没在等）
  await expect(row).toHaveAttribute('data-session-status', 'idle');

  await typeIn(page, id, 'work');
  await expect(row).toHaveAttribute('data-session-status', 'working');
  await expect(dot).toHaveAttribute('data-status', 'working');

  await typeIn(page, id, 'done');
  await expect(row).toHaveAttribute('data-session-status', 'done');
});

test('需要你的时候：状态点、边框、队列、状态栏四处一起变', async ({ page }) => {
  // 这条是这个模块存在的理由 —— 用户在四个会话之间不可能逐个去读终端
  const id = await newSession(page);
  await expandFirst(page);

  await typeIn(page, id, 'ask');

  const row = page.locator(`[data-testid="agent-session-${id}"]`);
  await expect(row).toHaveAttribute('data-session-status', 'waiting');

  // 窗格边框变琥珀色（还带着一个会闪的点）
  await expect(page.getByTestId(`agent-pane-${id}`)).toHaveClass(/is-waiting/);
  // 侧栏顶部的队列里出现它
  await expect(page.getByTestId('agent-queue')).toBeVisible();
  await expect(page.getByTestId(`agent-queue-${id}`)).toBeVisible();
  // 状态栏也数着
  await expect(page.getByTestId('agents-status-waiting')).toContainText('1 个在等你');
});

test('⚠️提示里那句「等你确认」是从终端转义序列里读出来的', async ({ page }) => {
  // 假 agent 同时发了一条 OSC 9 和一条事件文件 —— 真世界里 Claude 的 hook
  // 和终端通知序列就是这样重叠的。两条都到，状态只该记一次
  const id = await newSession(page);
  await typeIn(page, id, 'ask');

  await expect(page.getByTestId(`agent-line-${id}`)).toHaveText('等待你的确认');
  // 历史里 waiting 只有一条（去抖生效）
  const history = await page.getByTestId('agent-history').textContent();
  expect(history?.match(/需要你/g)?.length).toBe(1);
});

test('在需要你的窗格里敲键 = 你在处理了，它离开队列', async ({ page }) => {
  const id = await newSession(page);
  await expandFirst(page);
  await typeIn(page, id, 'ask');
  await expect(page.getByTestId(`agent-queue-${id}`)).toBeVisible();

  const textarea = page.locator(`[data-testid="agents-term-host-${id}"] textarea`);
  await textarea.focus();
  await page.keyboard.type('y');

  await expect(page.getByTestId('agent-queue')).toHaveCount(0);
  await expect(page.locator(`[data-testid="agent-session-${id}"]`)).toHaveAttribute(
    'data-session-status',
    'working',
  );
});

test('Ctrl+Shift+U 跳到等得最久的那个会话', async ({ page }) => {
  const first = await newSession(page);
  await typeIn(page, first, 'ask');
  await expect(page.getByTestId(`agent-queue-${first}`)).toBeVisible();

  // 屏幕上换成第二个会话，让第一个下屏
  const second = await newSession(page);
  expect(second).not.toBe(first);

  await page.keyboard.press('Control+Shift+KeyU');
  // 跳回来之后它就是屏幕上那一格，而且已经不在队列里了
  await expect.poll(() => focusedId(page)).toBe(first);
  await expect(page.getByTestId('agent-queue')).toHaveCount(0);
});

test('分屏：切一刀、拖分隔条、收掉一格', async ({ page }) => {
  const left = await newSession(page);
  await expandFirst(page);
  await expect(page.getByTestId(`agent-pane-${left}`)).toBeVisible();

  await page.keyboard.press('Control+Shift+KeyD');
  await expect(page.locator('.rd-agent-pane')).toHaveCount(2);
  const right = await focusedId(page);
  expect(right).not.toBe(left);

  // 拖分隔条：往左拖，左格变窄
  const divider = page.getByTestId('agent-divider-root');
  const box = (await divider.boundingBox())!;
  const before = (await page.getByTestId(`agent-pane-${left}`).boundingBox())!.width;

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  // 先抖一下再走：分隔条用的是 pointer 事件 + setPointerCapture，
  // 全量跑的时候第一次 move 偶尔会被丢掉（那样整段拖拽等于没发生）
  await page.mouse.move(box.x + box.width / 2 - 4, box.y + box.height / 2, { steps: 2 });
  await page.mouse.move(box.x - 120, box.y + box.height / 2, { steps: 12 });
  await page.mouse.up();

  // ⚠️ 用轮询而不是读一次：拖拽在**全量并行**跑的时候会被节流，布局晚一两帧
  // 才落定（单跑必过、全量里偶发红，2026-09-19 撞到过一次）
  await expect
    .poll(async () => (await page.getByTestId(`agent-pane-${left}`).boundingBox())!.width)
    .toBeLessThan(before);

  // 收掉右边那一格：只剩一格，而且**进程没被杀**（侧栏里还看得见）
  await page.keyboard.press('Control+Shift+KeyW');
  await expect(page.locator('.rd-agent-pane')).toHaveCount(1);
  await expect(page.locator(`[data-testid="agent-session-${right}"]`)).toBeVisible();
});

test('一个会话不会同时占两格 —— 已经在屏幕上就不再提供「分屏显示」', async ({ page }) => {
  const id = await newSession(page);
  await expandFirst(page);
  await page.locator(`[data-testid="agent-session-${id}"]`).click({ button: 'right' });
  await expect(page.getByTestId('menu-在右边分屏显示')).toHaveCount(0);
  // 右键菜单开着的时候按 Esc 关掉，免得挡住后面的操作
  await page.keyboard.press('Escape');
});

test('关掉一个会话：进程没了，布局里那一格也收掉', async ({ page }) => {
  const id = await newSession(page);
  await expandFirst(page);
  await page.locator(`[data-testid="agent-session-${id}"]`).click({ button: 'right' });
  await page.getByTestId('menu-关掉这个会话').click();

  await expect(page.locator(`[data-testid="agent-session-${id}"]`)).toHaveCount(0);
  await expect(page.getByTestId('agent-empty')).toBeVisible();
});

test('退出码显示出来，状态是「已退出」', async ({ page }) => {
  const id = await newSession(page);
  await expandFirst(page);
  await typeIn(page, id, 'exit');

  await expect(page.locator(`[data-testid="agent-session-${id}"]`)).toHaveAttribute(
    'data-session-status',
    'exited',
  );
  await expect.poll(() => termText(page, id)).toContain('退出码');
});

test('在别的模块里也能看见「有 agent 在等你」（图标角标）', async ({ page }) => {
  // 这是唯一的跨模块提醒。没有它，用户去画个图就完全不知道 agent 停下来了
  const id = await newSession(page);
  await typeIn(page, id, 'ask');
  await expect(page.getByTestId(`agent-queue-${id}`)).toBeVisible();

  await page.getByTestId('module-diagram').click();
  await expect(page.getByTestId('canvas-svg')).toBeVisible();

  await expect(page.getByTestId('agents-badge')).toBeVisible();
  await expect(page.getByTestId('agents-badge')).toHaveText('1');

  // 没有等待的会话时角标不出现（一直亮着的角标等于没有角标）
  await page.getByTestId('module-agents').click();
  await page.getByTestId(`agent-queue-${id}`).click();
  await page.getByTestId('module-diagram').click();
  await expect(page.getByTestId('agents-badge')).toHaveCount(0);
});

test('集成向导：看得见要改哪个文件、能启用、能撤销', async ({ page }) => {
  await newSession(page);

  await expect(page.getByTestId('agent-int-state-claude')).toHaveText('未启用');
  await page.getByTestId('agent-int-open-claude').click();

  const dialog = page.getByTestId('agent-integrate-dialog');
  await expect(dialog).toBeVisible();
  // 路径和改动内容都摆出来，不藏在「一键优化」后面
  await expect(page.getByTestId('agent-int-path')).toContainText('.claude');
  await expect(page.getByTestId('agent-int-preview')).toContainText('hooks.');
  // 说清楚「新开的会话才生效」—— 不说的话用户会盯着一个不变的状态点怀疑我们坏了
  await expect(dialog).toContainText('新开的会话才会生效');

  await page.getByTestId('agent-int-apply').click();
  await expect(page.getByTestId('agent-int-revert')).toBeVisible();
  await page.getByTestId('agent-int-close').click();
  await expect(page.getByTestId('agent-int-state-claude')).toHaveText('已启用');

  // 撤销之后回到「未启用」
  await page.getByTestId('agent-int-open-claude').click();
  await page.getByTestId('agent-int-revert').click();
  await page.getByTestId('agent-int-close').click();
  await expect(page.getByTestId('agent-int-state-claude')).toHaveText('未启用');
});

test('配置读不了的时候：说清原因，而且不给「启用」按钮', async ({ page }) => {
  // 这是「出事的时候用户唯一能看到的东西」：文件不是合法 JSON 时我们拒绝写入
  // （不能把人家配置搞坏），但必须告诉他为什么。
  // 浏览器假实现里专门留了个开关走这条路 —— 不留的话这段界面永远走不到，
  // 也就是一段没被测过的死代码
  await page.evaluate(() => {
    (window as unknown as { __pretendIntegrationUnusable?: (v: boolean) => void })
      .__pretendIntegrationUnusable?.(true);
  });

  await newSession(page);
  await page.getByTestId('agent-int-open-claude').click();

  await expect(page.getByTestId('agent-int-unusable')).toBeVisible();
  await expect(page.getByTestId('agent-int-unusable')).toContainText('不是合法的 JSON');
  await expect(page.getByTestId('agent-int-apply')).toHaveCount(0);
  await expect(page.getByTestId('agent-int-revert')).toHaveCount(0);

  await page.getByTestId('agent-int-close').click();
  await expect(page.getByTestId('agent-int-state-claude')).toHaveText('配置文件读不了');
});

test('工作目录的会话数、展开收起、双击改名', async ({ page }) => {
  const id = await newSession(page);
  const wsHead = page.locator('[data-testid^="agent-ws-head-"]').first();
  const wsId = (await wsHead.getAttribute('data-testid'))!.replace('agent-ws-head-', '');

  // ⚠️ 会话行**默认收起**：侧栏一眼看到的该是「我有几个窗口」而不是
  // 「我有几个会话」。所以这里先展开，再收起确认它真的收得回去
  await expect(page.locator(`[data-testid="agent-session-${id}"]`)).toHaveCount(0);
  await page.getByTestId(`agent-ws-head-${wsId}`).getByRole('button', { name: '展开' }).click();
  await expect(page.locator(`[data-testid="agent-session-${id}"]`)).toBeVisible();
  await page.getByTestId(`agent-ws-head-${wsId}`).getByRole('button', { name: '收起' }).click();
  await expect(page.locator(`[data-testid="agent-session-${id}"]`)).toHaveCount(0);

  // 那个数字是窗口里的会话数
  await expect(page.getByTestId(`agent-ws-head-${wsId}`)).toContainText('1');

  // 双击改名
  await page.getByTestId(`agent-ws-name-${wsId}`).dblclick();
  await page.keyboard.press('Control+A');
  await page.keyboard.type('我的项目');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId(`agent-ws-name-${wsId}`)).toHaveText('我的项目');
});

test('切到别的模块再回来，会话和画面都还在', async ({ page }) => {
  // 终端字节流着的时候切模块 —— 这是「终端实例活在 React 树外面」那条设计的验收
  const id = await newSession(page);
  await expandFirst(page);
  await typeIn(page, id, 'work');
  await expect.poll(() => termText(page, id)).toContain('正在处理');

  await page.getByTestId('module-redis').click();
  await expect(page.getByTestId('redis-main')).toBeVisible();
  await page.getByTestId('module-agents').click();

  await expect(page.getByTestId(`agent-pane-${id}`)).toBeVisible();
  await expect.poll(() => termText(page, id)).toContain('正在处理');
  // 状态也还在（轮询没停在切走的时候）
  await expect(page.locator(`[data-testid="agent-session-${id}"]`)).toHaveAttribute(
    'data-session-status',
    'working',
  );
});

// ------------------------------------------------------------ 新建会话对话框

/** 侧栏第一个工作目录的 id */
async function firstWorkspaceId(page: Page): Promise<string> {
  const testid =
    (await page.locator('[data-testid^="agent-ws-head-"]').first().getAttribute('data-testid')) ??
    '';
  return testid.replace('agent-ws-head-', '');
}

test('新建会话：填几个就开几个，一次铺成网格', async ({ page }) => {
  await newSession(page); // 先把工作目录建出来（顺带开着一个 claude）
  const wsId = await firstWorkspaceId(page);

  await page.getByTestId(`agent-new-session-${wsId}`).click();
  await expect(page.getByTestId('agent-new-dialog')).toBeVisible();

  // 默认就是一个 claude（侧栏那个「＋」以前点一下就是开一个），
  // 再补两个 claude、一个终端
  await page.getByTestId('agent-new-count-claude').fill('3');
  await page.getByTestId('agent-new-count-shell').fill('1');
  await expect(page.getByTestId('agent-new-summary')).toContainText('一共 4 个');

  await page.getByTestId('agent-new-confirm').click();
  await expect(page.getByTestId('agent-new-dialog')).toHaveCount(0);

  // 4 个新建的把原来那一格撑成 2×2（2 列 × 2 行）
  await expect(page.locator('[data-testid="agent-split-root"] .rd-agent-pane')).toHaveCount(4);
  // 侧栏里加上原来那个一共 5 个会话
  // ⚠️ 前缀要限定在侧栏里：检查器里那块详情的 testid 是 `agent-session-detail`，
  // 按前缀选会把它也算进来（这条曾经写成 6 而不是 5）
  // ⚠️ 会话行默认收起，先展开
  await expandFirst(page);
  await expect(
    page.locator('[data-testid="agent-workspaces"] [data-testid^="agent-session-"]'),
  ).toHaveCount(5);
});

test('新建会话：一个都不填时按钮是灰的（不会开出空的一批）', async ({ page }) => {
  await newSession(page);
  const wsId = await firstWorkspaceId(page);

  await page.getByTestId(`agent-new-session-${wsId}`).click();
  await page.getByTestId('agent-new-count-claude').fill('0');

  await expect(page.getByTestId('agent-new-confirm')).toBeDisabled();
  await expect(page.getByTestId('agent-new-summary')).toContainText('还没填数量');
});

test('启动参数：设一次，之后新建的命令都带上', async ({ page }) => {
  await newSession(page);
  const wsId = await firstWorkspaceId(page);

  await page.getByTestId(`agent-new-session-${wsId}`).click();
  await page.getByTestId('agent-new-args').click();
  await expect(page.getByTestId('agent-args-dialog')).toBeVisible();

  await page.getByTestId('agent-args-claude').fill('--dangerously-skip-permissions');
  await page.getByTestId('agent-args-save').click();

  // 保存之后回到「填数量」那一页，而不是把两个对话框一起关掉
  await expect(page.getByTestId('agent-new-dialog')).toBeVisible();
  await page.getByTestId('agent-new-confirm').click();

  // 新会话的终端里能看到**带参数的那条命令**（假 agent 会把命令回显出来）
  const fresh = await focusedId(page);
  await expect.poll(() => termText(page, fresh)).toContain('claude --dangerously-skip-permissions');

  // 再打开一次：存过的值还在（走的是持久化那条路）
  await page.getByTestId(`agent-new-session-${wsId}`).click();
  await page.getByTestId('agent-new-args').click();
  await expect(page.getByTestId('agent-args-claude')).toHaveValue('--dangerously-skip-permissions');
});

// ------------------------------------------------------------ 一个目录一个窗口

test('一个工作目录就是一个窗口：各看各的分屏，父窗口一关子窗口全收', async ({ page }) => {
  // 预置两个工作目录。浏览器里那个假「选文件夹」永远返回同一个路径，第二次
  // 添加会被去重 —— 而这条用例正需要**两个不同的窗口**
  await page.addInitScript(() => {
    localStorage.setItem(
      'devtoolkit.agents.v1',
      JSON.stringify({
        workspaces: [
          { id: 'ws_alpha', path: 'D:\\work\\alpha', name: 'alpha' },
          { id: 'ws_beta', path: 'D:\\work\\beta', name: 'beta' },
        ],
      }),
    );
  });
  await page.reload();
  await page.getByTestId('module-agents').click();

  // 侧栏一眼是**两个窗口**（一个目录一条），不是「一堆会话」
  await expect(page.locator('[data-testid^="agent-ws-head-"]')).toHaveCount(2);

  // alpha 里摆两块
  await page.getByTestId('agent-new-session-ws_alpha').click();
  await page.getByTestId('agent-new-confirm').click();
  await expect(page.locator('.rd-agent-pane')).toHaveCount(1);
  await page.keyboard.press('Control+Shift+KeyD');
  await expect(page.locator('.rd-agent-pane')).toHaveCount(2);

  // 切到 beta：它是**空的**（不是继承了 alpha 的两块）
  await page.getByTestId('agent-ws-head-ws_beta').click();
  await expect(page.getByTestId('agent-empty')).toBeVisible();
  await expect(page.getByTestId('agent-ws-head-ws_beta')).toHaveAttribute(
    'data-workspace-active',
    'true',
  );

  // beta 里开一个
  await page.getByTestId('agent-new-session-ws_beta').click();
  await page.getByTestId('agent-new-confirm').click();
  await expect(page.locator('.rd-agent-pane')).toHaveCount(1);

  // 切回 alpha：两块原样还在
  await page.getByTestId('agent-ws-head-ws_alpha').click();
  await expect(page.locator('.rd-agent-pane')).toHaveCount(2);

  // 关掉父窗口：它里面的会话全收掉，**目录还在**（那一行还看得见）
  page.on('dialog', (d) => void d.accept());
  await page.getByTestId('agent-ws-head-ws_alpha').click({ button: 'right' });
  await page.getByTestId('menu-关闭全部会话（2）').click();

  await expect(page.getByTestId('agent-empty')).toBeVisible();
  await expect(page.getByTestId('agent-ws-head-ws_alpha')).toBeVisible();
  // beta 那个会话没被连累
  await page.getByTestId('agent-ws-head-ws_beta').click();
  await expect(page.locator('.rd-agent-pane')).toHaveCount(1);
});

// ------------------------------------------------------------------ 侧栏搜索

test('侧栏搜索：按目录名过滤；搜会话名时那个窗口自动撑开', async ({ page }) => {
  // 预置两个窗口（浏览器里那个假「选文件夹」永远给同一个路径，加不出第二个）
  await page.addInitScript(() => {
    localStorage.setItem(
      'devtoolkit.agents.v1',
      JSON.stringify({
        workspaces: [
          { id: 'ws_alpha', path: 'D:\\work\\alpha', name: 'alpha' },
          { id: 'ws_beta', path: 'D:\\work\\beta', name: 'beta' },
        ],
      }),
    );
  });
  await page.reload();
  await page.getByTestId('module-agents').click();
  await expect(page.locator('[data-testid^="agent-ws-head-"]')).toHaveCount(2);

  // 搜目录名：只剩那一个窗口
  await page.getByTestId('agents-ws-search').fill('beta');
  await expect(page.locator('[data-testid^="agent-ws-head-"]')).toHaveCount(1);
  await expect(page.getByTestId('agent-ws-head-ws_beta')).toBeVisible();

  await page.getByTestId('agents-ws-search-clear').click();
  await expect(page.locator('[data-testid^="agent-ws-head-"]')).toHaveCount(2);

  // 在 alpha 里开一个会话（标题是 `claude #1`）
  await page.getByTestId('agent-new-session-ws_alpha').click();
  await page.getByTestId('agent-new-confirm').click();
  await expect(page.locator('.rd-agent-pane')).toHaveCount(1);

  // 搜**会话名**：会话行默认是收起的，所以这里同时验「那条窗口自动撑开」——
  // 撑不开的话用户搜到一个会话却看不见它
  await page.getByTestId('agents-ws-search').fill('claude #1');
  await expect(page.locator('[data-testid^="agent-ws-head-"]')).toHaveCount(1);
  await expect(page.getByTestId('agent-ws-head-ws_alpha')).toBeVisible();
  await expect(
    page.locator('[data-testid="agent-workspaces"] [data-session-title="claude #1"]'),
  ).toBeVisible();

  await page.getByTestId('agents-ws-search').fill('zzzz');
  await expect(page.getByTestId('agents-ws-nomatch')).toBeVisible();

  // 清空之后两条都回来
  await page.getByTestId('agents-ws-search-clear').click();
  await expect(page.locator('[data-testid^="agent-ws-head-"]')).toHaveCount(2);
});


test('Git Bash 路径：填了就存下来，下次打开还在', async ({ page }) => {
  // 老版 claude 在 Windows 上必须要 Git Bash，而用户的 Git 可能装在 PATH 之外
  // （真机上就是：D:\software\git\install\Git）。这个框是那条出路。
  await newSession(page);
  const wsId = await firstWorkspaceId(page);

  await page.getByTestId(`agent-new-session-${wsId}`).click();
  await page.getByTestId('agent-new-args').click();
  await page.getByTestId('agent-args-gitbash').fill('D:\\software\\git\\install\\Git\\bin\\bash.exe');
  await page.getByTestId('agent-args-save').click();

  // 回到数量那一页，再进来看看 —— 值该还在
  await expect(page.getByTestId('agent-new-dialog')).toBeVisible();
  await page.getByTestId('agent-new-args').click();
  await expect(page.getByTestId('agent-args-gitbash')).toHaveValue(
    'D:\\software\\git\\install\\Git\\bin\\bash.exe',
  );

  // 填了之后给一句「会原样交给 claude」的提示（路径对不对由 claude 说了算）
  await expect(page.getByTestId('agent-args-gitbash-set')).toBeVisible();
});

test('环境自检：把应用自己看到的 claude / bash / PATH 列出来', async ({ page }) => {
  // 真机上出过「VS Code 里 claude 好好的、窗格跑不起来」——差别只在环境，
  // 而环境是看不见的。这一格就是把它摊开（浏览器版给的是诚实的假报告）
  await newSession(page);

  await expect(page.getByTestId('agent-env')).toBeVisible();
  await expect(page.getByTestId('agent-env-detail')).toBeVisible();
  await expect(page.getByTestId('agent-env-claude')).toContainText('PATH 里找不到');
  await expect(page.getByTestId('agent-env-bash')).toContainText('找不到');

  // 重新自检也点得动（走一遍真链路：按钮 → store → 服务层 → 报告）
  await page.getByTestId('agent-env-refresh').click();
  await expect(page.getByTestId('agent-env-detail')).toBeVisible();
});
