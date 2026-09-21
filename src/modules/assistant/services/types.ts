/**
 * 助手模块的服务层接口。
 *
 * 和另外几个模块一样：这里只放**接口**，实现分 `tauri.ts` / `web.ts` 两份，
 * 由 `index.ts` 按运行环境挑一份。
 */

import type { ProviderKind } from '../core/config';

/** API key 配到什么程度了。 */
export interface AssistantKeyStatus {
  /**
   * 这台机器上**有没有可用的钥匙串**。
   *
   * ⚠️ 和「配没配 key」是两件事，必须分开：
   * * `available === false` —— 这台机器根本没有钥匙串（headless、服务器、
   *   浏览器版）。界面要**明说**，因为它意味着 key 只能明文存在别处。
   * * `available === true && configured === false` —— 一切正常，就是还没填。
   *
   * 混成一个的话，上层没法决定「是提醒用户去填，还是该警告他这台机器存不住」。
   */
  available: boolean;
  /** 配过 key 没有。 */
  configured: boolean;
}

export interface AssistantClient {
  /** 这个提供方的 key 配到什么程度了。 */
  keyStatus(kind: ProviderKind): Promise<AssistantKeyStatus>;

  /**
   * 存一把 key。
   *
   * ⚠️ **没有对应的「读回来」** —— 这是和连接密码故意不一样的地方：
   * 密码要回填进编辑框让用户改，而 key 只需要「换一把」。
   * 少一个读接口，就少一条密钥经过 webview 的路。
   */
  setApiKey(kind: ProviderKind, key: string): Promise<void>;
}
