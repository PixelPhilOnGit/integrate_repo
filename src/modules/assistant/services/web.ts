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

import type { ProviderKind } from '../core/config';
import type {
  AssistantClient,
  AssistantEvent,
  AssistantKeyStatus,
  ApprovalDecision,
  SendRequest,
} from './types';

const keys = new Map<ProviderKind, string>();

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
    async keyStatus(kind: ProviderKind): Promise<AssistantKeyStatus> {
      return { available: false, configured: keys.has(kind) };
    },

    async setApiKey(kind: ProviderKind, key: string): Promise<void> {
      const trimmed = key.trim();
      // 空串 = 删掉（和 Rust 那边一致：空 key 存进去等于没配）
      if (trimmed === '') keys.delete(kind);
      else keys.set(kind, trimmed);
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
  runs.clear();
  requests.clear();
  sessions.clear();
  nextRun = 1;
}
