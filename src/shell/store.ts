/**
 * 外壳状态。
 *
 * 刻意**只有三样东西**：当前模块、状态栏文字、错误。
 * 工作区、文件树、文档这些都属于具体模块 —— 外壳不认识它们。
 *
 * 和模块的 store 互不引用：模块通过构造时注入的 ShellApi 往外说话，
 * 外壳不知道任何模块的存在（只认注册表里的 Module 接口）。
 */

import type { ShellApi } from './types';

export interface ShellState {
  /** 当前模块 id */
  activeModule: string;
  status: string | null;
  error: string | null;
}

export class ShellStore implements ShellApi {
  private listeners = new Set<() => void>();
  private state: ShellState;

  constructor(initialModule: string) {
    this.state = { activeModule: initialModule, status: null, error: null };
  }

  // ---------------------------------------------------------------- 订阅

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getSnapshot = (): ShellState => this.state;

  private set(patch: Partial<ShellState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }

  // ---------------------------------------------------------------- ShellApi

  setStatus = (msg: string | null): void => {
    this.set({ status: msg });
  };

  reportError = (e: unknown): void => {
    this.set({ error: describeError(e) });
  };

  clearError = (): void => {
    this.set({ error: null });
  };

  // ---------------------------------------------------------------- 模块切换

  activate(id: string): void {
    if (this.state.activeModule === id) return;
    // 切模块时清掉上一个模块留下的状态文字，否则会挂着一条不相干的消息
    this.set({ activeModule: id, status: null, error: null });
  }
}

/** 把任意抛出物转成可读的中文提示 */
export function describeError(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}
