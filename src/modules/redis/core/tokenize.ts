/**
 * 命令行分词。
 *
 * 规则**照抄 redis-cli 的 `sdssplitargs`**，不自己发明 —— 用户的手感来自 redis-cli，
 * 换个规则只会让人困惑。几条容易搞反的：
 *
 * - 未加引号的 token 里，**反斜杠是普通字符**（`a\b` 就是三个字符 `a`、`\`、`b`）
 * - `"双引号"` 里支持 `\xHH`、`\n \r \t \b \a`，其它 `\c` 一律还原成 `c`
 * - `'单引号'` 里**只**支持 `\'`，别的反斜杠原样保留
 * - 结束引号后面必须跟空白或直接结束：`"a"b` 是错的，redis-cli 也这么判
 *
 * 放在 TS 而不是 Rust：分词是「客户端的便利」，不是协议的一部分 —— IPC 的契约是
 * `args: string[]`。放这里能让 tauri 和浏览器两个实现共用同一份，还能在 node 下
 * 毫秒级穷举边界用例。
 */

export type TokenizeResult =
  | { ok: true; tokens: string[] }
  | { ok: false; reason: string };

const SIMPLE_ESCAPES: Record<string, string> = {
  n: '\n',
  r: '\r',
  t: '\t',
  b: '\b',
  a: '\x07',
};

function isSpace(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\v' || c === '\f';
}

function isHex(c: string): boolean {
  return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
}

export function tokenize(input: string): TokenizeResult {
  const tokens: string[] = [];
  let i = 0;

  while (i < input.length) {
    while (i < input.length && isSpace(input.charAt(i))) i += 1;
    if (i >= input.length) break;

    const quote = input.charAt(i) === '"' || input.charAt(i) === "'" ? input.charAt(i) : null;
    let token = '';

    if (quote === null) {
      // 裸 token：读到下一个空白为止，反斜杠不做特殊处理
      while (i < input.length && !isSpace(input.charAt(i))) {
        token += input.charAt(i);
        i += 1;
      }
    } else {
      i += 1; // 跳过开引号
      let closed = false;

      while (i < input.length) {
        const c = input.charAt(i);

        if (quote === '"' && c === '\\' && i + 1 < input.length) {
          const next = input.charAt(i + 1);
          if (next === 'x' && i + 3 < input.length && isHex(input.charAt(i + 2)) && isHex(input.charAt(i + 3))) {
            token += String.fromCharCode(parseInt(input.slice(i + 2, i + 4), 16));
            i += 4;
            continue;
          }
          const simple = SIMPLE_ESCAPES[next];
          if (simple !== undefined) {
            token += simple;
            i += 2;
            continue;
          }
          // 其它 \c → c（和 sdssplitargs 的 default 分支一致）
          token += next;
          i += 2;
          continue;
        }

        if (quote === "'" && c === '\\' && input.charAt(i + 1) === "'") {
          token += "'";
          i += 2;
          continue;
        }

        if (c === quote) {
          closed = true;
          i += 1;
          break;
        }

        token += c;
        i += 1;
      }

      if (!closed) {
        return { ok: false, reason: `第 ${i} 个字符处的${quote === '"' ? '双' : '单'}引号没有闭合` };
      }
      if (i < input.length && !isSpace(input.charAt(i))) {
        return { ok: false, reason: '结束引号后面必须是空白（想连写的话把整段放进同一对引号里）' };
      }
    }

    tokens.push(token);
  }

  return { ok: true, tokens };
}

/**
 * 把 token 数组还原成一行可复制粘贴的命令。
 *
 * 日志要回显用户敲的命令 —— 直接 `args.join(' ')` 会把带空格的参数拆散，
 * 用户复制回去执行就错了。所以含特殊字符的 token 重新加引号。
 */
export function formatArgs(args: readonly string[]): string {
  return args.map(quoteIfNeeded).join(' ');
}

function quoteIfNeeded(arg: string): string {
  if (arg === '') return '""';
  // 可以裸着出去的字符集：字母数字加一小撮安全的符号
  if (/^[A-Za-z0-9._:/@*?[\]{}()<>=+-]+$/.test(arg)) return arg;
  // 否则用双引号包起来，并把引号和反斜杠转义掉
  return `"${arg.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
