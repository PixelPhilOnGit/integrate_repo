/**
 * 桌面端实现：走 Tauri 命令。
 *
 * ⚠️ `send` **每次新建一个 Channel**：Rust 侧丢掉通道时会发 `{end:true}`，
 * JS 收到就注销回调 —— 复用同一个通道对象的话，第二次发消息的事件会全部
 * 石沉大海，而且不报错（SSH / assistant 都踩过，形状一模一样）。
 *
 * `send` 的 invoke **不等跑完**：它在开轮次之后立刻返回 `SendAck`，事件靠
 * 通道边跑边推。一轮可能好几分钟。
 */

import { createChannel, invoke } from '../../../shared/platform/invoke';
import type {
  CliKind,
  CliProbe,
  GroupClient,
  GroupDetail,
  GroupEvent,
  GroupMessage,
  GroupSummary,
  GroupConfigInput,
  SendAck,
  SendRequest,
} from './types';

export function createTauriGroupClient(): GroupClient {
  return {
    async list(): Promise<GroupSummary[]> {
      return await invoke<GroupSummary[]>('group_list');
    },

    async create(name: string): Promise<GroupDetail> {
      return await invoke<GroupDetail>('group_create', { name });
    },

    async get(id: string): Promise<GroupDetail> {
      return await invoke<GroupDetail>('group_get', { groupId: id });
    },

    async save(config: GroupConfigInput): Promise<GroupDetail> {
      return await invoke<GroupDetail>('group_save', { config });
    },

    async remove(id: string): Promise<boolean> {
      return await invoke<boolean>('group_delete', { groupId: id });
    },

    async history(id: string, limit?: number): Promise<GroupMessage[]> {
      return await invoke<GroupMessage[]>('group_history', {
        groupId: id,
        limit: limit ?? null,
      });
    },

    async send(request: SendRequest): Promise<SendAck> {
      const channel = await createChannel<GroupEvent>((event) => {
        request.onEvent(event);
      });
      return await invoke<SendAck>('group_send', {
        groupId: request.groupId,
        text: request.text,
        mentionIds: request.mentionIds,
        channel,
      });
    },

    async stop(groupId: string, turnId: string): Promise<void> {
      await invoke<null>('group_stop', { groupId, turnId });
    },

    async clearHistory(groupId: string): Promise<void> {
      await invoke<null>('group_clear_history', { groupId });
    },

    async probe(kind: CliKind, command: string | null): Promise<CliProbe> {
      return await invoke<CliProbe>('group_probe', { kind, command });
    },
  };
}
