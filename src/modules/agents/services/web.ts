/**
 * 浏览器端的智能体会话客户端：内存假实现。
 *
 * 不是「顺便支持一下浏览器」—— headless 环境里起不了原生窗口，Playwright
 * 只能驱动普通 Chromium 里的前端，**这个实现是整条自动化验证链路的前提**。
 *
 * # 它和真实现的分工必须一模一样
 *
 * 最要紧的一条：**状态事件要真的走「事件文件」那条路**。
 * 假 agent 报状态时，这里把它变成一条「目录里出现的文件」（`{name, at}`），
 * 前端照常 `takeEvents()` → `parseEventName` → 状态机。
 * 如果这里图省事直接去改 store，那么「文件名格式、mtime 排序、取走即删除、
 * 对不上号的 id 要丢掉」这几条在浏览器里**一条都不会被走到** ——
 * 而它们恰恰是外部程序唯一能影响界面的入口。
 */

import { createFakeAgent, type FakeAgent } from '../core/fakeAgent';
import type {
  AgentOpenOutcome,
  AgentsClient,
  EnvironmentProbe,
  EventFile,
  PtyOpenRequest,
} from './types';

const encoder = new TextEncoder();

interface Session {
  agent: FakeAgent;
}

export function createWebAgentsClient(): AgentsClient {
  const sessions = new Map<string, Session>();
  /** 「事件目录」：攒着等 takeEvents 取走，取走即清空 */
  const events: EventFile[] = [];

  /**
   * 事件的时间戳。
   *
   * 用真实时钟（状态机里要拿它算「等了多少秒」），但**必须严格递增** ——
   * 同一毫秒里来的两条事件如果时间戳相同，「谁最新」就变成了数组顺序，
   * 而那个顺序是不该被依赖的
   */
  let clock = 0;
  const stamp = (): number => {
    clock = Math.max(clock + 1, Date.now());
    return clock;
  };

  return {
    async open(request: PtyOpenRequest): Promise<AgentOpenOutcome> {
      // ⚠️ 浏览器里**连不了远端**：没有 SSH、没有钥匙串、也起不了别的机器上的进程。
      // 明确失败而不是假装成功 —— 假装的话用户会以为「连上了但没输出」，
      // 那种迷惑比一句实话难查得多。
      if (request.remote !== undefined) {
        throw new Error('浏览器版连不了远端机器（没有 SSH 能力）——请用桌面版。');
      }

      // 同 id 再开一次是替换 —— 和 Rust 侧语义一致
      sessions.get(request.id)?.agent.close();
      sessions.delete(request.id);

      // eslint-disable-next-line no-restricted-syntax -- 下面 return 的是新加的
      const agent = createFakeAgent({
        onData: (bytes) => {
          request.onEvent({ kind: 'data', bytes });
        },
        onExit: (code) => {
          sessions.delete(request.id);
          request.onEvent({ kind: 'exit', code });
        },
        onState: (state) => {
          events.push({ name: `${state}.${request.id}`, at: stamp() });
        },
      });

      sessions.set(request.id, { agent });

      // 启动命令是**送进 shell 的一行输入**（真实现也是这样），所以这里
      // 走的就是「用户敲了这一行」那条路，回显、行规程、状态事件全都会经过
      if (request.command !== '') {
        agent.write(encoder.encode(`${request.command}\r`));
      }

      // 本机那条路永远是 ready（只有远端才可能返回主机密钥那两态）
      return { kind: 'ready' };
    },

    async write(id: string, data: Uint8Array): Promise<void> {
      sessions.get(id)?.agent.write(data);
    },

    async resize(id: string, cols: number, rows: number): Promise<void> {
      sessions.get(id)?.agent.resize(cols, rows);
    },

    async close(id: string): Promise<void> {
      sessions.get(id)?.agent.close();
    },

    async closeAll(): Promise<void> {
      for (const session of sessions.values()) session.agent.close();
      sessions.clear();
    },

    async takeEvents(): Promise<EventFile[]> {
      const taken = events.slice();
      events.length = 0;
      return taken;
    },

    async eventsDir(): Promise<string> {
      // 说实话：浏览器里没有目录。界面上会把这句原样显示出来
      return '（浏览器模式：状态事件走内存，没有真的目录）';
    },
  };
}


/**
 * 环境自检的**浏览器版**：一份诚实的假报告。
 *
 * 浏览器里没有 Windows 那些东西，所以如实说「这里没有」—— 比编一份像模像样的
 * 假数据好：界面上那一格的作用是「告诉我真实环境」，编数据等于把它的意义抹掉。
 */
export function createWebProbe(): EnvironmentProbe {
  return {
    async probe() {
      return {
        shell: '/bin/sh',
        pathCount: 0,
        pathHead: [],
        claude: null,
        git: null,
        bash: null,
        bashOnPath: null,
        gitBashSetting: null,
      };
    },
  };
}
