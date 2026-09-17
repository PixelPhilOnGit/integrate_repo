/**
 * 浏览器实现：内存假 Redis + localStorage。
 *
 * 这不是「顺便支持一下浏览器」。headless 环境里起不了原生窗口，Playwright 只能
 * 驱动普通 Chromium 里的前端 —— **这个实现是整条自动化验证链路的前提**。
 * 所以假 Redis 要足够真：`SET a 1` 之后再 `GET a` 得真能拿回 `1`，
 * e2e 断言「连接 → 执行 → 展示结果」才有意义。
 *
 * 协议层的正确性不归这里管：那是 Rust 侧打真 Redis 的集成测试的职责。
 * 这里只保证界面链路（连接、执行、展示、报错、断开）都是通的。
 */

import { createFakeRedis } from '../core/fakeRedis';
import type { RedisReply, ServerInfo } from '../core/types';
import { createProfileStore } from './credentials';
import type { KeyValueStore, RedisClient, RedisServices } from './types';

/**
 * 这个主机名**永远连不上**。
 *
 * 需要一个「确定性地失败」的地址，e2e 才能稳定地断言失败分支
 * （错误提示、输入框禁用、状态点变红）。用 `.invalid` 这个保留顶级域，
 * 保证它在任何网络环境下都不会意外解析成功。
 */
export const UNREACHABLE_HOST = 'unreachable.invalid';

const STORAGE_KEY = 'devtoolkit.redis.v1';

/**
 * localStorage 上的极简 KV。
 *
 * 内存里留一份权威副本：localStorage 写失败（配额满、隐私模式）时，
 * 至少**当前这次会话**里的连接列表还是对的，不会刚存完就读不回来。
 */
const memory = new Map<string, unknown>();
let loaded = false;

function readAll(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) {
      for (const [key, value] of Object.entries(parsed)) memory.set(key, value);
    }
  } catch {
    // 存储里的东西坏了就当没有 —— 反正 `credentials.ts` 还会逐条校验一遍
  }
}

function writeAll(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(memory)));
  } catch {
    // 写不进去就算了：内存里的状态仍然是对的，用户这次会话还能正常用
  }
}

const kv: KeyValueStore = {
  async get<T>(key: string): Promise<T | null> {
    readAll();
    return memory.has(key) ? (memory.get(key) as T) : null;
  },

  async set(key: string, value: unknown): Promise<void> {
    readAll();
    memory.set(key, value);
    writeAll();
  },
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 从 INFO 的文本里抠出版本号，和 Rust 侧 `parse_version` 一个逻辑 */
function parseVersion(info: string): string | null {
  for (const line of info.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('redis_version:')) {
      const value = trimmed.slice('redis_version:'.length).trim();
      if (value !== '') return value;
    }
  }
  return null;
}

export function createWebServices(): RedisServices {
  /** 连接 id → 这个连接的假 Redis 实例（每个连接一个独立的库空间） */
  const connections = new Map<string, ReturnType<typeof createFakeRedis>>();

  const client: RedisClient = {
    async connect(params): Promise<ServerInfo> {
      const address = `${params.host}:${params.port}`;

      if (params.host.trim().toLowerCase() === UNREACHABLE_HOST) {
        throw new Error(
          `连接 Redis（${address}）失败：无法解析主机名或者连接被拒绝。\
请确认地址和端口正确、服务已启动、防火墙放行。`,
        );
      }

      const fake = createFakeRedis();

      // 有密码就先认证 —— 和真实现一样，认证的问题要在建连阶段暴露
      if (params.password !== '') {
        const authed = fake.exec(['AUTH', params.username || 'default', params.password]);
        if (authed.type === 'error') {
          throw new Error(`连接 Redis（${address}）失败：${authed.message}`);
        }
      }

      // 库号越界由服务端报错（真实现也是这样，不在这里硬编码上界）
      if (params.db !== 0) {
        const selected = fake.exec(['SELECT', String(params.db)]);
        if (selected.type === 'error') {
          throw new Error(`连接 Redis（${address}）失败：${selected.message}`);
        }
      }

      connections.set(params.id, fake);

      const info = fake.exec(['INFO']);
      return {
        address,
        db: params.db,
        version: info.type === 'bulk' ? parseVersion(info.text) : null,
      };
    },

    async disconnect(id: string): Promise<void> {
      connections.delete(id);
    },

    async exec(id: string, args: readonly string[]): Promise<RedisReply> {
      const fake = connections.get(id);
      if (!fake) {
        // 文案和 Rust 侧的 NotConnected 对齐，两个平台的错误提示不该长得不一样
        throw new Error(`连接 “${id}” 当前不在活动状态，请先连接。`);
      }

      // `DEBUG SLEEP` 真 Redis 也有。用它在 e2e 里稳定地制造一个「命令正在执行」
      // 的窗口，去断言执行期间输入框是禁用的。
      if (args[0]?.toUpperCase() === 'DEBUG' && args[1]?.toUpperCase() === 'SLEEP') {
        await delay(Number(args[2]) || 100);
        return { type: 'status', text: 'OK' };
      }

      return fake.exec(args);
    },
  };

  return {
    client,
    profiles: createProfileStore(kv),
  };
}
