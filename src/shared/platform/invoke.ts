/**
 * 调用一个 Rust command。
 *
 * 从 `platform/tauri.ts` 里提出来的：那里原本是个私有函数，但「调用后端命令」
 * 这个动作本身不含任何模块知识 —— 模块自己带的那套平台桥（`modules/<模块>/services/`）
 * 也要用它。提出来之后全项目只有**一份** `@tauri-apps/api/core` 的加载缓存。
 *
 * # 用动态 import 的理由
 *
 * 静态 import 会把 Tauri 的模块打进浏览器产物里，而某些插件在模块顶层就会去
 * 访问 `__TAURI_INTERNALS__`，在纯浏览器里直接抛错。动态 import + Promise 缓存
 * 既保证浏览器路径完全不加载它们，又不会每次调用都重新解析。
 *
 * # 边界（重要）
 *
 * 它给两处用：**模块自己的平台桥**（`modules/<模块>/services/tauri.ts`）和
 * **平台层自身的基础设施**（`platform/tauri.ts` 的文件操作、`platform/kv.ts`
 * 的键值存储）。模块**业务代码**不该直接用 —— 那会绕过平台抽象直接捅后端，
 * 这个文件就退化成万能口子了。
 */

type CoreModule = typeof import('@tauri-apps/api/core');

let coreMod: Promise<CoreModule> | null = null;

const core = (): Promise<CoreModule> => (coreMod ??= import('@tauri-apps/api/core'));

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: rawInvoke } = await core();
  try {
    return await rawInvoke<T>(cmd, args);
  } catch (e) {
    // Rust 侧返回的错误是字符串，包装成 Error 以便上层统一处理
    throw new Error(typeof e === 'string' ? e : String(e));
  }
}

/**
 * 建一个 IPC 通道，把收到的消息喂给 `onMessage`。
 *
 * 返回值直接当 `invoke(cmd, { channel })` 的参数用。类型在这里被擦成 `object`
 * 是有意的：调用方那边已经有具体的消息类型了，这里只负责「把回调接上」。
 *
 * # 两条必须遵守的用法
 *
 * 1. **一次通信用一个新通道，绝不跨调用复用。** Rust 侧把通道丢掉时会往 JS
 *    发一条 `{ end: true }`，JS 收到就**注销** `onmessage`。所以任何在发消息之前
 *    就返回的调用（比如一次被拒绝的连接）都会把这个通道打死 —— 之后的消息会
 *    石沉大海，终端一片空白而且**不报错**，非常难查。
 * 2. 通道**只有单向**（Rust → 前端）。回话走普通的 `invoke`。
 *
 * 它和 `invoke` 放同一个文件，是为了共用上面那份 `@tauri-apps/api/core` 的
 * 加载缓存 —— 分成两个文件就会各自动态 import 一次。
 */
export async function createChannel<T>(onMessage: (message: T) => void): Promise<object> {
  const { Channel } = await core();
  return new Channel<T>(onMessage) as object;
}
