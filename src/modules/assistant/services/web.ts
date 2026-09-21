/**
 * 浏览器实现（内存假实现，给 e2e 和 `npm run dev` 用）。
 *
 * ⚠️ **语义必须和 Rust 那边一模一样**，否则 e2e 是假绿、真机全是 bug ——
 * 这个仓库在这条上反复栽过（见 `tasks/services/web.ts` 头部的说明）。
 *
 * 这里唯一"和 Rust 不同"的地方是 `available`：浏览器**没有钥匙串**，
 * 所以它恒为 `false`。这不是偷懒，是事实 —— 连接密码那边的浏览器实现
 * 也是这么报的（`shared/platform/secrets.ts`），界面因此会挂一个警告。
 * key 本身存在内存里，好让 e2e 能走完「填 → 保存 → 显示已配置」这一串。
 */

import type { ProviderKind } from '../core/config';
import type { AssistantClient, AssistantKeyStatus } from './types';

const keys = new Map<ProviderKind, string>();

export function createWebAssistantClient(): AssistantClient {
  return {
    async keyStatus(kind: ProviderKind): Promise<AssistantKeyStatus> {
      return { available: false, configured: keys.has(kind) };
    },

    async setApiKey(kind: ProviderKind, key: string): Promise<void> {
      const trimmed = key.trim();
      // 空串 = 删掉（和 Rust 那边一致：空 key 存进去等于没配）
      if (trimmed === '') keys.delete(kind);
      else keys.set(kind, trimmed);
    },
  };
}

/** 给 e2e 用的重置钩子（单 worker 串行跑，每个用例开始前清一次）。 */
export function __resetAssistantForTest(): void {
  keys.clear();
}
