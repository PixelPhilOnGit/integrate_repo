/**
 * 「体验」那一轮钉下的界面护栏（2026-10-15，v0.15.0）。
 *
 * 这一组防的都是**功能用例结构性地测不到**的东西：控件被挤出可视区、
 * 命中区只有 11px、排布串了行 —— 按 testid 填值的断言全绿，用户却点不中。
 * 所以这里量的是真实几何：boundingBox、以及「点在目标外几像素还命中不命中」。
 *
 * ⚠️ 扩容后的命中区**不出现在 boundingBox 里**（多条规则用 `::after` 往外探，
 * 视觉和布局都不动，见 styles.css `.rd-conn-caret` 处的技法注释）——
 * 所以对这类控件测的是 `elementFromPoint` 探针，不是盒子大小。
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
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto('/');
  await expect(page.getByTestId('app-shell')).toBeVisible();
});

async function box(page: Page, selector: string) {
  const b = await page.locator(selector).first().boundingBox();
  expect(b, `${selector} 应该有个盒子`).not.toBeNull();
  return b!;
}

/**
 * 在控件本体外 `beyond` 像素的四个方向各探一次：命中它（或它的后代）才算通过。
 * 用的是 `elementFromPoint` —— 伪元素命中会归给宿主元素，正好能把 ::after 的
 * 扩容区量出来。
 */
async function hitOutside(
  page: Page,
  selector: string,
  beyond: number,
  { vertical = true }: { vertical?: boolean } = {}
): Promise<boolean> {
  const r = await page.evaluate(
    ({ sel, b, vert }) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) return { ok: false, why: `${sel} 不在 DOM 里（共 ${document.querySelectorAll(sel).length} 个）` };
      const rect = el.getBoundingClientRect();
      const cx = rect.x + rect.width / 2;
      const cy = rect.y + rect.height / 2;
      const probes: Array<[number, number]> = [
        [cx - rect.width / 2 - b, cy], // 左
        [cx + rect.width / 2 + b, cy], // 右
      ];
      if (vert) {
        probes.push([cx, cy - rect.height / 2 - b]); // 上
        probes.push([cx, cy + rect.height / 2 + b]); // 下
      }
      const misses: string[] = [];
      for (const [px, py] of probes) {
        const hit = document.elementFromPoint(px, py);
        if (!(hit === el || el.contains(hit as Node))) {
          misses.push(
            `(${px.toFixed(1)},${py.toFixed(1)})→${hit ? `${hit.tagName}.${(hit as HTMLElement).dataset?.testid ?? String((hit as HTMLElement).className).slice(0, 24)}` : 'null'}`
          );
        }
      }
      return {
        ok: misses.length === 0,
        why: misses.length ? `rect=${JSON.stringify(rect.toJSON())} 未命中: ${misses.join(' ; ')}` : '',
      };
    },
    { sel: selector, b: beyond, vert: vertical }
  );
  if (!r.ok) {
    // 让失败信息一步到位（节点侧打印，浏览器 console 默认收不到）
    // eslint-disable-next-line no-console
    console.log(`[hitOutside] ${selector} beyond=${beyond}: ${r.why}`);
  }
  return r.ok;
}

