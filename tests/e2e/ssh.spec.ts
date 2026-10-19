/**
 * SSH 模块的端到端测试。
 *
 * 跑在普通 Chromium 里，打的是 `services/web.ts` 那份**内存假实现** ——
 * 假 shell 真的维护当前目录、命令历史和一个内存文件系统（见
 * `core/fakeSsh.ts` 的头部说明），所以这里的断言打的是**真实行为**而不是
 * 写死的预期：`cd 项目` 之后再 `pwd` 真的会变。
 *
 * 覆盖不到的那部分（真的 SSH 协议、PTY 尺寸、对真 OpenSSH 能不能用）
 * 由 Rust 那两组集成测试负责 —— 浏览器这边刻意不假装测过。
 */

import { expect, test, type Locator, type Page } from '@playwright/test';

/** 检查器现在**默认折叠**（v0.16.0）：要碰它里面的东西，先点开右边的把手 */
async function openInspector(page: Page): Promise<void> {
  const toggle = page.getByTestId('inspector-toggle');
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute('aria-pressed')) === 'false') {
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  }
}
import {
  CHANGED_KEY_HOST,
  UNREACHABLE_HOST,
  fakeFingerprint,
} from '../../src/modules/ssh/core/fakeSsh';

const STORAGE_KEY = 'devtoolkit.ssh.v1';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/');
  await expect(page.getByTestId('app-shell')).toBeVisible();
  await page.getByTestId('module-ssh').click();
  await expect(page.getByTestId('ssh-main')).toBeVisible();
  // 连接属性 / 格式化面板都在检查器里 —— 默认折叠之后先点开
  await openInspector(page);
});

// ------------------------------------------------------------------ 工具

/**
 * 当前**挂着**的那个终端会话 id。
 *
 * 必须限定在 `ssh-term-host` 里面：切走的终端不会被销毁，而是挪到屏幕外的
 * 存放点里，那些容器同样带着 `data-testid`，直接选择会选到好几个。
 */
async function activeTerminalId(page: Page): Promise<string> {
  const testid = await page
    .locator('[data-testid="ssh-term-host"] [data-testid^="ssh-term-"]')
    .first()
    .getAttribute('data-testid');
  return (testid ?? '').replace('ssh-term-', '');
}

/**
 * 终端里已经显示出来的文本。
 *
 * 读的是 xterm 自己的缓冲区（开发构建挂出来的钩子），不是渲染出来的 DOM ——
 * 后者换个渲染后端就没了。
 */
async function termText(page: Page): Promise<string> {
  const id = await activeTerminalId(page);
  return page.evaluate((sessionId) => {
    const hub = (window as unknown as { __sshHub?: { snapshot(id: string): string | null } })
      .__sshHub;
    return hub?.snapshot(sessionId) ?? '';
  }, id);
}

/**
 * 在终端里敲一条命令。
 *
 * 走的是**用户的真实输入路径**：聚焦 xterm 那个隐藏的 textarea，然后按键。
 * 直接调 `onData` 之类的捷径会让「键盘 → xterm → onData → 后端」这一段
 * 整个没被验证过，而那正是终端最容易出错的一截。
 */
async function type(page: Page, line: string): Promise<void> {
  await page.locator('[data-testid="ssh-term-host"] [data-testid^="ssh-term-"] textarea').focus();
  await page.keyboard.type(line);
  await page.keyboard.press('Enter');
}

/**
 * 新建一个连接，填好参数，点连接。
 *
 * **密码默认填一个**：新建出来的档案密码是空的，而校验要求非空（SSH 没有凭据
 * 连不上，后端也会拦），所以不填的话「连接」按钮是禁用的。
 */
async function connectNew(
  page: Page,
  options: { username?: string; password?: string; host?: string } = {},
): Promise<void> {
  // reload 之后偏好被清、检查器回到折叠 —— 统一在这里补开
  await openInspector(page);
  await page.getByTestId('ssh-btn-new').click();
  // ⚠️ 弹框要点确认才真的建（先收集后建 —— 取消的话 store 一个字没动）。
  // 这里用默认值建出来，参数照旧在后面那些 `ssh-field-*` 里填 —— 那是**右侧
  // 完整表单**，也就是用户改已有连接的那条路，同样要盖到。
  await page.getByTestId('ssh-new-confirm').click();
  if (options.host !== undefined) {
    await page.getByTestId('ssh-field-host').fill(options.host);
  }
  if (options.username !== undefined) {
    await page.getByTestId('ssh-field-username').fill(options.username);
  }
  await page.getByTestId('ssh-field-password').fill(options.password ?? 'secret');
  await page.getByTestId('ssh-btn-connect').click();
}

