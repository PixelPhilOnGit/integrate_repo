/**
 * 命令块的纯逻辑。
 *
 * 这层是「本地推断块边界」的全部依据，所以断言直接打在**块的口径**上：
 * 哪一行、从第几列开始、命令原文是什么、耗时怎么算。
 *
 * ⚠️ 它**不碰终端**（缓冲区读取由调用方做），所以这里的行号/列都是字面量 ——
 * 这正是要的：把「什么时候算一块」这件事和终端实现彻底分开。
 */
import { describe, expect, it } from 'vitest';
import {
  cleanTyped,
  createBlockTracker,
  splitInput,
  stripEscapes,
} from '../../src/modules/ssh/core/blocks';

describe('命令块：一条命令怎么变成一块', () => {
  it('敲字 → 回车：命令、起点、时刻都记下来', () => {
    const t = createBlockTracker();

    // 提示符占了 0..3 列，用户从第 4 列开始敲
    t.begin(10, 4, 1000);
    t.submit('ls -la', 10, 10, 1500);

    const [block] = t.blocks();
    expect(block).toMatchObject({
      command: 'ls -la',
      line: 10,
      col: 4, // 起点取的是**敲第一个键**那一刻，不是回车那一刻
      at: 1500,
      lastOutputAt: null,
    });
  });

  it('起点只认这一轮的第一个键 —— 后面那些字是在同一个起点后面打的', () => {
    const t = createBlockTracker();
    t.begin(3, 8, 100);
    t.begin(3, 9, 200); // 第二个字符
    t.begin(3, 10, 300);
    t.submit('echo hi', 3, 15, 400);

    expect(t.blocks()[0]).toMatchObject({ col: 8 });
  });

  it('多行命令：起点是第一行的位置', () => {
    const t = createBlockTracker();
    t.begin(5, 2, 100);
    // 续行在下一行，回车时光标已经到第 6 行
    t.submit('echo a \\\necho b', 6, 7, 900);

    expect(t.blocks()[0]).toMatchObject({ line: 5, col: 2 });
  });

  it('没有 begin 时，用回车的位置倒推起点（整行粘贴、历史里取出来的）', () => {
    const t = createBlockTracker();
    // 「user@host:~$ git status」——光标在 22 列，命令长 10
    t.submit('git status', 7, 22, 500);

    expect(t.blocks()[0]).toMatchObject({ line: 7, col: 12 });
  });

  it('倒推也不会算出负数（提示符短、命令长的时候）', () => {
    const t = createBlockTracker();
    t.submit('verylongcommand', 1, 3, 500);
    expect(t.blocks()[0]!.col).toBe(0);
  });
});

describe('命令块：哪些不算一块', () => {
  it('空命令不成块 —— Ctrl+C、直接回车、只按方向键都不是一次执行', () => {
    const t = createBlockTracker();
    t.begin(1, 2, 10);
    t.submit('   ', 1, 5, 20); // 只剩空白

    expect(t.blocks()).toHaveLength(0);
  });

  it('空命令之后，输出不会被记到上一条命令头上', () => {
    const t = createBlockTracker();
    t.begin(1, 2, 10);
    t.submit('ls', 1, 4, 20);

    // 用户按了 Ctrl+C（不成块），接着终端继续吐字节
    t.begin(2, 2, 30);
    t.submit('', 2, 3, 40);
    t.output(50);

    // 那一块仍然停在「一个字节都没吐」
    expect(t.blocks()[0]!.lastOutputAt).toBeNull();
  });
});

