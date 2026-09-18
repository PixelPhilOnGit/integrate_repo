/**
 * 内存版假 SSH 会话 —— 一个迷你行规程（line discipline），不是连接层。
 *
 * 为什么要有一个「足够真」的假 shell：headless 环境里起不了原生窗口，Playwright
 * 只能驱动普通 Chromium 里的前端（同 `redis/core/fakeRedis.ts` 的开头）。终端是这个
 * 模块的主界面，如果假实现是「收到什么都回一段写死的文本」，「连接 → 打字 → 看见
 * 回显 → 退出」这条链路就完全没被验证过 —— 那是对着假数据自欺。
 *
 * 所以这里真的维护了一个 shell 该有的状态：当前目录、命令行缓冲、命令历史、
 * 一个内存文件系统。`cd 项目` 之后再 `pwd` 真的会变，`cat` 一个中文文件真的会把
 * 中文吐回来。e2e 因此断言的是真实行为，而不是我们写死的预期。
 *
 * # 边界
 *
 * - **不是连接层**：握手、认证、主机密钥、PTY 尺寸都不在这里。文件开头那几个纯函数
 *   （指纹、连不上、认证）是给 `services/web.ts` 在**建连阶段**用的，和 shell 没有交互。
 * - **纯逻辑**：不碰 DOM、不碰 localStorage、没有定时器、没有异步，所以能在 vitest
 *   的 node 环境里直接跑。
 * - **不做列宽和折行**：真实终端里折行是终端模拟器（xterm.js）的活，远端只负责发
 *   字节流。所以这里没有、也不该有 `resize` 这个概念 —— 别把它当成漏做。
 * - **不做配色**：默认的 bash 提示符也是素的。替身跟着素，断言里就少一堆转义序列。
 *
 * # 输出是分块发的
 *
 * 提示符、每一条输出行、退出提示各自是**独立的 `emit()` 调用**，不是拼成一个大字符串
 * 一次发完。e2e 要观察的正是「输出分多次到达终端」这条路径（xterm 的写入、滚动、
 * 触发器都在那条路上），合成一块发就等于那条路径没测。
 *
 * # 报错的文案分两类
 *
 * 命令自身的报错**照抄真实工具的英文原话**（`ls: cannot access 'x': No such file
 * or directory`）—— 假实现最怕的就是报错长得不像真的。需要说明「演示环境的限制」时
 * 才用中文（比如没有接标准输入），因为那种话在真实工具里根本没有对应物。
 */

import type { SshAuthKind } from './types';

// ------------------------------------------------------------------ 建连阶段

/**
 * 这个主机名**永远连不上**。
 *
 * 需要一个「确定性地失败」的地址，e2e 才能稳定地断言失败分支。用 `.invalid`
 * 这个保留顶级域，保证它在任何网络环境下都不会意外解析成功 —— 和 SQL / Redis
 * 两个模块同一个理由。
 */
export const UNREACHABLE_HOST = 'unreachable.invalid';

/**
 * 这个主机名**每次握手都报一把和已信任的不一样的主机密钥**。
 *
 * 它是 TOFU 拒绝那条链路的确定性钩子：服务层对这台机器一律回 `hostKeyMismatch`
 * （`actual` 取 `fakeFingerprint`，`expected` 取调用方存的那把），e2e 因此不用
 * 「先信任一次、再制造变化」就能稳定看到那个弹窗 —— 少一步准备就少一处能抖的地方。
 *
 * ⚠️ 密钥变了**不在这里报错**：它是一次成功握手得出的结论，按 `core/types.ts` 的
 * 约定要走 `Ok` 的 `hostKeyMismatch`，所以 `connectFailure` 对它返回 null。
 */
export const CHANGED_KEY_HOST = 'changed-key.invalid';

