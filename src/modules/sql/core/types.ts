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

/**
 * 支持哪种引擎。端口默认值跟着它走。
 *
 * ⚠️ **`mongodb` 不是 SQL**，它只是**连接的一种**：侧栏、档案、凭据那些和别的
 * 引擎共用（用户的心智是「我这里有一堆数据源」），但**工作台不一样** ——
 * SQL 那几种是「编辑器 + 结果表格」，Mongo 是文档浏览器（库 → 集合 → 文档）。
 * 所以有个 [`isSqlKind`] 用来分流，别到处写 `kind === 'mysql' || …`。
 */
export type SqlKind = 'postgres' | 'mysql' | 'clickhouse' | 'mongodb';

/** 这个引擎走不走「SQL 工作台」。Mongo 不走 */
export function isSqlKind(kind: SqlKind): boolean {
  return kind !== 'mongodb';
}

/** 侧栏里按种类分组的**显示顺序**（也是新建时下拉里的顺序） */
export const KIND_ORDER: readonly SqlKind[] = ['postgres', 'mysql', 'clickhouse', 'mongodb'];

/** 种类的中文名。界面上只该从这里拿文案 */
export const KIND_LABEL: Record<SqlKind, string> = {
  postgres: 'PostgreSQL',
  mysql: 'MySQL',
  clickhouse: 'ClickHouse',
  mongodb: 'MongoDB',
};

/** 默认端口。改引擎的时候表单会跟着换 */
export const DEFAULT_PORT: Record<SqlKind, number> = {
  postgres: 5432,
  mysql: 3306,
  // ClickHouse 的 HTTP 口（客户端走的就是它，不是 9000 那个原生协议口）
  clickhouse: 8123,
  mongodb: 27017,
};

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
  /**
   * 它属于哪个 schema。
   *
   * ⚠️ **这个字段是必须的**，不是装饰：PostgreSQL 解析裸表名只看 `search_path`，
   * 表要是不在 `public` 里，生成的 SQL 必须写成 `"schema"."表"` 才选得中。
   * （真机上报过 `relation "account_api" does not exist` —— 就是丢了它。）
   * MySQL / ClickHouse 那边它就是当前库名，Mongo 是库名。
   */
  schema: string;
  /**
   * 它是哪种东西。
   *
   * ⚠️ Mongo 给的是 `collection` —— 别把它硬塞进 table/view 里：
   * 那不是「表」，界面上也不该按表来叫（用户看到「表」会去找表 ✗）。
   */
  kind: 'table' | 'view' | 'collection';
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

