/**
 * 命令块色条：终端左边那一条竖栏。
 *
 * # 它是什么
 *
 * 每条命令一块色条：**相邻两块交替颜色**（一眼分得开），鼠标放上去显示
 * 「命令 + 耗时 / 有没有输出」，点一下把**命令和它的输出一起复制走**。
 *
 * # 位置从哪来
 *
 * 全部由 `core/blocksView.ts` 的 `bandsOf` 算（纯函数，单测盖着）：它把
 * 「第几行」换算成像素。这里只负责把算出来的东西摆进 DOM。
 *
 * # 为什么重画不经过 store
 *
 * 色条跟着**视口**动（远端一输出、一滚动，所有位置就变了），所以订阅的是
 * hub 的视口事件，一个动画帧里只画一次。走 store 那条路的话，每来一段字节就
 * 要把侧栏、标签栏、检查器全重渲染一遍 —— 和「字节流不进 store」是同一条理由。
 *
 * # 宽窄是固定的一栏，不是压在文字上
 *
 * 终端自己缩进（见 styles.css 里 `.rd-ssh-term-row`），所以色条**不占**文字的
 * 位置：FitAddon 量的是终端容器的宽度，列数会自动算对。压在上面看着更省地方，
 * 但那会盖住每一行的第一个字符 —— 终端里那正是最要紧的一列。
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { copyText } from '../../../shared/terminal/hub';
import { bandsOf, type BlockBand } from '../core/blocksView';
import { terminalHub } from '../core/terminalHub';
import type { SshStore } from '../state/store';

interface Props {
  sessionId: string;
  store: SshStore;
}

/** 复制成功那个提示显示多久 */
const COPIED_MS = 900;

export function BlockGutter({ sessionId, store }: Props): ReactNode {
  const [bands, setBands] = useState<BlockBand[]>([]);
  const [copied, setCopied] = useState<number | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    let frame: number | null = null;

    const draw = (): void => {
      frame = null;
      const metrics = terminalHub.metrics(sessionId);
      setBands(metrics === null ? [] : bandsOf(store.blocksOf(sessionId), metrics));
    };
    // 远端刷屏时这个回调每秒能来几十次，合并到动画帧里再画
    const schedule = (): void => {
      if (frame !== null) return;
      frame = requestAnimationFrame(draw);
    };

    schedule();
    const off = terminalHub.onViewport(sessionId, schedule);
    return () => {
      off();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [sessionId, store]);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const copy = (band: BlockBand): void => {
    copyText(store.blockText(sessionId, band.id));
    setCopied(band.id);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(null), COPIED_MS);
  };

  const foldedIds = store.foldedBlocks(sessionId);
  const foldable = store.canFold(sessionId);

  return (
    <div className="rd-ssh-blocks" data-testid={`ssh-blocks-${sessionId}`}>
      {bands.map((band) => {
        const isFolded = foldedIds.has(band.id);
        const classes = [
          'rd-ssh-band',
          `is-lane${band.lane}`,
          isFolded ? 'is-folded' : '',
          copied === band.id ? 'is-copied' : '',
        ]
          .filter((c) => c !== '')
          .join(' ');

        // 折叠不可用时（输出太多、或者这会儿正忙）**不写进提示**：写一句
        // 「现在不能折」反而让人以为坏了。功能在那儿，只是这次没动
        const hint = foldable ? '\n双击：折叠 / 展开这一块' : '';

        return (
          <button
            key={band.id}
            type="button"
            className={classes}
            style={{ top: `${band.top}px`, height: `${band.height}px` }}
            title={`${band.title}\n单击：复制这条命令和它的输出${hint}`}
            aria-label={`${isFolded ? '展开' : '折叠'}或复制：${band.command}`}
            data-testid={`ssh-band-${band.id}`}
            // 测试按命令文本选色条比按自动生成的 id 稳
            data-band-command={band.command}
            data-band-folded={isFolded ? 'true' : 'false'}
            onClick={() => copy(band)}
            onDoubleClick={() => store.toggleBlockFold(sessionId, band.id)}
          />
        );
      })}
      {copied !== null && (
        <span className="rd-ssh-band-toast" data-testid="ssh-band-copied">
          已复制
        </span>
      )}
    </div>
  );
}
