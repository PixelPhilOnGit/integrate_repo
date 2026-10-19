/**
 * 图片灯箱：内嵌图片点一下之后的大图查看。
 *
 * 支持**放大 / 缩小 / 复位**（按钮 + 滚轮）和放大后的**拖动平移**。
 * 缩放按 `transform: translate + scale`，不重排 —— 拖动手感稳定。
 *
 * 和弹框一样用 `useModalKeys`（焦点圈 + 退场还焦点）；Esc 自己处理 ——
 * 那个 hook 刻意不管 Esc（各弹框的关闭语义不同）。
 *
 * 只依赖 React 和 `shared/ui`，**不 import 任何模块** —— 知识库、任务、
 * 将来的任何模块都能直接拿。
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useModalKeys } from '../ui/useModalKeys';

export interface ImageLightboxProps {
  url: string;
  alt: string;
  onClose: () => void;
  testId?: string;
}

const MIN_SCALE = 0.5;
const MAX_SCALE = 6;

const clampScale = (value: number): number =>
  Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));

export function ImageLightbox({ url, alt, onClose, testId }: ImageLightboxProps): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  useModalKeys({ ref });
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  // 滚轮缩放：React 的 onWheel 是 passive 的，preventDefault 不生效 ——
  // 必须用原生监听 + { passive: false }。
  useEffect(() => {
    const root = ref.current;
    if (root === null) return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      setScale((current) =>
        clampScale(current * (e.deltaY < 0 ? 1.15 : 1 / 1.15)),
      );
    };
    root.addEventListener('wheel', onWheel, { passive: false });
    return () => root.removeEventListener('wheel', onWheel);
  }, []);

  const reset = (): void => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  };

  const tid = (suffix: string): string | undefined =>
    testId === undefined ? undefined : `${testId}-${suffix}`;

  return (
    <div
      className="rd-image-lightbox"
      data-testid={testId}
      role="dialog"
      aria-modal="true"
      aria-label={`图片：${alt}`}
      ref={ref}
      tabIndex={-1}
      onMouseDown={(e) => {
        // 只有点在背板上才关（点图片本身不关）
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="rd-image-lightbox-tools">
        <button
          type="button"
          data-testid={tid('zoom-out')}
          title="缩小"
          aria-label="缩小"
          onClick={() => setScale((s) => clampScale(s / 1.25))}
        >
          −
        </button>
        <button
          type="button"
          data-testid={tid('reset')}
          title="复位（100%）"
          aria-label="复位"
          onClick={reset}
        >
          {Math.round(scale * 100)}%
        </button>
        <button
          type="button"
          data-testid={tid('zoom-in')}
          title="放大"
          aria-label="放大"
          onClick={() => setScale((s) => clampScale(s * 1.25))}
        >
          ＋
        </button>
        <button
          type="button"
          data-testid={tid('close')}
          title="关闭"
          aria-label="关闭"
          onClick={onClose}
        >
          ✕
        </button>
      </div>

      <img
        className="rd-image-lightbox-img"
        data-testid={tid('img')}
        data-scale={scale}
        src={url}
        alt={alt}
        draggable={false}
        style={{
          transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
          cursor: scale > 1 ? 'grab' : 'default',
        }}
        onDoubleClick={reset}
        onPointerDown={(e) => {
          if (scale <= 1) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (d === null) return;
          setOffset({ x: d.ox + (e.clientX - d.x), y: d.oy + (e.clientY - d.y) });
        }}
        onPointerUp={(e) => {
          drag.current = null;
          e.currentTarget.releasePointerCapture(e.pointerId);
        }}
      />
    </div>
  );
}