/** 走到「终端已经能打字」那一步 */
async function connectAndTrust(page: Page, options = {}): Promise<void> {
  await connectNew(page, options);
  await expect(page.getByTestId('ssh-trust-dialog')).toBeVisible();
  await page.getByTestId('ssh-trust-accept').click();
  await expect(page.getByTestId('ssh-trust-dialog')).toBeHidden();
  await expect(page.getByTestId('ssh-status')).toContainText('已连接');
}

// ------------------------------------------------------------------ 基本链路

test('新建连接、首次信任、终端里能敲命令', async ({ page }) => {
  await expect(page.getByTestId('ssh-conn-list')).toContainText('还没有连接');

  await connectNew(page);

  // 第一次连一台机器必须问 —— 这是整个模块的安全模型，不能默认放行
  await expect(page.getByTestId('ssh-trust-dialog')).toBeVisible();
  const fingerprint = await page.getByTestId('ssh-trust-fingerprint').textContent();
  expect(fingerprint).toMatch(/^SHA256:/);
  // 假指纹也必须是 43 个字符的 base64（长的和真的一样），否则这个弹窗
  // 在浏览器里就没有「要逐字符比对」的形态可言了
  expect(fingerprint?.replace('SHA256:', '')).toHaveLength(43);

  await page.getByTestId('ssh-trust-accept').click();
  await expect(page.getByTestId('ssh-status')).toContainText('已连接');

  // 横幅和提示符该已经出来了
  await expect.poll(() => termText(page)).toContain('SuperIndividual');

  await type(page, 'whoami');
  await expect.poll(() => termText(page)).toContain('root');
});

test('命令是真的在执行 —— cd 之后再 pwd 会变', async ({ page }) => {
  await connectAndTrust(page);

  // 家目录跟着用户名走：root 是 /root（和真 Linux 一致）
  await type(page, 'pwd');
  await expect.poll(() => termText(page)).toContain('/root');

  // 中文目录名要走完整条编码链路（键盘 → UTF-8 → 假 shell → UTF-8 → xterm）
  await type(page, 'cd 项目');
  await type(page, 'pwd');
  await expect.poll(() => termText(page)).toContain('/root/项目');
});

test('中文内容能原样走完整条链路', async ({ page }) => {
  await connectAndTrust(page);

  await type(page, 'ls');
  await expect.poll(() => termText(page)).toContain('readme.txt');

  await type(page, 'cat 项目/说明.md');
  await expect.poll(() => termText(page)).toContain('演示项目');
});

test('打错的命令报错但**不弹外壳错误条**', async ({ page }) => {
  await connectAndTrust(page);

  await type(page, '不存在的命令');
  await expect.poll(() => termText(page)).toContain('command not found');

  // 敲错命令是终端里的家常便饭，弹错误条会把整个界面搞得很吵 ——
  // 和 Redis / SQL 那条「服务器报错是结果不是故障」是同一条守门
  await expect(page.getByTestId('error-banner')).toBeHidden();
});

test('退格和 Ctrl+C 都是真的行规程在起作用', async ({ page }) => {
  await connectAndTrust(page);

  // 同 `type()`：必须限定在宿主里，屏幕外存放点里那些容器也带着同样的 testid
  const textarea = page.locator('[data-testid="ssh-term-host"] [data-testid^="ssh-term-"] textarea');
  await textarea.focus();
  await page.keyboard.type('wrogn');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.keyboard.type('ho');
  await page.keyboard.press('Enter');
  await expect.poll(() => termText(page)).toContain('root');

  // Ctrl+C 丢开当前这行，不执行
  await page.keyboard.type('这行不要执行');
  await page.keyboard.press('Control+c');
  await page.keyboard.type('echo 之后');
  await page.keyboard.press('Enter');
  await expect.poll(() => termText(page)).toContain('之后');
});

test('exit 之后退出码显示出来，而且**不弹错误条**', async ({ page }) => {
  await connectAndTrust(page);

  await type(page, 'exit 3');

  await expect(page.getByTestId('ssh-status-exit')).toContainText('退出码 3');
  await expect.poll(() => termText(page)).toContain('退出码 3');
  // 「远端正常退出」是个结果，不是故障
  await expect(page.getByTestId('error-banner')).toBeHidden();
});

// ------------------------------------------------------------------ 多标签

test('一个连接可以开多个终端，切来切去内容都在', async ({ page }) => {
  await connectAndTrust(page);

  // 第二个标签
  await page.getByTestId('ssh-btn-connect').click();
  await expect(page.getByTestId('ssh-status')).toContainText('已连接');
  await type(page, 'echo 第二个终端');
  await expect.poll(() => termText(page)).toContain('第二个终端');

  const tabs = page.locator('[data-testid="ssh-tabs"] [data-session-title]');
  await expect(tabs).toHaveCount(2);

  // 切回第一个：它里面的东西该还在（终端是**藏起来**不是销毁的）
  await tabs.first().click();
  await expect.poll(() => termText(page)).not.toContain('第二个终端');

  await tabs.nth(1).click();
  await expect.poll(() => termText(page)).toContain('第二个终端');
});

