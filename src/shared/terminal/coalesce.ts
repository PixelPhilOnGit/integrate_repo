/**
 * 尾部合并：连续来的值只把**最后一个**送出去。
 *
 * # 为什么需要它（不是「优化」，是正确地性问题）
 *
 * 拖动分隔条时，尺寸每一帧都在变。每一帧都发给 PTY 的话：
 *
 * - **Windows 的 ConPTY 会损坏输出**。这不是我们的猜测：wezterm 作者的原话是
 *   「cursor moves up and then conpty decides to repaint the screen at that
 *   position, corrupting the output」，Windows Terminal 的 issue #15935 里
 *   记着同源的大量重复行。
 * - 就算不损坏，让里面的进程每秒重排六十次也没意义 —— 它要的是**最终尺寸**。
 *
 * 所以合并之后再发：拖动期间看着是「卡一下」，停下来立刻对齐。
 * 100ms 这个量级人眼察觉不到，而重排次数从每秒几十次降到十次以内。
 *
 * # 为什么是尾部而不是首部
 *
 * 首部合并（leading edge）会漏掉最后那一下 —— 而**最后那一下才是用户要的尺寸**。
 * 拖到一半松手，界面停在一个中间宽度上，那是明显的 bug。
 */

export interface Coalescer<T> {
  /** 推一个新值。它会替换掉还没送出去的那个 */
  push(value: T): void;
  /** 取消还没送出去的那个（会话关了、元素卸载了） */
  cancel(): void;
  /** 立刻送出挂着的那个，不等计时器。给测试和「切走前先对齐」用 */
  flush(): void;
}

export function createCoalescer<T>(
  delayMs: number,
  send: (value: T) => void,
  /** 注入计时器只是为了让测试不依赖真实时间；生产不传 */
  timer: {
    setTimeout: (fn: () => void, ms: number) => unknown;
    clearTimeout: (handle: unknown) => void;
  } = {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  },
): Coalescer<T> {
  let pending: { value: T } | null = null;
  let handle: unknown = null;

  const clear = (): void => {
    if (handle !== null) timer.clearTimeout(handle);
    handle = null;
  };

  return {
    push(value: T): void {
      pending = { value };
      // 每来一个新值就**重置**计时器：连续拖动期间一个都不会发出去，
      // 手一停才发最后那一个
      clear();
      handle = timer.setTimeout(() => {
        handle = null;
        const out = pending;
        pending = null;
        if (out !== null) send(out.value);
      }, delayMs);
    },

    cancel(): void {
      clear();
      pending = null;
    },

    flush(): void {
      clear();
      const out = pending;
      pending = null;
      if (out !== null) send(out.value);
    },
  };
}