/**
 * 确定性的假指纹：同一个 host:port 永远同一串，不同 host:port 不同。
 *
 * ⚠️ **它不是真的 SHA-256**，只是一串长得像的字符串。形状照着真指纹来：
 * `SHA256:` + 43 个 base64 字符（32 字节、无填充），这样弹窗、已知主机列表里显示的
 * 东西和真连一台机器时长得一样。对一个替身来说硬要求只有两条 —— **同输入同输出**
 * 和 **不同主机不同输出**（不然「密钥变了」那条分支根本造不出来），而这两条一个
 * FNV-1a 就够，没必要为此引一个哈希实现。
 *
 * 刻意不依赖 `node:crypto` 或 `crypto.subtle`：这个文件在浏览器里也要跑，而后者是
 * 异步的 —— 一个纯函数没有理由变成 async。
 */
export function fakeFingerprint(host: string, port: number): string {
  return `SHA256:${base64NoPad(fingerprintBytes(`${host.trim().toLowerCase()}:${port}`))}`;
}

/** 假指纹用的算法名。固定值 —— 弹窗里每次看到同一个，e2e 才好断言 */
export function fakeAlgorithm(): string {
  return 'ssh-ed25519';
}

/**
 * 魔数主机名的连接失败文案；不是魔数返回 null。
 *
 * 文案和 SQL / Redis 两个模块对齐（点名地址 + 提示查地址、端口、服务、防火墙）：
 * 用户在三个模块里看到的失败提示长得一样，是刻意的。
 */
export function connectFailure(host: string, port: number): string | null {
  if (host.trim().toLowerCase() !== UNREACHABLE_HOST) return null;
  return `连接 SSH 服务器（${host.trim()}:${port}）失败：无法解析主机名或者连接被拒绝。\
请确认地址和端口正确、服务已启动、防火墙放行。`;
}

/** 认证被拒的文案前半段。带上支持的方式 —— 真服务器拒绝时也是这么提示的 */
const AUTH_REJECTED = '认证被拒绝（本服务器支持 publickey、password 两种方式）';

/** 这个用户名**永远认不过** —— e2e 用它稳定地看到「密码不对」那条分支 */
const WRONG_CREDENTIALS_USER = 'nobody';

/**
 * 假认证：返回错误文案，`null` 表示通过。
 *
 * 四个确定性的钩子，e2e 靠它们稳定地看到失败分支，不用去猜什么密码才是错的：
 * 用户名为空、密码为空（**只对密码认证成立**）、用户名恰好是 `nobody`。
 *
 * ⚠️ 第三个参数不是装饰：私钥认证**没有密码**（无口令的私钥很常见），拿空串进来
 * 会被当成「密码为空」而拒掉。所以私钥认证要显式传 `'key'`，让口令不参与判定 ——
 * 假实现本来就无视私钥路径（见 `core/types.ts` 里的说明），何必再让一个不存在的
 * 密码挡在门口。用户名则不管哪种认证方式都要查。
 */
export function authFailure(
  username: string,
  password: string,
  kind: SshAuthKind = 'password',
): string | null {
  const name = username.trim();
  if (name === '') return `${AUTH_REJECTED}：用户名为空。`;
  if (kind === 'password' && password === '') return `${AUTH_REJECTED}：密码为空。`;
  if (name === WRONG_CREDENTIALS_USER) return `${AUTH_REJECTED}：用户名或密码不正确。`;
  return null;
}

// ------------------------------------------------------------------ 假指纹的字节

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * 拿 32 字节来当指纹的原料：8 块 32 位的 FNV-1a 拼起来。
 *
 * 每块掺进块号当起点 —— 同一个 32 位哈希重复八遍会得到一堆重复的字节组，
 * 摆出来就不像指纹了。
 */
function fingerprintBytes(seed: string): Uint8Array {
  const bytes = new Uint8Array(32);
  for (let block = 0; block < 8; block += 1) {
    let hash = fnv1a32(`${block}:${seed}`);
    for (let i = 0; i < 4; i += 1) {
      bytes[block * 4 + i] = hash & 0xff;
      hash >>>= 8;
    }
  }
  return bytes;
}

/** FNV-1a 32 位。`Math.imul` 是精确的 32 位乘法，用它比手写移位不容易错 */
function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * 标准 base64，不带 `=` 填充 —— 刚好是 `ssh-keyscan` / `ssh-keygen -lf` 里那串的形状。
 * 自己写而不是用 Buffer / btoa：前者浏览器里没有，后者要先把字节拼成一个字符串。
 */
