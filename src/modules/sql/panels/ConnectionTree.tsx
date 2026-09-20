/**
 * 左侧栏：**种类 → 分组 → 连接 → 库 → 表**。
 *
 * # 第一层是种类（引擎）
 *
 * 用户的原话：「最好左侧有个分类，新建连接后新建 pg，那这个连接属于 pg，也就是
 * 连接最好有一个 tag」。所以树的第一层按引擎分（PostgreSQL / MySQL / ClickHouse /
 * MongoDB），连接挂在它下面 —— 一眼看出「这个连接是什么库」，
 * 而不是从 `root@127.0.0.1:27017` 这种地址串里去猜。
 *
 * # 第二层是分组（用户自己建的目录）
 *
 * 用户的原话：「连接要考虑管理什么的，最好是有目录管理」。分组**只有一层**、
 * 而且**是全局的、不分引擎** —— 同一个「生产库」在 pg 和 mysql 底下都会出现。
 * 让分组属于某个引擎的话，用户得先想「这个组是给哪个引擎的」，
 * 而他要的只是「把这几条放一起」。形状和规则见 `shared/connections/groups.ts`。
 *
 * **两个维度别混**：种类是**系统给的**（这个连接是什么库），分组是**用户自己分的**
 * （这几条是我哪个项目的）。顺序也是和用户确认过的：**引擎在上、分组在下**。
 *
 * # 下面三层是**包含关系**，不是并列
 *
 * 表属于库，所以表必须画在它那个库底下。之前写成了「库」和「表」两个并排的
 * 小节标题、底下一堆平铺的行 —— 看起来像两个并列的列表，用户根本看不出
 * 「这些表是这个库的」。现在库是节点，当前那个展开、表缩进在它下面。
 *
 * 为什么同时只有一个库展开：**PostgreSQL 一个连接绑一个库**，换库要重连；
 * MySQL 虽然能 `USE`，但对用户来说也是「当前在哪个库」。
 * 所以画成「能同时展开好几个库」是骗人的。
 */

import { useState, type ReactNode } from 'react';
import { ConnectionGroupRow } from '../../../shared/connections/ConnectionGroupRow';
import { assignGroups } from '../../../shared/connections/groups';
import { ConnectionRow } from '../../../shared/connections/ConnectionRow';
import type { ConnectionGroup } from '../../../shared/connections/types';
import { ContextMenu, type MenuItem } from '../../../shared/ui/ContextMenu';
import { NoMatch, SearchBox } from '../../../shared/ui/SearchBox';
import { fuzzyFilter } from '../../../shared/search';
import { displayName, qualifyName } from '../core/query';
import { KIND_LABEL, KIND_ORDER, type SqlKind, type SqlProfile, type TableInfo } from '../core/types';
import type { SqlState, SqlStore } from '../state/store';

interface Props {
  state: SqlState;
  store: SqlStore;
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
  /** 哪些种类被收起来了（默认都展开） */
  const [collapsedKinds, setCollapsedKinds] = useState<Partial<Record<SqlKind, boolean>>>({});
  /** 哪些**用户分组**被收起来了。纯显示状态，不持久化（和上面那个一个道理） */
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  /** 正在行内改名的分组 id + 草稿（和文件树那套一样，不用弹窗） */
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const closeMenu = (): void => setMenu(null);

  /**
   * 只按**连接行自己的文本**（名字 + 地址串，里面带着引擎名和 host:port）过滤。
   *
   * 不往底下两层钻：库和表要连上之后才加载，而没加载的东西搜不出来 ——
   * 「有时候搜得到、有时候搜不到」比搜不到更让人困惑。表名的搜索本来就在
   * 主区那个列表里。
   *
   * 和 Redis 一样按相关度排序（平铺的连接列表），树形的侧栏才保序。
   */
  const visible = fuzzyFilter(state.profiles, query, (p) => [
    p.name,
    `${KIND_LABEL[p.kind]} ${p.host}:${p.port}`,
  ]);
  const searching = query.trim() !== '';

  /**
   * 按引擎分组。
   *
   * 只画**有连接的**种类：四个空分组常驻在侧栏里是纯噪音，而「新建一个 Mongo 连接」
   * 在「新建」菜单里选得出来（那个菜单本来就是选引擎的）。
   *
   * 搜索时分组壳留着（用户能看出命中的那条属于哪个引擎），但里面只有命中的。
   */
  const kindGroups = KIND_ORDER.map((kind) => ({
    kind,
    items: visible.filter((p) => p.kind === kind),
  })).filter((g) => g.items.length > 0);

