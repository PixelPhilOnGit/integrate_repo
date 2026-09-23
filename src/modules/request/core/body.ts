/**
 * 响应体这一块的纯逻辑：base64 解码、**流式**文本解码、二进制判定、十六进制预览。
 *
 * # 为什么逐块解码要小心
 *
 * 传输层是按块给的（一次 `Chunk` 事件就是一块），而**块的边界和字符的边界
 * 毫无关系** —— 一个汉字（3 字节）完全可能被切成「1 字节 + 2 字节」。
 * 每块单独 `new TextDecoder().decode(chunk)` 的话，那两个半个字符各变成一个
 * U+FFFD，界面上每行中文都带问号。SSH 那一轮踩的是同一个坑（那边踩完的结论是
 * 「字节走 base64，前端自己拼」）。
 *
 * 所以这里用 `TextDecoder` 的**流式模式**（`{ stream: true }`）：它自己会
 * 把最后那半个字符留到下一块。这正是浏览器为这件事提供的接口。
 *
 * ⚠️ 收尾时**要 flush 一次**（`decode()` 不带参数）：响应要是正好断在
 * 半个字符上，不 flush 的话那半个字符会**静静地消失**，而断在半个字符上
 * 恰恰说明这条响应是被切断的 —— 那件事得让用户看见。
 */

/** base64 → 字节。 */
export function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** 字节 → base64（给浏览器版的假实现用；真链路上这一步在 Rust 那边）。 */
export function toBase64(bytes: Uint8Array): string {
  // ⚠️ 不能 `String.fromCharCode(...bytes)`：几兆的字节数一展开就是
  // 「参数太多」的栈溢出（`/big` 那条假路由正好会撞上）。分块拼。
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** 文本 → base64（假的响应体是字符串，转字节再过一次 [`toBase64`]）。 */
export function textToBase64(text: string): string {
  return toBase64(new TextEncoder().encode(text));
}

/**
 * 边收边解的那条流。
 *
 * 同时留两样东西：**解出来的文本**（正常显示）和**原始字节的前若干字节**
 *（二进制内容是拿不到文本的，那时界面画十六进制）。
 * 只留前缀、不留全量字节：全量在内存里躺一份毫无用处（要下载文件的话
 * 用户不会用调试器），而 2 MiB 的字节数组拷贝一次就是一次白白的开销。
 */
export class BodyStream {
  private decoder = new TextDecoder('utf-8');
  /** ⚠️ 字段名别叫 `text` —— 和下面那个 getter 同名会直接编译不过 */
  private textSoFar = '';
  private count = 0;
  private prefixBytes: Uint8Array = new Uint8Array();

  /** 前缀最多留这么多字节（够画一屏十六进制了）。 */
  private static readonly PREFIX_LIMIT = 1024;

  push(base64: string): void {
    const bytes = fromBase64(base64);
    this.count += bytes.length;
    this.textSoFar += this.decoder.decode(bytes, { stream: true });
    if (this.prefixBytes.length < BodyStream.PREFIX_LIMIT) {
      const want = BodyStream.PREFIX_LIMIT - this.prefixBytes.length;
      const merged = new Uint8Array(this.prefixBytes.length + Math.min(want, bytes.length));
      merged.set(this.prefixBytes);
      merged.set(bytes.subarray(0, Math.min(want, bytes.length)), this.prefixBytes.length);
      this.prefixBytes = merged;
    }
  }

  /** 收尾：把解码器里那半个字符冲出来（见文件头部）。 */
  finish(): void {
    this.textSoFar += this.decoder.decode();
  }

  get text(): string {
    return this.textSoFar;
  }

  /** 收到的字节数（raw，不是字符数）。 */
  get bytes(): number {
    return this.count;
  }

  get prefix(): Uint8Array {
    return this.prefixBytes;
  }
}

/**
 * 这个 content-type 是不是「能当文本看」。
 *
 * ⚠️ 判的是**声明**，不是内容。声明成文本但字节不是合法 UTF-8 的服务端是有的
 *（多半它自己写错了），那种情况下界面上会显示几个替换字符 —— 如实。
 * 反过来（声明成二进制、其实是文本）也没办法：真去嗅探内容的话，
 * 一段恰好全是可打印字节的二进制会显示成乱码，那比「画十六进制」更糟。
 */
export function isTextual(contentType: string | null): boolean {
  if (contentType === null || contentType.trim() === '') {
    // 没说是什么：默认当文本试一下。缺 content-type 的响应绝大多数是文本，
    // 而当不了文本时（解出来全是替换字符）用户自己看得出来。
    return true;
  }
  const type = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (type.startsWith('text/')) return true;
  if (type === 'application/json' || type.endsWith('+json')) return true;
  if (type === 'application/xml' || type.endsWith('+xml')) return true;
  if (type === 'application/javascript' || type === 'application/x-javascript') return true;
  if (type === 'application/x-www-form-urlencoded') return true;
  if (type === 'application/graphql' || type === 'application/x-ndjson') return true;
  if (type === 'application/yaml' || type === 'application/x-yaml') return true;
  return false;
}

/** 这个 content-type 是不是 JSON（决定要不要试着美化一下）。 */
export function isJson(contentType: string | null): boolean {
  if (contentType === null) return false;
  const type = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return type === 'application/json' || type.endsWith('+json');
}

/**
 * 十六进制预览（每行 16 字节，右边配 ASCII 那一栏）。
 *
 * `limit` 是**字节**上限 —— 这是给「这个响应是二进制的，我瞄一眼是什么」
 * 用的，不是查看器。
 */
export function hexDump(bytes: Uint8Array, limit = 256): string {
  const slice = bytes.subarray(0, Math.min(limit, bytes.length));
  const lines: string[] = [];
  for (let i = 0; i < slice.length; i += 16) {
    const row = slice.subarray(i, i + 16);
    const hex = Array.from(row)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(' ')
      .padEnd(16 * 3 - 1, ' ');
    const ascii = Array.from(row)
      .map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.'))
      .join('');
    lines.push(`${i.toString(16).padStart(6, '0')}  ${hex}  ${ascii}`);
  }
  return lines.join('\n');
}

/**
 * 试着把一段文本美化成 JSON。
 *
 * 返回 `null` = 「不是 JSON」或者「美化之后和原来一样」——**调用方据此决定
 * 要不要给那个「格式化」开关**。给一个点了没反应的开关，比不给更糟。
 *
 * ⚠️ 这里**吞掉解析错误**是对的：body 不是 JSON 是常态（HTML、纯文本、
 * SSE 流），不是错误。
 */
export function prettyJson(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const first = trimmed[0];
  if (first !== '{' && first !== '[') return null;
  try {
    const pretty = JSON.stringify(JSON.parse(trimmed), null, 2);
    return pretty === text ? null : pretty;
  } catch {
    return null;
  }
}
