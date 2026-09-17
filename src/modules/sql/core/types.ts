/**
 * SQL 模块的数据形状。
 *
 * `QueryResult` / `ServerInfo` / `TableInfo` 是**前后端的 IPC 契约**，
 * 字段名照着 Rust 侧 `devtoolkit-sql` 的 serde 输出写。
 */

import type {
  ConnectionProfileBase,
  ConnectionRuntime as BaseRuntime,
} from '../../../shared/connections/types';

/** 支持哪种引擎。端口默认值跟着它走 */
export type SqlKind = 'postgres' | 'mysql';

export interface SqlProfile extends ConnectionProfileBase {
  kind: SqlKind;
  /**
   * 库名。
   *
   * **PostgreSQL 这里必填** —— 它一个连接绑一个库，不指定的话驱动会拿用户名当库名，
   * 报一个很难懂的错。MySQL 可以不填（连上去再 `USE`）。
   */
  database: string;
}

/**
 * SQL 的运行时状态。
 *
 * 必须显式指定 `ServerInfo` —— 共享层那个泛型默认是 `unknown`，
 * 不指定的话 `runtime.server.database` 这种访问全都不通过。
 */
export type SqlRuntime = BaseRuntime<ServerInfo>;

/** 连上之后后端回的信息 */
export interface ServerInfo {
  address: string;
  kind: string;
  version: string;
  database: string;
}

/** 一个列的名字和类型 */
export interface ColumnInfo {
  name: string;
  typeName: string;
}

/** 一个单元格。`text` 为 null 表示 SQL 的 NULL —— 和空字符串是两回事 */
export interface Cell {
  text: string | null;
  /** 内容不是合法 UTF-8（真二进制列） */
  binary?: boolean;
}

export interface QueryResult {
  columns: ColumnInfo[];
  rows: Cell[][];
  /** 非 SELECT 语句的影响行数 */
  affected: number | null;
  /** 行数超过上限被截断了 */
  truncated: boolean;
  elapsedMs: number;
  /**
   * 引擎报的错。
   *
   * **有它不代表连接坏了** —— 表不存在、语法错都是一次成功的往返，
   * 只是没成功执行。前端该把它显示在结果区里，而不是弹外壳错误条。
   */
  error?: string;
}

/** 一个库里的表 */
export interface TableInfo {
  name: string;
  kind: 'table' | 'view';
  rows?: number;
}

/** 传给服务层的连接参数 */
export interface ConnectParams {
  id: string;
  kind: SqlKind;
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
}

export const KIND_LABEL: Record<SqlKind, string> = {
  postgres: 'PostgreSQL',
  mysql: 'MySQL',
};

/** 两种引擎的默认端口 */
export const DEFAULT_PORT: Record<SqlKind, number> = {
  postgres: 5432,
  mysql: 3306,
};