  /**
   * 搜索时**强制展开**所有分组 —— 命中的那条埋在收起来的分组里等于没搜到。
   *
   * ⚠️ 撑开是**临时的**（叠加在这一步），`collapsedGroups` 一个字不写：写进去的话，
   * 清空搜索之后被搜索撑开的分组会自己开着，用户手动收起来的那层就回不去了。
   * 文件树那边踩过同一个坑，规矩是一样的。
   */
  const isGroupCollapsed = (id: string): boolean => !searching && collapsedGroups[id] === true;
  const toggleGroup = (id: string): void =>
    setCollapsedGroups((c) => ({ ...c, [id]: !isGroupCollapsed(id) }));

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

  /** 「新建」→ 先选引擎。两种引擎的默认端口/用户名差很多，让用户先选省得改 */
  const openNewMenu = (x: number, y: number): void => {
    setMenu({
      x,
      y,
      items: (Object.keys(KIND_LABEL) as SqlKind[]).map((kind) => ({
        label: KIND_LABEL[kind],
        onSelect: () => void store.createProfile(kind),
      })),
    });
  };

  /** 分组头（或者它被改名时的输入框）。引擎底下那一层，两个地方要用，抽出来 */
  const renderGroupHead = (group: ConnectionGroup, count: number): ReactNode => {
    if (renaming === group.id) {
      return (
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
      );
    }
    return (
      <ConnectionGroupRow
        group={group}
        count={count}
        collapsed={isGroupCollapsed(group.id)}
        onToggle={() => toggleGroup(group.id)}
        onContextMenu={(x, y) => openGroupMenu(group, x, y)}
      />
    );
  };

