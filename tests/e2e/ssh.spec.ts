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

import { expect, test, type Page } from '@playwright/test';
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
  await page.getByTestId('ssh-btn-new').click();
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
  await expect.poll(() => termText(page)).toContain('Devtoolkit');

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

test('会话行右键能关掉这一条，另一条留下', async ({ page }) => {
  await connectAndTrust(page);
  await page.getByTestId('ssh-btn-connect').click();
  await expect(page.getByTestId('ssh-status')).toContainText('已连接');

  const tabs = page.locator('[data-testid="ssh-tabs"] [data-session-title]');
  await expect(tabs).toHaveCount(2);

  // 连上之后这个连接是**自动展开**的（`connect()` 里顺手置的），
  // 所以会话行此刻已经在了 —— 别去点那个箭头，那一下是折叠
  //
  // ⚠️ 必须限定 `button`：容器那个 testid 是 `ssh-sessions-<档案 id>`，
  // 它也是 `ssh-session-` 开头，只按前缀选会把容器一起选进来
  const sessions = page.locator(
    '[data-testid="ssh-conn-list"] button[data-testid^="ssh-session-"]',
  );
  await expect(sessions).toHaveCount(2);

  await sessions.nth(1).click({ button: 'right' });
  await page.getByTestId('menu-关闭这个会话').click();
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

test('侧栏搜索：按连接名过滤；搜会话名时把那条连接自动撑开', async ({ page }) => {
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

  // 搜**会话名**：那条连接要留下，而且自动撑开、会话行看得见 ——
  // 否则用户搜一个会话名会得到「没有匹配的」，而其实它在折叠的连接里
  await page.getByTestId('ssh-conn-search').fill('deploy');
  await expect(page.locator('[data-conn-name="生产机"]')).toHaveCount(0);
  // 限定在侧栏里：主区标签栏也挂着同样的 data-session-title（不限定会选中两个）
  await expect(
    page.locator('[data-testid="ssh-conn-list"] [data-session-title="deploy@10.1.2.3"]'),
  ).toBeVisible();

  await page.getByTestId('ssh-conn-search').fill('zzzz');
  await expect(page.getByTestId('ssh-conn-nomatch')).toBeVisible();

  // 清空：两条都回来（顺序还是原来的）
  await page.getByTestId('ssh-conn-search-clear').click();
  await expect(page.locator('[data-conn-name]')).toHaveCount(2);
});
