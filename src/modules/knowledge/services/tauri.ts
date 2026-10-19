/**
 * 知识库的桌面实现：每个方法就是一次 `invoke`，生成那条多一个 `Channel`。
 *
 * 参数表里**只有 vault 名和相对路径**（老规矩，见 `kb_commands.rs` 头部）；
 * 绝对路径、文件对话框都在 Rust 侧。
 */

import { createChannel, invoke } from '../../../shared/platform/invoke';
import type { GenEvent, GenListener, KnowledgeClient } from './types';

export function createTauriKnowledgeClient(): KnowledgeClient {
  return {
    vaults: () => invoke('kb_vaults'),
    createVault: (name) => invoke('kb_vault_create', { name }),
    deleteVault: (name) => invoke('kb_vault_delete', { name }),
    revealVault: (name) => invoke('kb_vault_reveal', { name }),
    sync: (name) => invoke('kb_sync', { name }),

    cards: (name) => invoke('kb_cards', { name }),
    cardRead: (name, rel) => invoke('kb_card_read', { name, rel }),
    cardSetStatus: (name, rel, status) => invoke('kb_card_set_status', { name, rel, status }),
    cardSetArchived: (name, rel, archived) =>
      invoke('kb_card_set_archived', { name, rel, archived }),
    cardDelete: (name, rel) => invoke('kb_card_delete', { name, rel }),

    search: (name, query) => invoke('kb_search', { name, query }),

    sources: (name) => invoke('kb_sources', { name }),
    sourceAdd: (name) => invoke('kb_source_add', { name }),
    sourceDelete: (name, rel, deleteGenerated) =>
      invoke('kb_source_delete', { name, rel, deleteGenerated }),

    async generate(name, sourceRels, cli, note, onEvent: GenListener) {
      // ⚠️ 一次通信一个新通道（见 createChannel 的头注释：复用会把回调打死）
      const channel = await createChannel<GenEvent>(onEvent);
      return invoke('kb_generate', { name, sourceRels, cli, note, channel });
    },
    cancelGenerate: (name, runId) => invoke('kb_generate_cancel', { name, runId }),
    runs: (name, sourceRel) => invoke('kb_runs', { name, sourceRel }),

    async fileRead(name, target) {
      // 和 tasks 的附件缩略图同一条路：Rust 返回原始字节，浏览器侧归一化。
      const raw = await invoke<ArrayBuffer | number[] | Uint8Array>('kb_file_read', {
        name,
        target,
      });
      if (raw instanceof ArrayBuffer) return raw;
      if (raw instanceof Uint8Array) {
        return raw.buffer.slice(
          raw.byteOffset,
          raw.byteOffset + raw.byteLength
        ) as ArrayBuffer;
      }
      return new Uint8Array(raw).buffer;
    },

    cliProbe: () => invoke('kb_cli_probe'),
  };
}
