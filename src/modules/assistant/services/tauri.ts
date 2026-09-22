/**
 * 桌面端实现：走 Tauri 命令。
 *
 * 密钥的读写全在 Rust 那边（系统钥匙串），这个文件只搬运「配没配」和
 * 「存一把」—— **key 本身不回传**，理由见 `types.ts`。
 */

import { createChannel, invoke } from '../../../shared/platform/invoke';
import type { ProviderKind } from '../core/config';
import type {
  AssistantClient,
  AssistantEvent,
  AssistantKeyStatus,
  ApprovalDecision,
  SendRequest,
} from './types';

export function createTauriAssistantClient(): AssistantClient {
  return {
    async keyStatus(kind: ProviderKind): Promise<AssistantKeyStatus> {
      return await invoke<AssistantKeyStatus>('assistant_api_key_status', { kind });
    },

    async setApiKey(kind: ProviderKind, key: string): Promise<void> {
      await invoke<null>('assistant_set_api_key', { kind, key });
    },

    async send(request: SendRequest): Promise<number> {
      // ⚠️ **每次 send 都新建一个通道。**
      //
      // Rust 侧把通道丢掉时会往 JS 发一条 `{end: true}`，JS 收到就把回调
      // 注销。复用同一个通道对象的话，第二次发消息时事件会**全部石沉大海**
      // —— 而且不报错。SSH 那一轮踩过，形状一模一样（见 `ssh/services/tauri.ts`）。
      const channel = await createChannel<AssistantEvent>((event) => {
        request.onEvent(event);
      });

      // ⚠️ 这个 invoke **不等跑完** —— 它在起跑之后就返回 run 编号，
      // 事件靠上面的通道边跑边推。一次 run 可能好几分钟。
      return await invoke<number>('assistant_send', {
        session: request.session,
        workspace: request.workspace,
        prompt: request.prompt,
        config: request.config,
        strategy: request.strategy,
        channel,
      });
    },

    async approve(
      run: number,
      call: string,
      decision: ApprovalDecision,
    ): Promise<boolean> {
      return await invoke<boolean>('assistant_approve', { run, call, decision });
    },

    async cancel(run: number): Promise<void> {
      await invoke<null>('assistant_cancel', { run });
    },

    async clearSession(session: string): Promise<void> {
      await invoke<null>('assistant_clear_session', { session });
    },
  };
}
