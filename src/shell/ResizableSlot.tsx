/**
 * 可拖动的侧栏槽位（左右各一个）。
 *
 * # 为什么在外壳里做，而不是让每个模块自己管
 *
 * 五个模块的侧栏都是同一个 `.rd-panel`，宽度本该一样 —— 让五个模块各写一遍
 * 拖动逻辑，等于把同一件事抄五份，而且**迟早有一份和另外四份不一样**
 *（比如忘了落盘、忘了夹取）。外壳本来就在摆这些槽位，宽度就是它的活。
 *
 * # 拖动时为什么不走 React 状态
 *
 * 拖动是每秒几十次的事，每次都 `set()` 会让主区（顺序图的画布、终端的格子）
 * 跟着重渲染一遍 —— 那些地方渲染一次不便宜。所以拖动过程中**直接改 DOM 的
 * 内联宽度**（`ref.style.width`），松手时才写进 store（一次重渲染 + 落盘）。
 * 这和 SSH 那边「终端字节不走 store」是同一条理由。
 *
 * # 三条手感上的规矩
 *
 * 1. **拖到一半鼠标划出窗口也跟得住**：靠 `setPointerCapture`，
 *    不是在 window 上挂 mousemove（那样松开鼠标会丢事件，宽度卡在半路）；
 * 2. **双击回到默认宽度** —— 拖窄了想拖回去得一点一点来，双击是行业惯例；
 * 3. **光标和禁止选中**：拖动时整页 `user-select: none`，不然会顺手选中
 *    侧栏里的文字（拖动过程中的选区是没法用的，还会让界面看着像坏了）。
 */

import { useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { shellStore } from './shellInstance';

export interface ResizableSlotProps {
  /** 在哪一侧。右侧的拖动方向是反的（往左拖 = 变宽） */
  side: 'left' | 'right';
  /** 当前模块 id —— 宽度按模块存 */
  moduleId: string;
  children: ReactNode;
}

export function ResizableSlot({ side, moduleId, children }: ResizableSlotProps): ReactNode {
  const slot = useRef<HTMLDivElement>(null);
  const isLeft = side === 'left';
  const width = isLeft ? shellStore.sideWidth(moduleId) : shellStore.inspectorWidth(moduleId);

  const apply = (w: number): void => {
    if (slot.current !== null) slot.current.style.width = `${w}px`;
  };

  const onDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    // ⚠️ 只认鼠标左键 —— 右键菜单和中键粘贴都会触发 pointerdown
    if (e.button !== 0) return;
    const handle = e.currentTarget;
    const startX = e.clientX;
    const startWidth = slot.current?.getBoundingClientRect().width ?? width;
    // 往左拖是变宽还是变窄，看在哪一侧
    const sign = isLeft ? 1 : -1;

    handle.setPointerCapture(e.pointerId);
    document.body.classList.add('rd-resizing');

    const onMove = (ev: PointerEvent): void => {
      apply(startWidth + sign * (ev.clientX - startX));
    };
    const onUp = (ev: PointerEvent): void => {
      handle.releasePointerCapture(ev.pointerId);
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      document.body.classList.remove('rd-resizing');
      // 松手才写进 store：夹取和落盘都在那儿（见它的文档）
      const final = slot.current?.getBoundingClientRect().width ?? startWidth;
      if (isLeft) shellStore.setSideWidth(moduleId, final);
      else shellStore.setInspectorWidth(moduleId, final);
    };

    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  };

  const onDoubleClick = (): void => {
    if (isLeft) shellStore.resetSideWidth(moduleId);
    else shellStore.resetInspectorWidth(moduleId);
  };

  return (
    <div
      className={`rd-slot rd-slot-${side}`}
      ref={slot}
      style={{ width: `${width}px` }}
      data-testid={`panel-slot-${side}`}
    >
      {children}
      <div
        className="rd-slot-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="拖动调整宽度（双击回默认）"
        title="拖动调整宽度，双击回到默认"
        data-testid={`panel-handle-${side}`}
        onPointerDown={onDown}
        onDoubleClick={onDoubleClick}
      />
    </div>
  );
}
