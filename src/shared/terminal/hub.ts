/**
 * 终端实例的持有者。
 *
 * # 为什么它不在 React 里
 *
 * 终端字节是每秒几十次的流。走 store 的话每一次都会触发一次
 * `useSyncExternalStore` 的更新，侧栏、标签栏、检查器全跟着重渲染。
 * 所以字节走这条路：**Rust → 服务层 → 这里 → xterm**，
 * React 全程看不见它们，它只管标签、状态、退出码那些人手级别的信息。
 *
 * # 为什么是「藏起来」而不是「销毁重建」
 *
 * 切到别的模块再回来，会话不该断，而且**画面也该还在**。
 *
 * 一开始想的是「销毁 xterm、回来时用缓冲里的字节重放」。那行不通：裸字节
 * 重建不出终端的**状态** —— `DECCKM`（vim/less 里方向键要发什么序列）、
 * bracketed paste、备用屏幕、滚动区域、光标可见性，全都是会话早期设置一次的
 * **粘性模式**，不在最近的输出里。重放的结果是全屏程序切回来就永久花屏，
 * 而且因为重排之后尺寸没变**不会发 SIGWINCH**，vim 不会重绘。
 *
 * 所以做法是：挂着，但挪到屏幕外。容器保持有布局（固定尺寸），xterm 继续
 * 正常工作，回来时再挪回 React 给的宿主节点里。
 *
 * ⚠️ 代价是每个会话常驻一份 xterm 实例和一段 DOM。所以 `dispose` 必须真的
 * 把东西清掉 —— 会话关掉却不释放，开一天下来就是一串看不见的终端在吃内存。
 *
 * # 为什么在 shared 里
 *
 * SSH 和智能体会话两个模块都要用这一份，而它不认识任何模块 —— 只认
 * `HubHooks` 那两个出口，由各模块的 store 自己接上。共享的代价是
 * **类名不能再带模块前缀**了（`.rd-term*`），这反而是对的：
 * 它描述的本来就是「被 hub 塞进来的那些节点」长什么样，和哪个模块无关。
 */

import { createCoalescer, type Coalescer } from './coalesce';
import { clampSize, hasLayout, sameSize, type TermSize } from './fit';

type XtermModule = typeof import('@xterm/xterm');
type FitModule = typeof import('@xterm/addon-fit');

/**
 * xterm 走动态 import。
 *
 * 模块注册表是**在启动路径上**把各个模块都拉起来的（见 `shell/registry.ts`），
 * 所以静态 import 会让每个用户无论用不用终端都先下载解析一遍 xterm。
 * 这里缓存一份 promise，第一次真正要开会话时才加载。
 *
 * 缓存在模块级而不是实例级：两个模块各建一个 hub 时，xterm 也只加载一次。
 */
let xtermModule: Promise<[XtermModule, FitModule]> | null = null;

function loadXterm(): Promise<[XtermModule, FitModule]> {
  xtermModule ??= Promise.all([
    import('@xterm/xterm'),
    import('@xterm/addon-fit'),
    // xterm 自带一份样式表（光标、选中、滚动条、渲染层的定位），不加载的话
    // 终端能跑但长得完全不对。它是跟着 xterm 懒加载的：全程序只有这一个模块
    // 用到，没必要让每个用户在启动时都下载它 —— Vite 会把它注入成 style 标签
    import('@xterm/xterm/css/xterm.css'),
  ]).then(([xterm, fit]) => [xterm, fit]);
  return xtermModule;
}

/** 一个会话对应的一份东西 */
interface Entry {
  term: import('@xterm/xterm').Terminal;
  fit: import('@xterm/addon-fit').FitAddon;
  container: HTMLDivElement;
  /** 只在挂载期间存在 */
  observer: ResizeObserver | null;
  /** 当前已经报给远端的尺寸。用来做「没变就不发」的判断 */
  size: TermSize | null;
  disposed: boolean;
  /** 上一次 fit 的调度。用来合并同一个动画帧里的多次触发 */
  frame: number | null;
}

