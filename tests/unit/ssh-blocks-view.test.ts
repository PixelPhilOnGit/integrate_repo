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
