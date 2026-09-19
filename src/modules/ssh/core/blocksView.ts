/**
 * 命令块 → 色条（几何 + 文案）。
 *
 * 纯计算：给一串块和一份视口量法，算出每条色条画在哪、多高、什么颜色、点一下
 * 复制什么。**不碰 DOM、不碰 xterm** —— 正因为这样，这一层能被单测盖满，
 * 而它恰恰是最容易出错的地方（滚动之后错位一行、行高算错一像素就对不齐）。
 */

import type { CommandBlock } from './blocks';
import type { TermMetrics } from '../../../shared/terminal/hub';

/**
 * 一条色条。
 *
 * `top` / `height` 是**相对视图顶端**的像素值，可能为负或者超出视口
 * （那半截色条就该被裁掉）—— 裁切交给 CSS，这里只给真实几何。
 */
export interface BlockBand {
  id: number;
  top: number;
  height: number;
  /** 相邻两块交替（0 / 1），一眼分得开 */
  lane: 0 | 1;
  /** 命令原文。点一下复制它和输出 */
  command: string;
  /** 悬浮时显示的一行说明（命令 + 耗时/无输出） */
  title: string;
}

/**
 * 算出色条。只有**和视口有交集**的块才会出现 —— 滚回滚区里几千条色条全画出来
 * 是白费（而且 DOM 一多滚动就卡）。
 */
export function bandsOf(blocks: readonly CommandBlock[], metrics: TermMetrics): BlockBand[] {
  const { cellHeight, viewportLine, rows, lines } = metrics;
  if (cellHeight <= 0 || rows <= 0) return [];

  const viewTop = viewportLine;
  const viewBottom = viewportLine + rows;
  const out: BlockBand[] = [];

  // ⚠️ **从哪一块开始扫**：二分找「最后一块起点在视口之上」的那一块。
  //
  // 一块占的范围是 [自己的行, 下一块的行)，所以跨过视口顶端的那一块（起点在
  // 上面、内容伸进视口）也必须画。从它开始往后扫到第一块起点在视口下面为止。
  //
  // 以前是从 0 开始一格格 `continue` 过去 —— 平摊看没问题，但**每一帧**都这么扫，
  // 而长时间用下来块数会上千（每条命令一块）。那是「开着一整天越来越卡」那类
  // 问题的典型形状：单帧不慢，帧数一多就显出来了。
  let first = 0;
  let lo = 0;
  let hi = blocks.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const line = blocks[mid]?.line ?? 0;
    if (line <= viewTop) {
      first = mid; // 候选：起点在视口之上（可能正跨着视口顶端）
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  for (let i = first; i < blocks.length; i += 1) {
    const block = blocks[i];
    if (block === undefined) continue;

    // 这一块的输出到哪儿为止：到下一块的起点，最后一块到缓冲区末尾。
    // （这也是为什么不把范围存进块里：下一块出现之前它根本不知道）
    const next = blocks[i + 1];
    const endLine = next === undefined ? lines : next.line;

    if (endLine <= viewTop) continue; // 整块都在视口上面
    if (block.line >= viewBottom) break; // 这块和后面的都在视口下面（按顺序的）

    const top = (block.line - viewTop) * cellHeight;
    const height = Math.max(1, (endLine - block.line) * cellHeight);

    out.push({
      id: block.id,
      top,
      height,
      lane: i % 2 === 0 ? 0 : 1,
      command: block.command,
      title: bandTitle(block, next === undefined),
    });
  }

  return out;
}

/**
 * 悬浮说明：命令 + 结局。
 *
 * ⚠️ **本地拿不到退出码**（那要远端 shell 打 OSC 133），所以这里说的是
 * 「耗时」和「一个字节都没输出」—— 这两件事本地是真的知道，而且多半够用：
 * 一条跑了 3 秒还没输出的命令，和一条 0.01 秒就结束的，用户的判断本来就不一样。
 */
export function bandTitle(block: CommandBlock, live: boolean): string {
  const parts = [block.command];
  if (block.lastOutputAt !== null) {
    parts.push(`耗时 ${formatDuration(block.lastOutputAt - block.at)}`);
  } else if (live) {
    // 最后一块还没吐过东西：可能正在跑，也可能是个静默命令 —— 本地分不出来，
    // 所以两个都不说死
    parts.push('还没有输出');
  } else {
    parts.push('没有输出');
  }
  return parts.join(' · ');
}

/**
 * 耗时的说法。**不给到毫秒**：这个数是从「回车」到「最后一字节输出」估出来的，
 * 给三位小数是在假装精确。
 */
export function formatDuration(ms: number): string {
  if (ms < 0) return '—';
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${Math.round(seconds - minutes * 60)}s`;
}

/**
 * 折叠之后那条摘要行。**写进终端缓冲区**（所以是文本，不是 DOM）。
 *
 * 用 `\x1b[2m`（暗色）标出来，和真实输出区分开 —— 用户折叠之后得能看出来
 * 「这里被折起来了」，而不是以为命令什么都没输出。
 */
export function collapsedLine(block: CommandBlock): string {
  const tail =
    block.lastOutputAt === null
      ? '没有输出'
      : `耗时 ${formatDuration(block.lastOutputAt - block.at)}`;
  return `\x1b[2m▸ ${block.command}（已折叠 · ${tail}）\x1b[0m`;
}
