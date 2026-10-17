/**
 * 外壳的检查器折叠（v0.16.0 起**默认折叠** —— 用户点名要的）。
 *
 * 这一组盯三件事：默认是折叠的、展开态**按模块各记各的**、以及模块通过
 * `ShellApi.openInspector()` 请外壳把检查器露出来时**只动当前模块**。
 *
 * 界面上的那半（把手、宽度、格子里的内容）归 e2e —— 这里测的是状态和落盘。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fakePrefs = vi.hoisted(() => ({
  data: { inspectorOpen: {} as Record<string, boolean> },
  /** 每次落盘存一份（断言「写了几次、写的是什么」都用它） */
  saved: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../src/shared/platform', () => ({
  platform: {
    getPrefs: async () => ({ ...fakePrefs.data }),
    setPrefs: async (patch: Record<string, unknown>) => {
      fakePrefs.saved.push(patch);
      if (patch.inspectorOpen !== undefined) {
        fakePrefs.data.inspectorOpen = patch.inspectorOpen as Record<string, boolean>;
      }
    },
  },
}));

import { ShellStore } from '../../src/shell/store';

beforeEach(() => {
  fakePrefs.data = { inspectorOpen: {} };
  fakePrefs.saved.length = 0;
  // 构造时要问一次系统主题（跟随系统那一档）
  (globalThis as { window?: unknown }).window = {
    matchMedia: () => ({ matches: false, addEventListener: () => {} }),
  };
});

describe('默认折叠', () => {
  it('没点开过的模块一律是折叠的', () => {
    const store = new ShellStore('redis');
    expect(store.inspectorOpen('redis')).toBe(false);
    expect(store.inspectorOpen('sql')).toBe(false);
  });

  it('点开一个模块，别的模块不受影响（按模块各记各的）', () => {
    const store = new ShellStore('redis');
    store.setInspectorOpen('redis', true);
    expect(store.inspectorOpen('redis')).toBe(true);
    expect(store.inspectorOpen('sql')).toBe(false);
  });

  it('展开状态会落盘 —— 下次启动还是开着', () => {
    const store = new ShellStore('redis');
    store.setInspectorOpen('redis', true);
    expect(fakePrefs.data.inspectorOpen).toEqual({ redis: true });
  });

  it('读回上次开着的那个模块', async () => {
    fakePrefs.data.inspectorOpen = { redis: true };
    const store = new ShellStore('redis');
    await store.initTheme();
    expect(store.inspectorOpen('redis')).toBe(true);
    expect(store.inspectorOpen('sql')).toBe(false);
  });

  it('已经开着再点一次不重复写盘（幂等 —— 少写一次就少一次磁盘扰动）', () => {
    const store = new ShellStore('redis');
    store.setInspectorOpen('redis', true);
    fakePrefs.saved.length = 0;
    store.setInspectorOpen('redis', true);
    expect(fakePrefs.saved).toHaveLength(0);
  });
});

describe('模块请外壳把它露出来（ShellApi.openInspector）', () => {
  it('开的是**当前模块** —— 模块不必知道自己的 id 该往哪儿开', () => {
    const store = new ShellStore('agents');
    store.openInspector();
    expect(store.inspectorOpen('agents')).toBe(true);
    expect(store.inspectorOpen('redis')).toBe(false);
  });

  it('只开不收 —— 模块没有权利把用户的检查器关掉', () => {
    const store = new ShellStore('agents');
    store.setInspectorOpen('agents', true);
    store.openInspector();
    expect(store.inspectorOpen('agents')).toBe(true);
  });

  it('切过模块之后请的是**新**那个模块的（回归：Ctrl+Shift+F 得开对面板）', () => {
    const store = new ShellStore('agents');
    store.activate('sql');
    store.openInspector();
    expect(store.inspectorOpen('sql')).toBe(true);
    expect(store.inspectorOpen('agents')).toBe(false);
  });
});
