/**
 * 浏览器实现（内存假实现，给 e2e 和 `npm run dev` 用）。
 *
 * ⚠️ **语义必须和 Rust 那边一模一样**，否则 e2e 是假绿、真机全是 bug ——
 * 这个仓库在这条上反复栽过（见 `tasks/services/web.ts` 头部的说明）。
 * 具体要对上的是**事件的顺序和形状**：
 *
 * ```
 * iteration → textDelta… → toolRequested → [approvalNeeded → approvalDecided]
 *           → toolFinished → … → finished     ← finished 一定是最后一条
 * ```
 *
 * 这里唯二"和 Rust 不同"的地方：
 *
 * * `available` 恒为 `false` —— 浏览器**没有钥匙串**。这不是偷懒，是事实
 *   （`shared/platform/secrets.ts` 也这么报），界面因此会挂一个警告。
 * * 干活的是这段假流程，不是真模型 —— 所以它**按 `prompt` 里的关键词决定**
 *   要不要走写文件那条路（那会让审批弹层出现）。e2e 靠这个驱动。
 */

import { validateConfig } from '../core/config';
import type { ProviderConfig, ProviderKind } from '../core/config';
import type {
  AssistantClient,
  AssistantEvent,
  AssistantKeyStatus,
  ApprovalDecision,
  ConnectionReport,
  SendRequest,
} from './types';

/**
 * 假钥匙串：**按配置 id** 存（和真实现一样 —— key 挂在配置上）。
 *
 * ⚠️ 从 `Map<ProviderKind, string>` 改过来的。旧版按提供方存，同一家的两份配置
 * 会互相顶掉；e2e 里「两份配置各有一把 key」那条就是钉这个的。
 */
const keys = new Map<string, string>();

/**
 * 老版本按**提供方**命名的那一份 —— 只为了让 e2e 跑得到「升级搬迁」那条路。
 *
 * ⚠️ 这是浏览器版**唯一**主动模拟旧数据的地方：真机上那个老条目躺在系统钥匙串
 * 里（前端根本看不到），而这里得有个东西可搬，否则 `migrateApiKey` 那条路
 * 在 e2e 里永远是空转。
 */
const legacyKeys = new Map<ProviderKind, string>();

/** 假 agent 的节奏。够慢到能看见流式效果，又不至于拖慢 e2e。 */
const TICK = 12;

