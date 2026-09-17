/**
 * 桌面端的 SQL 客户端：走 Rust command。
 *
 * 档案持久化不在这里 —— 那是 `shared/connections/kv.ts` 的事。
 * 这个文件只负责「把请求发给后端的 SQL 内核」。
 */

import { invoke } from '../../../shared/platform/invoke';
import type { QueryResult, ServerInfo, TableInfo } from '../core/types';
import type { SqlClient } from './types';

export function createTauriSqlClient(): SqlClient {
  return {
    async connect(params): Promise<ServerInfo> {
      return invoke<ServerInfo>('sql_connect', {
        id: params.id,
        config: {
          kind: params.kind,
          host: params.host,
          port: params.port,
          username: params.username,
          password: params.password,
          // 空库名传 null：Rust 侧按 `Option<String>` 收，
          // 传空串会让驱动拿空串当库名
          database: params.database === '' ? null : params.database,
        },
      });
    },

    async disconnect(id: string): Promise<void> {
      await invoke<void>('sql_disconnect', { id });
    },

    async query(id: string, sql: string): Promise<QueryResult> {
      return invoke<QueryResult>('sql_query', { id, sql });
    },

    async databases(id: string): Promise<string[]> {
      return invoke<string[]>('sql_databases', { id });
    },

    async tables(id: string): Promise<TableInfo[]> {
      return invoke<TableInfo[]>('sql_tables', { id });
    },

    async useDatabase(id: string, database: string): Promise<ServerInfo> {
      return invoke<ServerInfo>('sql_use_database', { id, database });
    },
  };
}
