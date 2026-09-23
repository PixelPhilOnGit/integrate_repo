/**
 * 「接口调试」的数据形状。
 *
 * 这里只有**纯类型**（没有函数、不 import 任何东西）—— 形状和逻辑分开，
 * 是为了逻辑那几块（`draft.ts` / `history.ts` / `body.ts`）能在不 import
 * 任何界面代码的前提下被单测直接调。
 */

/** 请求头的一行（编辑器里那一行）。 */
export interface HeaderRow {
  /** 只给 React 当 key 用。 */
  id: string;
  name: string;
  value: string;
  /**
   * 这一行发不发。
   *
   * ⚠️ **不能用「把 name 清空」代替**：调接口时最常用的动作就是「这条头
   * 先关掉试试」，而清空之后想再打开就得重新打一遍名字。
   */
  enabled: boolean;
}

/**
 * 发出去时可调的那几项。
 *
 * ⚠️ 默认值必须和 Rust 那边（`request_commands.rs` 的 `OptionsSpec`）以及
 * 传输层（`RequestOptions::default()`）**三处一致** —— 不一致的症状是
 * 「界面显示 30 秒，实际等 90 秒」，而那种偏差没人会去查。
 */
export interface RequestOptions {
  /** 建连 + TLS 握手 + 等响应头的上限（秒）。 */
  timeoutSecs: number;
  /** 响应体两块数据之间的上限（秒）。 */
  idleTimeoutSecs: number;
  /** 跟不跟 3xx。 */
  followRedirects: boolean;
  /** 最多跟几跳。 */
  maxRedirects: number;
  /** ⚠️ 跳过证书链校验（只跳链、不跳签名）。界面上有红字，默认关。 */
  acceptInvalidCerts: boolean;
}

/**
 * 一份请求草稿 —— 编辑器里正在编辑的那个东西。
 *
 * ⚠️ 它同时是「历史条目」和「保存的请求」身体里装的那份东西：
 * 点一下历史就能回到当时的请求，靠的就是**整份草稿都存下来了**。
 */
export interface RequestDraft {
  /**
   * ⚠️ 是 `string` 而不是 `'GET' | 'POST' | ...` 这种联合类型：
   * 传输层**没有方法白名单**（`PROPFIND`、各家自己造的扩展方法都合法，
   * 而且调接口的时候用到的恰恰是那些）。写死成联合类型的话，
   * 界面会拦住用户真的想发的方法。
   */
  method: string;
  /** 完整地址，比如 `https://api.example.com/users?page=2`。 */
  url: string;
  headers: HeaderRow[];
  /** 请求体。空串 = 不带 body（不是「带一个空的 body」）。 */
  body: string;
  options: RequestOptions;
}

/** 一次跳转。 */
export interface RedirectInfo {
  status: number;
  from: string;
  to: string;
}

/** 响应头到手之后的那一堆（`started` 事件）。 */
export interface ResponseHead {
  status: number;
  reason: string;
  /** 保序、重复的都在。 */
  headers: Array<[string, string]>;
  finalUrl: string;
  redirects: RedirectInfo[];
  httpVersion: string;
  /**
   * 从点「发送」到响应头到手（含建连和 TLS）。
   *
   * ⚠️ 它和传输层内部那个 `ttfb` 不是一回事（那个不含建连）。
   * 界面上显示这个 —— 用户的心理模型是「我点了发送之后等了多久」。
   */
  elapsedMillis: number;
}

/** 一次请求的结局（历史里记的就是它）。 */
export type RequestOutcome =
  | {
      kind: 'ok';
      status: number;
      totalMillis: number;
      bytes: number;
      /** 撞上转发的 2 MiB 上限了。 */
      truncated: boolean;
    }
  | {
      kind: 'failed';
      /** 传输层给的大类（`connect` / `tls` / `timeout` / `idle` / …）。 */
      errorKind: string;
      message: string;
      /** 出错之前已经收到的字节数（正文读了一半才断的那种）。 */
      bytes: number;
    };

/** 历史里的一条。 */
export interface HistoryEntry {
  id: string;
  /** 发出去的时刻（毫秒）。 */
  at: number;
  /** 列表上直接显示这两个（不用去翻草稿）。 */
  method: string;
  url: string;
  outcome: RequestOutcome;
  /** 当时那份请求 —— 点一下就整份回到编辑器里。 */
  draft: RequestDraft;
}

/** 保存下来、起了名字的那条。 */
export interface SavedRequest {
  id: string;
  name: string;
  savedAt: number;
  draft: RequestDraft;
}

/**
 * 正在跑/刚跑完的那个响应。
 *
 * ⚠️ 正文是**边收边解**的（`text` 一直是最新的），所以界面上的「正在打字」
 * 效果不需要等整条响应回来。逐块解码由 `core/body.ts` 的 `BodyStream` 管 ——
 * 那里处理了「一个汉字被切在两个块之间」那件事。
 */
export interface ResponseState {
  phase: 'idle' | 'running' | 'done' | 'failed';
  head: ResponseHead | null;
  /** 解出来的正文（文本）。二进制内容这里会是替换字符，界面走十六进制那条路。 */
  text: string;
  /** 收到的原始字节数。 */
  bytes: number;
  /** 前多少个字节（画十六进制预览用，不攒整条响应）。 */
  prefix: Uint8Array;
  truncated: boolean;
  error: { errorKind: string; message: string; bytes: number } | null;
  totalMillis: number | null;
}

/** 一条都没有的空响应（模块刚打开时）。 */
export function emptyResponse(): ResponseState {
  return {
    phase: 'idle',
    head: null,
    text: '',
    bytes: 0,
    prefix: new Uint8Array(),
    truncated: false,
    error: null,
    totalMillis: null,
  };
}
