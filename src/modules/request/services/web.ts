/**
 * 浏览器端实现：一个**足够真的**假服务器（`core/fakeHttp.ts` 算计划，
 * 这里照着它把事件一条条推出来）。
 *
 * ⚠️ 它和真链路走的是**同一条前端路径**：一样的事件、一样的 base64 正文、
 * 一样的分块节奏。所以「流式解码」「收到一半断了」「撞上 2 MiB 上限」这些
 * 分支在 e2e 里都能真的跑到 —— 那正是这个文件存在的理由（浏览器版不是玩具，
 * headless 环境里 Playwright 只能靠它）。
 *
 * 不真的一样只有两处，都写在注释里：**空闲超时**（要等 90 秒，演不了）
 * 和**真的网络**（假实现当然不碰网）。
 */

import { textToBase64 } from '../core/body';
import { planFor } from '../core/fakeHttp';
import type { RequestClient, RequestEvent, SendRequest } from './types';

/**
 * 最多往界面里搬多少响应体。
 *
 * ⚠️ 这个数**必须和 Rust 侧那个一致**（`request_commands.rs` 的
 * `MAX_FORWARD_BYTES`）—— 它是两边共同遵守的一份契约：界面上那条
 * 「只显示了前 2 MiB」的横幅、以及「超了就停」的行为都靠它。
 * 不一样的话，浏览器版和真机的行为会分叉，而 e2e 验的是前者。
 */
export const MAX_FORWARD_BYTES = 2 * 1024 * 1024;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function createWebRequestClient(): RequestClient {
  return {
    async send(request: SendRequest): Promise<void> {
      const plan = planFor({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: request.body,
        options: request.options,
      });

      const emit = (event: RequestEvent): void => request.onEvent(event);
      const startedAt = Date.now();

      await sleep(plan.latencyMs);

      // 连响应头都没到就失败了（地址不合法 / 连不上 / 证书不对 / 超时）
      if (plan.head === null) {
        const f = plan.fail ?? { errorKind: 'connect', message: '连不上' };
        emit({ kind: 'failed', errorKind: f.errorKind, message: f.message, bytes: 0 });
        return;
      }

      emit({
        kind: 'started',
        status: plan.head.status,
        reason: plan.head.reason,
        headers: plan.head.headers,
        finalUrl: plan.head.finalUrl,
        redirects: plan.head.redirects,
        httpVersion: 'HTTP/1.1',
        elapsedMillis: Date.now() - startedAt,
      });

      const encoder = new TextEncoder();
      let bytes = 0;

      for (let i = 0; i < plan.chunks.length; i += 1) {
        // ⚠️ 先判「上一块之后就该断」，再决定发不发这一块 —— 和真链路上
        // 「连接被掐」的时序一致：用户拿到的是断点之前的那几块。
        if (plan.failAfterChunks !== null && i >= plan.failAfterChunks) {
          const f = plan.fail ?? { errorKind: 'body', message: '读到一半断了' };
          emit({ kind: 'failed', errorKind: f.errorKind, message: f.message, bytes });
          return;
        }

        const chunk = encoder.encode(plan.chunks[i] ?? '');
        if (bytes + chunk.length > MAX_FORWARD_BYTES) {
          // 和 Rust 一样「整块放不下就停手」（不是切一半发出去）
          emit({ kind: 'finished', bytes, truncated: true, totalMillis: Date.now() - startedAt });
          return;
        }
        bytes += chunk.length;

        await sleep(plan.chunkDelayMs);
        emit({ kind: 'chunk', base64: textToBase64(plan.chunks[i] ?? '') });
      }

      // ⚠️ 循环走完也要再判一次「计划里说之后要断」——
      // 断点正好落在最后一块之后（`/cut` 就是：一块正文，然后连接没了）时，
      // 只在循环里判的话会漏掉，把一条被截断的响应报成 `finished`。
      if (plan.failAfterChunks !== null) {
        const f = plan.fail ?? { errorKind: 'body', message: '读到一半断了' };
        emit({ kind: 'failed', errorKind: f.errorKind, message: f.message, bytes });
        return;
      }

      emit({ kind: 'finished', bytes, truncated: false, totalMillis: Date.now() - startedAt });
    },
  };
}