test('关掉一个标签，另一个还在', async ({ page }) => {
  await connectAndTrust(page);
  await page.getByTestId('ssh-btn-connect').click();
  await expect(page.getByTestId('ssh-status')).toContainText('已连接');

  const tabs = page.locator('[data-testid="ssh-tabs"] [data-session-title]');
  await expect(tabs).toHaveCount(2);

  await page.locator('[data-testid="ssh-tabs"] [data-testid^="ssh-tab-close-"]').first().click();
  await expect(tabs).toHaveCount(1);
  await expect(page.getByTestId('ssh-status')).toContainText('已连接');
});

test('⚠️ 侧栏那个按钮连上之后是「新开」，点它只多一个标签', async ({ page }) => {
  await connectAndTrust(page);

  // 侧栏一行上那个按钮做的事是「再开一个终端」，所以它**不能**在连上之后
  // 自称「断开」—— 那正是原来的 bug：文案归共享组件按连接状态算，
  // 按钮却只新开会话，用户点「断开」点出来一个新终端
  const toggle = page
    .locator('[data-testid="ssh-conn-list"] [data-testid^="conn-toggle-"]')
    .first();
  await expect(toggle).toHaveText('新开');
  await expect(toggle).toHaveAttribute('title', '在同一个连接上再开一个终端');

  const tabs = page.locator('[data-testid="ssh-tabs"] [data-session-title]');
  await expect(tabs).toHaveCount(1);

  await toggle.click();
  await expect(tabs).toHaveCount(2);
  // 两个会话都活着：是**多**开一个，不是把原来那个换掉
  await expect(page.getByTestId('ssh-status')).toContainText('已连接');
  await expect(toggle).toHaveText('新开');
});

test('标签栏的关闭按钮能关掉这一条，另一条留下（侧栏不再有会话行）', async ({ page }) => {
  await connectAndTrust(page);
  await page.getByTestId('ssh-btn-connect').click();
  await expect(page.getByTestId('ssh-status')).toContainText('已连接');

  const tabs = page.locator('[data-testid="ssh-tabs"] [data-session-title]');
  await expect(tabs).toHaveCount(2);

  // ⚠️ 2026-10-15 起**侧栏不再显示会话**（用户定的：「连接就是叶子节点」）——
  // 关单条会话走标签栏里那个 ×（本来就有，侧栏那份是重复）
  await tabs.nth(1).locator('[data-testid^="ssh-tab-close-"]').click();
  await expect(tabs).toHaveCount(1);
});

test('切到别的模块再回来，会话和画面都还在', async ({ page }) => {
  await connectAndTrust(page);
  await type(page, 'echo 切模块之前');
  await expect.poll(() => termText(page)).toContain('切模块之前');

  await page.getByTestId('module-redis').click();
  await expect(page.getByTestId('app-shell')).toBeVisible();
  await page.getByTestId('module-ssh').click();

  // 会话没断
  await expect(page.getByTestId('ssh-status')).toContainText('已连接');
  // 画面也还在 —— 终端是藏到屏幕外，不是销毁重建
  await expect.poll(() => termText(page)).toContain('切模块之前');
});

// ------------------------------------------------------------------ 失败分支

test('连不上的地址：检查器里报错，不弹错误条', async ({ page }) => {
  await connectNew(page, { host: UNREACHABLE_HOST });

  await expect(page.getByTestId('ssh-conn-error')).toBeVisible();
  await expect(page.getByTestId('ssh-conn-error')).toContainText('无法解析主机名或者连接被拒绝');
  // 一次没连上不该满屏红字：错误就摆在导致它的那几个参数旁边
  await expect(page.getByTestId('error-banner')).toBeHidden();
  // 也不会留下一个空的标签页
  await expect(page.locator('[data-testid="ssh-tabs"] [data-session-title]')).toHaveCount(0);
});

test('密码被拒：说清楚是凭据的问题', async ({ page }) => {
  await connectNew(page, { username: 'nobody', password: '随便' });
  await expect(page.getByTestId('ssh-trust-dialog')).toBeVisible();
  await page.getByTestId('ssh-trust-accept').click();

  await expect(page.getByTestId('ssh-conn-error')).toBeVisible();
  await expect(page.getByTestId('ssh-conn-error')).toContainText('用户名或密码不正确');
  await expect(page.getByTestId('error-banner')).toBeHidden();
});

