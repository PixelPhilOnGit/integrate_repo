/**
 * SQL 模块的各个槽位。
 *
 * **没有 Toolbar**：这个模块的操作用按钮都在主区里（执行）和侧栏里（新建），
 * 再来一条顶部通栏只是重复。
 */

import { useSyncExternalStore, type ReactNode } from 'react';
import { ConnectionForm } from './panels/ConnectionForm';
import { ConnectionTree } from './panels/ConnectionTree';
import { QueryPane } from './panels/QueryPane';
import { sqlStore } from './state/store';

function useSql() {
  const state = useSyncExternalStore(sqlStore.subscribe, sqlStore.getSnapshot);
  return { state };
}

export function SqlSidebar(): ReactNode {
  const { state } = useSql();
  return <ConnectionTree state={state} store={sqlStore} />;
}

export function SqlMain(): ReactNode {
  const { state } = useSql();
  return <QueryPane state={state} store={sqlStore} />;
}

export function SqlInspector(): ReactNode {
  const { state } = useSql();
  return <ConnectionForm state={state} store={sqlStore} />;
}

/** 状态栏右侧：当前连接、库、上次耗时 */
export function SqlStatusItems(): ReactNode {
  const { state } = useSql();
  const profile = sqlStore.selectedProfile();
  const runtime = profile ? state.runtime[profile.id] : undefined;

  if (!profile) {
    return (
      <span className="rd-muted" data-testid="sql-status">
        没有连接
      </span>
    );
  }

  const database = runtime?.server?.database ?? profile.database;

  return (
    <span className="rd-muted" data-testid="sql-status">
      {profile.name} · {profile.host}:{profile.port}
      {database !== '' ? `/${database}` : ''} · {statusText(runtime?.status)}
    </span>
  );
}

function statusText(status: string | undefined): string {
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
