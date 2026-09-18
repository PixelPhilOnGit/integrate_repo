/**
 * 桌面端的 SSH 客户端：走 Rust command。
 *
 * 连接的持久化不在这里 —— 那是 `shared/platform/kv.ts` 的事，四个模块共用。
 * 这个文件只负责「把命令发给后端的 SSH 内核」，外加两件**只有这条路上才需要**
 * 的事：base64 编解码、和把并发写串行化。
 */

import { createChannel, invoke } from '../../../shared/platform/invoke';
import type { SshEvent, SshOpenOutcome, TerminalEvent } from '../core/types';
import type { SshClient, SshOpenRequest } from './types';

export function createTauriSshClient(): SshClient {
  /**
   * 写的串行链。
   *
   * `ssh_write` 每次是独立的 invoke，两次未 await 的调用**到达顺序不保证** ——
   * 打字会乱序成 `sl`。这条链保证「调用顺序 = 到达顺序」，
   * 这正是接口里承诺的那条。
   *
   * 失败要吞掉再继续：一次写失败（比如会话已经没了）不该让后面所有的写
   * 都跟着失败 —— 那会把一个「终端已经退出」的小事放大成「键盘整个失灵」。
   */
  let writes: Promise<unknown> = Promise.resolve();

  return {
    async open(request: SshOpenRequest): Promise<SshOpenOutcome> {
      // ⚠️ **每次 open 都新建一个通道。**
      //
      // Rust 侧把通道丢掉时会往 JS 发一条 `{end: true}`，JS 收到就把
      // `onmessage` 注销。而任何在发消息之前就返回的 `ssh_open`
      // （TOFU 的第一次必然如此）都会走到那条路 —— 复用通道对象的话，
      // 用户点了「信任」重试，终端会一片空白**而且不报错**。
      const channel = await createChannel<TerminalEvent>((event) => {
        request.onEvent(decode(event));
      });

      return invoke<SshOpenOutcome>('ssh_open', {
        id: request.id,
        config: {
          host: request.host,
          port: request.port,
          username: request.username,
          auth: request.auth,
          term: request.term,
          cols: request.cols,
          rows: request.rows,
          expectedFingerprint: request.expectedFingerprint,
          acceptNewHostKey: request.acceptNewHostKey,
        },
        channel,
      });
    },

    write(id: string, data: Uint8Array): Promise<void> {
      const next = writes
        .catch(() => undefined)
        .then(() => invoke<void>('ssh_write', { id, bytes: encode(data) }));
      writes = next;
      return next;
    },

    async resize(id: string, cols: number, rows: number): Promise<void> {
      await invoke<void>('ssh_resize', { id, cols, rows });
    },

    async close(id: string): Promise<void> {
      await invoke<void>('ssh_close', { id });
    },

    async closeAll(): Promise<void> {
      await invoke<void>('ssh_close_all');
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
function decode(event: TerminalEvent): SshEvent {
  return event.kind === 'data'
    ? { kind: 'data', bytes: decodeBase64(event.bytes) }
    : { kind: 'exit', code: event.code, reason: event.reason };
}
