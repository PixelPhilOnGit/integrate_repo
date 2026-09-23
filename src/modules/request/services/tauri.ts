/**
 * 桌面端实现：走 Tauri 命令 + `Channel`。
 *
 * 这个文件薄得几乎没有东西 —— 那是对的：请求怎么发、字节怎么读、
 * 跳转怎么跟，全在 `devtoolkit-request` 里（那个 crate 不依赖 tauri，
 * 所以它能脱离 WebKit 跑真 socket 的测试）。
 */

import { createChannel, invoke } from '../../../shared/platform/invoke';
import type { RequestClient, RequestEvent, SendRequest } from './types';

export function createTauriRequestClient(): RequestClient {
  return {
    async send(request: SendRequest): Promise<void> {
      // ⚠️ **一次请求一个新通道**，绝不跨调用复用。
      //
      // Rust 侧把通道丢掉时会往 JS 发一条 `{end: true}`，JS 收到就把回调
      // **注销** —— 之后的消息会全部石沉大海，而且不报错（SSH 和助手两轮
      // 各踩过一次，形状一模一样）。这里每次 send 都新建，所以不会有第二次
      // 机会踩到它。见 `shared/platform/invoke.ts` 的 `createChannel`。
      const channel = await createChannel<RequestEvent>((event) => {
        request.onEvent(event);
      });

      await invoke<null>('request_send', {
        spec: {
          method: request.method,
          url: request.url,
          headers: request.headers,
          body: request.body,
          options: request.options,
        },
        channel,
      });
    },
  };
}
