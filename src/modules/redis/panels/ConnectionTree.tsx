/**
 * 左侧栏：**分组 → 连接 → 库** 的树。
 *
 * # 第一层是「分组」（用户自己建的目录）
 *
 * 用户的原话：「连接要考虑管理什么的，最好是有目录管理」。分组只**一层**，
 * 不做嵌套（2026-09-20 确认过）—— 理由和形状都在 `shared/connections/groups.ts`。
 *
 * Redis 这里**没有「按引擎分」那层**（SQL 模块有）：Redis 就是一种协议，
 * 分不出花来。所以它的第一层直接是用户的分组。
 *
 * **没分组的连接画在最上面**，且**不缩进** —— 新建的连接就是未分组，
 * 不放最上面的话用户得先展开某个组才找得着它（或者以为没建成功）。
 *
 * # key 不放在树里
 *
 * 一个库可能有几十万个 key，塞进树会直接把界面拖死。这里只到「库」这一层
 * （带每个库的 key 数），key 列表在主区里带过滤和滚动加载。这也是主流客户端的做法。
 */

import { useState, type ReactNode } from 'react';
import { ConnectionGroupRow } from '../../../shared/connections/ConnectionGroupRow';
import { assignGroups } from '../../../shared/connections/groups';
import { ConnectionRow } from '../../../shared/connections/ConnectionRow';
import type { ConnectionGroup } from '../../../shared/connections/types';
import { ContextMenu, type MenuItem } from '../../../shared/ui/ContextMenu';
import { NoMatch, SearchBox } from '../../../shared/ui/SearchBox';
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
  /** 正在行内改名的分组 id + 草稿（和文件树那套一样，不用弹窗） */
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  /** 哪些分组是收起来的。**纯显示状态，不持久化**（和 SQL 那个引擎折叠一个道理） */
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

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
  // ⚠️ 搜索时才藏空组：**平时空组必须画出来**，用户刚点「＋分组」建的就是空组，
  // 藏起来他会以为按钮坏了（见 `assignGroups` 的说明）
  const grouped = assignGroups(visible, state.groups, searching);

  /**
   * 搜索时**强制展开**所有分组 —— 命中的那条埋在收起来的分组里等于没搜到。
   *
   * ⚠️ 撑开是**临时的**（叠加在这一步），`collapsed` 一个字不写：写进去的话，
   * 清空搜索之后被搜索撑开的分组会自己开着，用户手动收起来的那层就回不去了。
   * 文件树那边踩过同一个坑，规矩是一样的。
   */
  const isCollapsed = (id: string): boolean => !searching && collapsed[id] === true;

  const commitRename = async (): Promise<void> => {
    const id = renaming;
    setRenaming(null);
    if (id === null || draft.trim() === '') return;
    await store.renameGroup(id, draft.trim());
  };

  /** 分组的右键菜单。删除分组**不需要确认弹窗**：它一条连接都不删（见 store 里那条注释） */
  const openGroupMenu = (group: ConnectionGroup, x: number, y: number): void => {
    setMenu({
      x,
      y,
      items: [
        {
          label: '重命名',
          onSelect: () => {
            setRenaming(group.id);
            setDraft(group.name);
          },
        },
        {
          // 把后果写在菜单里，比事后再弹一个确认框强 —— 用户点之前就该知道
          label: '删除分组（连接回到未分组）',
          danger: true,
          separatorBefore: true,
          onSelect: () => void store.deleteGroup(group.id),
        },
      ],
    });
  };

  return (
    <div className="rd-panel rd-conn-list" data-testid="conn-list">
      <div className="rd-panel-head">
        <span>连接</span>
        <button
          type="button"
          data-testid="btn-new-group"
          title="新建分组（把连接归归类）"
          onClick={() => void store.createGroup()}
        >
          ＋分组
        </button>
        <button
          type="button"
          data-testid="btn-new-connection"
          title="新建连接"
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
          {/* 未分组的在最上面（也不缩进）：新建的连接就在这儿 */}
          {grouped.ungrouped.map((profile) => (
            <ConnectionBranch
              key={profile.id}
              profile={profile}
              state={state}
              store={store}
              onMenu={setMenu}
            />
          ))}

          {grouped.groups.map(({ group, items }) => (
            <div key={group.id}>
              {renaming === group.id ? (
                <div className="rd-conn-group-head" data-testid={`conn-group-rename-${group.id}`}>
                  <span className="rd-agent-caret" />
                  <input
                    className="rd-rename-input"
                    autoFocus
                    value={draft}
                    aria-label="重命名分组"
                    data-testid="group-rename-input"
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={() => void commitRename()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void commitRename();
                      if (e.key === 'Escape') setRenaming(null);
                      e.stopPropagation();
                    }}
                  />
                </div>
              ) : (
                <ConnectionGroupRow
                  group={group}
                  count={items.length}
                  collapsed={isCollapsed(group.id)}
                  onToggle={() =>
                    setCollapsed((c) => ({ ...c, [group.id]: !isCollapsed(group.id) }))
                  }
                  onContextMenu={(x, y) => openGroupMenu(group, x, y)}
                />
              )}

              {!isCollapsed(group.id) && (
                <div className="rd-conn-group-body">
                  {items.map((profile) => (
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
            </div>
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

  /** 右键菜单：连接/断开 + 移入分组 + 删除。删除是低频但必须有的操作，放这儿最合适 */
  const openMenu = (x: number, y: number): void => {
    const items: MenuItem[] = [
      {
        label: connected ? '断开' : '连接',
        disabled: status === 'connecting',
        onSelect: () => void (connected ? store.disconnect(profile.id) : store.connect(profile.id)),
      },
    ];

    // 「移入分组」：`ContextMenu` 没有子菜单，所以平铺列出来。
    // 分组通常只有几个，平铺比多一层菜单更好点 —— 而且当前的组会打勾，
    // 一眼看出这条连接现在在哪儿。
    if (state.groups.length > 0) {
      items.push(
        ...state.groups.map((group, i) => ({
          label: `移入「${group.name}」`,
          checked: profile.groupId === group.id,
          separatorBefore: i === 0,
          onSelect: () => void store.moveToGroup(profile.id, group.id),
        })),
      );
    }
    if (profile.groupId !== undefined) {
      items.push({
        label: '移出分组',
        onSelect: () => void store.moveToGroup(profile.id, null),
      });
    }

    items.push({
      label: '删除',
      danger: true,
      separatorBefore: true,
      onSelect: () => void store.deleteProfile(profile.id),
    });

    onMenu({ x, y, items });
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
