/**
 * 左侧栏：连接 → 库 → 表。
 *
 * # 三层是**包含关系**，不是并列
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
import { ConnectionRow } from '../../../shared/connections/ConnectionRow';
import { ContextMenu, type MenuItem } from '../../../shared/ui/ContextMenu';
import { KIND_LABEL, type SqlKind, type SqlProfile } from '../core/types';
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

  const closeMenu = (): void => setMenu(null);

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

  return (
    <div className="rd-panel rd-conn-list" data-testid="sql-conn-list">
      <div className="rd-panel-head">
        <span>连接</span>
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

      {state.profiles.length === 0 ? (
        <div className="rd-empty">还没有连接，点「新建」加一个</div>
      ) : (
        <div className="rd-panel-body">
          {state.profiles.map((profile) => (
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
                profileId={profile.id}
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
  profileId,
  database,
  active,
  tables,
  store,
}: {
  profileId: string;
  database: string;
  active: boolean;
  tables: { name: string; kind: 'table' | 'view' }[];
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
          if (!active) void store.useDatabase(profileId, database);
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
              key={table.name}
              type="button"
              className="rd-db-row is-child"
              data-testid={`sql-table-${table.name}`}
              data-table-kind={table.kind}
              title={`SELECT * FROM ${table.name}`}
              onClick={() => store.insertTableQuery(table.name)}
            >
              <span className="rd-db-name">{table.name}</span>
              {table.kind === 'view' && <span className="rd-db-count">视图</span>}
            </button>
          ))
        ))}
    </>
  );
}