function base64NoPad(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = i + 1 < bytes.length ? (bytes[i + 1] ?? 0) : null;
    const b2 = i + 2 < bytes.length ? (bytes[i + 2] ?? 0) : null;

    out += BASE64_ALPHABET.charAt(b0 >> 2);
    out += BASE64_ALPHABET.charAt(((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4));
    if (b1 === null) break;
    out += BASE64_ALPHABET.charAt(((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6));
    if (b2 === null) break;
    out += BASE64_ALPHABET.charAt(b2 & 0x3f);
  }
  return out;
}

// ------------------------------------------------------------------ 假文件系统

type FsEntry = { kind: 'dir' } | { kind: 'file'; content: string };

/** 家目录：root 的家在 `/root`，别人在 `/home/<名字>`，和真机器一样 */
function homeOf(user: string): string {
  return user === 'root' ? '/root' : `/home/${user}`;
}

/**
 * 演示文件系统。
 *
 * 做成「每次建会话现造一份」而不是共享一张表：两个会话各改各的，互不干扰，
 * 也省掉了「上一个测试留下的状态」这类难查的问题。代价是文件改不了 ——
 * 这个替身本来也没有写文件的命令。
 */
function buildFileSystem(user: string, host: string): Map<string, FsEntry> {
  const home = homeOf(user);
  const fs = new Map<string, FsEntry>();
  const dir = (path: string): void => void fs.set(path, { kind: 'dir' });
  const file = (path: string, content: string): void => void fs.set(path, { kind: 'file', content });

  for (const path of ['/', '/etc', '/home', '/tmp', home, `${home}/项目`]) dir(path);
  file('/etc/hostname', `${host}\n`);
  file('/etc/os-release', 'NAME="Devtoolkit 演示环境"\nID=devtoolkit\nVERSION_ID="0.2.0"\n');
  file(`${home}/readme.txt`, 'Devtoolkit demo shell.\nEverything under this home lives in memory.\n');
  file(
    `${home}/说明.txt`,
    '这是一个演示环境里的假文件。\n内容放在内存里，关掉窗口就没了。\n命令和文件都只在本进程内存在，不会碰真实系统。\n',
  );
  file(`${home}/项目/说明.md`, '# 演示项目\n\n这个目录用来试 cd、相对路径和 ls。\n');
  file(
    '/tmp/演示.log',
    '2026-09-17 09:12:01 启动演示环境\n2026-09-17 09:12:02 装载假文件系统\n2026-09-17 09:12:03 就绪\n',
  );

  return fs;
}

/** 按行切开，丢掉结尾那个空的「行」—— 文件末尾的换行不算一行（真 wc 也是这么数的） */
function splitLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * 把用户敲的路径解析成规范化的绝对路径。
 *
 * `~` 只认自己（`~someone` 不展开，会被当成普通目录名进而在访问时报 No such file）——
 * 演示里没有人家的家目录，假装支持反而会出现「列出了不存在的东西」这种更坏的假象。
 */
function normalize(path: string): string {
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    // 根目录上的 .. 还是根目录：空数组 pop 是空操作，正好
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `/${parts.join('/')}`;
}

/**
 * 把一行拆成参数。
 *
 * 只处理引号和反斜杠 —— 这是**行规程**该管的事（用户敲了 `echo "你好 世界"`，
 * 命令拿到的就是一个参数）。变量展开、`|`、`>`、`&&` 一概不做：那是完整 shell 的
 * 活，而这个替身只有一个固定命令表，做了也没有命令会去读管道。
 */
function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  /** 空引号 `""` 也是一个参数，所以不能靠「current 非空」来判断有没有参数 */
  let started = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line.charAt(i);

    if (ch === '\\' && quote !== "'") {
      const next = line.charAt(i + 1);
      if (next === '') {
        current += ch;
      } else {
        current += next;
        i += 1;
      }
      started = true;
      continue;
    }

    if (quote !== null) {
      if (ch === quote) quote = null;
      else current += ch;
      started = true;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }

    if (ch === ' ' || ch === '\t') {
      if (started) {
        tokens.push(current);
        current = '';
        started = false;
      }
      continue;
    }

    current += ch;
    started = true;
  }

  if (started) tokens.push(current);
  return tokens;
}

