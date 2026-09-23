/**
 * 助手模块的服务层接口。
 *
 * 和另外几个模块一样：这里只放**接口**，实现分 `tauri.ts` / `web.ts` 两份，
 * 由 `index.ts` 按运行环境挑一份。
 */

import type { ProviderConfig, ProviderKind } from '../core/config';

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
  /**
   * **这份配置**的 key 配到什么程度了。
   *
   * ⚠️ 收的是配置 id 而不是提供方 —— key 挂在**配置**上：同一家可以有好几份
   *（「工作用 Anthropic」「自己的 Anthropic」），按提供方存会让它们互相顶掉。
   */
  keyStatus(profileId: string): Promise<AssistantKeyStatus>;

  /**
   * 存一把 key。**空串 = 删掉**。
   *
   * ⚠️ **没有对应的「读回来」** —— 这是和连接密码故意不一样的地方：
   * 密码要回填进编辑框让用户改，而 key 只需要「换一把」。
   * 少一个读接口，就少一条密钥经过 webview 的路。
   */
  setApiKey(profileId: string, key: string): Promise<void>;

  /**
   * 把**老版按提供方命名的凭据**搬到**按配置命名的条目**上（升级用）。
   *
   * ⚠️ **幂等，可以反复调。** 调用方什么都不用记：只在这份配置「还没有 key
   * 且它正是从旧版迁过来的那一份」时才调它，搬没搬成从 `keyStatus` 看得出来。
   * 于是「搬到一半崩了」「钥匙串当时锁着」都能在下次自动重试。
   *
   * 为什么在 Rust 侧做：前端**拿不到 key 的值**（只写不读）。搬法（读来源 →
   * 写目标 → 删来源）在 Rust 的 `plan_key_move` 里，有穷举测试。
   */
  migrateApiKey(fromKind: ProviderKind, toProfileId: string): Promise<void>;

  /**
   * 发一句话，跑一次。
   *
   * 事件**边跑边推**（`onEvent`），函数本身在**起跑之后**就返回这次 run 的编号 ——
   * 不要 await 到跑完（一次 run 可能好几分钟，而且中途要等用户点审批）。
   *
   * 返回的编号用来 [`AssistantClient.cancel`]；审批那一条事件的
   * `key.run` 是同一个值。
   */
  send(request: SendRequest): Promise<number>;

  /**
   * 回答一条审批。
   *
   * 返回 `false` 表示这条审批**已经不存在了**（超时 / 被取消 / 重复点击）——
   * ⚠️ 那是**一个明确的契约，不是错误**：上层该做的是什么都不做，
   * 而不是弹一个报错。
   */
  approve(run: number, call: string, decision: ApprovalDecision): Promise<boolean>;

  /**
   * 停止一次 run。
   *
   * ⚠️ 停止**不是**「拒绝这次审批」：拒绝只让模型换个做法继续跑，
   * 停止是整个 run 结束。这个区别用户感知很强 ——
   * 点了停止还在花钱是最糟的一类 bug。
   */
  cancel(run: number): Promise<void>;

  /**
   * 忘掉一个会话的历史（用户点了「清空」）。
   *
   * ⚠️ 清空**必须**连历史一起清：只清屏幕的话，界面上空了、模型还记得，
   * 下一句它会接着说上一句的事 —— 那比不清更让人困惑。
   */
  clearSession(session: string): Promise<void>;

  /**
   * 试一下这套配置通不通（用户点「测试连接」）。
   *
   * ⚠️ 它是**一次往返**，不是流式 —— 用户点它是为了立刻知道结果。
   * 而且它**不走 Channel**：用户卡住的时候，「界面收不到事件」和
   * 「网络根本不通」是两回事，而走 Channel 的话这两种会表现成同一个样子
   * （都卡着、都不报错）。一个直接返回结果的命令才能把它们分开。
   */
  testConnection(config: ProviderConfig, profileId: string): Promise<ConnectionReport>;
}

/**
 * 试出来的结果。
 *
 * 文案是**成品**（Rust 侧拼好的）—— 这一层不再加工，直接显示。
 */
export interface ConnectionReport {
  /** 通没通。 */
  ok: boolean;
  /** 花了多少毫秒。 */
  millis: number;
  /** 一句话。 */
  message: string;
  /**
   * 模型真回了什么（成功时才有）。
   *
   * ⚠️ 它不是装饰：只显示「成功」的话，用户没法分辨自己是不是被中间设备骗了
   * （有的企业代理会回一个 200 然后什么也不给）。
   */
  reply: string;
}

