import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 文件浏览器 store 的行为测试。
 *
 * 布景照 `agents-store.test.ts`：hub 换成替身（node 里跑不了 xterm）、
 * platform 换成记账替身（真列目录归 Rust 那组测试）。这里盯的是**编排**：
 * 谁在什么时候被调用、缓存/展开/竞态这些只有在真跑一遍才暴露的规矩。
 *
 * ⚠️ **store 只有一个模块级实例**（和生产一致）。一开始每个用例 new 一个，
 * 结果旧实例还订阅着 agentsStore —— 它们也是 tab='files' 的僵尸，背景里
 * 一起调 listDir，调用次数全对不上。单实例 + beforeEach 归位就没这问题。
 */

vi.mock('../../src/modules/agents/core/terminalHub', () => ({
  agentHub: {
    create: vi.fn(async () => {}),
    attach: vi.fn(),
    detach: vi.fn(),
    feed: vi.fn(),
    note: vi.fn(),
    dispose: vi.fn(),
    has: vi.fn(() => true),
    size: vi.fn(() => 0),
    snapshot: vi.fn(() => null),
    onInput: () => {},
    onResize: () => {},
  },
}));

const fakePlatform = vi.hoisted(() => ({
  kind: 'web' as const,
  pickWorkspace: vi.fn(),
  confirm: vi.fn(),
  listDir: vi.fn(),
  readPreview: vi.fn(),
  openPath: vi.fn(),
}));
vi.mock('../../src/shared/platform', () => ({ platform: fakePlatform }));

import { explorerStore } from '../../src/modules/agents/state/explorer';
import { agentsStore } from '../../src/modules/agents/state/store';
import type { DirEntry } from '../../src/shared/platform/types';

const dir = (name: string, path?: string): DirEntry => ({
  name,
  path: path ?? name,
  kind: 'dir',
  isSymlink: false,
});
const file = (name: string, path?: string): DirEntry => ({
  name,
  path: path ?? name,
  kind: 'file',
  isSymlink: false,
});

/** 手动控制履行时机的 Promise（给竞态用例用） */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** 每个用例一个不重样的目录，避开 agentsStore 按路径去重 */
let seq = 0;
async function freshWorkspace(): Promise<string> {
  seq += 1;
  const path = `/proj-${seq}`;
  fakePlatform.pickWorkspace.mockResolvedValueOnce(path);
  await agentsStore.addWorkspace();
  return path;
}

/** 把异步链推进到静止（几个 tick 足够：我们的实现没有真实定时器） */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  fakePlatform.listDir.mockReset();
  fakePlatform.readPreview.mockReset();
  fakePlatform.listDir.mockResolvedValue([]);
  fakePlatform.readPreview.mockResolvedValue({ kind: 'text', text: '' });
  // 每个用例从「会话」标签起步（上一个用例可能把它留在「文件」上）
  explorerStore.setTab('session');
});

