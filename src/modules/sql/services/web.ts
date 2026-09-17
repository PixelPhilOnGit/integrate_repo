/**
 * 浏览器端的 SQL 客户端：内存假实现。
 *
 * 不是「顺便支持一下浏览器」—— headless 环境里起不了原生窗口，Playwright
 * 只能驱动普通 Chromium 里的前端，**这个实现是整条自动化验证链路的前提**。
 *
 * 假引擎在 `core/fakeSql.ts`（纯逻辑、可单测），这里只做连接层的事。
 */

import { DEMO_DATABASES, demoTables, runFakeQuery } from '../core/fakeSql';
import type { QueryResult, ServerInfo, TableInfo } from '../core/types';
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

      if (params.username.trim() === '') {
        throw new Error(`连接数据库（${address}）失败：用户名不能为空。`);
      }

      const session: Session = {
        address,
        kind: params.kind,
        // 版本号编得像一点，界面上要显示
        version: params.kind === 'mysql' ? '8.0.46' : '16.4',
        database: params.database === '' ? (DEMO_DATABASES[0] ?? 'demo') : params.database,
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

    async query(id: string, sql: string): Promise<QueryResult> {
      const session = sessionOf(id);
      void session;
      // 假引擎是同步的，但接口是异步的（真实现要走网络）
      return runFakeQuery(sql);
    },

    async databases(id: string): Promise<string[]> {
      sessionOf(id);
      return [...DEMO_DATABASES];
    },

    async tables(id: string): Promise<TableInfo[]> {
      sessionOf(id);
      return demoTables();
    },

    async useDatabase(id: string, database: string): Promise<ServerInfo> {
      const session = sessionOf(id);
      if (!DEMO_DATABASES.includes(database)) {
        throw new Error(`服务器拒绝了这次操作：Unknown database '${database}'`);
      }

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
