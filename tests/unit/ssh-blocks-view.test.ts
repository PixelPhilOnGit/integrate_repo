/**
 * 命令块 → 色条（几何 + 文案）。
 *
 * 这一层最容易出的错是**差一行、差一像素**：滚动之后错位一行，色条就和命令
 * 对不上了，而那种错在界面上看着「就是不对」，却很难说清哪儿不对。所以
 * 位置和裁剪的边界在这里逐条钉住。
 */
import { describe, expect, it } from 'vitest';
import { bandsOf, collapsedLine, formatDuration } from '../../src/modules/ssh/core/blocksView';
import type { CommandBlock } from '../../src/modules/ssh/core/blocks';
import type { TermMetrics } from '../../src/shared/terminal/hub';

function metrics(patch: Partial<TermMetrics> = {}): TermMetrics {
  return {
    viewportLine: 0,
    cellHeight: 16,
    rows: 10,
    lines: 100,
    cursorLine: 0,
    cursorCol: 0,
    // 内容的末尾。**给个真实值**（默认 100 = 整段都有内容），不然色条高度
    // 会被算成 1 行，那些断言就全变成假的绿
    lastContentLine: 100,
    cols: 80,
    alt: false,
    ...patch,
  };
}

function block(id: number, line: number, patch: Partial<CommandBlock> = {}): CommandBlock {
  return { id, command: `cmd${id}`, line, col: 4, at: 1000, lastOutputAt: 1200, ...patch };
}

describe('色条的几何', () => {
  it('一块占「自己那行」到「下一块那行」，行高换算成像素', () => {
    const blocks = [block(1, 0), block(2, 3)];
    const bands = bandsOf(blocks, metrics());

    expect(bands[0]).toMatchObject({ id: 1, top: 0, height: 3 * 16 });
    // 第二块到缓冲区末尾（100 行）
    expect(bands[1]).toMatchObject({ id: 2, top: 3 * 16, height: (100 - 3) * 16 });
  });

  it('滚动之后跟着视口走（同一个块，top 变小）', () => {
    const blocks = [block(1, 5), block(2, 8)];
    expect(bandsOf(blocks, metrics({ viewportLine: 0 }))[0]!.top).toBe(5 * 16);
    expect(bandsOf(blocks, metrics({ viewportLine: 3 }))[0]!.top).toBe(2 * 16);
  });

  it('相邻两块交替颜色', () => {
    const bands = bandsOf([block(1, 0), block(2, 1), block(3, 2), block(4, 3)], metrics());
    expect(bands.map((b) => b.lane)).toEqual([0, 1, 0, 1]);
  });

  it('只有和视口有交集的才画 —— 滚过去的不画（几千条色条 DOM 会让滚动发卡）', () => {
    // ⚠️ 块的**输出**一直延伸到下一块那一行，所以判断交集要用整段范围：
    // 一条早就跑完、但输出还留在视口里的命令，色条本来就该看得见
    const blocks = [block(1, 0), block(2, 5), block(3, 10), block(4, 45)];
    const bands = bandsOf(blocks, metrics({ viewportLine: 30, rows: 10, lines: 60 }));

    // 1、2 两块的输出都在视口上面；第 3 块的输出一直到缓冲区末尾，跨过视口
    expect(bands.map((b) => b.id)).toEqual([3]);
  });

  it('视口下面第一个块出现就停 —— 后面的更在下面，不用再算了', () => {
    const blocks = [block(1, 0), block(2, 1), block(3, 50), block(4, 60)];
    const bands = bandsOf(blocks, metrics({ viewportLine: 30, rows: 5, lines: 80 }));

    // 第 2 块的输出从第 1 行一直铺到第 50 行，穿过视口（30..35）→ 画
    // 第 3 块自己在第 50 行，在视口下面 → 从它开始停
    expect(bands.map((b) => b.id)).toEqual([2]);
  });

  it('还没量到行高（不画），而不是拿 0 去除', () => {
    expect(bandsOf([block(1, 0)], metrics({ cellHeight: 0 }))).toEqual([]);
    expect(bandsOf([block(1, 0)], metrics({ rows: 0 }))).toEqual([]);
  });

  it('行高是小数时，色条也不少于 1 像素（0 像素的色条等于没画）', () => {
    // 真实的行高就是小数（12px 字号 × 1.2 = 14.4）
    const bands = bandsOf([block(1, 0), block(2, 1)], metrics({ cellHeight: 0.4 }));
    expect(bands[0]!.height).toBe(1);
  });

  it('零块就是零条', () => {
    expect(bandsOf([], metrics())).toEqual([]);
  });
});

/**
 * `clear`（`ESC[2J`）之后的那一片残留色条。
 *
 * ⚠️ 这一组里的行号不是编的：**是在 node 里跑真 xterm、把 `\x1b[H\x1b[2J` 灌进去
 * 量出来的**。`clear` 是**原地**擦掉视口那几行 —— 绝对行号不变、`viewportY`
 * 不变，只是那几行变空白。所以修法不能看行号（看着全都对），只能看「内容还剩
 * 到哪一行」。
 *
 * 量出来的那组数（80×10 的终端，视口在第 6 行，`clear` 敲在第 14 行）：
 * 擦之前 `lastContentLine = 16`；擦之后视口那几行全空、新提示符落在第 6 行，
 * 于是 `lastContentLine = 7`。
 */
