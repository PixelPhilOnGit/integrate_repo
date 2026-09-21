/**
 * 命令块：把一次「敲命令 → 看输出」圈成一块。
 *
 * # 这套东西**全在本地算**，不往远端装任何东西
 *
 * 块边界只有两个可能的来源，我们只用本地那一个：
 *
 *   - **用户按了回车** —— 按键就是从我们这儿发出去的，精确知道（这个文件用它）
 *   - shell 自己打 OSC 133 标记 —— 更准（还带退出码），但要在远端装 shell 集成。
 *     这条路是明确不要的：它会动用户的服务器
 *
 * 所以这里能给的：边界、命令原文、输出范围、耗时、有没有输出。
 * **给不了的：退出码**（它只存在于远端 shell 里，本地无论如何看不见）、
 * 提示符的精确起点（差一行以内，见 `col`）。
 *
 * # 命令原文为什么不是从按键还原的
 *
 * 行编辑在远端：Tab 补全、↑ 历史、Ctrl+R 搜索，我们这边看到的只是一串控制序列。
 * 所以命令原文是**回车那一刻从终端缓冲区里读出来的**（谁有这个模型谁去读，
 * 见 SSH store 里的接线）—— 补全后的、从历史里取出来的、粘贴进去的，都是缓冲区
 * 里真实的样子。这个文件只管把「哪一刻是回车」「那一块从哪一行开始」记下来。
 *
 * # 一条命令是怎么变成一块的
 *
 * ```
 * 用户敲第一个键 ──► begin(光标位置)   命令从这一列开始（≈ 提示符的终点）
 * 用户按回车     ──► submit(命令原文)   这一块成型；之后的输出时间都记在它身上
 * 远端吐字节     ──► output(时刻)      只更新「最后一字节输出是什么时候」
 * ```
 *
 * 输出的**行范围**不在这里存：它是「这一块的起点」到「下一块的起点」，而下
 * 一块的起点要等下一块出现才知道。渲染时按顺序算一把就行 —— 存下来反而要跟着
 * 终端的滚动和重排同步，那是两处真相。
 */

/**
 * 一块：一条命令 + 它的输出。
 *
 * ⚠️ `line` 是终端缓冲区里的**绝对行号**（含回滚区，不是视口内的行），
 * 这样滚动、重排之后它仍然指得住同一处内容。
 */
export interface CommandBlock {
  id: number;
  /** 命令原文。空命令不会成块（见 `submit`） */
  command: string;
  /** 命令那一行的绝对行号 */
  line: number;
  /**
   * 命令第一个字符在第几列 —— 也就是提示符的终点。
   *
   * 这是**近似**：真正的提示符终点要 OSC 133 才拿得到。取值是「用户敲第一个键
   * 时光标在哪」。复制的时候从这里开始截，好把提示符甩掉；偏一点点也只影响
   * 色条的横向起点，不影响命令原文本身。
   */
  col: number;
  /** 回车那一刻的毫秒时间戳 */
  at: number;
  /**
   * 回车之后**最后一字节输出**的时间戳。
   *
   * `null` 有两种含义，看这块是不是最后一块：还在跑（后面可能还有输出），
   * 或者跑完了但一个字节都没吐（`ls` 一个空目录就是这样）。
   */
  lastOutputAt: number | null;
}

export interface BlockTracker {
  /** 用户敲下了这一轮的第一个键 */
  begin(line: number, col: number, at: number): void;
  /**
   * 用户按了回车。`command` 是那一刻从终端缓冲区里读出来的命令原文。
   *
   * 返回值：**真的立了一块**就把它交出来，空命令（Ctrl+C、直接回车）返回 null ——
   * 调用方要靠它决定「从这里开始，字节归哪一块」（见 `byteLog` 的分段）。
   */
  submit(command: string, line: number, col: number, at: number): CommandBlock | null;
  /** 远端吐了字节 */
  output(at: number): void;
  /**
   * 这一轮的起点（用户敲第一个键时光标在哪）。没有就是 null。
   *
   * 调用方要用它去**终端缓冲区里读命令原文**（起点 → 回车时的光标），
   * 所以这个位置不能只留在内部。
   */
  start(): { line: number; col: number } | null;
  /**
   * 这一轮不成立了（用户按了 Ctrl+C）。
   *
   * Ctrl+C 之后 shell 会在**新的一行**重新打提示符，而起点如果还记着上一行，
   * 下一条命令读出来就会带上前一行的残渣。
   */
  cancel(): void;
  /**
   * 折叠/展开之后**重算每一块的行号**。
   *
   * 重放一遍终端内容会把行数改掉（折起来的那块只剩一行摘要），所有块的位置
   * 都会往上挪。`moved` 给的是「块 id → 新的起点行」，没提到的块保持原样 ——
   * 这样调用方只报它真的挪过的那些。
   */
  remap(moved: ReadonlyMap<number, number>): void;
  /**
   * 丢掉一批**内容已经不在**的旧块（清屏把坐标系重置了），返回丢掉的 id。
   *
   * 判据是行号：`line >= 传进来的那个行号` 的那些。为什么这个判据成立、为什么
   * 不能用「新块比上一块小就全清」那种粗暴规则，见调用处（store 立块那一刻）
   * 的推演 —— 这个文件不知道终端里发生了什么，只知道行号。
   *
   * ⚠️ **刚提交的那一块（数组最后一个）要留着**：它的行号正好等于这个判据。
   *
   * 为什么必须丢：被擦掉的那些块，行号还"有效"（绝对行号没变），但内容没了 ——
   * 色条会画在空行上。而且清屏把行号推回小数之后，`ESC[3J` 那批旧块的大行号
   * 会把「块按 line 有序」这条不变式破坏掉，而二分查找和渲染那两条 `break`
   * 全靠它。
   */
  pruneFrom(line: number): number[];
  /** 现在有哪些块（新的在后）。渲染和复制都从这里拿 */
  blocks(): readonly CommandBlock[];
}