test('小控件的命中区：箭头/抓手/⋯/清空，点偏几像素仍然命中', async ({ page }) => {
  // 顺序图文件树行尾的「⋯」（悬停才显形，但一直在 DOM 里、也一直都在命中）。
  // ⚠️ 只探横向：纵向的扩区在 23px 行距里必然和相邻行的 ⋯ 在缝隙处相遇
  // （谁赢取决于像素取整，不是坏），行高本身另有断言
  await page.getByTestId('current-path').waitFor();
  const more = await box(page, '.rd-tree-more');
  expect(more.height).toBeGreaterThanOrEqual(18);
  expect(await hitOutside(page, '.rd-tree-more', 2, { vertical: false })).toBe(true);

  // 智能体会话：工作目录的展开箭头 —— 用户为同类箭头报过三次「点不到」
  await page.getByTestId('module-agents').click();
  await page.getByTestId('agent-empty').waitFor();
  await page.getByTestId('agent-add-workspace-empty').click();
  const agentCaret = await box(page, '.rd-agent-caret');
  expect(agentCaret.width).toBeGreaterThanOrEqual(26);
  expect(agentCaret.height).toBeGreaterThanOrEqual(22);

  // 连接树：折叠箭头 + 拖拽抓手（要连上，行里才有库列表和抓手）
  await page.getByTestId('module-redis').click();
  await page.getByTestId('redis-main').waitFor();
  await openInspector(page); // 连接属性在检查器里
  await page.getByTestId('btn-new-connection').click();
  await page.getByTestId('redis-new-confirm').click();
  await page.getByTestId('btn-conn-toggle').click();
  await page.locator('[data-testid="conn-status"]').first().waitFor();
  expect(await hitOutside(page, '.rd-conn-caret', 2)).toBe(true);
  expect(await hitOutside(page, '.rd-conn-drag', 2)).toBe(true);

  // 接口调试：历史「清空」—— 破坏性动作，且此前只有 15×22
  await page.getByTestId('module-request').click();
  await page.getByTestId('request-main').waitFor();
  await page.getByTestId('request-url').fill('https://demo.example/json');
  await page.getByTestId('request-send').click();
  await page.getByTestId('request-status').waitFor();
  const clear = await box(page, '[data-testid="request-clear-history"]');
  expect(clear.width).toBeGreaterThanOrEqual(22);
  expect(clear.height).toBeGreaterThanOrEqual(22);

  // sql 引擎分组头的「＋」和目标 —— 和 agents 的加号共用一套几何
  await page.getByTestId('module-sql').click();
  await page.getByTestId('sql-main').waitFor();
  await openInspector(page);
  await page.getByTestId('btn-new-sql-connection').click();
  await page.getByTestId('sql-new-confirm').click();
  await page.getByTestId('btn-sql-conn-toggle').click();
  await page.locator('[data-testid="sql-status"]').first().waitFor();
  expect(await hitOutside(page, '.rd-agent-add', 2)).toBe(true);
});

test('窄窗下工具栏右侧不丢（回归：1024 宽时「主题/导出」被裁在视口外还没提示）', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 700 });
  await page.getByTestId('current-path').waitFor();
  // 右段（主题 + 三个导出）钉在可见区内 —— 它们此前跟着左段一起滚出去
  const inView = async (selector: string): Promise<boolean> => {
    const b = await page.locator(selector).first().boundingBox();
    return b !== null && b.x >= 0 && b.x + b.width <= 1024;
  };
  expect(await inView('[data-testid="theme-select"]')).toBe(true);
  expect(await inView('[data-testid="btn-export-png"]')).toBe(true);
  expect(await inView('[data-testid="btn-export-mermaid"]')).toBe(true);
  expect(await inView('button:has-text("SVG")')).toBe(true);
});

test('弹框的焦点圈与回车语义（回归：Tab 曾走出弹框、一次回车曾铡掉助手对话）', async ({
  page,
}) => {
  // (a) 新建连接弹框：Tab 圈在框内（此前第 7 次起就落到背景的模块页签上），
  //     输入框里的回车 = 点「新建」
  await page.getByTestId('module-redis').click();
  await page.getByTestId('redis-main').waitFor();
  await page.getByTestId('btn-new-connection').click();
  await expect(page.getByTestId('redis-new-name')).toBeFocused();
  for (let i = 0; i < 10; i += 1) await page.keyboard.press('Tab');
  const stillInside = await page.evaluate(() => {
    const dialog = document.querySelector('[data-testid="redis-new-dialog"]');
    return dialog?.contains(document.activeElement) ?? false;
  });
  expect(stillInside).toBe(true);
  await page.getByTestId('redis-new-host').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('redis-new-dialog')).toHaveCount(0);

  // (b) ssh 信任弹窗：初始焦点在「取消」（安全默认）——此前进场时焦点还在
  //     BODY 上，Tab 两下再回车能把底下的模块切走
  await page.getByTestId('module-ssh').click();
  await page.getByTestId('ssh-main').waitFor();
  await openInspector(page); // 密码那一格在检查器里
  await page.getByTestId('ssh-btn-new').click();
  await page.getByTestId('ssh-new-confirm').click();
  await page.getByTestId('ssh-field-password').fill('secret');
  await page.getByTestId('ssh-btn-connect').click();
  await expect(page.getByTestId('ssh-trust-dialog')).toBeVisible();
  await expect(page.getByTestId('ssh-trust-cancel')).toBeFocused();
  for (let i = 0; i < 6; i += 1) await page.keyboard.press('Tab');
  const trustInside = await page.evaluate(() => {
    const dialog = document.querySelector('[data-testid="ssh-trust-dialog"]');
    return dialog?.contains(document.activeElement) ?? false;
  });
  expect(trustInside).toBe(true);
  await page.keyboard.press('Escape');

  // (c) 助手审批：焦点进到「允许」；这时按回车 = 允许。
  //     此前焦点留在刚点过的按钮上（它已经变成「停止」），一次回车把整轮对话铡了
  await page.getByTestId('module-assistant').click();
  await openInspector(page);
  await page.getByTestId('assistant-inspector').waitFor();
  await page.getByTestId('assistant-key-input').fill('sk-test');
  await page.getByTestId('assistant-key-save').click();
  await page.getByTestId('assistant-pick-workspace').click();
  await page.getByTestId('assistant-input').fill('帮我写一个文件');
  await page.getByTestId('assistant-send').click();
  await expect(page.getByTestId('assistant-approval')).toBeVisible();
  await expect(page.getByTestId('assistant-approval-allow')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('assistant-approval')).toHaveCount(0);
  // 这一轮真的继续跑完了：收尾那句「好了。」是审批**之后**才发的
  // （「整个停掉」会在审批处直接中断，不会有它）
  await expect(page.getByTestId('assistant-running')).toHaveCount(0);
  await expect(page.locator('[data-testid="assistant-msg-assistant"]').last()).toContainText(
    '好了。'
  );
});

