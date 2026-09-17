/**
 * 撤销/重做。
 *
 * 用快照栈而不是命令逆操作：值本身是不可变的，每次改动都产生新对象但共享
 * 未改动的子结构，所以一次快照的实际内存开销远小于"整个文档的副本"。
 * 换来的是 undo/redo 有绝对正确性 —— 不需要为每个命令写一个逆命令，
 * 也就不会出现"删了参与者 undo 不回来"这类经典 bug。
 *
 * 拖拽的处理：拖拽过程中不希望每一步鼠标移动都进栈（否则 Ctrl+Z 要按几百次）。
 * 所以用 beginDrag() 记下起点，preview() 实时替换当前状态但不入栈，
 * endDrag() 才真正压栈。离散操作直接用 apply()。
 */


const MAX_DEPTH = 200;

export class History<T> {
  private past: T[] = [];
  private future: T[] = [];
  private current: T;
  /** 拖拽开始时的快照，null 表示当前不在拖拽中 */
  private pending: T | null = null;

  constructor(initial: T) {
    this.current = initial;
  }

  get value(): T {
    return this.current;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  /** 可撤销步数。UI 用它做灰化判断，测试用它验证"预览不入栈" */
  get undoDepth(): number {
    return this.past.length;
  }

  get redoDepth(): number {
    return this.future.length;
  }

  /** 离散操作：改完直接进历史 */
  apply(next: T): T {
    if (next === this.current) return this.current;
    this.pushPast(this.current);
    this.current = next;
    this.future = [];
    return this.current;
  }

  /** 开始拖拽 / 连续编辑 */
  beginDrag(): void {
    if (this.pending === null) this.pending = this.current;
  }

  /** 拖拽过程中的实时预览：替换当前状态但不进历史 */
  preview(next: T): T {
    this.current = next;
    return this.current;
  }

  /** 结束拖拽：只有真的变化了才进历史 */
  endDrag(): T {
    const before = this.pending;
    this.pending = null;
    if (before !== null && before !== this.current) {
      this.pushPast(before);
      this.future = [];
    }
    return this.current;
  }

  /** 放弃拖拽，回到起点 */
  cancelDrag(): T {
    if (this.pending !== null) {
      this.current = this.pending;
      this.pending = null;
    }
    return this.current;
  }

  undo(): T {
    const prev = this.past.pop();
    if (prev === undefined) return this.current;
    this.future.push(this.current);
    this.current = prev;
    return this.current;
  }

  redo(): T {
    const next = this.future.pop();
    if (next === undefined) return this.current;
    this.past.push(this.current);
    this.current = next;
    return this.current;
  }

  /** 换文档（打开另一个文件）时重置，历史不应该跨文件延续 */
  reset(doc: T): void {
    this.past = [];
    this.future = [];
    this.pending = null;
    this.current = doc;
  }

  private pushPast(doc: T): void {
    this.past.push(doc);
    if (this.past.length > MAX_DEPTH) this.past.shift();
  }
}
