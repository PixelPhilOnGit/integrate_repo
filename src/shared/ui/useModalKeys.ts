/**
 * 弹框的焦点圈与键盘行为 —— 2026-10-15 体验评审落下的「全仓一起做」。
 *
 * 背景（评审实测，不是推演）：全仓五个弹框都没有焦点圈 —— Tab 六七次就能
 * 走到弹框**背后**的界面；ssh 首次连接的指纹弹窗出现时焦点还在 BODY 上，
 * Tab 两下再回车就换了模块；助手审批出现时焦点停在刚点过的那个按钮上
 * （它刚好从「发送」变成了「停止」），一次回车把整轮对话铡了。
 *
 * 这个 hook 管三件事：
 *
 *   1. **焦点圈**：Tab / Shift+Tab 在弹框内部循环，出不去。
 *   2. **进场焦点**：挂载后焦点若不在弹框里，聚焦第一个可聚焦元素。
 *      各弹框**自己的 `autoFocus` 优先**（React 在 effects 之前就处理了，
 *      这里只在它没管的情况下兜底）。
 *   3. **退场还回去**：关掉后焦点回到打开它的那个元素。
 *
 * 外加一个可选的回车提交：**只在输入框/下拉里生效** —— 按钮上的回车走原生
 * 点击（别把「取消」的回车吞成提交），多行框里回车是换行，也要放行。
 *
 * ⚠️ **背板点击关闭、背景 `inert` 这两条这轮没做**，各有理由：
 * 前者和「在弹框里拖选文字、松手落在背板上」相冲（见 ConnectionDialog 旧注释）；
 * 后者（`inert` 属性）在老一点的 WebKitGTK 上不可用，桌面端内核版本不由我们定。
 */
import { useEffect, useRef, type RefObject } from 'react';

/** 可聚焦元素。`[tabindex="-1"]` 是拿来找回焦点的，不算 Tab 站 */
const FOCUSABLE =
  'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

export interface ModalKeysOptions {
  /** 弹框的容器元素（`.rd-modal` 那一层就够，不必整个背板） */
  ref: RefObject<HTMLElement | null>;
  /**
   * 弹框内容现在在不在。默认 `true`（宿主组件随开随卸的场景）。
   * ⚠️ **宿主常驻、内容条件渲染**的弹框必须传它（ssh 的信任弹窗就是）——
   * 那种情况下 hook 首次运行时 `ref.current` 还是 null，不重跑的话
   * 监听永远注册不上（而且 autoFocus 会把「看着能用」演得很像）。
   */
  open?: boolean;
  /**
   * 回车提交（可选）。传了它，焦点在输入框/下拉里按回车就会调这个；
   * 不传 = 这个弹框没有回车语义（比如纯确认框）。
   */
  onSubmit?: () => void;
}

export function useModalKeys({ ref, open = true, onSubmit }: ModalKeysOptions): void {
  // 回调每次渲染都是新函数 —— 用 ref 兜住，别让 effect 反复重挂
  // （重挂会把「退场还焦点」提前触发成「每帧还一次」）
  const latestSubmit = useRef(onSubmit);
  latestSubmit.current = onSubmit;

  useEffect(() => {
    if (!open) return;
    const root = ref.current;
    if (!root) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const focusables = (): HTMLElement[] =>
      Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.getClientRects().length > 0
      );

    if (!root.contains(document.activeElement)) {
      focusables()[0]?.focus();
    }

    const onKeyDown = (e: KeyboardEvent): void => {
      const inside = root.contains(e.target as Node);

      if (e.key === 'Enter') {
        if (!inside) return;
        const tag = (e.target as HTMLElement).tagName;
        if ((tag === 'INPUT' || tag === 'SELECT') && latestSubmit.current) {
          e.preventDefault();
          latestSubmit.current();
        }
        return;
      }

      if (e.key !== 'Tab') return;
      const list = focusables();
      const first = list[0];
      const last = list[list.length - 1];
      if (first === undefined || last === undefined) return;
      const active = document.activeElement;

      if (!inside) {
        // 焦点不知怎么跑到弹框外了（元素被卸载、或者从 BODY 进来）——
        // 拉回弹框里，别让它继续在背景界面里漫游
        e.preventDefault();
        first.focus();
        return;
      }
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      // 焦点还回打开它的那个按钮；那个元素已经被卸载了就算了
      if (previous !== null && document.contains(previous)) previous.focus();
    };
  }, [ref, open]);
}
