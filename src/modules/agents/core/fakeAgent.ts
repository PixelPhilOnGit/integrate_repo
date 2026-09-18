/**
 * 假的智能体会话：浏览器里的「那一边」。
 *
 * # 它不是「顺便支持一下浏览器」
 *
 * headless 环境里起不了原生窗口，Playwright 只能驱动普通 Chromium 里的前端，
 * **这个实现是整条自动化验证链路的前提**（和 `ssh/core/fakeSsh.ts` 同一个理由）。
 *
 * # 它必须和真实现走同一条路，否则 e2e 是自欺
 *
 * 尤其是这两条，一定要真的走一遍：
 * 1. **状态事件走事件文件那条路**：假 agent 不直接改 store，而是通过
 *    `onState` 让 web 客户端把它变成「事件目录里的一个文件」，
 *    再被 `takeEvents()` 取走、被 `parseEventName` 解析、被状态机吃掉。
 *    直接改 store 的话，那条链路上任何一环坏掉都测不出来。
 * 2. **「需要你」同时发 OSC 9 和事件文件**：真世界里 Claude 的 hook 和
 *    终端转义序列会同时报同一件事，去抖正是为它写的。这里刻意制造这个重复，
 *    让状态机那条「同一个信号只留一条」的规则在 e2e 里也被走到。
 *
 * # 怎么驱动它
 *
 * 靠**用户真的敲键盘**（e2e 里就是 `page.keyboard.type`）：输入 `ask` 回车 →
 * 它进入「等你」；输入 `work` → 「正在工作」；`done` → 「已完成」。
 * 走键盘而不是暴露一个 `window.__setStatus`，是因为「键盘 → xterm → onData →
 * 服务层 → 进程」这一段正是终端最容易出错的一截，绕过去就等于没测。
 */

import type { EventState } from './events';

/** 终端一行有多宽。假 agent 不做折行，够用就行 */
const PROMPT = '\x1b[36m❯\x1b[0m ';

const BANNER = [
  '',
  '\x1b[1mDevtoolkit 假 agent\x1b[0m \x1b[2m（浏览器模式：真进程是起不来的）\x1b[0m',
  '\x1b[2m输入 help 看能干什么\x1b[0m',
  '',
].join('\r\n');

export interface FakeAgentHooks {
  /** 往终端里吐字节 */
  onData: (bytes: Uint8Array) => void;
  /** 进程退出 */
  onExit: (code: number | null) => void;
  /**
   * 报一条状态事件。
   *
   * 实现方（web 客户端）要把它变成「事件目录里的一个文件」，
   * **不能**直接去改 store —— 见文件头那段。
   */
  onState: (state: EventState) => void;
}

export interface FakeAgent {
  /** 用户敲进来的字节 */
  write(bytes: Uint8Array): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

const encoder = new TextEncoder();

export function createFakeAgent(hooks: FakeAgentHooks): FakeAgent {
  /** 还没提交的那一行 */
  let line = '';
  let closed = false;

  const out = (text: string): void => {
    if (closed) return;
    hooks.onData(encoder.encode(text));
  };

  const prompt = (): void => out(`\r\n${PROMPT}`);

  const quit = (code: number): void => {
    if (closed) return;
    closed = true;
    out(`\r\n\x1b[2m（假 agent 退出了，退出码 ${code}）\x1b[0m\r\n`);
    hooks.onExit(code);
  };

  function submit(): void {
    const command = line.trim();
    out('\r\n');
    line = '';

    // 新建会话时那条启动命令也会走到这里（真实现里它是被送进 shell 的一行输入）。
    // 认出两个 agent CLI 并「假装启动」，不然演示和 e2e 里第一眼就是一句报错
    const head = command.split(/\s+/)[0] ?? '';
    if (head === 'claude' || head === 'codex') {
      out(`\x1b[2m（假）${head} 已启动，输入 help 看能干什么\x1b[0m`);
      prompt();
      return;
    }

    switch (command) {
      case '':
        break;

      case 'help':
        out(
          [
            '\x1b[2m可用的命令：\x1b[0m',
            '  \x1b[36mwork\x1b[0m   开始干活（状态变「正在工作」）',
            '  \x1b[36mask\x1b[0m    需要你确认（状态变「需要你」，并同时发一条终端通知）',
            '  \x1b[36mdone\x1b[0m   干完一个回合（状态变「已完成」）',
            '  \x1b[36mexit\x1b[0m   退出',
          ].join('\r\n'),
        );
        break;

      case 'work':
        out('\x1b[2m正在处理……\x1b[0m');
        hooks.onState('working');
        break;

      case 'ask':
        out('我需要你确认一下：是否执行这条 Bash 命令？');
        out('  \x1b[2mrm -rf ./build\x1b[0m');
        // 两个来源同时报同一件事 —— 真世界里 hook 和终端通知序列就是这么重叠的
        out(`\x1b]9;等待你的确认\x07`);
        hooks.onState('waiting');
        break;

      case 'done':
        out('这一回合干完了。');
        out(`\x1b]9;回合完成\x07`);
        hooks.onState('done');
        break;

      case 'exit':
        quit(0);
        return;

      default:
        out(`\x1b[31m未知命令：${command}\x1b[0m（输入 help 看看有什么）`);
    }

    prompt();
  }

  /** 行规程：能打印的字符回显，退格删一个，回车提交，Ctrl+C 丢开这一行 */
  function feed(text: string): void {
    for (const ch of text) {
      if (ch === '\r' || ch === '\n') {
        submit();
        continue;
      }
      if (ch === '\x7f' || ch === '\b') {
        if (line.length > 0) {
          line = line.slice(0, -1);
          out('\b \b');
        }
        continue;
      }
      if (ch === '\x03') {
        line = '';
        out('^C');
        prompt();
        continue;
      }
      if (ch < ' ') continue; // 别的控制字符不理会
      line += ch;
      out(ch);
    }
  }

  const decoder = new TextDecoder();
  out(BANNER);
  prompt();

  return {
    write(bytes: Uint8Array): void {
      if (closed) return;
      feed(decoder.decode(bytes));
    },

    resize(): void {
      // 假 agent 不做列宽（和假 SSH 一样）。尺寸这条路由 Rust 那组测试覆盖，
      // 浏览器这边刻意不假装测过
    },

    close(): void {
      if (closed) return;
      closed = true;
      hooks.onExit(null);
    },
  };
}
