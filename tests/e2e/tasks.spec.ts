/**
 * 任务模块的端到端测试。
 *
 * 浏览器里跑的是 `services/web.ts` 那份内存假实现 —— 它和 Rust 那边**一个语义**
 * （patch 没提到的字段不动、标完成记时间、改回去清掉）。所以这一组验的是
 * **界面链路**：新建 → 编辑 → 改状态 → 资料（文字/文件）→ 搜 → 删。
 *
 * 验不了的（归 Rust 集成测试）：真落盘、结构迁移、并发写；**真文件对话框**
 * 也到不了这里 —— 那是 Rust 侧的事（见 `task_commands.rs` 的模块头），
 * 「＋文件」在浏览器版直接造一条假资料顶上（见 `services/web.ts`）。
 */

import { expect, test, type Page } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('app-shell')).toBeVisible();
  await page.getByTestId('module-tasks').click();
  await expect(page.getByTestId('task-sidebar')).toBeVisible();
  // 检查器默认折叠之后，「标完成」这些在检查器里的控件要先点开
  await openInspector(page);
});

/** 侧栏里某一行的标题（按 id 选不稳，id 是随机生成的） */
function rows(page: Page) {
  return page.locator('[data-testid^="task-row-"]');
}

/** 资料条目（`<li>` 才有这个 testid；里面的按钮/框是另外的 testid，不会混进来） */
function materials(page: Page) {
  return page.locator('li[data-testid^="task-material-"]');
}

/** 建一条任务并把标题改成 `title`（标题框是自动聚焦的） */
/** 检查器现在**默认折叠**（v0.16.0）：要碰它里面的东西，先点开右边的把手 */
async function openInspector(page: Page): Promise<void> {
  const toggle = page.getByTestId('inspector-toggle');
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute('aria-pressed')) === 'false') {
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  }
}

async function newTask(page: Page, title: string): Promise<void> {
  await page.getByTestId('task-new').click();
  const titleBox = page.getByTestId('task-title');
  await expect(titleBox).toBeFocused(); // 新建之后光标就在标题上 —— 这是刻意的
  await titleBox.fill(title);
  await titleBox.press('Enter');
  await expect(rows(page).filter({ hasText: title })).toHaveCount(1);
}

/**
 * 给当前选中那条加一条文字资料：点「＋文字」→ 草稿框自动聚焦 → 打字 →
 * 点别处（`blur`）就存下 —— 和界面上的使用方式一模一样。
 */
async function addTextMaterial(page: Page, text: string): Promise<void> {
  await page.getByTestId('task-text-add').click();
  const draft = page.getByTestId('task-material-draft-input');
  await expect(draft).toBeFocused();
  await draft.fill(text);
  await draft.blur();
  // 存下的条目得真的出现（不然后面的断言全在空气上）
  await expect(materials(page).filter({ hasText: text })).toHaveCount(1);
}

test('连点新建不会落两条空任务；Esc 可以把刚建的空任务撤掉（回归）', async ({ page }) => {
  // 2026-10-15 体验评审：新建是即落库的 —— 此前连点两下 = 两条「新任务」，
  // Esc 也什么都不做，手滑建出来的只能手动去删
  await expect(page.getByTestId('task-empty')).toBeVisible();

  await page.getByTestId('task-new').click();
  await expect(rows(page)).toHaveCount(1);
  await expect(page.getByTestId('task-title')).toBeFocused();
  // 第二下：仍然只有一条（复用刚建的那条空任务，而不是再落一条）
  await page.getByTestId('task-new').click();
  await expect(rows(page)).toHaveCount(1);

  // 空任务上按 Esc（标题没动过）= 放弃整条
  await page.getByTestId('task-title').click();
  await page.getByTestId('task-title').press('Escape');
  await expect(rows(page)).toHaveCount(0);
  await expect(page.getByTestId('task-empty')).toBeVisible();

  // 建一条、打了半截标题再 Esc：只撤销这次编辑，任务还在、标题回默认
  await page.getByTestId('task-new').click();
  await page.getByTestId('task-title').fill('买牛奶');
  await page.getByTestId('task-title').press('Escape');
  await expect(rows(page)).toHaveCount(1);
  await expect(page.getByTestId('task-title')).toHaveValue('新任务');

  // 有内容的（这里：改了名）不受「连点新建」影响 —— 照常落新的一条
  await page.getByTestId('task-title').fill('买牛奶');
  await page.getByTestId('task-title').press('Enter');
  await page.getByTestId('task-new').click();
  await expect(rows(page)).toHaveCount(2);
});

