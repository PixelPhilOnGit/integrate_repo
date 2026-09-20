/**
 * 模块之间的一个**窄接口**：让别的模块能「把一件事交给某个 agent 会话」。
 *
 * # 为什么需要它（以及它为什么长这样）
 *
 * 任务模块要能把一条任务**派给**某个会话、并在那个会话结束时**回写**一条进度。
 * 但现有规矩是「模块之间不通过外壳通信」—— 直接 `import` 智能体会话的 store
 * 会把两个模块焊死（任务模块就得知道分屏、状态机、事件目录那些它根本用不上的东西）。
 *
 * 所以走这个**中立的槽位**：接口定义在共享层（**只有类型，不 import 任何模块**），
 * 会话模块启动时把自己的能力挂上来，任务模块读它。外壳全程不认识任何一边。
 *
 * # ⚠️ 会话 id 是**运行时**的，别往数据库里存
 *
 * 会话 id 只在那个进程活着的时候有意义（重启、关掉就没了）。所以：
 * 「这个任务派给了谁」**不落库**，而是任务那边的 store 里留一份内存映射 ——
 * 会话都没了，那条关联也就没什么可回写的了。
 * （HANDOFF 里「任务的 agent 外键已经留好位置」那句，落地时**故意没加那一列**：
 * 一列指向运行时 id 的外键，只会让后人以为它有意义。）
 */

/** 现在活着的、可以接受任务的一个会话 */
export interface AgentTarget {
  sessionId: string;
  /** 会话标题（`claude #1` 那种） */
  title: string;
  /** 在哪个工作目录下 —— 用户认这个，标题只是编号 */
  workspace: string;
  /** `claude` / `codex` / `shell` */
  kind: string;
}

export interface AgentBus {
  /** 现在能接受任务的会话。派任务时给用户挑 */
  list(): AgentTarget[];
  /**
   * 把一段文本送进某个会话 —— **当成用户自己敲进去的**（末尾自动补回车）。
   *
   * 返回 `false` 表示那个会话已经不在了（关了、退了）——
   * 调用方要能顺着这个告诉用户「没送出去」，而不是默默什么都没发生。
   */
  send(sessionId: string, text: string): boolean;
  /** 会话结束了。任务那边据此回写一条进度。返回退订函数 */
  onExit(cb: (sessionId: string) => void): () => void;
}

/**
 * 默认空实现。
 *
 * **必须有一个能用的默认值**：任务模块完全可能先于会话模块被激活
 * （用户先点「任务」再点「智能体会话」），那时候它读到的是这个空壳 ——
 * 「没有可以派的会话」是个正常状态，不该是崩溃或者 `undefined`。
 */
const EMPTY: AgentBus = {
  list: () => [],
  send: () => false,
  onExit: () => () => {},
};

let current: AgentBus = EMPTY;

/** 会话模块启动时把自己的实现挂上来（只该挂一次） */
export function attachAgentBus(bus: AgentBus): void {
  current = bus;
}

/** 一个**读的时候才解析**的代理：模块挂载的先后顺序不影响使用 */
export const agentBus: AgentBus = {
  list: () => current.list(),
  send: (sessionId, text) => current.send(sessionId, text),
  onExit: (cb) => current.onExit(cb),
};
