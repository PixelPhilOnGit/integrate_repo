/**
 * 通用右键菜单。
 *
 * 为什么不用原生 `popover` / `<dialog>`：需要精确跟随鼠标位置，
 * 而且要在 SVG 画布上方正确叠放。fixed 定位 + 点击外部关闭是最省事且可控的做法。
 *
 * 菜单项右侧可以显示快捷键 —— 这是用户学习快捷键的唯一有效途径，
 * Lucidchart 和 Visual Paradigm 都这么做。
 */

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

export interface MenuItem {
  label: string;
  /** 单选项打勾。刻意不把 ✓ 拼进 label —— 那样 testid 里会混入空格，脆得没法用 */
  checked?: boolean;
  /** 右侧显示的快捷键提示 */
  shortcut?: string;
  /** 危险操作（删除），用红色区分 */
  danger?: boolean;
  disabled?: boolean;
  /** 在这一项之前画一条分隔线 */
  separatorBefore?: boolean;
  onSelect: () => void;
}

export interface ContextMenuProps {
  /** 屏幕坐标（clientX / clientY） */
  x: number;
  y: number;
  items: readonly MenuItem[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  /**
   * 贴边时把菜单翻到鼠标另一侧，避免被视口裁掉。
   * 必须在浏览器画出之前量尺寸，否则会看到菜单先出现在错的位置再跳一下。
   */
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      left: x + r.width > window.innerWidth ? Math.max(4, x - r.width) : x,
      top: y + r.height > window.innerHeight ? Math.max(4, y - r.height) : y,
    });
  }, [x, y, items.length]);

  useEffect(() => {
    // 用 mousedown 而不是 click：click 会在"按下→抬起"之间触发别的操作
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="rd-menu"
      style={{ left: pos.left, top: pos.top }}
      role="menu"
      data-testid="context-menu"
      // 菜单自己也要吃掉右键，避免在菜单上再点右键时穿透到下层
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) => (
        <div key={`${item.label}-${i}`}>
          {item.separatorBefore && i > 0 && <div className="rd-menu-sep" role="separator" />}
          <button
            type="button"
            role="menuitem"
            disabled={item.disabled}
            data-testid={`menu-${item.label}`}
            className={`rd-menu-item${item.danger ? ' is-danger' : ''}`}
            onClick={() => {
              onClose();
              item.onSelect();
            }}
          >
            <span className="rd-menu-check">{item.checked ? '✓' : ''}</span>
            <span className="rd-menu-label">{item.label}</span>
            {item.shortcut && <kbd className="rd-menu-key">{item.shortcut}</kbd>}
          </button>
        </div>
      ))}
    </div>
  );
}