// ------------------------------------------------------------------ 命令表

/** Tab 补全的候选 */
const COMMANDS = [
  'cat', 'cd', 'clear', 'date', 'echo', 'exit', 'grep', 'help',
  'hostname', 'ls', 'pwd', 'uname', 'wc', 'whoami',
];

/**
 * 帮助文本的左列是「用法」，右列是中文说明。
 *
 * 用法里**只用 ASCII 占位符**（`<FILE>` 而不是 `<文件>`），这样按字符数补空格就等于
 * 按屏幕列数对齐 —— 中文在终端里是双宽的，掺进左列就会把右边的说明推得参差不齐，
 * 而按列宽对齐要专门算宽度，一个 help 不值当。
 */
const HELP_COMMANDS: [string, string][] = [
  ['ls [DIR]', '列目录内容'],
  ['cd [DIR]', '切换目录（支持 .. ~ - 和相对路径）'],
  ['pwd', '显示当前目录'],
  ['cat <FILE>', '打印文件内容'],
  ['echo <TEXT>', '原样输出（认引号）'],
  ['grep <TEXT> <FILE>', '按子串过滤文件的每一行'],
  ['wc [-l] <FILE>', '统计行数、词数、字节数'],
  ['whoami / hostname / date / uname [-a]', ''],
  ['clear', '清屏'],
  ['exit [CODE]', '结束会话'],
];

const HELP_LINES = [
  '演示 shell 支持的命令：',
  ...HELP_COMMANDS.map(([usage, desc]) => `  ${usage.padEnd(20)}${desc}`.trimEnd()),
  '',
  '编辑键：↑/↓ 翻历史、Tab 补全命令名、Ctrl+C 中断、Ctrl+L 清屏、Ctrl+D 退出。',
  '这是一个演示环境：文件在内存里，命令是假实现，没有连任何真实主机。',
];

// ------------------------------------------------------------------ 假 shell

export interface FakeShellOptions {
  user: string;
  host: string;
  /** 起始目录。默认家目录；给的不是个存在的目录就回落到家目录 */
  cwd?: string;
  /** 输出一段（调用方负责编码成字节） */
  emit(data: string): void;
  /**
   * 远端 shell 结束了。
   *
   * `exit 3` 就是 3；键盘上的 Ctrl+D（在空行上）是 0。**退出码由调用方决定怎么用**：
   * 会话状态、标签标题、「已退出」的提示都不归这个文件管。
   */
  onExit?(code: number): void;
}

export interface FakeShell {
  /** 键盘输入（已经按 UTF-8 解好的字符串）。退出或关闭之后一律静默忽略 */
  write(data: string): void;
  /** 拆掉这一端。幂等 */
  close(): void;
  /**
   * 远端 shell 已经结束了吗。
   *
   * ⚠️ **每次都要从 shell 上读**，别在开头 `const { exited } = shell` 解构出来 ——
   * 那样拿到的是解构那一刻的 false，之后再怎么读都不会变。属性而不是 `isExited(shell)`
   * 函数，是为了让调用方写起来就是一句 `shell.exited`（回调负责「什么时候」，
   * 这个属性负责「现在是什么状态」，两件事都需要）。
   */
  readonly exited: boolean;
}

/**
 * 开一个演示会话。**创建时就会发出一段横幅和第一个提示符**，所以调用方要先把
 * `emit` 接好再调这里（`onExit` 同理）。
 */