test('取消首次信任就不连了，也不会留下标签', async ({ page }) => {
  await connectNew(page);
  await expect(page.getByTestId('ssh-trust-dialog')).toBeVisible();

  await page.getByTestId('ssh-trust-cancel').click();
  await expect(page.getByTestId('ssh-trust-dialog')).toBeHidden();
  await expect(page.locator('[data-testid="ssh-tabs"] [data-session-title]')).toHaveCount(0);
});

test('信任过一次之后再连就不再问了', async ({ page }) => {
  await connectAndTrust(page);
  await page.locator('[data-testid="ssh-tabs"] [data-testid^="ssh-tab-close-"]').first().click();

  await page.getByTestId('ssh-btn-connect').click();
  await expect(page.getByTestId('ssh-status')).toContainText('已连接');
  await expect(page.getByTestId('ssh-trust-dialog')).toBeHidden();
});

// ------------------------------------------------------------------ 密钥变更

test('⚠️ 指纹变了：硬停，把新旧都摆出来，并提示怎么解', async ({ page }) => {
  // 预埋一条「之前信任过」的记录，指纹是**另一个端口**算出来的 ——
  // 也就是说，服务器这次报的肯定和它不一样
  const trusted = fakeFingerprint(CHANGED_KEY_HOST, 2222);
  await page.addInitScript(
    ([key, host, fingerprint]) => {
      localStorage.setItem(
        key,
        JSON.stringify({
          knownHosts: [{ host, port: 22, algorithm: 'ssh-ed25519', fingerprint, addedAt: '' }],
        }),
      );
    },
    [STORAGE_KEY, CHANGED_KEY_HOST, trusted] as const,
  );
  await page.reload();
  await page.getByTestId('module-ssh').click();

  await connectNew(page, { host: CHANGED_KEY_HOST });

  const warn = page.getByTestId('ssh-mismatch');
  await expect(warn).toBeVisible();
  await expect(warn).toContainText('主机密钥和上次不一样了');
  // 新旧两个指纹都要能看见，否则用户没法去核对
  await expect(warn).toContainText(trusted);
  await expect(warn).toContainText(fakeFingerprint(CHANGED_KEY_HOST, 22));

  // **没有「就这样继续」的按钮** —— 只有先去解信任这一条路
  await expect(page.getByTestId('ssh-trust-dialog')).toBeHidden();
  await expect(page.locator('[data-testid="ssh-tabs"] [data-session-title]')).toHaveCount(0);
  await expect(page.getByTestId('error-banner')).toBeHidden();
});

test('忘记主机密钥之后就按新机器重新确认一次', async ({ page }) => {
  const trusted = fakeFingerprint(CHANGED_KEY_HOST, 2222);
  await page.addInitScript(
    ([key, host, fingerprint]) => {
      localStorage.setItem(
        key,
        JSON.stringify({
          knownHosts: [{ host, port: 22, algorithm: 'ssh-ed25519', fingerprint, addedAt: '' }],
        }),
      );
    },
    [STORAGE_KEY, CHANGED_KEY_HOST, trusted] as const,
  );
  await page.reload();
  await page.getByTestId('module-ssh').click();

  await connectNew(page, { host: CHANGED_KEY_HOST });
  await expect(page.getByTestId('ssh-mismatch')).toBeVisible();

  await page.getByTestId('ssh-btn-forget').click();

  // 解信任 = 重新变成「没见过的机器」，所以要再问一次 ——
  // 而不是因为我们刚删过记录就默默接受
  await expect(page.getByTestId('ssh-trust-dialog')).toBeVisible();
  await expect(page.getByTestId('ssh-trust-fingerprint')).toContainText(
    fakeFingerprint(CHANGED_KEY_HOST, 22),
  );
  await expect(page.getByTestId('ssh-mismatch')).toBeHidden();
});

// ------------------------------------------------------------------ 私钥认证

test('切到私钥认证：密码框换成私钥路径，凭据被清掉', async ({ page }) => {
  await connectNew(page, { password: '先填个密码' });
  await page.getByTestId('ssh-trust-cancel').click();

  await page.getByTestId('ssh-field-auth').selectOption('key');
  await expect(page.getByTestId('ssh-field-key')).toBeVisible();
  await expect(page.getByTestId('ssh-field-password')).toHaveCount(0);

  // 「浏览…」要能给出一个路径（浏览器版给的是假的，但按钮不是死的）
  await page.getByTestId('ssh-btn-browse').click();
  await expect(page.getByTestId('ssh-field-key')).not.toHaveValue('');

  // 切回密码认证时私钥路径会被清掉，反之亦然 —— 别把不用的凭据留在盘上
  await page.getByTestId('ssh-field-auth').selectOption('password');
  await expect(page.getByTestId('ssh-field-password')).toHaveValue('');
});

// ------------------------------------------------------------------ 持久化

