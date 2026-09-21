/**
 * 桌面端实现：走 Tauri 命令。
 *
 * 密钥的读写全在 Rust 那边（系统钥匙串），这个文件只搬运「配没配」和
 * 「存一把」—— **key 本身不回传**，理由见 `types.ts`。
 */

import { invoke } from '../../../shared/platform/invoke';
import type { ProviderKind } from '../core/config';
import type { AssistantClient, AssistantKeyStatus } from './types';

export function createTauriAssistantClient(): AssistantClient {
  return {
    async keyStatus(kind: ProviderKind): Promise<AssistantKeyStatus> {
      return await invoke<AssistantKeyStatus>('assistant_api_key_status', { kind });
    },

    async setApiKey(kind: ProviderKind, key: string): Promise<void> {
      await invoke<null>('assistant_set_api_key', { kind, key });
    },
  };
}