describe('ExplorerStore', () => {
  it('切到「文件」才拉根目录，没切之前一次都不发', async () => {
    const root = await freshWorkspace();
    expect(fakePlatform.listDir).not.toHaveBeenCalled();

    explorerStore.setTab('files');
    await settle();

    expect(fakePlatform.listDir).toHaveBeenCalledTimes(1);
    expect(fakePlatform.listDir).toHaveBeenCalledWith(root, '');
  });

  it('展开目录时懒加载；收起再展开会重新列（新鲜度：收起再打开=一次刷新）', async () => {
    const root = await freshWorkspace();
    explorerStore.setTab('files');
    await settle();

    fakePlatform.listDir.mockResolvedValueOnce([file('app.ts', 'src/app.ts')]);
    explorerStore.toggleDir('src');
    await settle();
    expect(fakePlatform.listDir).toHaveBeenCalledWith(root, 'src');
    expect(explorerStore.getSnapshot().cache.get('src')).toHaveLength(1);

    explorerStore.toggleDir('src'); // 收起
    fakePlatform.listDir.mockResolvedValueOnce([file('app.ts', 'src/app.ts')]);
    explorerStore.toggleDir('src'); // 再展开 → 重列
    await settle();
    expect(fakePlatform.listDir).toHaveBeenCalledTimes(3); // 根 + 第一次展开 + 重展开
  });

  it('选文件读预览；text 原样进 state', async () => {
    await freshWorkspace();
    explorerStore.setTab('files');
    await settle();

    fakePlatform.readPreview.mockResolvedValueOnce({ kind: 'text', text: 'hello\n世界' });
    explorerStore.selectFile('README.md');
    await settle();

    expect(explorerStore.getSnapshot().preview).toEqual({ kind: 'text', text: 'hello\n世界' });
  });

  it('刷新：根 + 已展开的目录都重列，预览也重读', async () => {
    const root = await freshWorkspace();
    explorerStore.setTab('files');
    await settle();

    fakePlatform.listDir.mockResolvedValueOnce([dir('src')]);
    explorerStore.toggleDir('src');
    await settle();
    fakePlatform.readPreview.mockResolvedValueOnce({ kind: 'text', text: 'a' });
    explorerStore.selectFile('README.md');
    await settle();

    const before = fakePlatform.listDir.mock.calls.length;
    const beforePreview = fakePlatform.readPreview.mock.calls.length;
    explorerStore.refresh();
    await settle();

    expect(fakePlatform.listDir.mock.calls.length).toBe(before + 2); // 根 + src
    expect(fakePlatform.listDir).toHaveBeenCalledWith(root, 'src');
    expect(fakePlatform.readPreview.mock.calls.length).toBe(beforePreview + 1);
  });

  it('切工作目录：跟着换根、重新列（订阅推导的联动）', async () => {
    await freshWorkspace();
    explorerStore.setTab('files');
    await settle();

    const second = await freshWorkspace(); // addWorkspace 会把 active 切过去
    await settle();

    expect(explorerStore.getSnapshot().workspacePath).toBe(second);
    expect(fakePlatform.listDir).toHaveBeenLastCalledWith(second, '');
  });

  it('选中会话（任何路径）→ 切回「会话」标签', async () => {
    await freshWorkspace();
    explorerStore.setTab('files');
    await settle();
    expect(explorerStore.getSnapshot().tab).toBe('files');

    agentsStore.selectSession('whatever'); // 语义动作；不校验存在性也在所不问
    expect(explorerStore.getSnapshot().tab).toBe('session');
  });

  it('远端工作目录：诚实空态，一目录都不列', async () => {
    await agentsStore.addRemoteWorkspace({
      host: '10.0.0.9',
      port: 22,
      username: 'me',
      authKind: 'password',
      password: 'p',
      privateKeyPath: '',
      passphrase: '',
      path: '/srv/app',
      name: '产线',
    });
    explorerStore.setTab('files');
    await settle();

    const s = explorerStore.getSnapshot();
    expect(s.remote).toBe(true);
    expect(s.workspacePath).toBe('产线');
    expect(s.rootEntries).toHaveLength(0);
    // 给远端工作目录发 fs 调用 = 「把别人的路径喂给本机 fs」，绝不允许
    expect(fakePlatform.listDir).not.toHaveBeenCalledWith('/srv/app', '');
  });

  it('列目录失败：进面板底部的 listError，不炸整个模块', async () => {
    await freshWorkspace();
    explorerStore.setTab('files');
    await settle();

    fakePlatform.listDir.mockRejectedValueOnce(new Error('打不开：权限不够'));
    explorerStore.refresh();
    await settle();

    expect(explorerStore.getSnapshot().listError).toContain('权限不够');
  });

  it('竞态闸门：切目录之后，旧请求晚回来不许落地', async () => {
    await freshWorkspace();

    const old = deferred<DirEntry[]>();
    fakePlatform.listDir.mockReturnValueOnce(old.promise); // 第一个请求挂住
    explorerStore.setTab('files');

    // 切目录之前就把「新目录的答案」备好 —— 切换会立刻触发一次根刷新，
    // 备晚了那次调用吃到的还是 beforeEach 的空数组（这条踩过一次）
    fakePlatform.listDir.mockResolvedValue([dir('新的')]);
    const second = await freshWorkspace(); // 切目录 → generation++
    await settle();
    expect(explorerStore.getSnapshot().rootEntries.map((e) => e.name)).toEqual(['新的']);

    // 旧请求现在才回来 —— 不许覆盖新的结果
    old.resolve([dir('旧的')]);
    await settle();
    expect(explorerStore.getSnapshot().rootEntries.map((e) => e.name)).toEqual(['新的']);
    expect(explorerStore.getSnapshot().workspacePath).toBe(second);
  });
});