// ------------------------------------------------------------------ 命令块

test('命令块：敲一条命令就出一条色条，点一下连命令带输出复制走', async ({ page, context }) => {
  // 读剪贴板要权限。⚠️ 这一条**验的是真链路**：色条 → 剪贴板，中间不塞替身
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);

  await connectAndTrust(page);
  await expect.poll(() => termText(page)).toContain('输入 help');

  await type(page, 'echo 你好色条');
  await expect.poll(() => termText(page)).toContain('你好色条');

  // 色条出现了，而且认得出是哪条命令（测试按命令文本选，比按自动 id 稳）
  const band = page.locator('[data-band-command="echo 你好色条"]');
  await expect(band).toHaveCount(1);

  await band.click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain('echo 你好色条'); // 命令本身
  expect(copied).toContain('你好色条'); // 以及它的输出
  // 提示符不该被复制进去（起点是「用户敲第一个键」那一列）
  expect(copied).not.toContain('$ echo');
});

test('命令块：双击把输出折起来，再双击**原样**展开回来', async ({ page }) => {
  await connectAndTrust(page);
  await expect.poll(() => termText(page)).toContain('输入 help');

  // 用 help：它的输出是一张表，里面有 `cd <PATH>` 这种别处不会出现的字样，
  // 折没折掉一看就知道
  await type(page, 'help');
  await expect.poll(() => termText(page)).toContain('按子串过滤文件的每一行');

  const band = page.locator('[data-band-command="help"]');
  await expect(band).toHaveCount(1);

  // ⚠️ 这里**必须等一下**：折叠有「输出停下来 250ms 才做」的闸（见 store 的
  // `REDRAW_QUIET_MS`）。等不到就去双击的话会被拒，而且不报错 —— 这是设计里
  // 就有的行为，不是测试的权宜之计。（别改成重试：重试的第二次双击会把刚折好
  // 的那一下再展开，来回横跳）
  await page.waitForTimeout(500);
  await band.dblclick();
  await expect(band).toHaveAttribute('data-band-folded', 'true');

  // 折起来之后：输出收掉了，只剩一行摘要
  await expect.poll(() => termText(page)).not.toContain('按子串过滤文件的每一行');
  await expect.poll(() => termText(page)).toContain('已折叠');

  // 再展开：**内容原样回来**（这是重放那条路最难的部分 —— 回来得不全就是坏的）
  await band.dblclick();
  await expect.poll(() => termText(page)).toContain('按子串过滤文件的每一行');
  await expect(band).toHaveAttribute('data-band-folded', 'false');
});

test('连接和信任记录会留下来', async ({ page }) => {
  await connectAndTrust(page);

  // 同一个 context 里开第二个页面（不能 reload：init script 会把存储清掉）
  const second = await page.context().newPage();
  await second.goto('/');
  await second.getByTestId('module-ssh').click();

  // 侧栏那行显示的是**档案名 + 地址**（会话标题是另一个字段）
  await expect(second.getByTestId('ssh-conn-list')).toContainText('新建 SSH 连接');
  await expect(second.getByTestId('ssh-conn-list')).toContainText('127.0.0.1:22');
  // 信任记录也在，所以再连不该问第二次
  await second.getByTestId('ssh-btn-connect').click();
  await expect(second.getByTestId('ssh-status')).toContainText('已连接');
  await expect(second.getByTestId('ssh-trust-dialog')).toBeHidden();
  await second.close();
});

// ------------------------------------------------------------------ 侧栏搜索

test('侧栏搜索：按连接名过滤；搜会话名也能落回那条连接', async ({ page }) => {
  await connectAndTrust(page);
  await page.getByTestId('ssh-field-name').fill('生产机');
  // 第二条连另一台机器、换一个用户名 —— 会话标题是「用户名@主机」，
  // 光靠 IP 区分不开：`root@10.1` 是 `root@127.0.0.1` 的**子序列**
  // （模糊匹配本来就宽松），换个用户名才是一眼分得开的
  await connectAndTrust(page, { host: '10.1.2.3', username: 'deploy' });

  await expect(page.locator('[data-conn-name]')).toHaveCount(2);

  // 搜名字：只剩那一条
  await page.getByTestId('ssh-conn-search').fill('生产');
  await expect(page.locator('[data-conn-name]')).toHaveCount(1);
  await expect(page.locator('[data-conn-name="生产机"]')).toBeVisible();

  // 搜**会话名**：落回它所属的那条连接 —— 会话行自 2026-10-15 起不挂在侧栏了，
  // 但拿一个标签名来找「这是哪台机器」仍然要能找到（连接是唯一有意义的落点）
  await page.getByTestId('ssh-conn-search').fill('deploy');
  await expect(page.locator('[data-conn-name="生产机"]')).toHaveCount(0);
  await expect(page.locator('[data-conn-name]')).toHaveCount(1);

  await page.getByTestId('ssh-conn-search').fill('zzzz');
  await expect(page.getByTestId('ssh-conn-nomatch')).toBeVisible();

  // 清空：两条都回来（顺序还是原来的）
  await page.getByTestId('ssh-conn-search-clear').click();
  await expect(page.locator('[data-conn-name]')).toHaveCount(2);
});