test('记一条任务：新建 → 标题自动聚焦 → 改描述 → 标完成', async ({ page }) => {
  await expect(page.getByTestId('task-empty')).toBeVisible();

  await newTask(page, '写登录页');

  // 描述
  await page.getByTestId('task-body').fill('手机号 + 验证码，错误提示要具体');
  await page.getByTestId('task-body').blur();
  // 失焦之后存进了库 —— 再点回来读到的应该是刚写的那句
  await page.getByTestId('task-body').click();
  await expect(rows(page).first()).toHaveAttribute('data-task-status', 'todo');

  // 标完成
  await page.getByTestId('task-set-done').click();
  await expect(rows(page).first()).toHaveAttribute('data-task-status', 'done');
  await expect(page.getByTestId('task-done-at')).toBeVisible();

  // 改回进行中：那行「完成于」要消失（时间戳清了）
  await page.getByTestId('task-set-doing').click();
  await expect(rows(page).first()).toHaveAttribute('data-task-status', 'doing');
  await expect(page.getByTestId('task-done-at')).toHaveCount(0);
});

test('搜索：标题、描述、资料都搜得到，搜不到有提示和出口', async ({ page }) => {
  await newTask(page, '写登录页');
  await page.getByTestId('task-body').fill('要支持手机号');
  await page.getByTestId('task-body').blur();
  await newTask(page, '修连接池泄漏');
  await addTextMaterial(page, '是那个定时器没清');

  await expect(rows(page)).toHaveCount(2);

  // 搜标题
  await page.getByTestId('task-search').fill('登录');
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText('写登录页');

  // 搜描述（命中同一条）
  await page.getByTestId('task-search').fill('手机号');
  await expect(rows(page)).toHaveCount(1);

  // 搜资料（命中另一条）—— 很多信息是做完之后才写进去的
  await page.getByTestId('task-search').fill('定时器');
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText('修连接池泄漏');

  // 搜不到：给提示 + 一个清筛选的出口
  await page.getByTestId('task-search').fill('根本没有这个词');
  await expect(page.getByTestId('task-nomatch')).toBeVisible();
  await expect(rows(page)).toHaveCount(0);

  await page.getByTestId('task-clear-filter').click();
  await expect(rows(page)).toHaveCount(2);
  await expect(page.getByTestId('task-search')).toHaveValue('');
});

test('状态筛选和搜索是「同时生效」，不是各算各的', async ({ page }) => {
  await newTask(page, '写登录页');
  await newTask(page, '修连接池泄漏');
  await page.getByTestId('task-set-done').click(); // 把当前这条（连接池）标完成

  await page.getByTestId('task-filter-done').click();
  await expect(rows(page)).toHaveCount(1);

  // 在「已完成」里搜一条待办的标题：**不该出现**
  await page.getByTestId('task-search').fill('登录');
  await expect(rows(page)).toHaveCount(0);

  await page.getByTestId('task-clear-filter').click();
  await expect(rows(page)).toHaveCount(2);
});

test('删除要确认；取消就不删', async ({ page }) => {
  await newTask(page, '别删我');
  await newTask(page, '删了吧');

  // 取消
  page.once('dialog', (d) => void d.dismiss());
  await page.getByTestId('task-delete').click();
  await expect(rows(page)).toHaveCount(2);

  // 确认
  page.once('dialog', (d) => void d.accept());
  await page.getByTestId('task-delete').click();
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText('别删我');
});

test('切到别的模块再回来，任务和筛选都还在', async ({ page }) => {
  await newTask(page, '跨模块还在');

  await page.getByTestId('module-redis').click();
  await expect(page.getByTestId('redis-main')).toBeVisible();
  await page.getByTestId('module-tasks').click();

  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText('跨模块还在');
});