describe('命令块：输出记在谁头上', () => {
  it('输出只更新**最近提交**的那一块', () => {
    const t = createBlockTracker();
    t.begin(1, 0, 10);
    t.submit('a', 1, 1, 20);
    t.output(100);
    t.output(200);

    t.begin(5, 0, 300);
    t.submit('b', 5, 1, 400);
    t.output(500);

    const [first, second] = t.blocks();
    expect(first!.lastOutputAt).toBe(200); // 第二块的输出没有污染它
    expect(second!.lastOutputAt).toBe(500);
  });

  it('提交之前来的输出不算在任何块上', () => {
    const t = createBlockTracker();
    t.output(10); // 会话刚连上时的横幅
    t.begin(1, 0, 20);
    t.submit('ls', 1, 2, 30);

    expect(t.blocks()[0]!.lastOutputAt).toBeNull();
  });

  it('一个字节都没吐的块留着 lastOutputAt = null（渲染那边翻译成「无输出」）', () => {
    const t = createBlockTracker();
    t.begin(1, 0, 10);
    t.submit('mkdir x', 1, 2, 20);
    // 什么都不吐就结束了
    t.begin(2, 0, 30);
    t.submit('pwd', 2, 3, 40);

    expect(t.blocks()[0]!.command).toBe('mkdir x');
    expect(t.blocks()[0]!.lastOutputAt).toBeNull();
  });

  it('块按提交顺序排（新的在后），id 递增', () => {
    const t = createBlockTracker();
    for (const [i, cmd] of ['a', 'b', 'c'].entries()) {
      t.begin(i, 0, i * 10);
      t.submit(cmd, i, 1, i * 10 + 5);
    }

    expect(t.blocks().map((b) => b.command)).toEqual(['a', 'b', 'c']);
    expect(t.blocks()[0]!.id).toBeLessThan(t.blocks()[2]!.id);
  });
});

describe('命令块：起点与作废', () => {
  it('start() 把起点交出去（调用方要拿它去缓冲区读命令）', () => {
    const t = createBlockTracker();
    t.begin(4, 9, 100);
    expect(t.start()).toEqual({ line: 4, col: 9 });
  });

  it('提交之后起点就交出去了（下一条命令会重新记）', () => {
    const t = createBlockTracker();
    t.begin(4, 9, 100);
    t.submit('ls', 4, 11, 200);
    expect(t.start()).toBeNull();
  });

  it('Ctrl+C 作废这一轮：起点清掉，下一条命令从新位置算', () => {
    const t = createBlockTracker();
    t.begin(1, 5, 10); // 在提示符上敲了半条命令
    t.cancel(); // ……然后 Ctrl+C 了
    expect(t.start()).toBeNull();

    t.begin(2, 4, 20); // 新提示符在新的一行
    t.submit('pwd', 2, 7, 30);
    expect(t.blocks()[0]).toMatchObject({ line: 2, col: 4 });
  });
});

describe('命令块：重算行号（折叠之后）', () => {
  it('只改点名的那些块，没提到的保持原样', () => {
    const t = createBlockTracker();
    t.begin(0, 0, 1);
    t.submit('a', 0, 1, 2);
    t.begin(5, 0, 3);
    t.submit('b', 5, 1, 4);
    t.begin(9, 0, 5);
    t.submit('c', 9, 1, 6);

    // 折叠了第 1 块（少了 4 行），它后面两块整体上移
    t.remap(new Map([[2, 1], [3, 5]]));

    expect(t.blocks().map((b) => b.line)).toEqual([0, 1, 5]);
  });

  it('空的重算表什么都不改', () => {
    const t = createBlockTracker();
    t.begin(3, 0, 1);
    t.submit('ls', 3, 1, 2);
    t.remap(new Map());
    expect(t.blocks()[0]!.line).toBe(3);
  });
});

