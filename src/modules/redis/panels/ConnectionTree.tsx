/**
 * 左侧栏：连接 → 库 的树。
 *
 * **key 不放在树里** —— 一个库可能有几十万个 key，塞进树会直接把界面拖死。
 * 这里只到「库」这一层（带每个库的 key 数），key 列表在主区里带过滤和滚动加载。
 * 这也是主流客户端的做法。
 */

import { useState, type ReactNode } from 'react';
import { ConnectionRow } from '../../../shared/connections/ConnectionRow';
import { NoMatch, SearchBox } from '../../../shared/ui/SearchBox';
import { ContextMenu, type MenuItem } from '../../../shared/ui/ContextMenu';
import { fuzzyFilter } from '../../../shared/search';
import type { ConnectionProfile, DbInfo } from '../core/types';
import type { RedisState, RedisStore } from '../state/store';

interface Props {
  state: RedisState;
  store: RedisStore;
}

/** 一个正在显示的菜单：位置 + 内容 */
interface OpenMenu {
  x: number;
  y: number;
  items: MenuItem[];
}

export function ConnectionTree({ state, store }: Props): ReactNode {
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const [query, setQuery] = useState('');

  /**
   * 只按**连接行自己的文本**（名字 + 地址）过滤。
   *
   * 不往「库」那一层钻：库列表要连上之后才加载，而没加载的东西搜不出来 ——
   * 那种「有时候搜得到、有时候搜不到」的行为比不搜更让人困惑。
   * key 的过滤本来就在主区那个列表里（它有自己的输入框）。
   *
   * 这里用 `fuzzyFilter`（**按相关度排序**）而不是「保序过滤」：连接是一张
   * 平铺的列表，几十上百条时把最像的排到最上面才是有用的。树形的侧栏
   * （SSH / 智能体会话 / 文件树）反过来 —— 那里的顺序就是树的形状，不能动。
   *
   * ⚠️ 只过滤**显示**：`state.profiles` 一个字不动，连接状态、选中、展开
   * 全都不受影响。
   */
  const visible = fuzzyFilter(state.profiles, query, (p) => [p.name, addressOf(p)]);
  const searching = query.trim() !== '';

  return (
    <div className="rd-panel rd-conn-list" data-testid="conn-list">
      <div className="rd-panel-head">
        <span>连接</span>
        <button
          type="button"
          data-testid="btn-new-connection"
          onClick={() => void store.createProfile()}
        >
          新建
        </button>
      </div>

      {state.profiles.length > 0 && (
        <SearchBox
          value={query}
          onChange={setQuery}
          testId="redis-conn-search"
          placeholder="搜连接名或地址"
        />
      )}

      {state.profiles.length === 0 ? (
        <div className="rd-empty">还没有连接，点「新建」加一个</div>
      ) : searching && visible.length === 0 ? (
        <NoMatch testId="redis-conn-nomatch" />
      ) : (
        <div className="rd-panel-body">
          {visible.map((profile) => (
            <ConnectionBranch
              key={profile.id}
              profile={profile}
              state={state}
              store={store}
              onMenu={setMenu}
            />
          ))}
        </div>
      )}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      )}
    </div>
  );
}

function ConnectionBranch({
  profile,
  state,
  store,
  onMenu,
}: {
  profile: ConnectionProfile;
  state: RedisState;
  store: RedisStore;
  onMenu: (menu: OpenMenu) => void;
}): ReactNode {
  const status = state.runtime[profile.id]?.status ?? 'idle';
  const connected = status === 'connected';
  const expanded = state.expanded[profile.id] === true;
  const loading = state.keyspaceLoading[profile.id] === true;
  const dbs = state.keyspace[profile.id];

  /** 右键菜单：连接/断开 + 删除。删除是低频但必须有的操作，放这儿最合适 */
  const openMenu = (x: number, y: number): void => {
    onMenu({
      x,
      y,
      items: [
        {
          label: connected ? '断开' : '连接',
          disabled: status === 'connecting',
          onSelect: () => void (connected ? store.disconnect(profile.id) : store.connect(profile.id)),
        },
        {
          label: '删除',
          danger: true,
          separatorBefore: true,
          onSelect: () => void store.deleteProfile(profile.id),
        },
      ],
    });
  };

  return (
    <>
      <ConnectionRow
        id={profile.id}
        name={profile.name}
        address={addressOf(profile)}
        status={status}
        selected={state.selectedId === profile.id}
        expanded={expanded}
        onToggleExpand={() => void store.toggleExpanded(profile.id)}
        onSelect={() => store.select(profile.id)}
        onToggle={() => void (connected ? store.disconnect(profile.id) : store.connect(profile.id))}
        onContextMenu={openMenu}
      />

      {expanded && (
        <div className="rd-db-list" data-testid={`dbs-${profile.id}`}>
          {!connected && !loading && <div className="rd-db-hint">连上之后才能看到库</div>}
          {loading && <div className="rd-db-hint">读取库列表…</div>}

          {dbs?.map((info) => (
            <DatabaseRow
              key={info.db}
              profileId={profile.id}
              info={info}
              active={state.selectedId === profile.id && state.browse.db === info.db}
              store={store}
            />
          ))}
        </div>
      )}
    </>
  );
}

function DatabaseRow({
  profileId,
  info,
  active,
  store,
}: {
  profileId: string;
  info: DbInfo;
  active: boolean;
  store: RedisStore;
}): ReactNode {
  return (
    <button
      type="button"
      className={`rd-db-row${active ? ' is-active' : ''}`}
      data-testid={`db-${profileId}-${info.db}`}
      // 库号单独给一个 data 属性：testid 里带着连接 id（它是随机生成的），
      // 测试没法稳定地写出选择器
      data-db={info.db}
      data-key-count={info.keys}
      onClick={() => {
        // 点库同时把连接选中 —— 否则用户在别处选了另一个连接时，
        // 点了这行会跑到那个连接上去，看起来像点错了
        store.select(profileId);
        void store.openDb(profileId, info.db);
      }}
    >
      <span className="rd-db-name">db{info.db}</span>
      <span className="rd-db-count">{info.keys}</span>
    </button>
  );
}

/** Redis 的地址表示法：库号是 0 时省略（和 redis-cli 的习惯一致） */
function addressOf(profile: ConnectionProfile): string {
  const base = `${profile.host}:${profile.port}`;
  return profile.db === 0 ? base : `${base}/${profile.db}`;
}
