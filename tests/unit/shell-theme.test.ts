/**
 * 外壳的外观切换。
 *
 * 纯逻辑（选择 → 解析）在 `theme.test.ts` 里。这一组测的是**接线**：
 * 什么时候应用、存的是什么、系统主题变化时跟不跟。
 * 这几个恰恰是「设置好像没生效」这类问题的来源。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fakePrefs = vi.hoisted(() => ({
  data: { recentWorkspaces: [] as string[], lastWorkspace: null as string | null, theme: 'system' },
  saved: [] as string[],
  /** 让下一次读盘失败（测「读不出来也要能用」） */
  failGet: false,
}));
vi.mock('../../src/shared/platform', () => ({
  platform: {
    getPrefs: async () => {
      if (fakePrefs.failGet) throw new Error('读不了');
      return { ...fakePrefs.data };
    },
    setPrefs: async (patch: { theme?: string }) => {
      if (patch.theme !== undefined) {
        fakePrefs.data.theme = patch.theme;
        fakePrefs.saved.push(patch.theme);
      }
    },
  },
}));

import { ShellStore } from '../../src/shell/store';

/** 假的 <html>，用来读 data-theme */
const root = { dataset: {} as Record<string, string>, style: {} as Record<string, string> };
/** 假媒体查询：能读 matches，也能手动触发 change */
let systemDark = false;
const mediaListeners: Array<() => void> = [];

function setSystemDark(dark: boolean): void {
  systemDark = dark;
  for (const fn of mediaListeners) fn();
}

beforeEach(() => {
  root.dataset = {};
  root.style = {};
  systemDark = false;
  mediaListeners.length = 0;
  fakePrefs.data.theme = 'system';
  fakePrefs.saved.length = 0;
  fakePrefs.failGet = false;

  (globalThis as { window?: unknown }).window = {
    matchMedia: () => ({
      get matches() {
        return systemDark;
      },
      addEventListener: (_event: string, fn: () => void) => mediaListeners.push(fn),
    }),
  };
  (globalThis as { document?: unknown }).document = { documentElement: root };
});

describe('应用时机', () => {
  it('构造时就按系统偏好上一套颜色 —— 不能等读盘，否则深色系统的用户会先看到一帧白底', () => {
    setSystemDark(true);
    new ShellStore('diagram');
    expect(root.dataset['theme']).toBe('dark');
  });

  it('浅色系统起步就是浅色', () => {
    new ShellStore('diagram');
    expect(root.dataset['theme']).toBe('light');
  });

  it('顺带设置了 color-scheme —— 滚动条和表单控件才不会在深色里发亮', () => {
    setSystemDark(true);
    new ShellStore('diagram');
    expect(root.style['colorScheme']).toBe('dark');
  });
});

describe('读回上次的选择', () => {
  it('存的是深色就上深色，哪怕系统是浅色', async () => {
    fakePrefs.data.theme = 'dark';
    const store = new ShellStore('diagram');
    await store.initTheme();

    expect(root.dataset['theme']).toBe('dark');
    expect(store.getSnapshot().theme).toBe('dark');
  });

  it('⚠️ 读回来的仍然是「选择」本身，不是解析结果', async () => {
    // 存成解析结果的话，选了「跟随系统」的用户以后换了系统主题，
    // 应用还停在旧的那套颜色，而且他再也找不回「跟随系统」这一档
    fakePrefs.data.theme = 'system';
    setSystemDark(true);
    const store = new ShellStore('diagram');
    await store.initTheme();

    expect(root.dataset['theme']).toBe('dark'); // 屏幕上生效的
    expect(store.getSnapshot().theme).toBe('system'); // 记着的
  });

  it('存了个认不出来的值就当「跟随系统」，不让界面变成没配色', async () => {
    fakePrefs.data.theme = 'darkish';
    setSystemDark(true);
    const store = new ShellStore('diagram');
    await store.initTheme();

    expect(store.getSnapshot().theme).toBe('system');
    expect(root.dataset['theme']).toBe('dark');
  });

  it('读盘失败不抛也不弹错误条，界面停在这一套颜色上', async () => {
    // 外观读不出来不该在界面上留一条红色的东西 —— 用户没做错什么，
    // 而且他大概率根本不在意配色是不是上次那一套
    setSystemDark(true);
    fakePrefs.failGet = true;
    const store = new ShellStore('diagram');

    await expect(store.initTheme()).resolves.toBeUndefined();
    expect(root.dataset['theme']).toBe('dark'); // 构造时按系统偏好上的那一套还在
    expect(store.getSnapshot().theme).toBe('system');

    fakePrefs.failGet = false;
  });
});

describe('系统主题变化', () => {
  it('跟随系统时跟着变', async () => {
    const store = new ShellStore('diagram');
    await store.initTheme();
    expect(root.dataset['theme']).toBe('light');

    setSystemDark(true);
    expect(root.dataset['theme']).toBe('dark');
  });

  it('⚠️ 回归：明确选了档位之后，系统主题变化不该动它', async () => {
    // 用户刚做了个选择，被系统设置悄悄改掉是最让人恼火的一类问题
    const store = new ShellStore('diagram');
    await store.initTheme();

    store.setTheme('dark');
    expect(root.dataset['theme']).toBe('dark');

    // 系统切到浅色（用户没选跟随系统）
    setSystemDark(false);
    expect(root.dataset['theme']).toBe('dark');

    // 再切回深色也不该有变化
    setSystemDark(true);
    expect(root.dataset['theme']).toBe('dark');
  });
});

describe('setTheme', () => {
  it('应用 + 存进偏好', async () => {
    const store = new ShellStore('diagram');
    await store.initTheme();

    store.setTheme('light');
    expect(root.dataset['theme']).toBe('light');
    expect(fakePrefs.data.theme).toBe('light');
  });

  it('存的是选择本身（选「跟随系统」存的就是 system）', async () => {
    const store = new ShellStore('diagram');
    await store.initTheme();
    setSystemDark(true);

    store.setTheme('system');
    expect(fakePrefs.data.theme).toBe('system');
    expect(root.dataset['theme']).toBe('dark');
  });

  it('重复选同一档不做无谓的重画和写盘', async () => {
    const store = new ShellStore('diagram');
    await store.initTheme();
    store.setTheme('dark');
    fakePrefs.saved.length = 0;

    store.setTheme('dark');
    expect(fakePrefs.saved).toEqual([]);
  });
});
