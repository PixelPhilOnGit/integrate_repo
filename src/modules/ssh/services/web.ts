/**
 * 浏览器端的 SSH 客户端：内存假实现。
 *
 * 不是「顺便支持一下浏览器」—— headless 环境里起不了原生窗口，Playwright
 * 只能驱动普通 Chromium 里的前端，**这个实现是整条自动化验证链路的前提**。
 *
 * 假 shell 本身在 `core/fakeSsh.ts`（纯逻辑、可单测，真的维护当前目录、
 * 命令行缓冲、历史和一个内存文件系统）。这里只做**连接层**的事：
 * 连不上、主机密钥、认证，然后把 shell 接起来。
 *
 * # 它和真实现的分工必须一模一样，否则 e2e 是自欺
 *
 * 尤其是**主机密钥那三种结局**：假实现必须像真实现一样，在没信任过的时候
 * 回 `hostKeyUnknown` 而不是直接连上 —— 否则 TOFU 那条链路在浏览器里
 * 根本没被走过一遍。
 *
 * # 这里不实现 resize
 *
 * 真实终端里折行是终端模拟器（xterm）的事，远端只收尺寸。假 shell 不做列宽，
 * 所以尺寸对它没有意义。**这条路径由 Rust 那组打真服务端的测试覆盖**
 * （`stty size` 那条），浏览器这边刻意不假装测过。
 */

import {
  authFailure,
  connectFailure,
  createFakeShell,
  fakeAlgorithm,
  fakeFingerprint,
  type FakeShell,
} from '../core/fakeSsh';
import type { SshEvent, SshOpenOutcome } from '../core/types';
import type { SshClient, SshOpenRequest } from './types';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface Session {
  shell: FakeShell;
  /** 事件出口。存在会话上，是因为 shell 自己**退出**时（用户敲了 `exit`）
   *  还要靠它把结局报上去 —— 那时候 `open` 那个作用域早就结束了 */
  onEvent: (event: SshEvent) => void;
}

export function createWebSshClient(): SshClient {
  const sessions = new Map<string, Session>();

  return {
    async open(request: SshOpenRequest): Promise<SshOpenOutcome> {
      const address = `${request.host}:${request.port}`;

      // 同 id 再开一次是替换 —— 和 Rust 侧语义一致。
      // 旧的那个先收掉，否则会留下一个谁也够不着的 shell 在内存里
      sessions.get(request.id)?.shell.close();
      sessions.delete(request.id);

      // ---------------------------------------------------------- 连不上
      const failure = connectFailure(request.host, request.port);
      if (failure !== null) {
        throw new Error(failure);
      }

      // ---------------------------------------------------------- 主机密钥
      //
      // 判定顺序和 Rust 侧必须一致：主机密钥在**认证之前**（真实的 SSH 就是
      // 这样，密钥交换在认证前面）。所以「这台机器没见过」且密码也填错了时，
      // 先报的是「没见过这台机器」。
      const algorithm = fakeAlgorithm();
      const actual = fakeFingerprint(request.host, request.port);
      const expected = request.expectedFingerprint;

      if (expected === null && !request.acceptNewHostKey) {
        return {
          kind: 'hostKeyUnknown',
          host: request.host,
          port: request.port,
          algorithm,
          fingerprint: actual,
        };
      }

      if (expected !== null && expected !== actual) {
        return {
          kind: 'hostKeyMismatch',
          host: request.host,
          port: request.port,
          algorithm,
          expected,
          actual,
        };
      }

      // ---------------------------------------------------------- 认证
      const password = request.auth.kind === 'password' ? request.auth.password : '';
      const rejected = authFailure(request.username, password, request.auth.kind);
      if (rejected !== null) {
        throw new Error(rejected);
      }

      // ---------------------------------------------------------- 起 shell
      const session: Session = {
        onEvent: request.onEvent,
        shell: createFakeShell({
          user: request.username,
          host: request.host,
          emit: (text) => {
            request.onEvent({ kind: 'data', bytes: encoder.encode(text) });
          },
          onExit: (code) => {
            // 先删掉再报事件：上层收到 exit 时 `sessions` 已经干净了，
            // 不会出现「已经退出但 close 还能找到它」的中间状态
            sessions.delete(request.id);
            request.onEvent({ kind: 'exit', code, reason: '已退出' });
          },
        }),
      };
      sessions.set(request.id, session);

      return {
        kind: 'ready',
        address,
        username: request.username,
        fingerprint: actual,
        algorithm,
      };
    },

    async write(id: string, data: Uint8Array): Promise<void> {
      sessions.get(id)?.shell.write(decoder.decode(data));
    },

    async resize(): Promise<void> {
      // 刻意什么都不做，理由见文件头部
    },

    /**
     * 主动关掉。
     *
     * **刻意不报 exit 事件** —— 和真后端一致：Rust 侧的 `ssh_close` 会把读循环
     * abort 掉，事件流随之结束，不会再补一条 Exit。这是「用户自己关的，
     * 他当然知道关了」，由 store 在本地把会话标记成已关闭就行，
     * 再从流里回一条事件反而多一次没有信息量的往返。
     */
    async close(id: string): Promise<void> {
      const session = sessions.get(id);
      if (session === undefined) return;
      sessions.delete(id);
      session.shell.close();
    },

    async closeAll(): Promise<void> {
      for (const session of sessions.values()) {
        session.shell.close();
      }
      sessions.clear();
    },
  };
}