function wiped(patch: Partial<TermMetrics> = {}): TermMetrics {
  return metrics({ viewportLine: 6, lastContentLine: 7, lines: 16, ...patch });
}

describe('clear 之后：内容没了的块不画', () => {
  it('命令行被擦掉的块消失（同一条命令，擦之前是画着的）', () => {
    const blocks = [block(1, 14)]; // `clear` 自己：敲在屏幕倒数第二行
    // 擦之前：色条一直到内容末尾
    const before = metrics({ viewportLine: 6, lastContentLine: 16, lines: 16 });
    expect(bandsOf(blocks, before).map((b) => b.id)).toEqual([1]);
    // 擦之后：那几行空了 → 不画
    expect(bandsOf(blocks, wiped())).toEqual([]);
  });

  it('回滚区里的块不受影响 —— 那边的内容还在，几何一个像素都不动', () => {
    // 用户擦完往上滚（视口从第 0 行开始）：回滚区里有三块，第 14 行是 `clear`
    const view: Partial<TermMetrics> = { viewportLine: 0, rows: 10, lines: 16 };
    const blocks = [block(1, 0), block(2, 4), block(3, 6), block(4, 14)];
    const before = bandsOf(blocks, metrics({ ...view, lastContentLine: 16 }));
    const after = bandsOf(blocks, wiped(view));

    // ①② 两块各有下一块、终点都在内容末尾之前 → 逐字段和擦除前一模一样
    expect(after.filter((b) => b.id <= 2)).toEqual(before.filter((b) => b.id <= 2));
    // ③ 在擦除位置上面紧挨着，终点被夹到内容末尾（见下一条）；④ 被擦掉了
    expect(after.map((b) => b.id)).toEqual([1, 2, 3]);
  });

  it('上一块的终点夹到内容末尾 —— 不伸进被擦掉的空白区', () => {
    // 第 3 行那一块的输出原本一直铺到第 14 行的 `clear`（视口在 6..16）
    const blocks = [block(1, 3), block(2, 14)];
    const before = bandsOf(blocks, metrics({ viewportLine: 6, lastContentLine: 16, lines: 16 }));
    const after = bandsOf(blocks, wiped());

    expect(before[0]).toMatchObject({ height: (14 - 3) * 16 }); // 擦之前：一直铺到 14
    expect(after.map((b) => b.id)).toEqual([1]);
    // 擦之后收到内容末尾（7）：色条不再盖住第 7..13 行那一片空白
    expect(after[0]).toMatchObject({ top: (3 - 6) * 16, height: (7 - 3) * 16 });
  });

  it('⚠️ 边界：命令行正好是最后一行内容时仍然画（已知取舍，别当成回归）', () => {
    // 这是「`clear` 敲在屏幕最上面一行」的形状 —— 新提示符落在同一行，于是只剩
    // 一行色条贴在提示符旁边。**光靠内容末尾分不出它和「命令刚跑完、还没输出」**
    // （那种块本来就该有一行色条，不能连它一起抹掉），要分清得知道那一行上现在
    // 是什么字 —— 那是另一件事。这里把它钉住：知道它长什么样，比以为已经干净了好。
    const bands = bandsOf([block(1, 6)], wiped());
    expect(bands.map((b) => b.id)).toEqual([1]);
    expect(bands[0]).toMatchObject({ top: 0, height: 16 });
  });

  it('整段都被擦掉（连回滚区也没了）时一条不剩', () => {
    // `tput clear` 在新 ncurses 上还带 `ESC[3J`（连回滚区一起清，Linux 上是
    // 默认）——量出来是缓冲区缩到 rows 行、旧行号全部作废。这里只要「一条色条
    // 都不画」这个结果
    const bands = bandsOf(
      [block(1, 4), block(2, 9), block(3, 14)],
      metrics({ viewportLine: 0, rows: 10, lines: 10, lastContentLine: 1 }),
    );
    expect(bands).toEqual([]);
  });
});

