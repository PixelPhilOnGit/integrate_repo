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
  /**
   * 这一块是不是折着的。
   *
   * ⚠️ 放进来是为了让「折没折」参与**要不要重渲染**的判断：折叠状态变了、
   * 而几何恰好没变的时候（真机上出现过），没有这一条 React 会当成"没变化"，
   * 色条就一直显示旧状态。
   */
  folded: boolean;
  /** 悬浮时显示的一行说明（命令 + 耗时/无输出） */
  title: string;
}

/**
 * 算出色条。只有**和视口有交集**、而且**内容还在**的块才会出现 —— 滚回滚区里
 * 几千条色条全画出来是白费（而且 DOM 一多滚动就卡），内容没了的那些画出来
 * 是错的（`clear` 之后那一片残留色条就是它，见函数体里 `contentEndLine` 那一段）。
 */
/**
 * 内容**真正的末尾**在第几行。
 *
 * ⚠️ **不能用 `metrics.lines`。** 那是 xterm 缓冲区的长度，而缓冲区**永远至少有
 * `rows` 行**（屏幕多大就有多少行，后面全是空行）—— 用它当"内容到哪儿结束"，
 * 最后一块色条的高度就会一直是「从它那行到屏幕底部」✗。
 *
 * 也不用光标：光标可以被程序挪走、被用户滚动带走 ✗（`scrollback` 里滚上去看
 * 一眼，光标就不在内容末尾了）。用「最后一行有内容的行」。
 *
 * 折叠时这个错会**放大成看上去像坏了**：内容折起来之后只剩几行，而最后一块的
 * 色条还按 52 行画 —— 色条和文字彻底对不上，鼠标点色条的位置全是错的
 * （真机上报的现象）。光标在哪，内容就到哪。
 */
export function contentEnd(metrics: TermMetrics): number {
  // ⚠️ 用 `lastContentLine`（最后一行有内容的行）而**不是光标**：
  // 光标可以被程序挪走、被用户滚动带走，它不代表内容到哪儿结束。
  return Math.max(1, metrics.lastContentLine);
}

const NO_FOLDED: ReadonlySet<number> = new Set();

export function bandsOf(
  blocks: readonly CommandBlock[],
  metrics: TermMetrics,
  folded: ReadonlySet<number> = NO_FOLDED,
): BlockBand[] {
  const { cellHeight, viewportLine, rows } = metrics;
  if (cellHeight <= 0 || rows <= 0) return [];

  // 全屏程序（vim / less / htop）在跑：**一条色条都不画**。
  //
  // 这不是新规矩 —— `TermMetrics.alt` 那行的注释原话就是「在跑的时候不该做
  // 『命令块』这类东西」，只是这个函数一直没照做。不照做的后果实测过：
  // 刚连上就跑 vim 时（块行号还都小于 rows，绕不过下面那两条 break），
  // 色条会**画在 vim 的画面上**，几何还是按备用屏幕的内容末尾算的，和那几块
  // 真正的内容毫无关系。成熟会话看着没事纯属**碰巧对**：备用屏幕 `viewportY = 0`、
  // 只有几十行，块的行号（几百上千）撞上了下面那条 break —— 是行号量纲撞运气，
  // 不是设计。
  //
  // 备用屏幕有自己的缓冲区，正常缓冲区在切走期间原样留着（切回来行号/内容都对得上），
  // 所以这里直接返回空、切回来自动恢复，不需要在别处记状态。
  if (metrics.alt) return [];

  const viewTop = viewportLine;
  const viewBottom = viewportLine + rows;

  /**
   * 内容到哪儿结束。**这是「这一行还在不在」的唯一判据**。
   *
   * ⚠️ 块的 `line` 是绝对行号，它「指得住同一处内容」的前提是那处内容还在。
   * 而 `clear`（`ESC[2J`）是**原地**擦掉视口那几行：绝对行号不变、`viewportY`
   * 不变，只是那几行变成空白 —— 行号全都还"有效"，内容却没了。所以「这块还在
   * 不在」只能问内容末尾，不能看行号（真机上报过：`clear` 之后旧色条继续挂在
   * 空行上，点它还会从缓冲区里读出空的）。
   */
  const contentEndLine = contentEnd(metrics);
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

    // 命令行已经被擦掉（掉到内容末尾之后）→ 不画。**这会连带停掉后面所有块**，
    // 和下面那条「视口下面」的 break 一样靠「块按 line 有序」这一条 ——
    // 后面的块行号只会更大，没有例外
    if (block.line >= contentEndLine) break;

    // 这一块的输出到哪儿为止：到下一块的起点，最后一块到内容末尾。
    // （这也是为什么不把范围存进块里：下一块出现之前它根本不知道）
    const next = blocks[i + 1];
    // ⚠️ 终点要**夹在内容末尾之内**。下一块被擦掉时它自己的行号还很大，不夹的话
    // 这一块的色条会一路伸进空白区（`clear` 之后的另一条残留色条就是它）。
    // 最后一块的终点本来就用内容末尾，不是缓冲区末尾 —— 见 `contentEnd`
    const endLine = Math.max(
      Math.min(next === undefined ? contentEndLine : next.line, contentEndLine),
      block.line + 1,
    );

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
      folded: folded.has(block.id),
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
