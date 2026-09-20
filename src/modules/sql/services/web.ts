/**
 * 浏览器端的 SQL 客户端：内存假实现。
 *
 * 不是「顺便支持一下浏览器」—— headless 环境里起不了原生窗口，Playwright
 * 只能驱动普通 Chromium 里的前端，**这个实现是整条自动化验证链路的前提**。
 *
 * 假引擎在 `core/fakeSql.ts`（纯逻辑、可单测），这里只做连接层的事。
 */

import {
  DEMO_DATABASES,
  demoTables,
  fakeCollections,
  runFakeMongoQuery,
  runFakeQuery,
} from '../core/fakeSql';
import type { QueryResult, ServerInfo, SqlKind, TableInfo } from '../core/types';
import type { SqlClient } from './types';

/**
 * 这个主机名**永远连不上**。
 *
 * 需要一个「确定性地失败」的地址，e2e 才能稳定地断言失败分支。用 `.invalid`
 * 这个保留顶级域，保证它在任何网络环境下都不会意外解析成功。
 */
export const UNREACHABLE_HOST = 'unreachable.invalid';

interface Session {
  address: string;
  kind: string;
  version: string;
  database: string;
}

/** 假版本号，编得像一点（界面上要显示） */
const FAKE_VERSION: Record<SqlKind, string> = {
  postgres: '16.4',
  mysql: '8.0.46',
  clickhouse: '24.8',
  mongodb: '7.0',
};

export function createWebSqlClient(): SqlClient {
  const sessions = new Map<string, Session>();

  return {
    async connect(params): Promise<ServerInfo> {
      const address = `${params.host}:${params.port}`;

      if (params.host.trim().toLowerCase() === UNREACHABLE_HOST) {
        throw new Error(
          `连接数据库（${address}）失败：无法解析主机名或者连接被拒绝。\
请确认地址、端口、库名和用户名密码正确，服务已启动。`,
        );
      }

      // ⚠️ **和真实现一个口径**：Mongo 允许空用户名（本地常常不开鉴权），
      // 其余三种必须要 —— 假实现要是"一律要求"，浏览器里连不上而真机上能连，
      // 那这条链路等于没验过
      if (params.kind !== 'mongodb' && params.username.trim() === '') {
        throw new Error(`连接数据库（${address}）失败：用户名不能为空。`);
      }

      const session: Session = {
        address,
        kind: params.kind,
        // 版本号编得像一点，界面上要显示
        version: FAKE_VERSION[params.kind],
        // 没指定库就落到演示库上（真 MySQL 允许不选库，但那样什么都看不出来）
        database: params.database === '' ? (DEMO_DATABASES[0] ?? 'postgres') : params.database,
      };

      sessions.set(params.id, session);

      return {
        address: session.address,
        kind: session.kind,
        version: session.version,
        database: session.database,
      };
    },

    async disconnect(id: string): Promise<void> {
      sessions.delete(id);
    },

    async query(id: string, text: string): Promise<QueryResult> {
      const session = sessionOf(id);
      // 假引擎是同步的，但接口是异步的（真实现要走网络）
      // Mongo 那边传的是 **JSON 查询**而不是 SQL（见 core/query.ts 的说明）
      return session.kind === 'mongodb' ? runFakeMongoQuery(text) : runFakeQuery(text);
    },

    async databases(id: string): Promise<string[]> {
      const session = sessionOf(id);
      // 用户指定的库也算存在 —— 换成真服务器上「你连的那个库当然在」
      return [...new Set([session.database, ...DEMO_DATABASES])];
    },

    async tables(id: string): Promise<TableInfo[]> {
      const session = sessionOf(id);
      return session.kind === 'mongodb'
        ? fakeCollections(session.database)
        : demoTables(session.database);
    },

    async useDatabase(id: string, database: string): Promise<ServerInfo> {
      const session = sessionOf(id);
      session.database = database;
      return {
        address: session.address,
        kind: session.kind,
        version: session.version,
        database,
      };
    },
  };

  /** 取会话；没连上就抛和 Rust 侧同款的错 */
  function sessionOf(id: string): Session {
    const session = sessions.get(id);
    if (!session) {
      throw new Error(`连接 “${id}” 当前不在活动状态，请先连接。`);
    }
    return session;
  }
}
