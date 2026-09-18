/**
 * 桌面端的智能体会话客户端：走 Rust command。
 *
 * 持久化不在这里 —— 那是 `shared/platform/kv.ts` 的事。这个文件只负责
 * 「把命令发给后端的进程内核」，外加两件**只有这条路上才需要**的事：
 * base64 编解码、把并发写串行化。
 *
 * 形状是照着 `modules/ssh/services/tauri.ts` 写的 —— 那条路已经踩过坑了
 * （通道一次性、写要串行），没必要再踩一遍。
 */

import { createChannel, invoke } from '../../../shared/platform/invoke';
import type { PtyChannelEvent } from '../core/types';
import type { AgentsClient, EventFile, PtyOpenRequest } from './types';

export function createTauriAgentsClient(): AgentsClient {
  /**
   * 写的串行链。
   *
   * `agent_write` 每次是独立的 invoke，两次未 await 的调用**到达顺序不保证** ——
   * 打字会乱序成 `sl`。这条链保证「调用顺序 = 到达顺序」。
   *
   * 失败要吞掉再继续：一次写失败（会话已经没了）不该让后面所有的写都跟着失败，
   * 那会把「终端已经退出」这件小事放大成「键盘整个失灵」。
   */
  let writes: Promise<unknown> = Promise.resolve();

  return {
    async open(request: PtyOpenRequest): Promise<void> {
      // ⚠️ **每次 open 都新建一个通道。** Rust 侧把通道丢掉时会往 JS 发一条
      // `{end: true}`，JS 收到就把 `onmessage` 注销 —— 复用通道对象的话，
      // 第二次开会话时终端会一片空白**而且不报错**（见 shared/platform/invoke.ts）
      const channel = await createChannel<PtyChannelEvent>((event) => {
        request.onEvent(decode(event));
      });

      await invoke<void>('agent_open', {
        id: request.id,
        config: {
          cwd: request.cwd,
          shell: request.shell,
          command: request.command,
          cols: request.cols,
          rows: request.rows,
          env: request.env,
        },
        channel,
      });
    },

    write(id: string, data: Uint8Array): Promise<void> {
      const next = writes
        .catch(() => undefined)
        .then(() => invoke<void>('agent_write', { id, bytes: encode(data) }));
      writes = next;
      return next;
    },

    async resize(id: string, cols: number, rows: number): Promise<void> {
      await invoke<void>('agent_resize', { id, cols, rows });
    },

    async close(id: string): Promise<void> {
      await invoke<void>('agent_close', { id });
    },

    async closeAll(): Promise<void> {
      await invoke<void>('agent_close_all');
    },

    async takeEvents(): Promise<EventFile[]> {
      return invoke<EventFile[]>('agent_take_events');
    },

    async eventsDir(): Promise<string> {
      return invoke<string>('agent_events_dir');
    },
  };
}

// ------------------------------------------------------------------ base64

/**
 * 分块再拼。
 *
 * 不能直接 `String.fromCharCode(...bytes)` —— 参数太多会爆栈，而粘贴一大段
 * 文本（几百 KB）正好会踩到。分块之后每块三万多个参数，安全。
 */
function encode(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function decodeBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

/** 把 IPC 的事件翻译成应用层的形状。base64 到这一层为止 */
function decode(event: PtyChannelEvent): { kind: 'data'; bytes: Uint8Array } | { kind: 'exit'; code: number | null } {
  return event.kind === 'data'
    ? { kind: 'data', bytes: decodeBase64(event.bytes) }
    : { kind: 'exit', code: event.code };
}
