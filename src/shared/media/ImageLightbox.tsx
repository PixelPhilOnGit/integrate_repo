/**
 * 图片灯箱：内嵌图片点一下之后的大图查看。
 *
 * 和弹框一样用 `useModalKeys`（焦点圈 + 退场还焦点）；Esc 自己处理 ——
 * 那个 hook 刻意不管 Esc（各弹框的关闭语义不同）。
 *
 * 只依赖 React 和 `shared/ui`，**不 import 任何模块** —— 知识库、任务、
 * 将来的任何模块都能直接拿。
 */

import { useRef, type ReactNode } from 'react';
import { useModalKeys } from '../ui/useModalKeys';

export interface ImageLightboxProps {
  url: string;
  alt: string;
  onClose: () => void;
  testId?: string;
}

export function ImageLightbox({ url, alt, onClose, testId }: ImageLightboxProps): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  useModalKeys({ ref });

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
      <button
        type="button"
        className="rd-image-lightbox-close"
        data-testid={testId === undefined ? undefined : `${testId}-close`}
        onClick={onClose}
        aria-label="关闭"
      >
        ✕
      </button>
      <img className="rd-image-lightbox-img" src={url} alt={alt} />
    </div>
  );
}
