import { describe, expect, it } from 'vitest';
import {
  CHANGED_KEY_HOST,
  UNREACHABLE_HOST,
  authFailure,
  connectFailure,
  createFakeShell,
  fakeAlgorithm,
  fakeFingerprint,
} from '../../src/modules/ssh/core/fakeSsh';

const USER = 'dev';
const HOST = 'demo.invalid';

/** 提示符。家目录显示成 `~`（bash 的 `\w` 行为），换了目录就显示那个目录 */
const prompt = (dir = '~'): string => `${USER}@${HOST}:${dir}$ `;

/**
 * 最小测试台。
 *
 * 断言读的是 `text()`（拼起来的输出 = 终端上最终看到的样子），但 `chunks` 原样留着 ——
 * 有几条测试要验证输出确实是**分多次**来的，那是 e2e 观察的路径，不能只测拼接结果。
 */
function openShell(options: { user?: string; host?: string; cwd?: string } = {}) {
  const chunks: string[] = [];
  const exits: number[] = [];
  const shell = createFakeShell({
    user: options.user ?? USER,
    host: options.host ?? HOST,
    cwd: options.cwd,
    emit: (data) => {
      chunks.push(data);
    },
    onExit: (code) => {
      exits.push(code);
    },
  });

  return {
    shell,
    chunks,
    exits,
    /** 到现在为止终端上出现过的全部内容 */
    text: (): string => chunks.join(''),
    /** 记下当前位置，配 since() 只看这之后的新输出 */
    mark: (): number => chunks.length,
    since: (mark: number): string => chunks.slice(mark).join(''),
    /** mark() 之后新产生的每一块（要断言分块边界时用） */
    chunksSince: (mark: number): string[] => chunks.slice(mark),
    /** 敲键盘（原样喂给 shell） */
    type: (data: string): void => {
      shell.write(data);
    },
    /** 敲一条命令并回车 */
    run: (line: string): void => {
      shell.write(`${line}\r`);
    },
  };
}

