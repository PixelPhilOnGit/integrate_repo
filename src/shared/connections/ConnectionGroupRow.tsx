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
import type { ConnectionGroup } from './types';

export interface ConnectionGroupRowProps {
  group: ConnectionGroup;
  /** 组里**现在显示**几个连接 —— 搜索时是命中数，不是成员总数 */
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  /** 右键（屏幕坐标）。建组/重命名/删除/往里放连接都走它 */
  onContextMenu?: (x: number, y: number) => void;
}

export function ConnectionGroupRow({
  group,
  count,
  collapsed,
  onToggle,
  onContextMenu,
}: ConnectionGroupRowProps): ReactNode {
  return (
    <div
      className="rd-conn-group-head"
      data-testid={`conn-group-${group.id}`}
      // ⚠️ 组的 id 是随机生成的，e2e 没法拿它写稳定的选择器 ——
      // 定位一律走这两个属性（和连接行的 `data-conn-name` 一个道理）
      data-group-name={group.name}
      data-group-count={count}
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
        // 只有箭头能折叠（点整行不折叠）—— 和 SQL 那个引擎头保持一致，
        // 两个分组头的行为不一样才是真别扭
        aria-expanded={!collapsed}
        aria-label={collapsed ? '展开' : '收起'}
        title={collapsed ? '展开' : '收起'}
        data-testid={`conn-group-caret-${group.id}`}
        onClick={onToggle}
      >
        {collapsed ? '▸' : '▾'}
      </button>

      <span className="rd-conn-group-name">{group.name}</span>
      <span className="rd-muted rd-conn-group-count">{count}</span>
    </div>
  );
}