describe('命令块：清屏之后丢掉已经被擦掉的块', () => {
  it('行号 >= 新块的那些全丢，新块自己留着 —— 数组重新有序', () => {
    const t = createBlockTracker();
    // 三条命令停在旧坐标系的大行号上（清屏把回滚区剪掉之前记的）
    for (const [i, cmd] of ['a', 'b', 'c'].entries()) {
      t.begin(4000 + i * 3, 0, i);
      t.submit(cmd, 4000 + i * 3, 1, i + 1);
    }
    // 清屏之后的第一条命令：行号从 0 重新数
    t.begin(0, 0, 99);
    t.submit('d', 0, 1, 100);

    expect(t.pruneFrom(0)).toEqual([1, 2, 3]);
    expect(t.blocks().map((b) => b.command)).toEqual(['d']);
    // ⚠️ 这条不变式是二分查找和渲染那两条 break 的前提（清屏会把它破坏掉）
    expect(t.blocks().map((b) => b.line)).toEqual([0]);
  });

  it('⚠️ 回滚区里还剩内容的块一个都不动（`ESC[2J` 只擦视口那几行）', () => {
    const t = createBlockTracker();
    t.begin(2, 0, 1);
    t.submit('cat big.log', 2, 1, 2); // 在回滚区，内容还在
    t.begin(5, 0, 3);
    t.submit('clear', 5, 1, 4); // 在视口里，会被擦掉
    t.begin(5, 0, 5);
    t.submit('pwd', 5, 1, 6); // 清屏后第一条：行号回到视口第一行

    // 只丢 `clear` 那一块：新提示符正好落在它那一行，但回滚区那块（行号更小）
    // 一点没碰 —— 这正是「不能用『比上一块小就全清』」那条规则的原因
    expect(t.pruneFrom(5)).toEqual([2]);
    expect(t.blocks().map((b) => b.command)).toEqual(['cat big.log', 'pwd']);
  });

  it('没清过屏（行号一路往后走）：一个都不丢', () => {
    const t = createBlockTracker();
    t.begin(0, 0, 1);
    t.submit('ls', 0, 1, 2);
    t.begin(4, 0, 3);
    t.submit('pwd', 4, 1, 4);
    t.begin(9, 0, 5);
    t.submit('top', 9, 1, 6);

    expect(t.pruneFrom(9)).toEqual([]);
    expect(t.blocks().map((b) => b.command)).toEqual(['ls', 'pwd', 'top']);
  });

  it('剪完输出仍然记在最后提交的那一块上（它没被剪掉）', () => {
    const t = createBlockTracker();
    t.begin(900, 0, 1);
    t.submit('old', 900, 1, 2);
    t.begin(0, 0, 3);
    t.submit('new', 0, 1, 4);

    t.pruneFrom(0);
    t.output(777);

    expect(t.blocks()[0]!.lastOutputAt).toBe(777);
  });
});

describe('输入拆分与清洗', () => {
  it('普通按键：没有回车', () => {
    expect(splitInput('ls -l')).toEqual({ text: 'ls -l', submit: false });
  });

  it('回车键（\\r）算提交，并且只取回车之前的部分', () => {
    expect(splitInput('ls\r')).toEqual({ text: 'ls', submit: true });
  });

  it('粘贴进来的多行文本走 \\n', () => {
    expect(splitInput('echo hi\n')).toEqual({ text: 'echo hi', submit: true });
  });

  it('摘掉 bracketed paste 的包装', () => {
    // 粘贴时终端会给这两头加上标记，留着的话命令会以一个看不见的序列开头
    expect(stripEscapes('\x1b[200~ls\x1b[201~')).toBe('ls');
  });

  it('摘掉方向键之类（按 ↑ 取历史时最先出现的就是它）', () => {
    expect(stripEscapes('\x1b[A')).toBe('');
    expect(stripEscapes('\x1b[3~')).toBe('');
    expect(stripEscapes('a\x1b[Db')).toBe('ab');
  });

  it('兜底还原：退格、Ctrl+U、Ctrl+W 都跟着算', () => {
    expect(cleanTyped('ls -ll\x7f')).toBe('ls -l'); // 退格
    expect(cleanTyped('乱敲的\x15ls')).toBe('ls'); // Ctrl+U 清行
    // Ctrl+W 删的是**光标前一个词**（readline 的语义）：`git status` 删掉
    // `status`，再打 `push` 就成了 `git push`
    expect(cleanTyped('git status\x17push')).toBe('git push');
  });

  it('兜底还原：剩下的控制字符不显示，两头空白去掉', () => {
    expect(cleanTyped('  ls \x07')).toBe('ls');
  });
});