/**
 * 文件浏览器（智能体会话「文件」标签，2026-10-16）的几何护栏：
 * 刷新按钮的命中区、分界线的拖拽目标宽度、标签按钮的高度。
 * 空态下这些控件都不在 DOM 里，所以要先把「文件」标签点出来。
 */
test('群组：@ 候选行高与「＋成员」命中区', async ({ page }) => {
  await page.getByTestId('module-group').click();
  await expect(page.getByTestId('group-main')).toBeVisible();
  await page.getByTestId('group-new-empty').click();
  await page.getByTestId('group-new-name').fill('口径群');
  await page.getByTestId('group-new-confirm').click();
  await openInspector(page);

  await page.getByTestId('group-member-add').click();
  const card = page.getByTestId('group-member-card').last();
  const nameInput = card.getByTestId('group-member-name');
  await nameInput.fill('甲');
  await nameInput.blur();

  // ＋ 是小图标按钮：视觉小，命中区不能小（体验评审的 22px 下限）
  const add = await box(page, '[data-testid="group-member-add"]');
  expect(add.width).toBeGreaterThanOrEqual(22);
  expect(add.height).toBeGreaterThanOrEqual(22);

  // @ 候选行：键盘/鼠标都要点得中
  await page.getByTestId('group-input').fill('@');
  await expect(page.getByTestId('group-mention-panel')).toBeVisible();
  const item = await box(page, '[data-testid="group-mention-item"]');
  expect(item.height).toBeGreaterThanOrEqual(22);
});

test('文件浏览器：刷新按钮命中区、分界线够宽、标签不矮', async ({ page }) => {
  await page.getByTestId('module-agents').click();
  await page.getByTestId('agent-empty').waitFor();
  await page.getByTestId('agent-add-workspace-empty').click();
  await openInspector(page); // 「文件」标签在检查器里
  await page.getByTestId('agent-tab-files').click();
  await page.getByTestId('agent-explorer').waitFor();

  // 常规按钮量**盒子**（≥22 双方）—— 口径同 request 的「清空历史」。
  // hitOutside 探针是留给「::after 往外探」的小字形控件（⋯、抓手）的，
  // 普通按钮没有扩容机制，探外面必然落空
  const refresh = await box(page, '[data-testid="agent-explorer-refresh"]');
  expect(refresh.height).toBeGreaterThanOrEqual(22);
  expect(refresh.width).toBeGreaterThanOrEqual(22);

  // 分界线是**拖拽目标**：按 .rd-slot-handle 同一条口径量宽度（≥6px），
  // 不用 hitOutside —— 它没有 ::after 扩容，量本体就行
  const split = await box(page, '[data-testid="agent-explorer-split"]');
  expect(split.height).toBeGreaterThanOrEqual(6);

  // 两个标签按钮都得有常规命中高度（`.rd-tabs button` 的 padding 撑起来的）
  for (const id of ['agent-tab-session', 'agent-tab-files']) {
    const tab = await box(page, `[data-testid="${id}"]`);
    expect(tab.height).toBeGreaterThanOrEqual(22);
  }
});
