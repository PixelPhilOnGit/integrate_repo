/**
 * 本地终端的服务：在**本机**起一个 shell。
 *
 * # 为什么单独一个 client，而不是往 `SshClient` 里塞分支
 *
 * 两者只有「字节从哪来」不同，但**契约的形状**差得很远：SSH 的 `open` 要处理
 * 主机密钥那三种结局、要传凭据、要报告指纹；本地终端什么都没有 —— 它只有
 * 「起来了」和「起不来」。合成一个接口的话，本地终端那边得凭空实现一堆
 * 用不上的分支（而且每次加参数都会发现「这个对本地没意义」）。
 *
 * 上层（store）按档案的 `kind` 选一个 client 调，共用的部分是**事件形状**
 * （`SshEvent`）—— 所以终端、命令块、标签栏那些一行都不用改。
 */

import { createChannel, invoke } from '../../../shared/platform/invoke';
import { createFakeShell, type FakeShell } from '../core/fakeSsh';
import type { SshEvent } from '../core/types';
import type { LocalClient, LocalOpenRequest } from './types';

const encoder = new TextEncoder();

/**
 * Rust 那边推上来的事件形状（`devtoolkit_agents::PtyEvent`）。
 *
 * ⚠️ **不能直接复用 `TerminalEvent`**：那个的 `exit` 带一句 `reason`（SSH 的
 * 契约，远端断开有原因可讲），而 pty 的 Exit 只有一个退出码 —— 拿 SSH 那个类型
 * 去标它，等于在类型上撒一个运行时对不上的谎。
 */
type PtyUiEvent = { kind: 'data'; bytes: string } | { kind: 'exit'; code: number | null };

/**
 * 桌面端：走 Rust 的 `local_*` 命令。
 *
 * Rust 那边**复用智能体会话那套 PTY**（起进程、流字节、关掉时杀整棵进程树，
 * Windows 上还有 Job Object 兜底），只是换了一张会话表 ——
 * 见 `src-tauri/src/local_commands.rs` 的模块注释。
 */
export function createTauriLocalClient(): LocalClient {
  /**
   * 写的串行链。和 SSH 那边同一条约定：`local_write` 每次是独立的 invoke，
   * 不串行化的话两次未 await 的调用到达顺序不保证 —— 打字会乱序成 `sl`。
   */
  let writes: Promise<unknown> = Promise.resolve();

  return {
    async open(request: LocalOpenRequest): Promise<void> {
      // ⚠️ 每次 open 都新建通道：Rust 侧把通道丢掉时会往 JS 发 `{end: true}`，
      // JS 收到就把 onmessage 注销 —— 复用同一个对象的话，第二次连上会
      // 一片空白而且不报错（SSH 那边踩过同一个坑，见它的注释）
      const channel = await createChannel<PtyUiEvent>((event) => {
        request.onEvent(decode(event));
      });

      await invoke<void>('local_open', {
        id: request.id,
        shell: request.shell,
        cols: request.cols,
        rows: request.rows,
        channel,
      });
    },

    write(id: string, data: Uint8Array): Promise<void> {
      const next = writes
        .catch(() => undefined)
        .then(() => invoke<void>('local_write', { id, bytes: encode(data) }));
      writes = next;
      return next;
    },

    async resize(id: string, cols: number, rows: number): Promise<void> {
      await invoke<void>('local_resize', { id, cols, rows });
    },

    async close(id: string): Promise<void> {
      await invoke<void>('local_close', { id });
    },

    async closeAll(): Promise<void> {
      await invoke<void>('local_close_all');
    },
  };
}

/**
 * 浏览器端：**复用那份假 shell**。
 *
 * 不另写一个假的本地 shell：那等于把「行规程、命令历史、内存文件系统」在
 * 浏览器里再实现一遍，而且两份假实现迟早分叉（e2e 就会在一个和真实现行为
 * 不一致的东西上通过）。本地 terminal 和远端 terminal 在**界面这一侧**本来
 * 就是同一个东西 —— 假实现也该是同一个。
 *
 * 只有提示符里的 `user@host` 换成了 `devtoolkit@local`（写 `root@127.0.0.1`
 * 会让人以为自己在看一个远端会话）。
 */
export function createWebLocalClient(): LocalClient {
  const sessions = new Map<string, FakeShell>();

  return {
    async open(request: LocalOpenRequest): Promise<void> {
      // 测试钩子（只在开发构建里挂）：**参数有没有真的传下来**是这条链路上
      // 唯一没法从界面断言的事 —— 假 shell 不关心自己叫什么名字，所以
      // 「选了 cmd」在浏览器里看不出任何区别。真机上的差别归 Rust 那组测试
      if (import.meta.env.DEV && typeof window !== 'undefined') {
        const w = window as unknown as { __sshLocalRequests?: Array<{ shell: string }> };
        (w.__sshLocalRequests ??= []).push({ shell: request.shell });
      }

      // 同 id 再开一次是替换 —— 和 Rust 那边语义一致
      sessions.get(request.id)?.close();
      sessions.delete(request.id);

      const shell = createFakeShell({
        user: 'devtoolkit',
        host: 'local',
        emit: (text) => {
          request.onEvent({ kind: 'data', bytes: encoder.encode(text) });
        },
        onExit: (code) => {
          sessions.delete(request.id);
          request.onEvent({ kind: 'exit', code, reason: '已退出' });
        },
      });
      sessions.set(request.id, shell);
    },

    async write(id: string, data: Uint8Array): Promise<void> {
      sessions.get(id)?.write(new TextDecoder().decode(data));
    },

    async resize(): Promise<void> {
      // 假 shell 不做列宽（和 SSH 那边的假实现同一条），尺寸对它没有意义
    },

    async close(id: string): Promise<void> {
      sessions.get(id)?.close();
      sessions.delete(id);
    },

    async closeAll(): Promise<void> {
      for (const shell of sessions.values()) shell.close();
      sessions.clear();
    },
  };
}

// ------------------------------------------------------------------ 编解码

/** 和 SSH 那边同一套：分块再拼，避免参数太多爆栈 */
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
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * 把 Rust 的 `PtyEvent` 翻译成应用层事件。
 *
 * ⚠️ **`reason` 是我们补的**：智能体会话那边的 Exit 只有退出码（它有自己的
 * 状态机去解释），而 SSH 这边的事件契约要求一句人话（`endedReason` 直接显示在
 * 标签上）。本地终端没有「远端断开」这类原因，所以只有「已退出」一种。
 */
function decode(event: PtyUiEvent): SshEvent {
  return event.kind === 'data'
    ? { kind: 'data', bytes: decodeBase64(event.bytes) }
    : { kind: 'exit', code: event.code, reason: '已退出' };
}