// ------------------------------------------------------------------ 本地终端

test('本地终端：建一个、敲命令、命令块照常', async ({ page }) => {
  await expect(page.getByTestId('ssh-conn-list')).toContainText('还没有连接');

  // 种类在弹框里选。⚠️ 原来「本地」是单独一个按钮，2026-09-23 合并进了弹框 ——
  // 那两个按钮**替用户决定了种类**（想建本地终端却点了「新建」，得到的是一个
  // 要填主机和密码的东西，而界面上看不出哪里不对）。
  await page.getByTestId('ssh-btn-new').click();
  await page.getByTestId('ssh-new-kind').selectOption('local');
  await page.getByTestId('ssh-new-confirm').click();

  // 侧栏那一行说的是「本地」，不是 `127.0.0.1:22` 那种看着像远端的东西
  const row = page.locator('[data-testid^="conn-"]').first();
  await expect(row).toContainText('本地');
  await expect(page.getByTestId('ssh-field-kind')).toHaveValue('local');

  // 本地终端**没有信任这一步**（那台机器就是用户自己这台）
  await page.getByTestId('ssh-btn-connect').click();
  await expect(page.getByTestId('ssh-trust-dialog')).toHaveCount(0);
  await expect(page.getByTestId('ssh-status')).toContainText('已连接');

  // 而且它是**真的**终端：敲一条命令，断言输出
  await expect.poll(() => termText(page)).toContain('devtoolkit@local');
  await type(page, 'echo 本地也要能用');
  await expect.poll(() => termText(page)).toContain('本地也要能用');

  // 命令块（色条）那套在本地终端上照常工作 —— 它只认「会话」
  await expect(page.locator('[data-band-command="echo 本地也要能用"]')).toHaveCount(1);

  // 侧栏的状态点：本地终端连着的时候也是「已连接」
  await expect(row).toHaveAttribute('data-status', 'connected');
});

test('⚠️ 弹框里选「本地终端」：机器那一段消失，而且零输入就能建', async ({ page }) => {
  await page.getByTestId('ssh-btn-new').click();

  // 默认是 SSH 连接，所以要主机那一段
  await expect(page.getByTestId('ssh-new-host')).toBeVisible();
  await expect(page.getByTestId('ssh-new-name')).toHaveValue('新建 SSH 连接');

  await page.getByTestId('ssh-new-kind').selectOption('local');

  // ⚠️ 整块**隐藏**而不是禁用 —— 那三个字段对本地终端毫无意义，画三个灰框只是噪音
  //（和右侧表单一个处理）。
  await expect(page.getByTestId('ssh-new-host')).toHaveCount(0);
  await expect(page.getByTestId('ssh-new-port')).toHaveCount(0);
  await expect(page.getByTestId('ssh-new-username')).toHaveCount(0);

  // 名字跟着种类换（用户没碰过它，所以该换）
  await expect(page.getByTestId('ssh-new-name')).toHaveValue('新建本地终端');

  // ⚠️ **零输入就能建**（合并入口的代价要控制在这里）：本地终端没有别的必填项，
  // 名字也是预填好的。按钮要是灰的，用户会以为还得填什么。
  await expect(page.getByTestId('ssh-new-confirm')).toBeEnabled();
  await page.getByTestId('ssh-new-confirm').click();

  await expect(page.getByTestId('ssh-field-kind')).toHaveValue('local');
});

test('⚠️ 名字被改过之后，换种类不该把它改掉', async ({ page }) => {
  // 「只改用户没动过的」这条规则在弹框里同样成立 —— 和右侧表单那条是同一个判据。
  await page.getByTestId('ssh-btn-new').click();
  await page.getByTestId('ssh-new-name').fill('生产机');
  await page.getByTestId('ssh-new-kind').selectOption('local');

  await expect(page.getByTestId('ssh-new-name')).toHaveValue('生产机');
});