export interface HubHooks {
  /** 用户敲了键盘 */
  onInput: (sessionId: string, data: Uint8Array) => void;
  /** 终端尺寸变了（已经夹过、确认可用） */
  onResize: (sessionId: string, cols: number, rows: number) => void;
}

/**
 * 尺寸变化的合并窗口。
 *
 * 100ms 是权衡出来的：人眼察觉不到「拖完手一停才对齐」，而重排次数从每秒
 * 几十次降到十次以内。再长一点（200ms+）拖动时会明显觉得画面跟不上手。
 */
const RESIZE_COALESCE_MS = 100;

export interface TerminalHubOptions {
  /**
   * 终端容器的 `data-testid` 前缀，结果是 `<前缀>-<会话 id>`。
   *
   * 要按模块区分：测试和「找到某个会话的终端」都靠它，两个模块用同一个前缀
   * 的话，选择器会同时命中活着的和躺着的两批容器（历史上有过一次）。
   */
  testIdPrefix: string;
}

export class TerminalHub {
  private entries = new Map<string, Entry>();

  /**
   * 屏幕外的存放点。**每个 hub 一份**。
   *
   * 关键是**不能 `display: none`** —— 那样 `clientWidth` 变成 0，
   * xterm 量不到尺寸，`fit()` 会算出垃圾值。所以用 `fixed` + 挪到视口外
   * 两万像素的地方，尺寸照常给。
   *
   * 挂在 `document.body` 上而不是某个 React 节点里：React 会随模块卸载把自己的
   * 节点删掉，挂在里面的话切模块就跟着没了。
   */
  private holder: HTMLDivElement | null = null;

  /**
   * 每一路的尺寸变化都先合并再发。
   *
   * 拖动分隔条的时候尺寸每帧都在变，而**连续 resize 会让 ConPTY 损坏输出**
   * （wezterm 作者的原话 + Windows Terminal #15935）。合并之后拖动期间几乎不发，
   * 手一停发最终尺寸 —— 详见 `coalesce.ts`。
   */
  private resizers = new Map<string, Coalescer<TermSize>>();

  /**
   * 两个出口由 store 在构造时接上。
   *
   * 做成可写字段而不是构造参数，是为了避开 store ↔ hub 的循环依赖：
   * hub 不认识 store，store 认识 hub。
   */
  onInput: HubHooks['onInput'] = () => {};
  onResize: HubHooks['onResize'] = () => {};

  constructor(private options: TerminalHubOptions) {}

  private holderEl(): HTMLDivElement {
    if (this.holder) return this.holder;
    this.holder = document.createElement('div');
    this.holder.className = 'rd-term-holder';
    this.holder.setAttribute('aria-hidden', 'true');
    document.body.appendChild(this.holder);
    return this.holder;
  }

  /**
   * 建一个终端。**必须在调服务层的 `open` 之前 await 完**。
   *
   * 这个顺序是刻意的：`open` 一返回，事件就可能开始到达（快的时候横幅会在
   * `open` 的 promise 决议之前就到），那时候终端必须已经在了。
   * 否则就得再写一套「先攒着等终端好了再灌」的缓冲，而那套缓冲本身又是个
   * 竞态来源。
   */
  async create(sessionId: string, cols: number, rows: number): Promise<void> {
    const [xterm, fitModule] = await loadXterm();
    if (this.entries.has(sessionId)) return; // 并发建同一个会话时以先到的为准

    const term = new xterm.Terminal({
      cols,
      rows,
      // 和仓库里其它等宽输出区域用同一套字体栈（styles.css 里的那份）
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 12,
      lineHeight: 1.2,
      cursorBlink: true,
      // 回滚行数。会话常驻内存，给太多会每个标签都吃掉一大块
      scrollback: 5000,
      // 让 xterm 自己处理重排，窗口拉伸时不会出现断行错乱
      convertEol: false,
      allowProposedApi: true,
    });
    const fit = new fitModule.FitAddon();
    term.loadAddon(fit);

    const container = document.createElement('div');
    container.className = 'rd-term';
    container.dataset['testid'] = `${this.options.testIdPrefix}-${sessionId}`;

    term.open(container);

    // 键盘 → 后端
    term.onData((data) => {
      this.onInput(sessionId, new TextEncoder().encode(data));
    });

    installClipboard(term);

    const entry: Entry = {
      term,
      fit,
      container,
      observer: null,
      size: clampSize(cols, rows),
      disposed: false,
      frame: null,
    };
    this.entries.set(sessionId, entry);

    // 先放进存放点：建好到挂载之间可能有一小会儿，那期间它也得有个有布局的地方
    this.holderEl().appendChild(container);
  }

