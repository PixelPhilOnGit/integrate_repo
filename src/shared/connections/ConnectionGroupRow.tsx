/**
 * 连接列表里的一个**分组头**（用户自己建的那种目录）：
 * 折叠箭头 + 名字 + 成员数。
 *
 * 视觉上和 SQL 侧栏那个「按引擎分」的头（`.rd-kind-head`）是同一套样式 ——
 * 两个都是「一层分组头」，长得不一样只会让人以为它们不是一回事。
 * 但类名分开写（`rd-conn-group-*`）：让后人一眼看出「引擎那层是系统给的，
 * 这层是用户自己建的」。
 *
 * ⚠️ 没复用 `.rd-group` —— 那个名字已经被状态栏占了（`styles.css` 里是
 * 「状态栏上的一组东西」），撞上过一次的东西别再撞第二次。
 */

import type { ReactNode } from 'react';
import type { DragHandleProps } from './useConnectionDrag';
import type { ConnectionGroup } from './types';

export interface ConnectionGroupRowProps {
  group: ConnectionGroup;
  /** 组里**现在显示**几个连接 —— 搜索时是命中数，不是成员总数（都是子树总数） */
  count: number;
  /** 全路径（`"生产/项目A"`）。嵌套之后同名目录光看名字分不清 —— e2e 靠它定位 */
  path?: string;
  collapsed: boolean;
  onToggle: () => void;
  /** 右键（屏幕坐标）。新建连接/子目录、重命名、移动、删除都走它 */
  onContextMenu?: (x: number, y: number) => void;
  /** 拖拽抓手（悬停露出）。不传就不画 */
  dragHandle?: DragHandleProps;
  /** 这个目录正被拖着：原位置画淡一点 */
  dragging?: boolean;
  /** 拖拽正悬停在它上面（准备落进来）：高亮 */
  dropTarget?: boolean;
}

export function ConnectionGroupRow({
  group,
  count,
  path,
  collapsed,
  onToggle,
  onContextMenu,
  dragHandle,
  dragging,
  dropTarget,
}: ConnectionGroupRowProps): ReactNode {
  const title = path ?? group.name;

  return (
    <div
      className={`rd-conn-group-head${dragging === true ? ' is-dragging' : ''}${
        dropTarget === true ? ' is-drop-target' : ''
      }`}
      data-testid={`conn-group-${group.id}`}
      // ⚠️ 组的 id 是随机生成的，e2e 没法拿它写稳定的选择器 ——
      // 定位一律走这几个属性（和连接行的 `data-conn-name` 一个道理）。
      // `data-group-path` 是嵌套之后唯一不重的那一个（同名目录可以有）
      data-group-name={group.name}
      data-group-path={title}
      data-group-count={count}
      // ⚠️ **点整行也能折叠**（2026-10-15 用户定的：原话「最好后面点击分组也能
      // 展开」）。之前是「只有箭头能点」——那是个和引擎头对齐的取舍，现在两边
      // 一起改成整行可点，一致性还在
      onClick={onToggle}
      onContextMenu={
        onContextMenu === undefined
          ? undefined
          : (e) => {
              e.preventDefault();
              onContextMenu(e.clientX, e.clientY);
            }
      }
    >
      <button
        type="button"
        className="rd-agent-caret"
        // 只有箭头能折叠 → **现在整行都能了**（见上面那条）；箭头留着是因为
        // 它一眼说明「这里能折叠」。⚠️ 用户报过箭头太小点不到 → 字形和命中框
        // 都在 CSS 里撑大了（`.rd-agent-caret` 那条）
        aria-expanded={!collapsed}
        aria-label={collapsed ? '展开' : '收起'}
        title={collapsed ? '展开' : '收起'}
        data-testid={`conn-group-caret-${group.id}`}
        onClick={(e) => {
          // 冒泡到整行会再折叠一次（两次 = 没变）—— 拦掉
          e.stopPropagation();
          onToggle();
        }}
      >
        {collapsed ? '▸' : '▾'}
      </button>

      <span className="rd-conn-group-name" title={title}>
        {group.name}
      </span>
      <span className="rd-muted rd-conn-group-count">{count}</span>

      {dragHandle !== undefined && (
        <span
          className="rd-conn-drag"
          aria-hidden="true"
          title="拖动到别的目录里（拖到空白处回顶层）"
          {...dragHandle}
          onClick={(e) => e.stopPropagation()}
        >
          ⠿
        </span>
      )}
    </div>
  );
}
