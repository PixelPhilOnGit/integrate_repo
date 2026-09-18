/**
 * 桌面端的 Redis 客户端：走 Rust command。
 *
 * 连接的持久化不在这里 —— 那是 `shared/platform/kv.ts` 的事，三个模块共用。
 * 这个文件只负责「把命令发给后端的 Redis 内核」。
 */

import { invoke } from '../../../shared/platform/invoke';
import type { DbInfo, KeyDetail, RedisReply, ScanPage, ServerInfo } from '../core/types';
import type { RedisClient } from './types';

export function createTauriRedisClient(): RedisClient {
  return {
    async connect(params): Promise<ServerInfo> {
      return invoke<ServerInfo>('redis_connect', {
        id: params.id,
        config: {
          host: params.host,
          port: params.port,
          db: params.db,
          username: params.username,
          password: params.password,
        },
      });
    },

    async disconnect(id: string): Promise<void> {
      await invoke<void>('redis_disconnect', { id });
    },

    async exec(id: string, args: readonly string[]): Promise<RedisReply> {
      // 展开成普通数组：readonly 数组过不了 IPC，而且 serde 要的是 Vec<String>
      return invoke<RedisReply>('redis_exec', { id, args: [...args] });
    },

    async keyspace(id: string): Promise<DbInfo[]> {
      return invoke<DbInfo[]>('redis_keyspace', { id });
    },

    async select(id: string, db: number): Promise<void> {
      await invoke<void>('redis_select', { id, db });
    },

    async scan(id: string, pattern: string, cursor: number, count: number): Promise<ScanPage> {
      return invoke<ScanPage>('redis_scan', { id, pattern, cursor, count });
    },

    async keyDetail(
      id: string,
      key: Uint8Array,
      limit: number,
      knownType?: string,
    ): Promise<KeyDetail> {
      // Uint8Array 过 IPC 会变成普通数字数组，serde 正好能反序列化成 Vec<u8>
      // （和导出那条路同一个机制，见 shared/platform/tauri.ts 里的注释）
      return invoke<KeyDetail>('redis_key_detail', {
        id,
        key: Array.from(key),
        limit,
        knownType: knownType ?? null,
      });
    },
  };
}
