/**
 * 连接列表里的一行：状态点 + 名字 + 地址 + 连接/断开按钮。
 *
 * Redis / SQL / SSH 三个模块的侧栏都是这个形状，所以抽出来。
 * 差异只有两处，都用 props 表达：
 * - 地址怎么拼（Redis 要带 `/库号`，SQL 要带库名，SSH 就是 host:port）
 * - 状态文案（其实通用，见 `connStatusLabel`）
 *
 * CSS 类和 testid 沿用 Redis 那套 `rd-conn-*`（e2e 依赖它们，改了纯属制造 diff）。
 */

import type { ReactNode } from 'react';
import type { ConnStatus } from './types';

export interface ConnectionRowProps {
  /** 用于生成 testid 的稳定标识 */
  id: string;
  name: string;
  /** 已经拼好的地址串，比如 `127.0.0.1:6379/0` */
  address: string;
  status: ConnStatus;
  selected: boolean;
  onSelect: () => void;
  onToggle: () => void;
  /**
   * 展开状态。传了就画一个折叠箭头（连接变成树的一个可展开节点，
   * Redis/SQL 的「连接 → 库」都是这个形状）；不传就是一行平的。
   */
  expanded?: boolean;
  onToggleExpand?: () => void;
  /**
   * 在行上点右键。传了就触发（坐标是屏幕坐标，直接喂给 `ContextMenu`）。
   *
   * 删除、重命名这类「低频但必须有」的操作走右键 —— 常驻按钮会把行挤得很挤，
   * 而这个仓里文件树已经是这个习惯了，保持一致。
   */
  onContextMenu?: (x: number, y: number) => void;
}

export function ConnectionRow({
  id,
  name,
  address,
  status,
  selected,
  onSelect,
  onToggle,
  expanded,
  onToggleExpand,
  onContextMenu,
}: ConnectionRowProps): ReactNode {
  const connected = status === 'connected';
  const busy = status === 'connecting';

  return (
    <div
      className={`rd-conn-row${selected ? ' is-selected' : ''}`}
      data-testid={`conn-${id}`}
      data-conn-name={name}
      data-status={status}
      onClick={onSelect}
      onContextMenu={
        onContextMenu === undefined
          ? undefined
          : (e) => {
              e.preventDefault();
              onContextMenu(e.clientX, e.clientY);
            }
      }
    >
      {expanded !== undefined && (
        <button
          type="button"
          className={`rd-conn-caret${expanded ? ' is-open' : ''}`}
          data-testid={`conn-expand-${id}`}
          aria-expanded={expanded}
          title={expanded ? '折叠' : '展开看库'}
          onClick={(e) => {
            // 展开不该连带选中 —— 用户可能只是想看看这个连接下面有什么
            e.stopPropagation();
            onToggleExpand?.();
          }}
        >
          {/* 复用文件树那个箭头的视觉（同一个 SVG、同一个类），
              两处的折叠手感保持一致 */}
          <span className={`rd-tree-caret${expanded ? ' is-open' : ''}`} aria-hidden="true">
            <svg
              viewBox="0 0 16 16"
              width="12"
              height="12"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M6 4l4 4-4 4" />
            </svg>
          </span>
        </button>
      )}

      <span
        className={`rd-conn-dot is-${status}`}
        data-testid={`conn-dot-${id}`}
        title={connStatusLabel(status)}
      />

      <span className="rd-conn-text">
        <span className="rd-conn-name">{name}</span>
        <span className="rd-conn-addr">{address}</span>
      </span>

      <button
        type="button"
        className="rd-conn-toggle"
        data-testid={`conn-toggle-${id}`}
        disabled={busy}
        title={connected ? '断开' : '连接'}
        onClick={(e) => {
          // 别让点按钮顺带把选中也切了 —— 用户可能只是想连一下另一个连接
          e.stopPropagation();
          onToggle();
        }}
      >
        {busy ? '…' : connected ? '断开' : '连接'}
      </button>
    </div>
  );
}

/** 连接状态的统一文案。三个模块共用，免得同一个状态在三个地方叫三个名字 */
export function connStatusLabel(status: ConnStatus): string {
  switch (status) {
    case 'connected':
      return '已连接';
    case 'connecting':
      return '连接中';
    case 'error':
      return '连接出错';
    default:
      return '未连接';
  }
}
