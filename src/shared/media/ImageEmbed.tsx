/**
 * 内嵌图片：按需取字节 → Blob URL → 内嵌显示；点击打开灯箱；失败回落。
 *
 * 宿主只需要给一个 `load(target) → ArrayBuffer` —— 它从哪读（vault、
 * 附件目录、网络）这个组件不关心。这样知识库的 `_files/`、任务的附件、
 * 将来的其他来源都能复用同一套加载/灯箱/回落逻辑。
 *
 * # 三个容易写错的地方
 *
 * 1. **Blob URL 必须 revoke**：`target` 变了要收掉旧的；StrictMode 下 effect
 *    会跑两遍，cleanup 里 revoke 掉第一次的 URL，第二次重新建 —— 用
 *    `alive` 标记防止第一遍的异步结果在卸载后 setState。
 * 2. **`load` 每次渲染都是新函数**（调用方多半是内联箭头函数），放进依赖会
 *    无限重取。用 ref 兜住，effect 只依赖 `target`。
 * 3. **加载失败不抛给上层**：渲染宿主给的回落（知识库给的是文字角标），
 *    图片坏了不该让整个阅读器/列表炸掉。
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ImageLightbox } from './ImageLightbox';
import { imageMime } from './mime';

export interface ImageEmbedProps {
  /** 给人看的名字/读取目标（宿主自己解释） */
  target: string;
  load: (target: string) => Promise<ArrayBuffer>;
  alt?: string;
  /** 图片本体的 testid；`data-state` 会给出 loading/ready/error */
  testId?: string;
  className?: string;
  /** 默认 true；false = 只能看小图 */
  zoomable?: boolean;
  lightboxTestId?: string;
  /** 加载失败时渲染的东西（默认是一行文字） */
  fallback?: ReactNode;
}

export function ImageEmbed({
  target,
  load,
  alt,
  testId,
  className,
  zoomable = true,
  lightboxTestId,
  fallback,
}: ImageEmbedProps): ReactNode {
  const [state, setState] = useState<
    { phase: 'loading' } | { phase: 'ready'; url: string } | { phase: 'error' }
  >({ phase: 'loading' });
  const [open, setOpen] = useState(false);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let alive = true;
    let url: string | null = null;
    setState({ phase: 'loading' });
    setOpen(false);

    void (async () => {
      try {
        const bytes = await loadRef.current(target);
        if (!alive) return;
        const type = imageMime(target);
        url = URL.createObjectURL(
          type === '' ? new Blob([bytes]) : new Blob([bytes], { type }),
        );
        setState({ phase: 'ready', url });
      } catch {
        if (alive) setState({ phase: 'error' });
      }
    })();

    return () => {
      alive = false;
      if (url !== null) URL.revokeObjectURL(url);
    };
  }, [target]);

  if (state.phase === 'error') {
    return (
      <span
        className="rd-image-embed-fallback"
        data-testid={testId}
        data-state="error"
        title={`图片加载失败：${target}`}
      >
        {fallback ?? `[图片] ${target}`}
      </span>
    );
  }

  if (state.phase === 'loading') {
    return (
      <span
        className="rd-image-embed is-loading"
        data-testid={testId}
        data-state="loading"
      >
        [图片] {target}
      </span>
    );
  }

  return (
    <>
      <img
        className={className ?? 'rd-image-embed'}
        data-testid={testId}
        data-state="ready"
        src={state.url}
        alt={alt ?? target}
        loading="lazy"
        onClick={() => {
          if (zoomable) setOpen(true);
        }}
        style={{ cursor: zoomable ? 'zoom-in' : 'default' }}
      />
      {open && (
        <ImageLightbox
          url={state.url}
          alt={alt ?? target}
          onClose={() => setOpen(false)}
          testId={lightboxTestId}
        />
      )}
    </>
  );
}
