/**
 * 「接口调试」的服务层接口。
 *
 * 和另外几个模块一样：这里只有**接口**，实现分 `tauri.ts` / `web.ts` 两份，
 * 由 `index.ts` 按运行环境挑一份。
 *
 * # 这里只有**一个**方法，是刻意的
 *
 * 助手那边有六个命令（发消息、答审批、停止、清空……），因为一次 run 是
 * 一个长过程，中途要能插话。请求不一样：**发出去 → 收完**，中间没有决策点。
 * 所以只有一个 `send` —— 而它的事件流里也不会有需要前端回答的东西。
 */

import type { RedirectInfo, RequestOptions } from '../core/types';

/**
 * 一次请求往前端推的事件。
 *
 * ⚠️ **形状必须和 Rust 的 `RequestEvent` 一字不差**
 *（`request_commands.rs`，`#[serde(tag = "kind", rename_all = "camelCase",
 * rename_all_fields = "camelCase")]`）。这条缝两端的测试结构性地盖不到
 *（浏览器版走假实现、Rust 那边直接构造结构体），所以 Rust 侧有一组
 * `contract` 测试**手写字段名**钉着它 —— 和 SSH 的 `contract_*` 是同一套办法。
 */
export type RequestEvent =
  | {
      kind: 'started';
      status: number;
      reason: string;
      headers: Array<[string, string]>;
      finalUrl: string;
      redirects: RedirectInfo[];
      httpVersion: string;
      /** 从点发送到响应头到手（含建连和 TLS）。 */
      elapsedMillis: number;
    }
  | { kind: 'chunk'; base64: string }
  | {
      kind: 'finished';
      /** 实际交到前端手上的字节数。 */
      bytes: number;
      /** 撞上了那个 2 MiB 的转发上限。 */
      truncated: boolean;
      totalMillis: number;
    }
  | {
      kind: 'failed';
      /** 传输层给的大类：`invalid` / `connect` / `tls` / `timeout` / `idle` /
       *  `redirect` / `protocol` / `body`。 */
      errorKind: string;
      message: string;
      /** 出错之前已经收到的字节数（正文读了一半才断的那种）。 */
      bytes: number;
    };

/** 发一个请求要什么。 */
export interface SendRequest {
  /** 方法名。**不设白名单**（`PROPFIND` 这类扩展方法照发）。 */
  method: string;
  /** 完整地址。这一层**不做任何补全**（见 `core/draft.ts`）。 */
  url: string;
  /** 已经筛过的头（没启用的前端就不发了）。 */
  headers: Array<[string, string]>;
  /** 请求体。空串 = 不带 body。 */
  body: string;
  /** 可调项。字段名和 Rust 的 `OptionsSpec` 一一对应（不用再映射一遍）。 */
  options: RequestOptions;
  /** 事件回调。**边跑边来**，不是攒完一次性给。 */
  onEvent: (event: RequestEvent) => void;
}

export interface RequestClient {
  /**
   * 发一个请求。
   *
   * ⚠️ 返回的 Promise **一直等到整个请求结束**（响应体读干、或者出错）——
   * 和助手那个「起跑就返回 run 编号」不一样。所以调用方**不要 await 它**，
   * 事件照收，等它 settle 只是拿一个「这一趟彻底结束了」的信号。
   *
   * ⚠️ 它 reject 只有一种情况：**命令根本没跑起来**（比如前端少发了一个字段，
   * serde 反序列化失败）。请求本身的失败是事件（`failed`），不是 reject ——
   * 这一条和 SSH 那边「主机密钥的两种拒绝走 `Ok`」是同一条分工。
   */
  send(request: SendRequest): Promise<void>;
}
