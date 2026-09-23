/**
 * 左侧栏：模型配置的**名单**。
 *
 * 和连接类模块一个分工（侧栏列表 + 检查器编辑选中项），但**不复用**
 * `shared/connections/ConnectionTree` / `ConnectionRow` —— 它们的 props
 *（连接状态、地址串、连接/断开按钮）对「一份模型配置」毫无意义，
 * 硬塞进去是为了复用而造假数据。复用的是 **CSS 类名**
 *（`rd-conn-row` / `rd-conn-text` / `rd-conn-name` / `rd-conn-addr`），
 * 视觉上和连接列表一致，但不拖进连接的语义。
 *
 * 不做分组、不做展开箭头、不加搜索框 —— 配置通常三五个，
 * 那些是连接列表（几十条）才需要的东西。
 */

import { useState, type ReactNode } from 'react';
import { ContextMenu, type MenuItem } from '../../../shared/ui/ContextMenu';
import { PROVIDER_LABEL } from '../core/config';
import type { ProviderProfile } from '../core/config';
import type { AssistantState, AssistantStore } from '../state/store';

interface Props {
  state: AssistantState;
  store: AssistantStore;
}

/** 一个正在显示的菜单：位置 + 内容（和 `ConnectionTree` 同一个形状）。 */
interface OpenMenu {
  x: number;
  y: number;
  items: MenuItem[];
}

export function AssistantProfileList({ state, store }: Props): ReactNode {
  const [menu, setMenu] = useState<OpenMenu | null>(null);

  const openMenu = (x: number, y: number, profile: ProviderProfile): void => {
    setMenu({
      x,
      y,
      items: [
        {
          label: '删除',
          danger: true,
          // ⚠️ 会连钥匙串里那把一起删（不可逆）—— store 里配过 key 会先问一句
          onSelect: () => void store.deleteProfile(profile.id),
        },
      ],
    });
  };

  return (
    <div className="rd-panel rd-sidebar" data-testid="assistant-sidebar">
      <div className="rd-panel-head">
        <span>配置</span>
        <button
          type="button"
          data-testid="assistant-profile-new"
          title="新建一份模型配置"
          // 直接建、不弹框：四个字段里三个有默认值（名字会自动去重），
          // 弹框只是多一步。想改哪格去右边的表单里改。
          onClick={() => void store.createProfile()}
        >
          新建
        </button>
      </div>

      <div className="rd-panel-body">
        {state.profiles.length === 0 ? (
          <div className="rd-empty" data-testid="assistant-profiles-empty">
            还没有配置，点「新建」加一份
          </div>
        ) : (
          state.profiles.map((profile) => {
            const active = profile.id === state.selectedId;
            return (
              <div
                key={profile.id}
                className={`rd-conn-row${active ? ' is-selected' : ''}`}
                data-testid={`assistant-profile-${profile.id}`}
                data-profile-selected={active ? 'true' : 'false'}
                onClick={() => store.select(profile.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  openMenu(e.clientX, e.clientY, profile);
                }}
              >
                <span className="rd-conn-text">
                  <span className="rd-conn-name">{profile.name}</span>
                  <span className="rd-conn-addr">
                    {PROVIDER_LABEL[profile.kind]} · {profile.model || '（没填模型）'}
                  </span>
                </span>
                {active && (
                  <span
                    className="rd-assistant-picked"
                    data-testid={`assistant-profile-inuse-${profile.id}`}
                  >
                    在用
                  </span>
                )}
              </div>
            );
          })
        )}

        {/* key 的概览。⚠️ 说的是**选中那份**的状态 —— 它和下面那个列表项
            是同一份，切换时一起变 */}
        <div className="rd-assistant-summary">
          <span data-testid="assistant-sidebar-key">
            key：
            {state.keyStatus === null
              ? '…'
              : state.keyStatus.configured
                ? '已配置'
                : '还没配'}
          </span>
        </div>
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      )}
    </div>
  );
}