  return (
    <div className="rd-panel rd-conn-list" data-testid="sql-conn-list">
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
          data-testid="btn-new-sql-connection"
          title="新建连接（选引擎）"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            openNewMenu(r.left, r.bottom + 2);
          }}
        >
          新建
        </button>
      </div>

      {state.profiles.length > 0 && (
        <SearchBox
          value={query}
          onChange={setQuery}
          testId="sql-conn-search"
          placeholder="搜连接名、引擎或地址"
        />
      )}

      {state.profiles.length === 0 ? (
        <div className="rd-empty">还没有连接，点「新建」加一个</div>
      ) : searching && visible.length === 0 ? (
        <NoMatch testId="sql-conn-nomatch" />
      ) : (
        <div className="rd-panel-body">
          {kindGroups.map(({ kind, items }) => {
            const collapsed = collapsedKinds[kind] === true;
            // 这个引擎底下的连接**再按用户分组分一层**。分组是全局的，
            // 所以同一个组在每个引擎底下都会出现（各是各的成员）
            //
            // ⚠️ 搜索时才藏空组：平时某个引擎下一条成员都没有的组**也要画** ——
            // 用户建的组不该因为「这个引擎里还没放东西」就消失
            // （和上面「只画有连接的引擎」不冲突：那层是**系统给的**种类）
            const byGroup = assignGroups(items, state.groups, searching);
            return (
              <div className="rd-kind-group" key={kind} data-testid={`sql-kind-${kind}`}>
                <div className="rd-kind-head" data-testid={`sql-kind-head-${kind}`}>
                  <button
                    type="button"
                    className="rd-agent-caret"
                    aria-label={collapsed ? '展开' : '收起'}
                    title={collapsed ? '展开' : '收起'}
                    onClick={() =>
                      setCollapsedKinds((c) => ({ ...c, [kind]: !collapsed }))
                    }
                  >
                    {collapsed ? '▸' : '▾'}
                  </button>
                  <span className="rd-kind-name">{KIND_LABEL[kind]}</span>
                  <span className="rd-muted rd-kind-count" data-testid={`sql-kind-count-${kind}`}>
                    {items.length}
                  </span>
                  <button
                    type="button"
                    className="rd-agent-add"
                    title={`新建一个 ${KIND_LABEL[kind]} 连接`}
                    aria-label={`新建 ${KIND_LABEL[kind]} 连接`}
                    data-testid={`sql-kind-new-${kind}`}
                    onClick={() => void store.createProfile(kind)}
                  >
                    ＋
                  </button>
                </div>

                {!collapsed && (
                  <>
                    {/* 未分组的在最上面（也不缩进）：新建的连接就在这儿 */}
                    {byGroup.ungrouped.map((profile) => (
                      <ConnectionBranch
                        key={profile.id}
                        profile={profile}
                        state={state}
                        store={store}
                        onMenu={setMenu}
                      />
                    ))}

                    {byGroup.groups.map(({ group, items: members }) => (
                      <div key={group.id}>
                        {renderGroupHead(group, members.length)}
                        {!isGroupCollapsed(group.id) && (
                          <div className="rd-conn-group-body">
                            {members.map((profile) => (
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
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={closeMenu} />}
    </div>
  );
}

function ConnectionBranch({
  profile,
  state,
  store,
  onMenu,
}: {
  profile: SqlProfile;
  state: SqlState;
  store: SqlStore;
  onMenu: (menu: OpenMenu) => void;
}): ReactNode {
  const status = state.runtime[profile.id]?.status ?? 'idle';
  const connected = status === 'connected';
  const expanded = state.expanded[profile.id] === true;
  const loading = state.tablesLoading[profile.id] === true;

  const databases = state.databases[profile.id];
  const tables = state.tables[profile.id] ?? [];
  const active = state.runtime[profile.id]?.server?.database ?? profile.database;

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
        address={`${KIND_LABEL[profile.kind]} · ${profile.host}:${profile.port}`}
        status={status}
        selected={state.selectedId === profile.id}
        expanded={expanded}
        onToggleExpand={() => void store.toggleExpanded(profile.id)}
        onSelect={() => store.select(profile.id)}
        onToggle={() => void (connected ? store.disconnect(profile.id) : store.connect(profile.id))}
        onContextMenu={openMenu}
      />

      {expanded && (
        <div className="rd-db-list" data-testid={`sql-dbs-${profile.id}`}>
          {!connected && !loading && <div className="rd-db-hint">连上之后才能看到库和表</div>}
          {loading && <div className="rd-db-hint">读取中…</div>}

          {connected &&
            (databases ?? [active]).map((database) => (
              <DatabaseBranch
                key={database}
                profile={profile}
                database={database}
                active={database === active}
                tables={database === active ? tables : []}
                store={store}
              />
            ))}
        </div>
      )}
    </>
  );
}

/**
 * 一个库 + 它底下的表。
 *
 * 只有当前库展开并列出表 —— 见文件头的说明，这是引擎的真实模型决定的。
 */
function DatabaseBranch({
  profile,
  database,
  active,
  tables,
  store,
}: {
  profile: SqlProfile;
  database: string;
  active: boolean;
  // 用真的 `TableInfo`（而不是就地写一个 { name, kind }）：它带着 schema，
  // 而 schema 决定生成的 SQL 要不要限定 —— 少了这个字段就出「relation 不存在」
  tables: readonly TableInfo[];
  store: SqlStore;
}): ReactNode {
  return (
    <>
      <button
        type="button"
        className={`rd-db-row${active ? ' is-active' : ''}`}
        data-testid={`sql-db-${database}`}
        data-active={active}
        title={active ? `当前库：${database}` : `切到 ${database}`}
        onClick={() => {
          // 点当前库不重复发请求；点别的库才切过去
          if (!active) void store.useDatabase(profile.id, database);
        }}
      >
        <span className={`rd-tree-caret${active ? ' is-open' : ''}`} aria-hidden="true">
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
        <span className="rd-db-name">{database}</span>
      </button>

      {/* 表缩进在它的库底下 —— 这层包含关系是这次改动的重点 */}
      {active &&
        (tables.length === 0 ? (
          <div className="rd-db-hint is-child">这个库里没有表</div>
        ) : (
          tables.map((table) => (
            <button
              key={`${table.schema}.${table.name}`}
              type="button"
              className="rd-db-row is-child"
              data-testid={`sql-table-${table.name}`}
              data-table-kind={table.kind}
              // 悬浮里**把会生成的 SQL 原样写出来**：用户先看见，而不是点下去
              // 才发现 `relation ... does not exist`（真机上报过）
              title={`SELECT * FROM ${qualifyName(profile.kind, profile.database, table.schema, table.name)} LIMIT 100`}
              onClick={() => store.insertTableQuery(table)}
            >
              {/* 非默认 schema 的表带上 schema 前缀：一屏里两个同名的表，
                  光看名字分不出是哪个 */}
              <span className="rd-db-name">
                {displayName(profile.kind, profile.database, table.schema, table.name)}
              </span>
              {table.kind === 'view' && <span className="rd-db-count">视图</span>}
              {table.kind === 'collection' && <span className="rd-db-count">集合</span>}
            </button>
          ))
        ))}
    </>
  );
}