/**
 * 把一批输入拆成「回车之前敲进去的」和「有没有按回车」。
 *
 * 输入是用户敲的键（xterm 的 `onData`），所以回车是 `\r`（终端里的回车键），
 * `\n` 也认（粘贴进来的多行文本走这条）。
 *
 * 返回的 `text` 有两个用处：`begin` 那一轮里它其实用不上（命令原文从终端缓冲区
 * 读），但**回显还没回来时**它是唯一的退路 —— 见调用处。
 * 一次粘贴里有多行的话只认第一行之前的部分：那之后的每一行都会各自触发一次
 * 回车，本来就该切成好几块。
 */
export function splitInput(data: string): { text: string; submit: boolean } {
  const at = data.search(/[\r\n]/);
  if (at < 0) return { text: data, submit: false };
  return { text: data.slice(0, at), submit: true };
}

/**
 * 摘掉转义序列。
 *
 * 两类要从按键里摘干净的东西：
 *
 * * **bracketed paste 的包装**（`ESC[200~` / `ESC[201~`）—— 粘贴进来的文本
 *   会带着这一对，留着的话「命令原文」会以一个看不见的序列开头
 * * **方向键、Home、删除**（`ESC[A`、`ESC[3~` ……）—— 用户按 ↑ 取历史时，
 *   按键里最先出现的正是它
 *
 * 摘掉之后不影响终端行为：这一步只作用在**我们记下来的副本**上，
 * 真正发出去的还是原样的字节。
 */
export function stripEscapes(data: string): string {
  // CSI 序列：ESC [ 参数 中间字节 终止字节
  return data.replace(/\x1b\[[0-9;?]*[A-Za-z~]/g, '').replace(/\x1b./g, '');
}

/**
 * 从「用户敲的原始按键」凑出一条能看的命令 —— **只在回显没回来时兜底**。
 *
 * 不完美，而且这里就该不完美：退格、Ctrl+U、Ctrl+W 处理了（那是编辑命令时
 * 最常用的三个），Tab 补全补出来的内容仍然是空的、被删掉的字符也从历史里
 * 捞不回来。但这条路只在**缓冲区里读不到命令**时才走，那种时候有一条接近的
 * 总比一条空的强。
 */
export function cleanTyped(typed: string): string {
  let out = '';
  for (const ch of typed) {
    if (ch === '\x7f' || ch === '\b') out = out.slice(0, -1); // 退格
    else if (ch === '\x15') out = ''; // Ctrl+U：清掉整行
    else if (ch === '\x17') out = out.replace(/\S+\s*$/, ''); // Ctrl+W：删一个词
    else if (ch < ' ') continue; // 其余控制字符不显示
    else out += ch;
  }
  return out.trim();
}

export function createBlockTracker(): BlockTracker {
  const blocks: CommandBlock[] = [];
  let nextId = 1;

  /** 这一轮命令的起点（用户敲的第一个键）。还没敲就是 null */
  let start: { line: number; col: number; at: number } | null = null;
  /** 最后提交的那一块。输出往它身上记 */
  let last: CommandBlock | null = null;

  return {
    begin(line, col, at) {
      // 只认这一轮的第一个键：后面那些字符是在同一个起点后面打出来的
      start ??= { line, col, at };
    },

    submit(command, line, col, at) {
      // 没有 begin 也要能用，两种真实情况：在提示符上直接回车（Ctrl+C 之后），
      // 以及整行粘贴进来（那批字节不走 begin）。退而求其次用回车时的光标倒推 ——
      // 逐字敲出来的命令，起点就是「光标列 - 命令长度」。
      // 编辑过、或者提示符末尾有看不见的宽度时这个列会偏，但**只影响色条和复制
      // 的横向起点**，命令原文是从缓冲区读的，不受影响
      const from = start ?? { line, col: Math.max(0, col - command.length), at };
      start = null;

      // 空命令不留块：Ctrl+C、直接回车、只按了个方向键 —— 那不是一次执行。
      // 顺带把 last 清掉：这之后的输出不属于任何一块，别记到上一条命令头上
      if (command.trim() === '') {
        last = null;
        return null;
      }

      const block: CommandBlock = {
        id: nextId,
        command,
        line: from.line,
        col: from.col,
        at,
        lastOutputAt: null,
      };
      nextId += 1;
      blocks.push(block);
      last = block;
      return block;
    },

    output(at) {
      if (last !== null) last.lastOutputAt = at;
    },

    start: () => (start === null ? null : { line: start.line, col: start.col }),

    cancel() {
      start = null;
    },

    remap(moved) {
      for (const block of blocks) {
        const line = moved.get(block.id);
        if (line !== undefined) block.line = line;
      }
    },

    pruneFrom(line) {
      const dropped: number[] = [];
      // 从后往前剪（边扫边 splice，倒着走才不会错位），而且**从倒数第二个
      // 开始**：最后一个是刚提交的那一块，它的行号正好等于判据，但它自己得留着
      for (let i = blocks.length - 2; i >= 0; i -= 1) {
        const block = blocks[i];
        if (block === undefined || block.line < line) continue;
        dropped.push(block.id);
        blocks.splice(i, 1);
      }
      // 倒着扫出来的，翻回来交给调用方（「丢掉了哪几块」按原来的先后说更顺）
      return dropped.reverse();
    },

    blocks: () => blocks,
  };
}
