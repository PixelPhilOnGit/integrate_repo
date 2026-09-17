/**
 * 占位模块：数据库 / SSH 这些还没做的模块先在这里立个牌子。
 *
 * 它的真正作用**不是给用户看的，是验证架构的**：
 * 如果加一个模块只需要「写一个目录 + 注册表加一行」，架构就成立；
 * 如果还要改外壳内部，说明 Module 接口设计错了 —— 早发现早改，
 * 比等做完 Redis 模块才发现便宜得多。
 */

import type { ReactNode } from 'react';
import type { Module } from '../../shell/types';

/** 左侧栏：将来这里是连接列表 */
function PlaceholderSidebar(): ReactNode {
  return (
    <div className="rd-panel rd-placeholder-side">
      <div className="rd-panel-head">
        <span>连接</span>
      </div>
      <div className="rd-empty">还没有连接</div>
    </div>
  );
}

/** 主区域 */
function PlaceholderMain(): ReactNode {
  return (
    <div className="rd-placeholder" data-testid="placeholder-main">
      <h2>数据库 / SSH</h2>
      <p>这两个模块还没开始做。</p>
      <p className="rd-muted">
        这一屏的作用是验证模块化架构：它只用了一个目录 + 注册表里一行，
        没有改动外壳的任何内部实现。
      </p>
    </div>
  );
}

export const devPlaceholderModule: Module = {
  id: 'devplaceholder',
  name: '数据库（待实现）',
  icon: (
    <svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
      {/* 数据库柱体 */}
      <ellipse cx="10" cy="5" rx="6" ry="2.4" />
      <path d="M4 5v10c0 1.3 2.7 2.4 6 2.4s6-1.1 6-2.4V5" />
      <path d="M4 10c0 1.3 2.7 2.4 6 2.4s6-1.1 6-2.4" />
    </svg>
  ),
  Sidebar: PlaceholderSidebar,
  Main: PlaceholderMain,
  platform: { listedExtensions: [], defaultExtension: '' },
};
