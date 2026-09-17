/**
 * 左侧栏：连接 → 库 / 表。
 *
 * 和 Redis 那个树不一样：**库不是可展开的节点，是可切换的当前状态**。
 * 因为 PostgreSQL 一个连接绑一个库，把库画成可以随便展开的树是骗人的 ——
 * 点另一个库的真实含义是「换过去」。所以底下列的表永远只有一份，属于当前库。
 */

import type { ReactNode } from 'react';
import { ConnectionRow } from '../../../shared/connections/ConnectionRow';
import { KIND_LABEL, type SqlProfile } from '../core/types';
import type { SqlState, SqlStore } from '../state/store';

interface Props {
  state: SqlState;
  store: SqlStore;
}

export function ConnectionTree({ state, store }: Props): ReactNode {
  return (
    <div className="rd-panel rd-conn-list" data-testid="sql-conn-list">
      <div className="rd-panel-head">
        <span>连接</span>
        <button
          type="button"
          data-testid="btn-new-sql-connection"
          onClick={() => void store.createProfile()}
        >
          新建
        </button>
      </div>

      {state.profiles.length === 0 ? (
        <div className="rd-empty">还没有连接，点「新建」加一个</div>
      ) : (
        <div className="rd-panel-body">
          {state.profiles.map((profile) => (
            <ConnectionBranch key={profile.id} profile={profile} state={state} store={store} />
          ))}
        </div>
      )}
    </div>
  );
}

function ConnectionBranch({
  profile,
  state,
  store,
}: {
  profile: SqlProfile;
  state: SqlState;
  store: SqlStore;
}): ReactNode {
  const status = state.runtime[profile.id]?.status ?? 'idle';
  const connected = status === 'connected';
  const expanded = state.expanded[profile.id] === true;
  const loading = state.tablesLoading[profile.id] === true;

  const databases = state.databases[profile.id];
  const tables = state.tables[profile.id] ?? [];
  const active = state.runtime[profile.id]?.server?.database ?? profile.database;

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
      />

      {expanded && (
        <div className="rd-db-list" data-testid={`sql-dbs-${profile.id}`}>
          {!connected && !loading && <div className="rd-db-hint">连上之后才能看到库和表</div>}
          {loading && <div className="rd-db-hint">读取中…</div>}

          {connected && (
            <>
              <div className="rd-section-label">库</div>
              {(databases ?? [active]).map((database) => (
                <button
                  key={database}
                  type="button"
                  className={`rd-db-row${database === active ? ' is-active' : ''}`}
                  data-testid={`sql-db-${database}`}
                  data-active={database === active}
                  onClick={() => void store.useDatabase(profile.id, database)}
                >
                  <span className="rd-db-name">{database}</span>
                </button>
              ))}

              <div className="rd-section-label">表</div>
              {tables.length === 0 ? (
                <div className="rd-db-hint">这个库里没有表</div>
              ) : (
                tables.map((table) => (
                  <button
                    key={table.name}
                    type="button"
                    className="rd-db-row"
                    data-testid={`sql-table-${table.name}`}
                    data-table-kind={table.kind}
                    title={`SELECT * FROM ${table.name}`}
                    onClick={() => store.insertTableQuery(table.name)}
                  >
                    <span className="rd-db-name">{table.name}</span>
                    {table.kind === 'view' && <span className="rd-db-count">视图</span>}
                  </button>
                ))
              )}
            </>
          )}
        </div>
      )}
    </>
  );
}
