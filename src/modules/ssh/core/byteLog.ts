/**
 * 会话的**原始字节日志**：折叠命令块时的原料。
 *
 * # 为什么非要有它
 *
 * 折叠 = 「把这一块的输出从终端里收起来」。而 xterm 的缓冲区**删不掉中间几行**
 * （没有这种转义序列），所以只能把内容按新的分段**重放一遍**：折起来的那块换成
 * 一行摘要，其余原样写回。要重放就得有原始字节 —— 缓冲区里剩下的只是**渲染后**
 * 的结果，颜色、光标移动、清屏那些都不在里面了。
 *
 * # 为什么要分段
 *
 * 重放的最小单位不是「整场会话」，而是**块**：折叠/展开只改一块，其余的字节
 * 一字不动地写回去。
 *
 * ```
 * preamble         会话开头到第一条命令之间（横幅、第一个提示符、命令的回显）
 * block[3]         第 3 块：从它提交那一刻，到第 4 块提交那一刻
 * ```
 *
 * ⚠️ 注意分段点是**提交**而不是「命令回显」：用户敲字时远端回显的那几个字符
 * 是在提交**之前**到的，所以它落在**上一段**里 —— 而上一段的末尾正是
 * 「下一条命令那一行」，两边对得上（色条的范围也是这么切的）。
 *
 * # 上限
 *
 * 这份日志是**在终端缓冲区之外又存一份**，所以必须有上限：超了就不再攒，
 * 并把 `overflowed()` 置起来 —— 折叠那个按钮据此**直接关掉**，而不是悄悄
 * 折一半（折到一半的效果是内容对不上，比不能用糟得多）。
 */

/**
 * 一个会话攒多少字节就不攒了。
 *
 * # ⚠️ 这个数字是**内存**，不是性能
 *
 * 日志是「在终端缓冲区之外**又存一份**」，而且是**每个会话一份**、**活到会话
 * 关掉为止**（会话跑完之后它还留着 —— 那时候折叠一条早就跑完的大输出正是最
 * 有用的时候）。
 *
 * 2MB 是这么定的：一边是「够重放多少内容」（5000 行回滚区大约 1MB 上下，
 * 2MB 已经够折几条大输出了），另一边是「十个会话挂着多少内存」（20MB 上下，
 * 可以接受）。原来的 8MB 意味着十个会话就是 80MB —— 那是「开一天越来越卡」
 * 那类账的一部分。
 *
 * 超了就不再攒并把标记立起来：折叠按钮据此**直接关掉**，而不是折一半
 * （折到一半的效果是内容和行号对不上，比不能折糟得多）。
 */
export const DEFAULT_BYTE_LIMIT = 2 * 1024 * 1024;

export interface ByteLog {
  /** 记一段字节。还没提交过命令就落在开头那段 */
  append(bytes: Uint8Array, at: number): void;
  /** 从现在起，字节归这一块（提交一条命令时调） */
  startBlock(blockId: number): void;
  /** 开头那一段（重放时先写它） */
  preamble(): Uint8Array;
  /** 某一块的字节。没有这一块（或者日志溢出了）返回空 */
  block(blockId: number): Uint8Array;
  /** 最后一段字节是什么时候来的 —— 「shell 停下来了没有」靠它判断 */
  lastOutputAt(): number | null;
  total(): number;
  overflowed(): boolean;
}

export function createByteLog(limit: number = DEFAULT_BYTE_LIMIT): ByteLog {
  const head: Uint8Array[] = [];
  const blocks = new Map<number, Uint8Array[]>();
  let current: number | null = null;
  let total = 0;
  let over = false;
  let lastAt: number | null = null;

  const bucket = (): Uint8Array[] => {
    if (current === null) return head;
    let list = blocks.get(current);
    if (list === undefined) {
      list = [];
      blocks.set(current, list);
    }
    return list;
  };

  return {
    append(bytes, at) {
      lastAt = at;
      if (over) return;
      total += bytes.byteLength;
      if (total > limit) {
        // 超了就把已经攒的丢掉：留着它既不能折叠，又白占内存
        over = true;
        head.length = 0;
        blocks.clear();
        return;
      }
      bucket().push(bytes);
    },

    startBlock(blockId) {
      current = blockId;
    },

    preamble: () => join(head),

    block(blockId) {
      const list = blocks.get(blockId);
      return list === undefined ? new Uint8Array(0) : join(list);
    },

    lastOutputAt: () => lastAt,
    total: () => total,
    overflowed: () => over,
  };
}

function join(chunks: readonly Uint8Array[]): Uint8Array {
  let size = 0;
  for (const chunk of chunks) size += chunk.byteLength;

  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}
