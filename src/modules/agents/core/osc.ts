/**
 * 终端转义序列里的通知（OSC 9 / OSC 777）。
 *
 * # 为什么要有这条路
 *
 * 它是**零配置**的那一条。Claude Code 要靠 hook、Codex 要靠 `notify`，
 * 都得先改用户的配置文件才有效；而终端通知序列是程序自己往 pty 里写的，
 * 我们只要在旁边看着就能收到。
 *
 * ⚠️ **不要在这里写「Codex 默认会发 OSC」**。那个说法（`tui.notifications` 这个配置键）
 * 查证下来是**没证实**的：在 Codex 0.149.0 的二进制里 grep 不到这个键，
 * 官方能核对的配置只有 `notify`。二手资料里常见，但不要当事实写进注释。
 *
 * 收益具体到我们关心的事：
 * - **Codex 的「需要你」只能靠它**（官方只给了回合完成一个事件）
 * - 它是 hook 之外的第二条独立信号。两条同时报同一件事时，
 *   状态机的去抖会把重复的那条吃掉，不会出现两个通知
 *
 * # 它是「旁观者」，不是过滤器
 *
 * ⚠️ **扫描器一个字节都不吃掉。** xterm 那边照样收到完整的字节流 ——
 * 因为 OSC 这个命名空间里不只有通知：设置窗口标题（OSC 0/2）、
 * 超链接（OSC 8）、终端能力上报（OSC 4/10/11）都走同一套语法。
 * 在这里「顺手把认出来的序列删掉」会把上面那些一起弄坏，
 * 而且坏法很隐蔽（标题不更新了，没人会想到是通知扫描干的）。
 *
 * # 没做 OSC 99
 *
 * kitty 那套（`OSC 99 ; 元数据 ; 正文`）带参数解析和 base64 正文，
 * 而 v1 里没有任何一个目标程序在用它。**先不做，也不假装认它** ——
 * 认错一条 99 会变成一条莫名其妙的通知，比漏掉更烦人。
 */

/** 一条序列最长多少字节。超了就认定是畸形流，丢掉重来 */
const MAX_SEQUENCE = 4096;

/** 通知正文最多留多少字符。太长的正文在侧栏里也显示不下 */
const MAX_TEXT = 200;

export interface OscNotice {
  /** OSC 编号：9 或 777 */
  code: number;
  /** 可显示的一行文本。可能为空串（有些程序只发序列不带正文） */
  text: string;
}

export interface OscScanner {
  /**
   * 喂一段字节，返回这段里认出来的通知。
   *
   * 调用方**必须同时把这段字节喂给 xterm** —— 见文件头那段。
   */
  feed(bytes: Uint8Array): OscNotice[];
}

const ESC = 0x1b;
const BEL = 0x07;
const BACKSLASH = 0x5c;
const CLOSE_BRACKET = 0x5d;

const decoder = new TextDecoder();

/**
 * 建一个扫描器。
 *
 * 状态跟着实例走 —— **序列可以跨字节块**：pty 上来的是一个个
 * 不确定边界的块，一条序列被切成两半是常态（`ESC` 在一块结尾、
 * `]` 在下一块开头）。所以「当前正在攒什么」不能是函数的局部变量。
 */
export function createOscScanner(): OscScanner {
  /** 正在攒的 OSC 负载（不含开头的 `ESC ]`）。null 表示没在攒 */
  let pending: number[] | null = null;
  /** 上一个字节是 ESC，这个字节可能是 `]` 或者 `\` */
  let sawEsc = false;

  return {
    feed(bytes: Uint8Array): OscNotice[] {
      const out: OscNotice[] = [];

      for (const byte of bytes) {
        if (pending !== null) {
          // ---- 攒负载中 ----
          if (byte === BEL) {
            push(out, decode(pending));
            pending = null;
            continue;
          }
          if (byte === ESC) {
            // 可能是 ST（`ESC \`）的开头。先记下，下一个字节说了算
            sawEsc = true;
            continue;
          }
          if (sawEsc) {
            if (byte === BACKSLASH) {
              push(out, decode(pending));
              pending = null;
            } else {
              // 不是 ST，那就是一条畸形的序列。丢掉重来 ——
              // **不抛、不卡死**，后面的内容照样能认
              pending = null;
            }
            sawEsc = false;
            continue;
          }
          if (pending.length >= MAX_SEQUENCE) {
            // 一直没有终止符。再攒下去就是内存泄漏，丢掉重来
            pending = null;
            continue;
          }
          pending.push(byte);
          continue;
        }

        // ---- 找序列开头 ----
        if (sawEsc) {
          sawEsc = false;
          if (byte === CLOSE_BRACKET) {
            pending = [];
          }
          // 不是 `]` 就什么都不做：CSI（`ESC [`，颜色/光标）之类我们不关心，
          // 让状态自己回到「找 ESC」
          continue;
        }
        if (byte === ESC) sawEsc = true;
      }

      return out;
    },
  };
}

/** 字节 → 文本。畸形 UTF-8 会被替换成 U+FFFD 而不是抛（TextDecoder 的默认行为） */
function decode(payload: number[]): string {
  return decoder.decode(new Uint8Array(payload));
}

function push(out: OscNotice[], payload: string | null): void {
  if (payload === null) return;
  const notice = parsePayload(payload);
  if (notice !== null) out.push(notice);
}

/**
 * 把一条 OSC 负载解析成通知。不是通知就返回 null。
 *
 * 支持的两种：
 * - `9;<正文>` —— iTerm2 那套，也是最常见的
 * - `777;notify;<标题>;<正文>` —— rxvt 那套
 *
 * ⚠️ `777` 还用来做别的（`precmd` / `preexec`，shell 钩子在每条命令前后发的），
 * **那些不是给你的提醒**，混进来会变成满屏「命令执行完了」的假通知。
 */
export function parsePayload(payload: string): OscNotice | null {
  const semi = payload.indexOf(';');
  if (semi <= 0) return null;

  const code = Number(payload.slice(0, semi));
  const rest = payload.slice(semi + 1);

  if (code === 9) {
    return { code, text: clean(rest) };
  }

  if (code === 777) {
    const parts = rest.split(';');
    if (parts[0] !== 'notify') return null;
    const title = clean(parts[1] ?? '');
    const body = clean(parts.slice(2).join(';'));
    return { code, text: join(title, body) };
  }

  return null;
}

function join(title: string, body: string): string {
  if (title === '') return body;
  if (body === '') return title;
  return `${title}：${body}`;
}

/**
 * 去掉控制字符并截断。
 *
 * 正文是**外面来的**（程序往 pty 里写的，内容可能来自模型输出、
 * 甚至来自远端），所以按不可信输入处理：控制字符会让界面上的文字错位，
 * 超长的正文会把侧栏撑爆。
 */
function clean(text: string): string {
  // 控制字符一律抹掉。用转义写而不是字面量：源码里躺着看不见的字节，
  // 换个编辑器、过一次 diff 就可能被吃掉，而症状完全看不出来
  // eslint-disable-next-line no-control-regex
  const stripped = text.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return stripped.length > MAX_TEXT ? `${stripped.slice(0, MAX_TEXT)}…` : stripped;
}