const ZERO_USAGE = {
  uncachedInput: 0,
  cacheRead: 0,
  cacheCreation5m: 0,
  cacheCreation1h: 0,
  output: 0,
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 一次假 run 的运行期状态。 */
interface FakeRun {
  /** 用户按了停止。 */
  cancelled: boolean;
  /** 已经发过 `finished` 了（它只该发一次）。 */
  done: boolean;
  /** 挂着的审批：call id → 回答的回调。 */
  waiting: Map<string, (d: ApprovalDecision) => void>;
}

const runs = new Map<number, FakeRun>();
let nextRun = 1;

/**
 * 每个会话聊到第几轮了。
 *
 * ⚠️ 真实现那边「历史接上了」靠的是把上一轮的 `history` 发给模型，浏览器版
 * 没有模型，所以这里用一个**看得见的代理**：第一句之后的每一句，回复开头
 * 会多一句「接着上面说」。这样 e2e 才能验出「清空之后 session 真的换了」——
 * 只清屏幕不清历史是个真 bug（界面上空了、模型还记得）。
 */
const sessions = new Map<string, number>();

export function createWebAssistantClient(): AssistantClient {
  return {
    async keyStatus(profileId: string): Promise<AssistantKeyStatus> {
      // 浏览器**没有钥匙串**，所以 available 恒为 false。这不是偷懒，是事实 ——
      // 界面因此会挂一个「存不住」的警告（`assistant-no-keychain`）。
      return { available: false, configured: keys.has(profileId) };
    },

    async migrateApiKey(fromKind: ProviderKind, toProfileId: string): Promise<void> {
      // 和 Rust 侧 `plan_key_move` 同一套语义：读来源 → 写目标（非空就不写）→ 删来源。
      // 目标已经有值就**不覆盖** —— 那可能是用户后来自己填的一把。
      const source = legacyKeys.get(fromKind);
      if (source === undefined) return;
      if (!keys.has(toProfileId)) keys.set(toProfileId, source);
      legacyKeys.delete(fromKind);
    },

    async setApiKey(profileId: string, key: string): Promise<void> {
      const trimmed = key.trim();
      // 空串 = 删掉（和 Rust 那边一致：空 key 存进去等于没配）
      if (trimmed === '') keys.delete(profileId);
      else keys.set(profileId, trimmed);
    },

    async send(request: SendRequest): Promise<number> {
      const run = nextRun++;
      runs.set(run, { cancelled: false, done: false, waiting: new Map() });
      // 故意**不 await** —— 和真实现一样：起跑就返回，事件边走边推。
      void drive(run, request);
      return run;
    },

    async approve(
      run: number,
      call: string,
      decision: ApprovalDecision,
    ): Promise<boolean> {
      // ⚠️ 返回 `false` 是**契约不是错误**：这条审批已经不存在了
      // （超时 / 取消 / 重复点击）。和 `Gate::answer` 一个字不差。
      const state = runs.get(run);
      const resolve = state?.waiting.get(call);
      if (!state || !resolve) return false;
      state.waiting.delete(call);
      resolve(decision);
      return true;
    },

    async cancel(run: number): Promise<void> {
      const state = runs.get(run);
      // 停一个已经停下的东西不是错误（用户连点两下很正常）。
      if (!state || state.done) return;
      state.cancelled = true;
      // 挂着的审批要放掉，否则那个 await 永远不回。
      for (const [, resolve] of state.waiting) resolve('deny');
      state.waiting.clear();
      // ⚠️ **立刻**收尾，不是等下一个检查点 —— 用户点了停止，
      // 界面上就该马上停住。
      finishOnce(run, { kind: 'cancelled' });
    },

    async clearSession(session: string): Promise<void> {
      // 幂等：清一个不存在的会话不是错误。
      sessions.delete(session);
    },

    async testConnection(
      config: ProviderConfig,
      profileId: string,
    ): Promise<ConnectionReport> {
      // ⚠️ 真机上是**真的发一个最小请求**（见 `assistant_commands.rs`），
      // 这里只是把「几种结局」模拟出来，好让 e2e 走得到三条分支。
      //
      // 「填错了」那条要先判：它和 Rust 侧一样是**发请求之前**就拦下来的
      // （`ProviderConfig::validate`），别等模拟完网络再说。
      const problem = validateConfig(config);
      if (problem !== null) {
        return { ok: false, millis: 0, message: problem, reply: '' };
      }

      await sleep(120);

      if (!keys.has(profileId)) {
        return {
          ok: false,
          millis: 120,
          message: `还没配「${config.kind === 'anthropic' ? 'Anthropic' : 'OpenAI 兼容'}」的 API key`,
          reply: '',
        };
      }

      // 通了。`reply` 不是装饰：只显示「成功」的话，用户分不清自己是不是
      // 被中间设备骗了（有的代理回 200 然后什么也不给）。
      return {
        ok: true,
        millis: 120,
        message: '通了（120 毫秒）。key、地址、模型名都对得上。',
        reply: '好',
      };
    },
  };
}

/** `finished` 那条事件里的结局（从联合类型里摘出来，免得手抄一遍）。 */
type FinishedStatus = Extract<AssistantEvent, { kind: 'finished' }>['status'];

/** 把 `finished` 发出去，**只发一次**。 */
function finishOnce(run: number, status: FinishedStatus): void {
  const state = runs.get(run);
  const request = requests.get(run);
  if (!state || !request || state.done) return;
  state.done = true;
  request.onEvent({ kind: 'finished', status, usage: ZERO_USAGE, iterations: 1 });
  runs.delete(run);
  requests.delete(run);
}

/** 每个 run 的回调（`cancel` 的时候要用）。 */
const requests = new Map<number, SendRequest>();

/** 假 agent 的主流程。 */
async function drive(run: number, request: SendRequest): Promise<void> {
  requests.set(run, request);
  const state = runs.get(run);
  if (!state) return;

  const emit = (event: AssistantEvent): void => {
    // 停了之后就不再往外发了（Rust 那边也一样：取消是立刻返回）。
    if (!state.cancelled) request.onEvent(event);
  };

  // 第几轮了 —— 第二句起，开头带一句「接着上面说」，好让 e2e 看出
  // 「历史接上了」。真实现那边这件事是靠把上一轮的 history 发给模型做的。
  const round = (sessions.get(request.session) ?? 0) + 1;
  sessions.set(request.session, round);

  emit({ kind: 'iteration', n: 1 });
  await sleep(TICK);

  // 先吐两段字，让「正在打字」这件事看得见。
  const opener =
    round > 1 ? ['（接着上面说）', '我再看一眼。'] : ['我看看', '这个文件。'];
  for (const chunk of opener) {
    if (state.cancelled) return;
    emit({ kind: 'textDelta', text: chunk });
    await sleep(TICK);
  }

  // 一次读 —— 只读不问，**不该有审批**。
  emit({ kind: 'toolRequested', name: 'read_file', display: '读 a.txt' });
  await sleep(TICK);
  emit({
    kind: 'toolFinished',
    name: 'read_file',
    isError: false,
    content: '     1→hello\n',
  });

  // prompt 里带了「写」才走那条要审批的路。e2e 靠这个开关驱动。
  if (request.prompt.includes('写')) {
    const call = `call_${run}_1`;
    if (state.cancelled) return;

    emit({
      kind: 'approvalNeeded',
      key: { run, call },
      tool: 'write_file',
      display: '写入 out.txt（12 B）',
      canRemember: true,
    });

    const decision = await new Promise<ApprovalDecision>((resolve) => {
      state.waiting.set(call, resolve);
    });

    if (state.cancelled) return;

    const allowed = decision === 'allow' || decision === 'session';
    emit({
      kind: 'approvalDecided',
      key: { run, call },
      decision: allowed ? 'allowed' : 'denied',
    });
    emit({
      kind: 'toolFinished',
      name: 'write_file',
      isError: !allowed,
      content: allowed
        ? '已写入 out.txt（12 B）。'
        : '用户拒绝了这次操作。可以换个做法，或者先问问他想要什么。',
    });
  }

  if (state.cancelled) return;

  emit({ kind: 'textDelta', text: '好了。' });
  finishOnce(run, { kind: 'completed', reason: 'endTurn' });
}

/** 给 e2e 用的重置钩子（单 worker 串行跑，每个用例开始前清一次）。 */
export function __resetAssistantForTest(): void {
  keys.clear();
  legacyKeys.clear();
  runs.clear();
  requests.clear();
  sessions.clear();
  nextRun = 1;
}
