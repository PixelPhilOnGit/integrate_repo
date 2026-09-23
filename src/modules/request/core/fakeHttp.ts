/**
 * 浏览器版的**假服务器**：把「发一个请求」这件事算成一份计划，`services/web.ts`
 * 照着它一条条推事件出来。
 *
 * # 为什么要有这个
 *
 * 浏览器版不是玩具 —— headless 环境起不了原生窗口，Playwright 全靠它驱动
 * （见 HANDOFF）。所以每个连接类模块都自带一份**足够真的假实现**：
 * 假 SSH 有真的行规程和一个内存文件系统，假 Redis 真的会按命令改内存里的键。
 * 这一个的「真」体现在三件事上：
 *
 * 1. **响应是一块块吐的**（块之间有间隔）—— 不然「流式」在 e2e 里永远是
 *    「一次给完」，那条路径根本测不到；
 * 2. **正文是字节**（`services/web.ts` 会先过一遍 base64）—— 和真链路同一条
 *    解码路径，连「一个汉字被切在两块之间」都能演出来（`/text` 那条就是）；
 * 3. **错误分大类**（连不上 / 证书 / 超时 / 读到一半断）—— 界面对这些是
 *    分开措辞的，假实现不分类的话那一层在 e2e 里就是空白。
 *
 * ⚠️ **空闲超时那一条路演不了**：它要等 90 秒。真机上验，见 HANDOFF 的清单。
 *
 * # 路由
 *
 * 地址里的**主机名和路径**决定结果（见 [`planFor`] 那张表）——
 * 这样 e2e 不需要搭服务器，写一个地址就能要到想要的那一种响应。
 */

export interface FakeHead {
  status: number;
  reason: string;
  headers: Array<[string, string]>;
  /** 跟到最后的那个地址（没跟跳转就是请求时那个）。 */
  finalUrl: string;
  /** 跟过的每一跳。⚠️ 假实现把跳转**算在计划里**，不是真的一条条重发 ——
   *  真链路上那是传输层的事（`HttpTransport::send` 那个循环）。 */
  redirects: Array<{ status: number; from: string; to: string }>;
}

/** 一次请求会怎么走。 */
export interface FakePlan {
  /** 到响应头之前等多久（让「正在跑」这个状态在界面上真的能被看到）。 */
  latencyMs: number;
  /** 响应头。`null` = 连响应头都没到就失败了。 */
  head: FakeHead | null;
  /** 正文块（UTF-8 文本；`/binary` 那种走 `rawChunks`）。 */
  chunks: string[];
  /** 逐块之间的间隔。 */
  chunkDelayMs: number;
  /** 收完这些块之后断掉（`null` = 不收）。 */
  failAfterChunks: number | null;
  /** 失败信息（`failAfterChunks` 到了的时候用）。 */
  fail: { errorKind: string; message: string } | null;
}

/** 一份「直接成功」的计划（下面那几条路由都从它改）。 */
function reply(
  head: Omit<FakeHead, 'finalUrl' | 'redirects'> & Partial<Pick<FakeHead, 'finalUrl' | 'redirects'>>,
  chunks: string[],
  url: string,
  opts: { latencyMs?: number; chunkDelayMs?: number } = {},
): FakePlan {
  return {
    latencyMs: opts.latencyMs ?? 25,
    head: { finalUrl: url, redirects: [], ...head },
    chunks,
    chunkDelayMs: opts.chunkDelayMs ?? 12,
    failAfterChunks: null,
    fail: null,
  };
}

function fail(errorKind: string, message: string, latencyMs = 25): FakePlan {
  return { latencyMs, head: null, chunks: [], chunkDelayMs: 0, failAfterChunks: null, fail: { errorKind, message } };
}

/** 地址拆成主机 + 路径（只认 `http(s)://host[:port]/path`，和传输层一样挑剔）。 */
export function parseUrl(url: string): { host: string; path: string; tls: boolean } | null {
  const m = /^(https?):\/\/([^/]*)(\/.*)?$/i.exec(url.trim());
  if (m === null) return null;
  const authority = m[2] ?? '';
  if (authority === '') return null;
  const host = authority.includes('@') ? (authority.split('@')[1] ?? '') : authority;
  return { host: host.toLowerCase(), path: (m[3] ?? '/') || '/', tls: (m[1] ?? '').toLowerCase() === 'https' };
}