  /** 把终端挪进 React 给的宿主节点，并开始跟随尺寸变化 */
  attach(sessionId: string, host: HTMLElement): void {
    const entry = this.entries.get(sessionId);
    if (!entry || entry.disposed) return;

    host.appendChild(entry.container);

    // 观察宿主而不是终端自己：终端自己的尺寸是我们 fit 出来的，
    // 观察它会变成「fit 改尺寸 → 触发观察 → 再 fit」的自激循环
    entry.observer?.disconnect();
    if (typeof ResizeObserver !== 'undefined') {
      entry.observer = new ResizeObserver(() => this.scheduleFit(sessionId));
      entry.observer.observe(host);
    }
    this.scheduleFit(sessionId);
  }

  /** 挪回屏幕外。会话留着，画面也留着 */
  detach(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (!entry || entry.disposed) return;

    // 藏起来的时候要停掉观察：存放点是固定尺寸，继续观察只会产生噪声
    entry.observer?.disconnect();
    entry.observer = null;
    if (entry.frame !== null) {
      cancelAnimationFrame(entry.frame);
      entry.frame = null;
    }
    this.holderEl().appendChild(entry.container);
  }

  /**
   * 把 fit 推到下一个动画帧，并且**同一帧里只做一次**。
   *
   * `ResizeObserver` 在一次布局变化里可能回调好几次，而 `fit()` 自己会改
   * 终端尺寸 —— 直接在回调里 fit 会撞上「ResizeObserver loop completed with
   * undelivered notifications」那个警告，有时候还会来回抖。
   */
  private scheduleFit(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (!entry || entry.disposed || entry.frame !== null) return;

    entry.frame = requestAnimationFrame(() => {
      entry.frame = null;
      this.fitNow(sessionId);
    });
  }

  /** 量一次、夹一次、变了才报 */
  fitNow(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (!entry || entry.disposed) return;
    // 没布局（隐藏的标签页、还没挂上的节点）时量出来的值是垃圾
    if (!hasLayout(entry.container.parentElement)) return;

    try {
      entry.fit.fit();
    } catch {
      // fit 在极端尺寸下会抛（分母为零之类）。量不到就当这次没量到，
      // 下一次尺寸变化还会再来
      return;
    }

    const proposed = clampSize(entry.term.cols, entry.term.rows);
    if (proposed === null) return;
    // 尺寸没变就不发 —— 远端每次 resize 都要重排，白发的那些会让全屏程序闪烁
    if (sameSize(proposed, entry.size)) return;

    entry.size = proposed;
    this.resizerFor(sessionId).push(proposed);
  }

  /** 每一路一个合并器，用的时候才建 */
  private resizerFor(sessionId: string): Coalescer<TermSize> {
    let c = this.resizers.get(sessionId);
    if (c === undefined) {
      c = createCoalescer(RESIZE_COALESCE_MS, (size) => {
        this.onResize(sessionId, size.cols, size.rows);
      });
      this.resizers.set(sessionId, c);
    }
    return c;
  }

  /** 远端来的字节 */
  feed(sessionId: string, bytes: Uint8Array): void {
    const entry = this.entries.get(sessionId);
    if (!entry || entry.disposed) return;
    entry.term.write(bytes);
  }