test('图标栏角标数的是「还没做完的」', async ({ page }) => {
  await newTask(page, '一条待办');
  await expect(page.getByTestId('tasks-badge')).toHaveText('1');

  await newTask(page, '第二条');
  await expect(page.getByTestId('tasks-badge')).toHaveText('2');

  // 标完成之后角标退回去
  await page.getByTestId('task-set-done').click();
  await expect(page.getByTestId('tasks-badge')).toHaveText('1');
});

test('进度记录 + 归档：记几笔 → 归档 → 在归档档里连进度一起回顾', async ({ page }) => {
  // 用户的原话：「归档后最后回顾才能知道」—— 所以这条用例的重头戏是
  // **归档之后进度还在不在**
  await newTask(page, '重构连接池');

  await page.getByTestId('task-progress-input').fill('先看了一遍现有实现');
  await page.getByTestId('task-progress-add').click();
  await expect(page.getByTestId('task-progress-list')).toContainText('先看了一遍现有实现');

  // 回车也能记（连续记几笔时不该每次都去点按钮）
  await page.getByTestId('task-progress-input').fill('发现是定时器没清');
  await page.getByTestId('task-progress-input').press('Enter');
  await expect(page.getByTestId('task-progress-list')).toContainText('发现是定时器没清');
  // 记完输入框该空掉，接着记下一笔
  await expect(page.getByTestId('task-progress-input')).toHaveValue('');

  await page.getByTestId('task-set-done').click();
  await page.getByTestId('task-archive').click();

  // 常规列表里收起来了
  await expect(rows(page)).toHaveCount(0);
  await expect(page.getByTestId('task-filter-archived')).toBeVisible();

  // 归档那一档里能看到，**而且进度一笔不少**
  await page.getByTestId('task-filter-archived').click();
  await expect(rows(page)).toHaveCount(1);
  await rows(page).first().click();
  const timeline = page.getByTestId('task-progress-list');
  await expect(timeline).toContainText('先看了一遍现有实现');
  await expect(timeline).toContainText('发现是定时器没清');

  // 取消归档 → 回到常规列表
  await page.getByTestId('task-archive').click();
  await page.getByTestId('task-filter-all').click();
  await expect(rows(page)).toHaveCount(1);
});

test('资料：加文字 → 链接可点 → 改内容切走回来还在 → 清空回退 → 删除', async ({ page }) => {
  await newTask(page, '资料那条');
  await expect(page.getByTestId('task-materials-empty')).toBeVisible();

  // 空草稿：点了「＋文字」什么都不写、点别处 —— 自己收掉，不落库、不报错
  await page.getByTestId('task-text-add').click();
  await expect(page.getByTestId('task-material-draft-input')).toBeFocused();
  await page.getByTestId('task-body').click();
  await expect(page.getByTestId('task-material-draft-input')).toHaveCount(0);
  await expect(page.getByTestId('task-materials-empty')).toBeVisible();

  await addTextMaterial(page, '是定时器没清，参考 https://example.com/issue/42 ，回头再看');
  // ⚠️ 拿到它的 testid 之后就不再按文字定位：Playwright 的文字匹配**算得上
  // textarea 的当前值**，后面「清空输入框」那一步会让按文字找的定位器失配
  const liId = await materials(page).filter({ hasText: '定时器' }).getAttribute('data-testid');
  expect(liId).toBeTruthy();
  const item = page.getByTestId(liId as string);

  // 文字里的链接被切出来，是一个可点的东西（浏览器版点击是空操作，不炸就行）
  const link = item.getByTestId('task-material-link');
  await expect(link).toHaveCount(1);
  await expect(link).toHaveText('https://example.com/issue/42');
  await link.click();

  // 改内容：失焦保存。切到另一条任务再回来 —— 改过的还在（真存进去了）
  await item.locator('textarea').fill('是定时器没清（已修）');
  await item.locator('textarea').blur();
  await newTask(page, '另一条');
  await rows(page).filter({ hasText: '资料那条' }).click();
  await expect(page.getByTestId('task-materials')).toContainText('（已修）');

  // 清空 → 失焦 → **回退成库里的值**（空的不收，要删只能走 ✕）
  const box = item.locator('textarea');
  await box.fill('');
  await box.blur();
  await expect(box).toHaveValue(/（已修）/);

  // ✕ 删除
  await item.locator('[data-testid^="task-material-remove-"]').click();
  await expect(page.getByTestId('task-materials-empty')).toBeVisible();
});