const JSON_HEADERS: Array<[string, string]> = [
  ['content-type', 'application/json; charset=utf-8'],
  ['x-demo', 'devtoolkit'],
];

/** 回显这次请求（默认那条路由）—— 调接口时最有用的一种响应。 */
function echoBody(method: string, url: string, headers: Array<[string, string]>, body: string): string {
  return JSON.stringify(
    {
      note: '这是浏览器版的假服务器回显。真机上这里是你自己的服务端。',
      method,
      url,
      headers: Object.fromEntries(headers),
      body,
      receivedAt: '（浏览器版不记时间）',
    },
    null,
    2,
  );
}

/**
 * 这次请求会拿到什么。**纯函数**（没有计时器、没有随机）—— 所以 e2e 的断言
 * 是可预期的，单元测试也能直接调它。
 */
export function planFor(input: {
  method: string;
  url: string;
  headers: Array<[string, string]>;
  body: string;
  options: { followRedirects: boolean; maxRedirects: number; acceptInvalidCerts: boolean };
}): FakePlan {
  const { method, url, headers, body, options } = input;
  const parsed = parseUrl(url);
  if (parsed === null) {
    return fail('invalid', `地址要以 http:// 或 https:// 开头，现在是「${url.trim()}」`, 0);
  }
  const { host, path } = parsed;
  const upper = method.trim().toUpperCase();

  // ---- 主机名决定的那几种（先判，和路径无关）
  if (host === 'self-signed.local' || host === 'localhost:8443') {
    if (!options.acceptInvalidCerts) {
      return fail(
        'tls',
        `TLS 握手失败：certificate not valid for name "${host}"（自签证书 —— 打开「跳过证书校验」再试）`,
        40,
      );
    }
    return reply(
      { status: 200, reason: 'OK', headers: JSON_HEADERS },
      [JSON.stringify({ note: '证书校验被跳过了（就是右侧那个红字开关）' }, null, 2)],
      url,
    );
  }
  if (host === 'unreachable.invalid') {
    return fail('connect', `连不上 ${host}：Connection refused`, 60);
  }
  if (host === 'timeout.invalid') {
    return fail('timeout', '连接超时', 120);
  }

  // ---- 路径决定的那几种
  if (path.startsWith('/json')) {
    return reply(
      { status: 200, reason: 'OK', headers: JSON_HEADERS },
      [
        // ⚠️ 这两块拼起来是**一份合法 JSON**（e2e 里靠「排开」那条断言钉着）——
        // 中间那个引号曾经多写了一个，结果整份 JSON 解析不了，界面上看就是
        // 「JSON 没被美化」。假实现给的正文只有语法正确才有意义。
        '{"users":[{"id":1,"name":"阿德","tags":["admin","ops"]},{"id":2,"name":"小北","tags":[]}],',
        '"page":1,"total":2}',
      ],
      url,
    );
  }

  if (path.startsWith('/text')) {
    // ⚠️ 故意把一块切在一个汉字的中间（「阿|德」之间）—— 前端那条流式解码
    // 要是写错了，这里就会显示成两个替换字符。这条路由存在的全部理由就是这个。
    return reply(
      { status: 200, reason: 'OK', headers: [['content-type', 'text/plain; charset=utf-8']] },
      ['第一块，切在汉字的中间：阿', '德和小北都在这里。\n', '第三块，收尾。\n'],
      url,
    );
  }

  if (path.startsWith('/slow') || path.startsWith('/events')) {
    return reply(
      { status: 200, reason: 'OK', headers: [['content-type', 'text/event-stream']] },
      [
        'event: message\ndata: {"n":1}\n\n',
        'event: message\ndata: {"n":2}\n\n',
        'event: message\ndata: {"n":3}\n\n',
        'event: done\ndata: [DONE]\n\n',
      ],
      url,
      { latencyMs: 20, chunkDelayMs: 90 },
    );
  }

  if (path.startsWith('/binary')) {
    // 一小段 PNG 的头（不是完整图片，够验十六进制视图和「不是文本」那条判断）
    return reply(
      { status: 200, reason: 'OK', headers: [['content-type', 'image/png']] },
      ['\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00'],
      url,
    );
  }

  if (path.startsWith('/big')) {
    // 3 MiB —— 超过 2 MiB 的转发上限（`services/web.ts` 和 Rust 侧同一个数）
    const megabyte = 'x'.repeat(1024 * 1024);
    return reply(
      { status: 200, reason: 'OK', headers: [['content-type', 'text/plain']] },
      [megabyte, megabyte, megabyte],
      url,
      { latencyMs: 10, chunkDelayMs: 5 },
    );
  }

  if (path.startsWith('/error')) {
    return reply(
      { status: 500, reason: 'Internal Server Error', headers: JSON_HEADERS },
      ['{"error":"这个演示服务端故意炸了","hint":"换个路径，比如 /json"}'],
      url,
      { latencyMs: 30 },
    );
  }

  if (path.startsWith('/cut')) {
    // 响应头 + 一块正文，然后**断掉** —— 「收到一半之后连接没了」那条路
    return {
      latencyMs: 20,
      head: { status: 200, reason: 'OK', headers: [['content-type', 'text/plain']], finalUrl: url, redirects: [] },
      chunks: ['前半截正文（它后面就断了）'],
      chunkDelayMs: 10,
      failAfterChunks: 1,
      fail: { errorKind: 'body', message: '读响应体时断了：connection reset by peer' },
    };
  }

  if (path.startsWith('/secret')) {
    const hasAuth = headers.some(([k]) => k.toLowerCase() === 'authorization');
    if (!hasAuth) {
      return reply(
        { status: 401, reason: 'Unauthorized', headers: JSON_HEADERS },
        ['{"error":"没带 Authorization 头","hint":"在「头」那一页加一条 authorization 再发"}'],
        url,
        { latencyMs: 20 },
      );
    }
    return reply(
      { status: 200, reason: 'OK', headers: JSON_HEADERS },
      ['{"ok":true,"who":"带了 Authorization 的你"}'],
      url,
    );
  }

  if (path.startsWith('/loop')) {
    // 绕圈：跟跳转的话一定撞上限（不然就是死循环）
    if (options.followRedirects) {
      if (options.maxRedirects < 1) {
        return fail('redirect', '跳转超过 0 次，停手了：' + url + ' → ' + url, 10);
      }
      return fail(
        'redirect',
        `跳转超过 ${options.maxRedirects} 次，停手了：${url} → ${url}`,
        10 + options.maxRedirects * 5,
      );
    }
    return reply(
      { status: 302, reason: 'Found', headers: [['location', '/loop']] },
      [],
      url,
      { latencyMs: 10 },
    );
  }

  if (path.startsWith('/redirect')) {
    if (options.followRedirects) {
      if (options.maxRedirects < 1) {
        return fail('redirect', `跳转超过 0 次，停手了：${url} → ${url.replace('/redirect', '/json')}`, 10);
      }
      // 跟过去了：正文是 /json 那份，头是 200，另附一条跳转记录
      const to = url.replace('/redirect', '/json');
      return reply(
        { status: 200, reason: 'OK', headers: JSON_HEADERS, finalUrl: to, redirects: [{ status: 302, from: url, to }] },
        ['{"users":[{"id":1,"name":"阿德"}],"page":1,"total":1}'],
        to,
        { latencyMs: 25 },
      );
    }
    return reply(
      { status: 302, reason: 'Found', headers: [['location', '/json']] },
      ['（这一条不会显示：跟着跳转的话你会看到 /json 的内容）'],
      url,
      { latencyMs: 20 },
    );
  }

  // ---- 默认：回显
  const head = { status: 200, reason: 'OK', headers: JSON_HEADERS };
  if (upper === 'HEAD') {
    // HEAD 按规矩**不带正文**（但头和 GET 一样）
    return reply(head, [], url, { latencyMs: 15 });
  }
  return reply(head, [echoBody(upper, url, headers, body)], url, { latencyMs: 20 });
}