  /** 往终端里写一行提示（会话结束时用）。会话不在了就静静地算了 */
  note(sessionId: string, text: string): void {
    const entry = this.entries.get(sessionId);
    if (!entry || entry.disposed) return;
    // 先重置属性：退出时终端可能还停在某个颜色或反显里，
    // 不重置的话这行提示会带着上一条命令的颜色
    entry.term.write(`\r\n\x1b[0m\x1b[2m${text}\x1b[0m\r\n`);
  }

  /**
   * 彻底销毁。**会话关掉时必须调** —— 见文件头部关于内存的那段。
   *
   * 顺序要紧：**先摘掉回调再 dispose**。反过来的话，dispose 之后还可能有
   * 一拍迟到的 `feed()` 摸到这个已经销毁的终端，xterm 会抛。
   */
  dispose(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (!entry) return;

    this.entries.delete(sessionId);
    entry.disposed = true;

    // 挂着的那个尺寸别再发了：会话已经没了
    this.resizers.get(sessionId)?.cancel();
    this.resizers.delete(sessionId);

    if (entry.frame !== null) cancelAnimationFrame(entry.frame);
    entry.observer?.disconnect();
    entry.observer = null;

    try {
      entry.term.dispose();
    } catch {
      // 已经销毁过就别管了
    }
    entry.container.remove();
  }

  has(sessionId: string): boolean {
    return this.entries.has(sessionId);
  }

  /** 当前挂着的会话数。测试用来盯「有没有泄漏」 */
  size(): number {
    return this.entries.size;
  }

  /**
   * 终端里已经渲染出来的文本。
   *
   * 给测试和「复制全部」这类功能用。读的是 xterm 自己的缓冲区而不是 DOM ——
   * DOM 里的内容是渲染器的事，换成 canvas 渲染就什么都没有了。
   */
  snapshot(sessionId: string): string | null {
    const entry = this.entries.get(sessionId);
    if (!entry || entry.disposed) return null;

    const buffer = entry.term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buffer.length; i += 1) {
      const line = buffer.getLine(i);
      if (line) lines.push(line.translateToString(true));
    }
    // 末尾那些空行是缓冲区自带的，去掉才好断言
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines.join('\n');
  }
}

/** 各模块调这个建自己的实例（一个模块一个，别在组件里建） */
export function createTerminalHub(options: TerminalHubOptions): TerminalHub {
  return new TerminalHub(options);
}

/**
 * 复制粘贴。
 *
 * 只接管**复制**（`Ctrl+Shift+C`，macOS 上是 `Cmd+C` 带选中时）：
 * 终端里 `Ctrl+C` 必须是 SIGINT，不能是复制。
 *
 * 粘贴走浏览器原生的那条路（xterm 的隐藏 textarea 会收到 paste 事件），
 * 所以 `Ctrl+V` / `Cmd+V` 不用管。⚠️ 但 `navigator.clipboard` 在 Tauri 的
 * WebView 里能不能用**没有验证过**（code-server 当初就是因为不是安全上下文
 * 才改的 HTTPS）。真机上要是复制不出来，退路是
 * `tauri-plugin-clipboard-manager`。
 */
function installClipboard(term: import('@xterm/xterm').Terminal): void {
  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown') return true;

    const copyCombo =
      (event.ctrlKey && event.shiftKey && event.code === 'KeyC') ||
      (event.metaKey && !event.ctrlKey && event.code === 'KeyC');

    if (!copyCombo) return true;

    const selection = term.getSelection();
    if (selection !== '') {
      void navigator.clipboard?.writeText(selection).catch(() => {
        // 写不了剪贴板就算了：用户还能用鼠标选中再右键复制。
        // 这里不弹错误条 —— 复制失败不值得打断他正在做的事
      });
    }
    // 不管有没有选中都拦下：不拦的话 Ctrl+Shift+C 会被当成普通按键
    // 发到远端，变成一个莫名其妙的控制字符
    return false;
  });
}