test('本地终端：切 shell 之后再开一个，用的是新 shell', async ({ page }) => {
  await page.getByTestId('ssh-btn-new').click();
  await page.getByTestId('ssh-new-kind').selectOption('local');
  await page.getByTestId('ssh-new-confirm').click();
  await page.getByTestId('ssh-field-local-shell').selectOption('cmd');

  await page.getByTestId('ssh-btn-connect').click();
  await expect(page.getByTestId('ssh-status')).toContainText('已连接');

  // 假实现里 shell 只影响「起得起来」这件事（和真实现一样：名字交给后端去找），
  // 所以这里验的是**参数确实传下去了** —— 真机上的差别归 Rust 那组测试
  const requests = await page.evaluate(() => {
    const w = window as unknown as { __sshLocalRequests?: Array<{ shell: string }> };
    return w.__sshLocalRequests ?? [];
  });
  expect(requests.some((r) => r.shell === 'cmd')).toBe(true);
});

test('命令块：折叠再展开，色条要回到原来的高度', async ({ page }) => {
  // ⚠️ 这条盯的是**几何往返**。真机上报过「折叠之后色条全乱、鼠标点哪儿都不对」，
  // 那底下叠了六个 bug（终点算错、光标当内容末尾、sameBands 漏比 folded、
  // 展开时 delta 现算、补偿重画的 schedule 不在作用域、write 回调早于解析）。
  // 所以这里只断言**用户看得见的那件事**：折起来变小、展开回原样。
  await connectAndTrust(page);
  await expect.poll(() => termText(page)).toContain('输入 help');

  await type(page, 'help');
  await expect.poll(() => termText(page)).toContain('按子串过滤文件的每一行');

  const band = page.locator('[data-band-command="help"]');
  const heightOf = async (): Promise<number> => (await band.boundingBox())?.height ?? 0;

  const before = await heightOf();
  expect(before).toBeGreaterThan(100); // help 的输出是一大块

  // 折叠：色条缩到一行左右
  await page.waitForTimeout(500);
  await band.dblclick();
  await expect(band).toHaveAttribute('data-band-folded', 'true');
  await expect.poll(heightOf).toBeLessThan(40);

  // 展开：**高度必须回来**（真机上就是这一步不对）
  await band.dblclick();
  await expect(band).toHaveAttribute('data-band-folded', 'false');
  await expect.poll(heightOf).toBeGreaterThan(before - 40);
});

test('⚠️ 折叠之后光标要跟着内容走，不能跑回左上角（回归）', async ({ page }) => {
  // 折叠是靠「重放整段缓冲」实现的（xterm 删不掉缓冲区中间几行），而重放的
  // 最后一步原来会把**粘性模式**写回去 —— 那串里有 `\x1b[?6h` / `\x1b[?6l`
  // （原点模式），按 DECOM 的规矩**切换它会把光标送回原点**。
  // 于是折叠之后光标跑到最上面，用户一打字就插在历史中间，特别难看。
  // 这条量的是光标位置：重放的内容明明把光标带到了末尾，它不许被那一下打回去。
  await connectAndTrust(page);
  await expect.poll(() => termText(page)).toContain('输入 help');
  await type(page, 'help');
  await expect.poll(() => termText(page)).toContain('按子串过滤文件的每一行');
  // 折叠有「输出停下来 250ms 才做」的闸（见 store 的 REDRAW_QUIET_MS）
  await page.waitForTimeout(500);

  const cursorOf = async (): Promise<{ line: number; content: number }> =>
    page.evaluate(
      (id) => {
        const hub = (
          window as unknown as {
            __sshHub?: {
              metrics: (i: string) => { cursorLine: number; lastContentLine: number } | null;
            };
          }
        ).__sshHub;
        const m = hub?.metrics(id);
        return { line: m?.cursorLine ?? -1, content: m?.lastContentLine ?? -1 };
      },
      await activeTerminalId(page),
    );

  const before = await cursorOf();
  expect(before.line).toBeGreaterThan(0);

  await page.locator('[data-band-command="help"]').dblclick();
  await expect(page.locator('[data-band-command="help"]')).toHaveAttribute(
    'data-band-folded',
    'true',
  );

  // ⚠️ 折起来之后内容短了，但光标仍然要**贴着内容末尾** —— 不是钉在 0
  await expect.poll(async () => (await cursorOf()).line).toBeGreaterThan(0);
  const after = await cursorOf();
  expect(after.line).toBeGreaterThan(0);
  expect(Math.abs(after.line - after.content)).toBeLessThanOrEqual(1);
});

// ------------------------------------------------------------------ 目录

/**
 * 原生 HTML5 拖拽走**合成 DataTransfer 手动派发**。
 *
 * ⚠️ Playwright 的鼠标式 `locator.dragTo()` 驱动不了原生 DnD（那是给 pointer
 * 事件准备的）；而 `dragover` 必须被目标 `preventDefault`（我们的 handler 做了），
 * 不然 `drop` 静默不生效。
 */
async function dragTo(page: Page, from: Locator, to: Locator): Promise<void> {
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await from.dispatchEvent('dragstart', { dataTransfer });
  await to.dispatchEvent('dragover', { dataTransfer });
  await to.dispatchEvent('drop', { dataTransfer });
  await from.dispatchEvent('dragend', { dataTransfer });
}