test('资料：挂文件 → 缩略图 → 点开大图 → 文件名也进搜索 → 删除', async ({ page }) => {
  await newTask(page, '带一份资料');

  // 「＋文件」在浏览器版直接造一条假资料（真对话框在 Rust 侧开，e2e 到不了
  // 那儿）。假资料是「示例截图.png」+ 真 PNG 字节 —— 图片那条展示路径要靠它验
  await page.getByTestId('task-file-add').click();
  const item = materials(page).filter({ hasText: '示例截图.png' });
  await expect(item).toHaveCount(1);

  // 缩略图真的画出来了（走到「读字节 → Blob → img」这一步才有的）
  const thumb = item.locator('[data-testid^="task-material-thumb-"]');
  await expect(thumb.locator('img')).toBeVisible();

  // 点开大图：全屏那一层出来，Esc 关
  await thumb.click();
  await expect(page.getByTestId('task-image-viewer')).toBeVisible();
  await expect(page.getByTestId('task-image-viewer').locator('img')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('task-image-viewer')).toHaveCount(0);

  // 文件名也进搜索（「那个截图放哪了」问的是同一个问题）
  await page.getByTestId('task-search').fill('示例截图');
  await expect(rows(page)).toHaveCount(1);
  await page.getByTestId('task-search').fill('');

  // 删除条目（真机上这一步会连盘上那份文件一起删，归 Rust 集成测试验）
  await item.locator('[data-testid^="task-material-remove-"]').click();
  await expect(item).toHaveCount(0);
  await expect(page.getByTestId('task-materials-empty')).toBeVisible();
});

test('待办项：加、勾、取消勾、改文字、删（清单一条条走完）', async ({ page }) => {
  await newTask(page, '上线前的检查');

  // 空态在
  await expect(page.getByTestId('task-todos-empty')).toBeVisible();

  // 加两条（回车提交）
  const input = page.getByTestId('task-todo-input');
  await input.fill('先改配置');
  await input.press('Enter');
  await input.fill('再跑回归');
  await input.press('Enter');

  const todos = page.locator('li[data-testid^="task-todo-"]');
  await expect(todos).toHaveCount(2);
  await expect(page.getByTestId('task-todos-count')).toHaveText('0/2');

  // 勾掉第一条：计数变、文字带删除线（class is-done）
  const first = todos.filter({ hasText: '先改配置' });
  await first.locator('input[type="checkbox"]').check();
  await expect(page.getByTestId('task-todos-count')).toHaveText('1/2');
  await expect(first).toHaveClass(/is-done/);

  // 取消勾选：回到 0/2（doneAt 由后端清掉，界面上就是回到没勾的样子）
  await first.locator('input[type="checkbox"]').uncheck();
  await expect(page.getByTestId('task-todos-count')).toHaveText('0/2');
  await expect(first).not.toHaveClass(/is-done/);

  // 双击改文字
  await first.getByText('先改配置').dblclick();
  const rename = page.locator('[data-testid^="task-todo-rename-"]');
  await rename.fill('先改好配置');
  await rename.press('Enter');
  await expect(todos.filter({ hasText: '先改好配置' })).toHaveCount(1);

  // 删一条
  const second = todos.filter({ hasText: '再跑回归' });
  await second.locator('button').click();
  await expect(todos).toHaveCount(1);
  await expect(page.getByTestId('task-todos-count')).toHaveText('0/1');

  // 搜索能搜到待办里的词（「那条要改配置的任务」）
  await page.getByTestId('task-search').fill('改好配置');
  await expect(rows(page)).toHaveCount(1);
  await page.getByTestId('task-search').fill('');
});