function countOf(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe('假 SSH：连接层的纯函数', () => {
  it('同一个 host:port 永远同一个指纹，形状和真的一样', () => {
    const fingerprint = fakeFingerprint('example.com', 22);
    expect(fingerprint).toBe(fakeFingerprint('example.com', 22));
    // SHA256: + 43 个 base64 字符（32 字节无填充）—— 和 ssh-keyscan 的输出形状一致
    expect(fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
  });

  it('不同主机、不同端口是两把不同的钥匙', () => {
    expect(fakeFingerprint('a.example', 22)).not.toBe(fakeFingerprint('b.example', 22));
    expect(fakeFingerprint('a.example', 22)).not.toBe(fakeFingerprint('a.example', 2222));
  });

  it('主机名大小写和两端空格不影响结果', () => {
    // 不然 `LOCALHOST` 和 `localhost` 会得到两把「不同」的密钥，
    // 用户会在第二次连接时看到莫名其妙的「密钥变了」
    expect(fakeFingerprint(' Example.COM ', 22)).toBe(fakeFingerprint('example.com', 22));
  });

  it('算法名固定，且像个真的算法名', () => {
    expect(fakeAlgorithm()).toBe(fakeAlgorithm());
    expect(fakeAlgorithm()).toMatch(/^ssh-/);
  });

  it('魔数主机名连不上，文案里点名了地址', () => {
    const message = connectFailure(UNREACHABLE_HOST, 22);
    expect(message).toContain(`${UNREACHABLE_HOST}:22`);
    expect(message).toContain('失败');

    expect(connectFailure('example.com', 22)).toBeNull();
    // 密钥变了**不是**「连不上」：它是一次成功握手得出的结论，
    // 按 core/types.ts 的约定走 Ok 里的 hostKeyMismatch
    expect(connectFailure(CHANGED_KEY_HOST, 22)).toBeNull();
  });

  it('认证：空用户名、空密码、nobody 都被拒', () => {
    expect(authFailure('', 'pw')).toContain('用户名为空');
    expect(authFailure('   ', 'pw')).toContain('用户名为空');
    expect(authFailure(USER, '')).toContain('密码为空');
    expect(authFailure('nobody', '随便什么密码')).toContain('不正确');
    // 支持的方式要在文案里点名，用户才知道该换密码还是该换私钥
    expect(authFailure('nobody', 'x')).toContain('publickey');
    expect(authFailure('nobody', 'x')).toContain('password');
  });

  it('认证：除了那几个钩子，什么都放行', () => {
    // 假服务器不校验密码 —— e2e 才能用任意密码走通「连接」这条主路径
    expect(authFailure(USER, 'secret')).toBeNull();
    expect(authFailure(USER, '任意密码都行')).toBeNull();
  });

  it('私钥认证不拿空口令当错', () => {
    // 私钥认证没有「密码」这个概念，无口令的私钥是常态。
    // 不显式传 'key' 就会被当成「密码为空」误拒 —— 这个参数不是装饰
    expect(authFailure(USER, '', 'key')).toBeNull();
    // 用户名不管哪种认证方式都要查
    expect(authFailure('nobody', '', 'key')).toContain('不正确');
    expect(authFailure('', '', 'key')).toContain('用户名为空');
  });
});

describe('假 SSH：登录横幅', () => {
  it('一上来就是横幅加提示符，而且是分块发的', () => {
    const h = openShell();
    expect(h.shell.exited).toBe(false);

    // 三行横幅 + 一个空行 + 提示符：**五块**，不是一大坨
    expect(h.chunks).toHaveLength(5);
    expect(h.chunks[0]).toContain(HOST);
    expect(h.chunks[1]).toContain(USER);
    expect(h.chunks[1]).toContain('演示');
    expect(h.chunks[3]).toBe('\r\n');
    expect(h.chunks[4]).toBe(prompt());
  });

  it('root 的提示符用 #（和真 bash 一样）', () => {
    const h = openShell({ user: 'root' });
    // 家目录照旧显示成 ~（root 的家是 /root，不是 /home/root）
    expect(h.text().endsWith(`root@${HOST}:~# `)).toBe(true);
  });
});

describe('假 SSH：回显与编辑键', () => {
  it('逐字符回显，输出和提示符各自成块', () => {
    const h = openShell();
    const mark = h.mark();
    h.run('pwd');

    expect(h.chunksSince(mark)).toEqual([
      'p',
      'w',
      'd',
      '\r\n',
      `/home/${USER}\r\n`,
      prompt(),
    ]);
  });

  it('未知命令是经典的那句话', () => {
    const h = openShell();
    const mark = h.mark();
    h.run('fly-to-mars');
    expect(h.since(mark)).toBe(`fly-to-mars\r\nfly-to-mars: command not found\r\n${prompt()}`);
  });

  it('退格删字符，但删不掉提示符', () => {
    const h = openShell();
    const mark = h.mark();
    h.type('pwdx');
    h.type('\x7f\x7f\x7f\x7f\x7f'); // 五个退格，只有四个字符可删

    // 提示符是已经发出去的字节，第五个退格不该去擦它
    expect(countOf(h.since(mark), '\b \b')).toBe(4);

    // 行确实空了：回车不会执行任何命令，只换来一个干净的提示符
    h.run('');
    expect(h.since(mark)).not.toContain('/home/');
    expect(h.text().endsWith(`\r\n${prompt()}`)).toBe(true);
  });

  it('Ctrl+C 丢掉没敲完的行，换一个干净的提示符', () => {
    const h = openShell();
    h.type('echo 没有敲完');
    const mark = h.mark();
    h.type('\x03');

    expect(h.since(mark)).toBe(`^C\r\n${prompt()}`);
    h.run('');
    // 那半行被丢掉了：整段输出里「没有敲完」只出现一次（就是我敲进去的那次回显）
    expect(countOf(h.text(), '没有敲完')).toBe(1);
  });

  it('Ctrl+L 清屏并把提示符和当前行重画到左上角', () => {
    const h = openShell();
    h.type('pw');
    const mark = h.mark();
    h.type('\x0c');
    expect(h.since(mark)).toBe(`\x1b[2J\x1b[H\r\x1b[K${prompt()}pw`);
  });

  it('Ctrl+D 只在空行上退出', () => {
    const h = openShell();
    h.type('ab');
    h.type('\x04');
    expect(h.exits).toEqual([]); // 非空行上真 bash 什么也不做

    h.type('\x7f\x7f');
    h.type('\x04');
    expect(h.exits).toEqual([0]);
    expect(h.shell.exited).toBe(true);
  });
});

describe('假 SSH：历史', () => {
  it('↑/↓ 翻历史，翻到头就停住', () => {
    const h = openShell();
    h.run('pwd');
    h.run('whoami');

    h.type('\x1b[A');
    expect(h.text().endsWith(`\r\x1b[K${prompt()}whoami`)).toBe(true);
    h.type('\x1b[A');
    expect(h.text().endsWith(`\r\x1b[K${prompt()}pwd`)).toBe(true);
    h.type('\x1b[A'); // 已经是最老的一条，不动
    expect(h.text().endsWith(`\r\x1b[K${prompt()}pwd`)).toBe(true);

    h.type('\x1b[B');
    expect(h.text().endsWith(`\r\x1b[K${prompt()}whoami`)).toBe(true);
    h.type('\x1b[B'); // 回到草稿位（空行）
    expect(h.text().endsWith(`\r\x1b[K${prompt()}`)).toBe(true);
  });

  it('翻过草稿位再翻回来，没敲完的那行还在', () => {
    const h = openShell();
    h.run('pwd');
    h.run('whoami');

    h.type('ec');
    h.type('\x1b[A');
    expect(h.text().endsWith(`\r\x1b[K${prompt()}whoami`)).toBe(true);

    h.type('\x1b[B');
    expect(h.text().endsWith(`\r\x1b[K${prompt()}ec`)).toBe(true);

    // 回车跑的正是那半行 —— 证明草稿是真的还回来了，不是画上去的
    h.run('');
    expect(h.text()).toContain('ec: command not found');
  });

  it('应用光标模式下的方向键（ESC O A）也认', () => {
    // xterm 开了 DECCKM 之后方向键发的是 \x1bOA 而不是 \x1b[A，
    // 不认的话就会出现「从某个程序退出来之后历史键突然不好使」这种玄学
    const h = openShell();
    h.run('pwd');
    h.type('\x1bOA');
    expect(h.text().endsWith(`\r\x1b[K${prompt()}pwd`)).toBe(true);
  });

  it('空行不进历史', () => {
    const h = openShell();
    h.run('pwd');
    h.run('');
    h.run('');
    h.type('\x1b[A');
    // 两次空回车没有占住历史，↑ 直接就是上一条真命令
    expect(h.text().endsWith(`\r\x1b[K${prompt()}pwd`)).toBe(true);
  });

  it('历史为空时方向键一动不动', () => {
    const h = openShell();
    const mark = h.mark();
    h.type('\x1b[A');
    h.type('\x1b[B');
    expect(h.since(mark)).toBe('');
  });
});

describe('假 SSH：目录与文件', () => {
  it('pwd 和 cd：~、..、相对路径都走得通', () => {
    const h = openShell();

    h.run('cd 项目');
    const sub = h.mark();
    h.run('pwd');
    expect(h.since(sub)).toBe(`pwd\r\n/home/${USER}/项目\r\n${prompt('~/项目')}`);

    h.run('cd ..');
    const up = h.mark();
    h.run('pwd');
    expect(h.since(up)).toBe(`pwd\r\n/home/${USER}\r\n${prompt()}`);

    h.run('cd /tmp');
    const abs = h.mark();
    h.run('pwd');
    expect(h.since(abs)).toBe(`pwd\r\n/tmp\r\n${prompt('/tmp')}`);

    h.run('cd ~');
    const back = h.mark();
    h.run('pwd');
    expect(h.since(back)).toBe(`pwd\r\n/home/${USER}\r\n${prompt()}`);
  });

  it('cd - 回到上一个目录，并把目录打出来', () => {
    const h = openShell();
    h.run('cd /tmp');
    h.run('cd /etc');

    const mark = h.mark();
    h.run('cd -');
    expect(h.since(mark)).toBe(`cd -\r\n/tmp\r\n${prompt('/tmp')}`);
  });

  it('没切过目录时 cd - 报 OLDPWD not set', () => {
    const h = openShell();
    const mark = h.mark();
    h.run('cd -');
    expect(h.since(mark)).toContain('OLDPWD not set');
  });

  it('cd 到不存在的东西报真实 cd 的话', () => {
    const h = openShell();

    const missing = h.mark();
    h.run('cd 不存在的目录');
    expect(h.since(missing)).toContain("cd: 不存在的目录: No such file or directory");

    const notDir = h.mark();
    h.run('cd readme.txt');
    expect(h.since(notDir)).toContain('cd: readme.txt: Not a directory');
  });

  it('ls 列出目录内容，一行一块', () => {
    const h = openShell();
    const mark = h.mark();
    h.run('ls');

    // 顺序是码点序（不是拼音序），这里断言的是分块边界：一行一块 + 提示符
    expect(h.chunksSince(mark)).toEqual([
      'l',
      's',
      '\r\n',
      'readme.txt\r\n',
      '说明.txt\r\n',
      '项目\r\n',
      prompt(),
    ]);
  });

  it('ls 带参数：目录、文件、不存在各是一种行为', () => {
    const h = openShell();

    const etc = h.mark();
    h.run('ls /etc');
    expect(h.since(etc)).toContain('hostname');
    expect(h.since(etc)).toContain('os-release');

    const one = h.mark();
    h.run('ls readme.txt'); // 真 ls 会把文件名本身打回来
    expect(h.since(one)).toBe(`ls readme.txt\r\nreadme.txt\r\n${prompt()}`);

    const nope = h.mark();
    h.run('ls 没有这个目录');
    expect(h.since(nope)).toContain("ls: cannot access '没有这个目录': No such file or directory");
  });

  it('cat 一个中文文件，中文原样回来', () => {
    const h = openShell();
    const mark = h.mark();
    h.run('cat 说明.txt');

    const text = h.since(mark);
    expect(text).toContain('这是一个演示环境里的假文件。');
    expect(text).toContain('命令和文件都只在本进程内存在，不会碰真实系统。');

    // 三行文件 → 三块 + 提示符
    expect(h.chunksSince(mark).slice(-2)).toEqual([
      '命令和文件都只在本进程内存在，不会碰真实系统。\r\n',
      prompt(),
    ]);
  });

  it('cat 同时读多个文件，一个失败不影响后面的', () => {
    const h = openShell();
    const mark = h.mark();
    h.run('cat 没有这个文件 readme.txt');

    const text = h.since(mark);
    expect(text).toContain('cat: 没有这个文件: No such file or directory');
    expect(text).toContain('Devtoolkit demo shell.');
  });

  it('grep 按子串过滤文件的每一行', () => {
    const h = openShell();

    const hits = h.mark();
    h.run('grep 2026 /tmp/演示.log');
    expect(h.chunksSince(hits).slice(-4)).toEqual([
      '2026-09-17 09:12:01 启动演示环境\r\n',
      '2026-09-17 09:12:02 装载假文件系统\r\n',
      '2026-09-17 09:12:03 就绪\r\n',
      prompt(),
    ]);

    const empty = h.mark();
    h.run('grep 找不到的内容 /tmp/演示.log');
    // 一行都不匹配就是什么都不打（真 grep 这时退出码是 1，但退出码只属于会话本身）
    expect(h.since(empty)).toBe(`grep 找不到的内容 /tmp/演示.log\r\n${prompt()}`);

    const missing = h.mark();
    h.run('grep 任意 /etc/没有这个文件');
    expect(h.since(missing)).toContain('grep: /etc/没有这个文件: No such file or directory');
  });

  it('wc 数行数、词数、字节数', () => {
    const h = openShell();

    const full = h.mark();
    h.run('wc 说明.txt');
    expect(h.since(full)).toMatch(/^wc 说明\.txt\r\n3 \d+ \d+ 说明\.txt\r\n/);

    const lines = h.mark();
    h.run('wc -l 说明.txt');
    expect(h.since(lines)).toBe(`wc -l 说明.txt\r\n3 说明.txt\r\n${prompt()}`);
  });
});

describe('假 SSH：其它命令', () => {
  it('echo 认引号，也认 -n', () => {
    const h = openShell();

    const plain = h.mark();
    h.run('echo 你好 世界');
    expect(h.since(plain)).toBe(`echo 你好 世界\r\n你好 世界\r\n${prompt()}`);

    const quoted = h.mark();
    h.run('echo "你好  世界"'); // 引号里的两个空格要留住（不然分词就白做了）
    expect(h.since(quoted)).toBe(`echo "你好  世界"\r\n你好  世界\r\n${prompt()}`);

    const bare = h.mark();
    h.run('echo');
    expect(h.since(bare)).toBe(`echo\r\n\r\n${prompt()}`);

    const noNewline = h.mark();
    h.run('echo -n 不换行');
    expect(h.since(noNewline)).toBe(`echo -n 不换行\r\n不换行${prompt()}`);
  });

  it('whoami / hostname', () => {
    const h = openShell();
    const mark = h.mark();
    h.run('whoami');
    h.run('hostname');
    expect(h.since(mark)).toContain(`whoami\r\n${USER}\r\n`);
    expect(h.since(mark)).toContain(`hostname\r\n${HOST}\r\n`);
  });

  it('date 的格式是稳定的，时区用数字偏移', () => {
    const h = openShell();
    const mark = h.mark();
    h.run('date');
    // 具体几点几分不断言（那是真时钟），只钉住格式：不能变成依赖 locale 的写法
    const stamped = h
      .chunksSince(mark)
      .some((chunk) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{2}:\d{2}\r\n$/.test(chunk));
    expect(stamped).toBe(true);
  });

  it('uname 认 -a', () => {
    const h = openShell();

    const short = h.mark();
    h.run('uname');
    expect(h.since(short)).toBe(`uname\r\nLinux\r\n${prompt()}`);

    const full = h.mark();
    h.run('uname -a');
    const text = h.since(full);
    expect(text).toContain(`Linux ${HOST}`);
    expect(text).toContain('GNU/Linux');
  });

  it('clear 发清屏序列再把提示符画回去', () => {
    const h = openShell();
    const mark = h.mark();
    h.run('clear');
    expect(h.chunksSince(mark)).toEqual(['c', 'l', 'e', 'a', 'r', '\r\n', '\x1b[2J\x1b[H', prompt()]);
  });

  it('help 列出命令，并说清这是个演示环境', () => {
    const h = openShell();
    const mark = h.mark();
    h.run('help');
    const text = h.since(mark);
    expect(text).toContain('cat');
    expect(text).toContain('exit');
    expect(text).toContain('演示');
  });

  it('Tab 补全命令名；多个候选就列出来', () => {
    const h = openShell();

    h.type('ech\t');
    expect(h.text().endsWith('echo ')).toBe(true); // 唯一命中，补上并留一个空格
    h.run('hi');
    expect(h.text()).toContain('hi\r\n');

    const many = h.mark();
    h.type('c\t');
    // 先回显敲进去的 `c`（Tab 自己不占屏幕，它是编辑键），然后才是候选和重画
    expect(h.since(many)).toBe(`c` + `cat  cd  clear\r\n` + `\r\x1b[K${prompt()}c`);

    const none = h.mark();
    h.type('zz\t');
    expect(h.since(none)).toBe('zz'); // 没有候选就什么都不做
  });
});

describe('假 SSH：退出与关闭', () => {
  it('exit 发完再见就调 onExit(0)，之后不再有提示符', () => {
    const h = openShell();
    const mark = h.mark();
    h.run('exit');

    expect(h.since(mark)).toBe(`exit\r\n再见！演示会话结束。\r\n`);
    expect(h.exits).toEqual([0]);
    expect(h.shell.exited).toBe(true);
  });

  it('exit N 把 N 传出去', () => {
    const h = openShell();
    h.run('exit 3');
    expect(h.exits).toEqual([3]);
  });

  it('退出码只有一个字节', () => {
    // 每个用例换个新 shell：退出之后 write 就被无视了，同一个 shell 里敲不出第二次 exit
    const big = openShell();
    big.run('exit 256'); // 真 shell 里 256 就是 0
    expect(big.exits).toEqual([0]);

    const negative = openShell();
    negative.run('exit -1');
    expect(negative.exits).toEqual([255]);
  });

  it('exit 的两种参数错误', () => {
    const h = openShell();
    h.run('exit abc');
    expect(h.text()).toContain('exit: abc: numeric argument required');
    expect(h.exits).toEqual([2]); // 真 bash 在这种情况下按 2 退出

    const other = openShell();
    other.run('exit 1 2');
    expect(other.text()).toContain('exit: too many arguments');
    expect(other.exits).toEqual([]); // 参数太多时**不退出**
  });

  it('退出之后敲什么都没反应', () => {
    const h = openShell();
    h.run('exit');
    const mark = h.mark();
    h.type('pwd\r');
    h.type('\x03');
    expect(h.since(mark)).toBe('');
  });

  it('close 幂等，之后不再输出，但它不等于「退出了」', () => {
    const h = openShell();
    h.shell.close();

    const mark = h.mark();
    h.type('pwd\r');
    expect(h.since(mark)).toBe('');

    h.shell.close(); // 再来一次不该炸也不该有副作用
    // close 是「这一端拆了」，exited 是「远端 shell 结束了」，两回事
    expect(h.shell.exited).toBe(false);
  });
});
