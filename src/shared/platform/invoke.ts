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
 * 这个函数**只给模块自己的平台桥用**。平台层自身的能力（文件读写、系统对话框）
 * 必须走 `Platform` 接口 —— 否则任何模块都能拿它绕过平台抽象直接捅后端，
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