export function createFakeShell(opts: FakeShellOptions): FakeShell {
  // 空用户名理论上到不了这里（假认证会先拒），但真到了也不该让提示符变成
  // `@host` 这种半截样子
  const user = opts.user.trim() === '' ? 'dev' : opts.user.trim();
  const host = opts.host.trim() === '' ? 'localhost' : opts.host.trim();
  const home = homeOf(user);
  const fs = buildFileSystem(user, host);

  const start = opts.cwd === undefined ? home : normalize(opts.cwd);
  let cwd = fs.get(start)?.kind === 'dir' ? start : home;
  /** `cd -` 用的上一个目录；没切过就是 null（真 bash 这时报 OLDPWD not set） */
  let previous: string | null = null;

  let closed = false;
  let exited = false;

  /** 正在编辑的这一行 */
  let line = '';
  /** 浏览历史时，从草稿位离开前那一行；走回草稿位就还回去 */
  let draft = '';
  const history: string[] = [];
  /**
   * 历史游标。取值 `[0, history.length]`，**恰好等于 length 时表示「草稿位」**
   * （不在历史里，正在写新命令）—— 比「null 表示草稿」少一个分支。
   */
  let historyIndex = 0;
  /** 上一段输入末尾没读完的转义序列（见 `write`） */
  let pending = '';

  const shell: FakeShell = {
    write(data: string): void {
      if (closed || exited) return;

      const input = pending + data;
      pending = '';

      for (let i = 0; i < input.length; i += 1) {
        const ch = input.charAt(i);
        if (ch === '\x1b') {
          const end = escape(input, i);
          // 序列被切断（一个 ESC 序列跨了两次 write）—— 剩下的留到下一段再拼
          if (end < 0) {
            pending = input.slice(i);
            return;
          }
          i = end;
          continue;
        }
        key(ch);
      }
    },

    close(): void {
      closed = true;
    },

    get exited(): boolean {
      return exited;
    },
  };

  banner();
  return shell;

  // ---------------------------------------------------------------- 输出

  /** 发一段原始内容。close 之后一律不发（onExit 里调 close 是合法用法） */
  function emitRaw(data: string): void {
    if (closed) return;
    opts.emit(data);
  }

  /**
   * 发一行输出。
   *
   * 行尾统一 `\r\n`，和真 PTY 一样。只发 `\n` 在 xterm 里也能换行（它做了 ONLCR），
   * 但那会让「假实现的输出和真实现一致」这件事凭空依赖 xterm 的宽容。
   */
  function out(text: string): void {
    emitRaw(`${text}\r\n`);
  }

  function showPrompt(): void {
    emitRaw(prompt());
  }

  /** 重画「提示符 + 当前行」。`\r\x1b[K` 是回到行首再擦掉整行 —— 一次完整的屏上动作，不分块 */
  function redrawLine(): void {
    emitRaw(`\r\x1b[K${prompt()}${line}`);
  }

  /** 提示符。家目录显示成 `~`（bash 的 `\w` 默认行为），root 用 `#` */
  function prompt(): string {
    const shown =
      cwd === home ? '~' : cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd;
    return `${user}@${host}:${shown}${user === 'root' ? '#' : '$'} `;
  }

  /** 登录横幅。主机和用户名都点名 —— e2e 一眼能确认自己连的是哪个档案 */
  function banner(): void {
    out(`欢迎使用 Devtoolkit 演示服务器（${host}）`);
    out(`已以 ${user} 登录。这是一个演示环境：命令和文件都是内存里的假实现，不会碰真实系统。`);
    out('输入 help 看看有哪些命令。');
    out(''); // 空一行，和真 ssh 登录后的 MOTD 一样
    showPrompt();
  }

  // ---------------------------------------------------------------- 键盘

  function key(ch: string): void {
    switch (ch) {
      case '\r':
      case '\n': // 裸 \n 也当回车：调用方不一定补 \r
        accept();
        return;

      case '\x7f': // DEL 才是终端里的退格
      case '\b':
        backspace();
        return;

      case '\x03': // Ctrl+C：打断当前行，换一个干净的提示符
        // `^C` 和紧跟的换行是终端驱动同一次屏上变化，合成一块发
        out('^C');
        resetLine();
        showPrompt();
        return;

      case '\x0c': // Ctrl+L：清屏（不含回滚缓冲）并把提示符和当前行重画到左上角
        emitRaw('\x1b[2J\x1b[H');
        redrawLine();
        return;

      case '\x04': // Ctrl+D：只在空行上退出，非空行上真 bash 什么也不做
        // 真 bash 这时还会在屏幕上补一行 `exit` / `logout`（login shell 的说法不一样），
        // 替身统一成只发再见那一行 —— 「是哪种 shell」不值得为它开一个分支
        if (line === '') finish(0);
        return;

      case '\t':
        complete();
        return;

      default: {
        // 其它控制字符一律无视（真终端会把 `^X` 打到屏幕上，这里不做）
        if (ch.charCodeAt(0) < 0x20) return;
        line += ch;
        emitRaw(ch); // 逐字符回显：这就是终端上「打字」的样子
      }
    }
  }

  function backspace(): void {
    // 提示符是**已经发出去的字节**，删不掉；能删的只有自己这一行
    if (line === '') return;
    line = line.slice(0, -1);
    // 退一格、用空格盖掉、再退回来。比 `\x1b[D\x1b[K` 更接近真终端，
    // 也不依赖「光标后面没别的字符」这个假设
    emitRaw('\b \b');
  }

  function accept(): void {
    const input = line;
    line = '';
    draft = '';
    emitRaw('\r\n');

    // 空行不进历史（真 bash 也不进），刷新游标到草稿位
    if (input.trim() !== '') history.push(input);
    historyIndex = history.length;

    if (input.trim() !== '') run(input);
    // exit 里已经把 exited 立起来了；再发提示符就会出现「退出之后还在等输入」的假象
    if (!exited) showPrompt();
  }

  /** 丢掉正在编辑的行，历史游标回到草稿位 */
  function resetLine(): void {
    line = '';
    draft = '';
    historyIndex = history.length;
  }

  // ---------------------------------------------------------------- 编辑键

  function historyPrev(): void {
    if (historyIndex === 0) return; // 最老的一条了
    // 从草稿位往上走之前，先把没敲完的行收好，走回来时还回去
    if (historyIndex === history.length) draft = line;
    historyIndex -= 1;
    line = history[historyIndex] ?? '';
    redrawLine();
  }

  function historyNext(): void {
    if (historyIndex >= history.length) return; // 已经在草稿位了
    historyIndex += 1;
    line = historyIndex === history.length ? draft : (history[historyIndex] ?? '');
    redrawLine();
  }

  /**
   * 处理一个转义序列，返回它**最后一个字符的下标**；序列被切断返回 -1。
   *
   * 只认方向键（历史）和 SS3 形式的方向键：xterm 开了应用光标模式（DECCKM）之后
   * 方向键发的是 `\x1bOA` 而不是 `\x1b[A`，两种都得认，不然「在某个程序里退出来
   * 之后历史键突然不好使」这种玄学问题就会出现在替身上。
   *
   * 左右方向键、Home/End、Delete 一律无视：真终端里光标是**远端**在动的，这里不做
   * 行内编辑，等于远端不支持光标移动 —— 视觉上自洽（光标不会自己跑到别处去）。
   */
  function escape(input: string, start: number): number {
    const second = input.charAt(start + 1);
    if (second === '') return -1; // 只有 ESC，等下一段

    if (second === 'O') {
      const third = input.charAt(start + 2);
      if (third === '') return -1;
      if (third === 'A') historyPrev();
      else if (third === 'B') historyNext();
      return start + 2;
    }

    // 不是 CSI 的 ESC 序列（Alt+键之类）不认，吃掉两个字符就完事
    if (second !== '[') return start + 1;

    // CSI：参数字节在 0x20-0x3f，第一个 0x40-0x7e 的字节是终止字节
    for (let i = start + 2; i < input.length; i += 1) {
      const code = input.charCodeAt(i);
      if (code < 0x40 || code > 0x7e) continue;
      const final = input.charAt(i);
      if (final === 'A') historyPrev();
      else if (final === 'B') historyNext();
      return i;
    }
    return -1;
  }

  /**
   * Tab 补全，只补**命令名**（行里还没空格的时候）。
   *
   * 文件名补全刻意不做：中文文件名的补全在真 bash 里也是按字节走的，行为很微妙，
   * 而演示里手敲一个短名字就够了。多个候选时列出来再重画一遍提示符和行，和 readline
   * 一样；不做「先补到公共前缀」那一步。
   */
  function complete(): void {
    if (line.includes(' ')) return;

    const hits = COMMANDS.filter((name) => name.startsWith(line));
    if (hits.length === 0) return; // 真 readline 会响一声，字节流里就是没有输出

    if (hits.length === 1) {
      line = `${hits[0] ?? ''} `;
      redrawLine();
      return;
    }

    out(hits.join('  '));
    redrawLine();
  }

  // ---------------------------------------------------------------- 执行

  function run(raw: string): void {
    const tokens = tokenize(raw);
    const name = tokens[0];
    if (name === undefined) return; // 只有空白的一行：什么都不做，提示符照发
    const args = tokens.slice(1);

    switch (name) {
      case 'pwd':
        out(cwd);
        return;

      case 'ls':
        doLs(args);
        return;

      case 'cd':
        doCd(args);
        return;

      case 'cat':
        if (args.length === 0) {
          out('cat: 本演示环境没有接标准输入，请给一个文件名。');
          return;
        }
        // 多个文件就接着打（真 cat 就是这样），一个失败不影响后面的
        for (const operand of args) {
          const file = fileOf('cat', operand);
          if (file === null) continue;
          for (const text of splitLines(file.content)) out(text);
        }
        return;

      case 'echo':
        doEcho(args);
        return;

      case 'whoami':
        out(user);
        return;

      case 'hostname':
        out(host);
        return;

      case 'date':
        out(formatDate(new Date()));
        return;

      case 'uname':
        doUname(args);
        return;

      case 'wc':
        doWc(args);
        return;

      case 'grep':
        doGrep(args);
        return;

      case 'help':
        for (const text of HELP_LINES) out(text);
        return;

      case 'clear':
        emitRaw('\x1b[2J\x1b[H');
        return;

      case 'exit':
        doExit(args);
        return;

      default:
        // 经典格式，一个字都不能差 —— 这是真 shell 最容易被认出来的那句话
        out(`${name}: command not found`);
    }
  }

  /** 解析一个路径参数。空参数当当前目录（`ls` 不传参就是列当前目录） */
  function resolvePath(input: string): string {
    if (input === '') return cwd;
    if (input === '~') return home;
    if (input.startsWith('~/')) return normalize(`${home}/${input.slice(2)}`);
    if (input.startsWith('/')) return normalize(input);
    return normalize(`${cwd}/${input}`);
  }

  /** 取一个文件。取不到就按真实工具的文案报错并返回 null（cat / grep / wc 都是这个格式） */
  function fileOf(command: string, operand: string): { path: string; content: string } | null {
    const path = resolvePath(operand);
    const entry = fs.get(path);
    if (entry === undefined) {
      out(`${command}: ${operand}: No such file or directory`);
      return null;
    }
    if (entry.kind === 'dir') {
      out(`${command}: ${operand}: Is a directory`);
      return null;
    }
    return { path, content: entry.content };
  }

  /** 目录里的直接子项，按码点排序（真 ls 走 locale，这里不假装知道中文该怎么排） */
  function childrenOf(dir: string): string[] {
    const prefix = dir === '/' ? '/' : `${dir}/`;
    const names: string[] = [];
    for (const path of fs.keys()) {
      if (!path.startsWith(prefix) || path === dir) continue;
      const rest = path.slice(prefix.length);
      if (rest === '' || rest.includes('/')) continue;
      names.push(rest);
    }
    return names.sort();
  }

  function doLs(args: string[]): void {
    // 选项一律无视（`-l` 长格式、`-a`：这个演示文件系统里没有隐藏文件）
    const operand = args.find((arg) => !arg.startsWith('-')) ?? '';
    const target = resolvePath(operand);
    const entry = fs.get(target);
    if (entry === undefined) {
      // 报错里带上用户敲的原样字符串，真 ls 也是这么回的
      out(`ls: cannot access '${operand}': No such file or directory`);
      return;
    }
    if (entry.kind === 'file') {
      out(operand);
      return;
    }
    for (const name of childrenOf(target)) out(name);
  }

  function doCd(args: string[]): void {
    const operand = args[0];

    if (operand === undefined || operand === '~') {
      previous = cwd;
      cwd = home;
      return;
    }

    if (operand === '-') {
      if (previous === null) {
        out('cd: OLDPWD not set');
        return;
      }
      const target = previous;
      previous = cwd;
      cwd = target;
      out(cwd); // 真 bash 的 `cd -` 会把切过去之后的目录打出来
      return;
    }

    const target = resolvePath(operand);
    const entry = fs.get(target);
    if (entry === undefined) {
      out(`cd: ${operand}: No such file or directory`);
      return;
    }
    if (entry.kind !== 'dir') {
      out(`cd: ${operand}: Not a directory`);
      return;
    }
    previous = cwd;
    cwd = target;
  }

  function doEcho(args: string[]): void {
    // `-n` 是真 echo 的选项（不换行）。为此留一条「不带换行」的发射路径是值得的：
    // 不然它会被原样打出来，变成一个显眼的假
    if (args[0] === '-n') {
      emitRaw(args.slice(1).join(' '));
      return;
    }
    out(args.join(' '));
  }

  function doUname(args: string[]): void {
    if (!args.includes('-a')) {
      // 只认 -a：`-r` / `-m` 这些逐项输出对一个演示来说没有信息量
      out('Linux');
      return;
    }
    out(`Linux ${host} 6.8.0-devtoolkit #1 SMP PREEMPT_DYNAMIC x86_64 GNU/Linux`);
  }

  function doWc(args: string[]): void {
    const operand = args.find((arg) => !arg.startsWith('-'));
    if (operand === undefined) {
      out('wc: 请给一个文件名。');
      return;
    }

    const file = fileOf('wc', operand);
    if (file === null) return;

    const lines = splitLines(file.content).length;
    if (args.includes('-l')) {
      out(`${lines} ${operand}`);
      return;
    }

    // 词按空白切（中文整行算一个词）—— 这就是真 wc 的行为，不是「字数」
    const words = file.content.split(/\s+/).filter((word) => word !== '').length;
    const bytes = new TextEncoder().encode(file.content).length;
    // 数字之间用单空格：真 wc 在多文件时会按最大宽度对齐，这里不做那个对齐
    out(`${lines} ${words} ${bytes} ${operand}`);
  }

  function doGrep(args: string[]): void {
    const pattern = args[0];
    const operand = args[1];
    if (pattern === undefined || operand === undefined) {
      out('grep: 用法：grep <内容> <文件>');
      return;
    }

    const file = fileOf('grep', operand);
    if (file === null) return;

    // 纯子串匹配，没有正则、没有选项。匹配不到就是什么都不打（真 grep 这时退出码是 1，
    // 但退出码这个概念在这个替身里只属于会话本身）
    for (const text of splitLines(file.content)) {
      if (text.includes(pattern)) out(text);
    }
  }

  function doExit(args: string[]): void {
    const operand = args[0];

    if (operand === undefined) {
      finish(0);
      return;
    }

    if (args.length > 1) {
      // 真 bash 在这种情况下**不退出**，只报一句
      out('exit: too many arguments');
      return;
    }

    const code = Number(operand);
    if (!Number.isInteger(code)) {
      // 真 bash：报错并按 2 退出
      out(`exit: ${operand}: numeric argument required`);
      finish(2);
      return;
    }

    // 退出码只有一个字节：exit 256 在真 shell 里就是 0
    finish(code & 0xff);
  }

  /**
   * 结束会话。
   *
   * 先把 `exited` 立起来再回调：`onExit` 里同步调 `write()`（或者 close）是合法用法，
   * 那时候已经开始收尾了，不该再执行什么命令。
   */
  function finish(code: number): void {
    out('再见！演示会话结束。');
    exited = true;
    opts.onExit?.(code);
  }
}

/**
 * `date` 的格式：`2026-09-17 09:12:34 +08:00`。
 *
 * 用**数字时区偏移**而不是 `CST` / `GMT+8` 这种缩写 —— 缩写依赖 TZ 数据库和 locale，
 * 同一份代码在 CI 里可能打出另一个词，而数字偏移到哪都是同一个意思。
 *
 * 时间用真时钟（不是写死的常量）：一个永远停在同一个时刻的 `date` 比一个真的时钟
 * 更容易让人以为程序卡住了。反正没有 e2e 会去断言「现在几点」。
 */
function formatDate(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  const offset = -now.getTimezoneOffset(); // getTimezoneOffset 的符号和 UTC 偏移相反
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())} ` +
    `${offset < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`
  );
}