/** 一次 run 的结局。 */
export type RunStatus =
  | { kind: 'completed'; reason: string }
  | { kind: 'aborted'; reason: AbortReason }
  | { kind: 'cancelled' }
  | { kind: 'failed'; message: string };

/**
 * 为什么中止。
 *
 * ⚠️ 字段名要和 Rust 那边对得上（`loop_runner.rs` 的 `AbortReason`）——
 * 这条缝两端的测试都盖不到，所以 Rust 侧有一组 `contract_*` 测试钉着它。
 */
export type AbortReason =
  | { kind: 'iterationsExhausted'; limit: number }
  | { kind: 'budgetExhausted'; used: number; budget: number }
  | { kind: 'stuckOnRepeatedCall'; signature: string; times: number }
  | { kind: 'refused' }
  | { kind: 'retriesExhausted'; limit: number };

/** 一次审批的键（回答的时候要带回去）。 */
export interface ApprovalKey {
  run: number;
  call: string;
}

/** 用户对一次审批的回答。 */
export type ApprovalDecision = 'allow' | 'deny' | 'session';

/** 审批的结果（事件里回带的那份）。 */
export type ApprovalOutcome = 'notNeeded' | 'allowed' | 'denied' | 'cancelled';

/** 一次 run 里每一轮的用量。 */
export interface Usage {
  uncachedInput: number;
  cacheRead: number;
  cacheCreation5m: number;
  cacheCreation1h: number;
  output: number;
}

/**
 * 循环推上来的事件。
 *
 * ⚠️ **形状必须和 Rust 的 `RunEvent` 一字不差**（那边是
 * `#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]`）。
 * 这条缝是出过事的地方（见 HANDOFF 里 `rename_all_fields` 那一节），
 * 所以 Rust 侧有一组 `contract_*` 测试**手写字段名**钉着它。
 */
export type AssistantEvent =
  | { kind: 'iteration'; n: number }
  | { kind: 'textDelta'; text: string }
  | { kind: 'thinkingDelta'; text: string }
  | { kind: 'toolRequested'; name: string; display: string }
  | {
      kind: 'approvalNeeded';
      key: ApprovalKey;
      tool: string;
      display: string;
      /** 要不要给「记住」这个选项。见 `PreparedCall::needs_approval`。 */
      canRemember: boolean;
    }
  | { kind: 'approvalDecided'; key: ApprovalKey; decision: ApprovalOutcome }
  | { kind: 'toolFinished'; name: string; isError: boolean; content: string }
  | { kind: 'turnFinished'; stopReason: string; usage: Usage }
  | { kind: 'retrying'; attempt: number; reason: string }
  /** 这次 run 结束了。**一定是最后一条。** */
  | { kind: 'finished'; status: RunStatus; usage: Usage; iterations: number };

/** 发一句话要什么。 */
export interface SendRequest {
  /**
   * 会话标识。
   *
   * ⚠️ **同一个 `session` 的几次 send 共享历史**，换了它就是从零开始
   * （`assistant_clear_session` 清的就是它）。不传的话每一句都是独立的问题，
   * 模型看不到上一句。
   */
  session: string;
  /** 在哪个目录里干活（绝对路径）。 */
  workspace: string;
  prompt: string;
  config: ProviderConfig;
  /**
   * 用哪一份**配置**的 key（key 挂在配置上，不挂在提供方上）。
   *
   * ⚠️ 和 `config` 分开传是刻意的：`config` 是 IPC 那三个字段的契约（Rust 那边
   * 用它建 provider），而 id 只用来定位钥匙串条目 —— 两者混在一起会让
   * 「配置的形状」和「凭据的名字」纠缠，将来各自要变时互相绊住。
   */
  profileId: string;
  /**
   * 上下文策略。
   *
   * 用 `ContextStrategy::as_str` 的短名（`full` / `rolling:20` / …）——
   * 认不出来的话 Rust 侧会**报错**而不是退回全量（静默退回的话，
   * 用户以为在用滚动、账单会替他发现问题）。
   */
  strategy: string;
  /** 事件回调。**边跑边来**，不是攒完一次性给。 */
  onEvent: (event: AssistantEvent) => void;
}