test('目录：在此新建连接 → 嵌套子目录 → 拖拽 → 删除（连带连接，先确认）', async ({ page }) => {
  // 建一个目录
  await page.getByTestId('ssh-btn-new-group').click();
  const dir = page.locator('[data-group-path="新建目录"]');
  await expect(dir).toBeVisible();
  await expect(dir).toHaveAttribute('data-group-count', '0');

  // 目录右键 →「在此新建连接」：弹框的「所在目录」预选上这条，
  // 确认之后连接**直接落在目录里**（省掉「先建再右键移入」那两步 —— 用户报过）
  await dir.click({ button: 'right' });
  await page.getByTestId('menu-在此新建连接').click();
  await page.getByTestId('ssh-new-confirm').click();

  await expect(dir).toHaveAttribute('data-group-count', '1');
  // 连接真的在目录这一节里面（wrapper 是目录头的父节点，身子也归它）
  await expect(dir.locator('..').locator('.rd-conn-row')).toHaveCount(1);

  // 在「新建目录」里再建一层：路径是「父/子」—— 同名目录从此不再唯一，
  // 所以定位一律走 data-group-path
  await dir.click({ button: 'right' });
  await page.getByTestId('menu-新建子目录').click();
  const child = page.locator('[data-group-path="新建目录/新建目录"]');
  await expect(child).toBeVisible();

  // 拖拽：把连接从父目录拖进子目录（抓手起拖，落点是整节的区域）
  await dragTo(page, dir.locator('..').locator('.rd-conn-row .rd-conn-drag').first(), child);
  await expect(child).toHaveAttribute('data-group-count', '1');
  await expect(dir).toHaveAttribute('data-group-count', '1'); // 计数是子树总数

  // 折叠子目录：里面的连接跟着藏
  await page.locator('[data-group-path="新建目录/新建目录"] button').first().click();
  await expect(dir.locator('..').locator('.rd-conn-row')).toHaveCount(0);

  // 删除父目录：**连同子树里的东西一起删**，确认文案要说清删什么
  let confirmText = '';
  page.once('dialog', (d) => {
    confirmText = d.message();
    void d.accept();
  });
  await dir.click({ button: 'right' });
  await page.getByTestId('menu-删除目录（连同里面的东西）').click();

  expect(confirmText).toContain('1 个子目录');
  expect(confirmText).toContain('1 条连接');
  await expect(page.locator('[data-group-path="新建目录"]')).toHaveCount(0);
  await expect(page.getByTestId('ssh-conn-list')).toContainText('还没有连接');
});

test('目录：拖到空白处 = 移出目录（回未分组）', async ({ page }) => {
  await page.getByTestId('ssh-btn-new-group').click();
  await page.getByTestId('ssh-btn-new').click();
  await page.getByTestId('ssh-new-confirm').click();

  // 先放进目录
  await page.locator('.rd-conn-row').first().click({ button: 'right' });
  await page.getByTestId('menu-移入「新建目录」').click();
  const dir = page.locator('[data-group-path="新建目录"]');
  await expect(dir).toHaveAttribute('data-group-count', '1');

  // 拖回空白（面板空白就是「未分组」那个落点）
  await dragTo(
    page,
    page.locator('.rd-conn-row .rd-conn-drag').first(),
    page.locator('[data-testid="ssh-conn-list"] .rd-panel-body'),
  );
  await expect(dir).toHaveAttribute('data-group-count', '0');
});

test('新建弹框里直接选 shell：cmd / PowerShell 想建哪个建哪个（用户提的）', async ({ page }) => {
  await page.getByTestId('ssh-btn-new').click();
  await page.getByTestId('ssh-new-kind').selectOption('local');

  // ⚠️ 此前这个选择**只在建完之后的属性面板里**（等于藏起来）——
  // 用户原话「不能 cmd 终端和 PowerShell 都有吗」，找不到入口
  await page.getByTestId('ssh-new-local-shell').selectOption('cmd');
  await page.getByTestId('ssh-new-confirm').click();

  // 侧栏那一行直接写明用的是 cmd
  await expect(page.locator('[data-testid^="conn-"]').first()).toContainText('本地 · cmd');

  // 连上去：shell 参数确实传到后端了（和属性面板那条路同一个断言口径）
  await page.getByTestId('ssh-btn-connect').click();
  await expect(page.getByTestId('ssh-status')).toContainText('已连接');
  const requests = await page.evaluate(() => {
    const w = window as unknown as { __sshLocalRequests?: Array<{ shell: string }> };
    return w.__sshLocalRequests ?? [];
  });
  expect(requests.some((r) => r.shell === 'cmd')).toBe(true);
});
