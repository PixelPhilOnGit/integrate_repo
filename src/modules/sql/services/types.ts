/**
 * SQL 模块的服务层契约。
 *
 * `KeyValueStore` / `ProfileStore` / `ConnStatus` 那些通用的东西在
 * `shared/connections/`（三个连接类模块共用）。这里只剩 SQL 专属的部分。
 */

import type { ProfileStore } from '../../../shared/connections/types';
import type { ConnectParams, QueryResult, ServerInfo, SqlProfile, TableInfo } from '../core/types';

export interface SqlClient {
  /** 建立连接。失败时 reject，错误信息已经是可以直接显示的中文 */
  connect(params: ConnectParams): Promise<ServerInfo>;
  /** 断开。幂等：没连过也不报错 */
  disconnect(id: string): Promise<void>;
  /**
   * 执行一段 SQL。支持多条语句。
   *
   * **引擎报错（表不存在、语法错）是 `resolve` 出来的一条带 `error` 的结果**，
   * 不是 reject —— 那是一次成功的往返，只是没成功执行。只有传输层失败才 reject。
   */
  query(id: string, sql: string): Promise<QueryResult>;
  /** 库列表 */
  databases(id: string): Promise<string[]>;
  /** 当前库里的表 */
  tables(id: string): Promise<TableInfo[]>;
  /** 换库。两种引擎的做法不同，但对调用方是同一个行为 */
  useDatabase(id: string, database: string): Promise<ServerInfo>;
}

export interface SqlServices {
  client: SqlClient;
  profiles: ProfileStore<SqlProfile>;
}