describe('二分的「块按 line 有序」不变式', () => {
  /** 朴素实现：从第一块开始一块块扫。二分版必须和它给出一样的结果 */
  function byScanning(blocks: readonly CommandBlock[], m: TermMetrics): number[] {
    const contentEnd = Math.max(1, m.lastContentLine);
    const ids: number[] = [];
    for (let i = 0; i < blocks.length; i += 1) {
      const b = blocks[i]!;
      const next = blocks[i + 1];
      const end = Math.max(Math.min(next?.line ?? contentEnd, contentEnd), b.line + 1);
      if (b.line >= contentEnd) continue;
      if (end <= m.viewportLine) continue;
      if (b.line >= m.viewportLine + m.rows) continue;
      ids.push(b.id);
    }
    return ids;
  }

  it('块多、视口在中间、擦除边界落在块之间 —— 和一块块扫的结果一致', () => {
    // 2000 块、每 3 行一块：视口在 901..911（块的行是 3 的倍数，故意错开一格），
    // 内容末尾（`clear` 擦到的地方）1500
    const blocks = Array.from({ length: 2000 }, (_, i) => block(i + 1, i * 3));
    const m = metrics({ viewportLine: 901, rows: 10, lines: 6000, lastContentLine: 1500 });

    expect(bandsOf(blocks, m).map((b) => b.id)).toEqual(byScanning(blocks, m));
    // 顺带钉住二分的扫描范围：第 900 行那块（id 301）跨着视口顶端 —— top 是负的，
    // 半截交给 CSS 裁掉也算数；第 897 行那块（id 300）的输出正好在视口上面收尾
    // → 不画；第 912 行那块在视口下面 → 从这里停下
    expect(bandsOf(blocks, m).map((b) => b.id)).toEqual([301, 302, 303, 304]);
    expect(bandsOf(blocks, m)[0]!.top).toBeLessThan(0);
  });

  it('内容末尾把整串块砍光时立刻收手（不画、也不空转到末尾）', () => {
    const blocks = Array.from({ length: 2000 }, (_, i) => block(i + 1, i * 3 + 3));
    const m = metrics({ viewportLine: 0, rows: 10, lines: 6000, lastContentLine: 1 });
    expect(bandsOf(blocks, m)).toEqual([]);
  });
});

describe('色条的文案', () => {
  it('悬浮说明带上命令和耗时', () => {
    const bands = bandsOf([block(1, 0, { command: 'ls -la', at: 1000, lastOutputAt: 1420 })], metrics());
    expect(bands[0]!.title).toContain('ls -la');
    expect(bands[0]!.title).toContain('420ms');
  });

  it('一个字节都没输出的块说「没有输出」', () => {
    // 它不是最后一块：早就结束了，只是什么都没吐（`mkdir` 就是这样）
    const blocks = [block(1, 0, { lastOutputAt: null }), block(2, 1)];
    expect(bandsOf(blocks, metrics())[0]!.title).toContain('没有输出');
  });

  it('最后一块还没输出时说「还没有输出」—— 正在跑还是静默，本地分不出来', () => {
    const blocks = [block(1, 0, { lastOutputAt: null })];
    expect(bandsOf(blocks, metrics())[0]!.title).toContain('还没有输出');
  });

  it('⚠️ 不说退出码之类本地拿不到的东西', () => {
    const bands = bandsOf([block(1, 0)], metrics());
    expect(bands[0]!.title).not.toContain('退出');
  });
});

describe('全屏程序在跑（备用屏幕）', () => {
  // `TermMetrics.alt` 那行的注释原话就是「在跑的时候不该做『命令块』这类东西」，
  // 这个函数一直没照做。不照做的后果实测过：备用屏幕 `viewportY = 0`、只有几十行，
  // 所以**刚连上就跑 vim** 时（块行号还都小于 rows，绕不过那两条 break），
  // 色条会画在 vim 的画面上，几何还是按备用屏幕算的。
  it('一条色条都不画', () => {
    const blocks = [block(1, 2), block(2, 4), block(3, 6)];
    expect(bandsOf(blocks, metrics({ alt: true }))).toEqual([]);
  });

  it('⚠️ 成熟会话「看着没事」是撞运气，不是这条规则在起作用', () => {
    // 块行号很大时，下面那条 `block.line >= viewBottom` 的 break 会先把它们挡掉 ——
    // 备用屏幕只有几十行。这条测试钉住的是：**不能拿这个"碰巧对"当理由
    // 把 alt 那条判断删掉**，年轻会话立刻就露。
    const mature = [block(1, 500), block(2, 900)];
    expect(bandsOf(mature, metrics({ alt: true }))).toEqual([]);
    // 同一组块，在正常屏幕下（视口滚到 500 附近、内容也还在）是要画的 ——
    // 对比之下才说明 alt 那条规则真的在做一件事，而不是"反正本来就不画"
    const normal = metrics({
      alt: false,
      viewportLine: 500,
      lines: 1000,
      lastContentLine: 1000,
    });
    expect(bandsOf(mature, normal).length).toBeGreaterThan(0);
  });

  it('切回正常屏幕后色条自己回来（不需要别处记状态）', () => {
    const blocks = [block(1, 2)];
    expect(bandsOf(blocks, metrics({ alt: true }))).toEqual([]);
    expect(bandsOf(blocks, metrics({ alt: false }))).toHaveLength(1);
  });
});

describe('耗时与折叠摘要', () => {
  it('耗时的三档说法', () => {
    expect(formatDuration(420)).toBe('420ms');
    expect(formatDuration(1500)).toBe('1.5s');
    expect(formatDuration(65_000)).toBe('1m5s');
    expect(formatDuration(-1)).toBe('—');
  });

  it('折叠摘要是一行文本（要写进终端缓冲区），带命令和结局', () => {
    const line = collapsedLine(block(1, 0, { command: 'ls -la', at: 1000, lastOutputAt: 3000 }));
    expect(line).toContain('ls -la');
    expect(line).toContain('已折叠');
    expect(line).toContain('2.0s');
  });
});
