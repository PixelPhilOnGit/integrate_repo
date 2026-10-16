/**
 * 文件浏览器的纯逻辑：展开摊平、预览态组装、体积文案。
 *
 * 摊平这层最容易在边上出错 —— 折叠的子级漏渲染/多渲染、深度算错一格，
 * 界面上都要点到第三层才看得出来。字面量直接测干净。
 */

import { describe, expect, it } from 'vitest';
import {
  baseName,
  flatten,
  formatBytes,
  isHidden,
  previewToState,
} from '../../src/modules/agents/core/explorer';
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

describe('flatten', () => {
  it('折叠的目录只出一行，展开的出子级（深度 +1）', () => {
    const root = [dir('src'), file('README.md')];
    const cache = new Map([
      ['src', [file('app.ts', 'src/app.ts'), file('util.ts', 'src/util.ts')]],
    ]);

    const collapsed = flatten(root, new Set(), cache);
    expect(collapsed.map((r) => r.entry.name)).toEqual(['src', 'README.md']);
    expect(collapsed.every((r) => r.depth === 0)).toBe(true);

    const expanded = flatten(root, new Set(['src']), cache);
    expect(expanded.map((r) => r.entry.name)).toEqual([
      'src',
      'app.ts',
      'util.ts',
      'README.md',
    ]);
    expect(expanded.map((r) => r.depth)).toEqual([0, 1, 1, 0]);
  });

  it('展开了但缓存还没到（加载中）——不炸，子级自然缺席', () => {
    const rows = flatten([dir('src')], new Set(['src']), new Map());
    expect(rows.map((r) => r.entry.name)).toEqual(['src']);
  });

  it('嵌套两层：深度是累计的', () => {
    const cache = new Map([
      ['a', [dir('a/b', 'a/b')]],
      ['a/b', [file('a/b/c.ts', 'a/b/c.ts')]],
    ]);
    const rows = flatten([dir('a')], new Set(['a', 'a/b']), cache);
    expect(rows.map((r) => [r.entry.name, r.depth])).toEqual([
      ['a', 0],
      ['a/b', 1],
      ['a/b/c.ts', 2],
    ]);
  });
});

describe('previewToState', () => {
  it('三态原样翻过来', () => {
    expect(previewToState({ kind: 'text', text: 'hi' })).toEqual({ kind: 'text', text: 'hi' });
    expect(previewToState({ kind: 'binary' })).toEqual({ kind: 'binary' });
    expect(previewToState({ kind: 'tooLarge', size: 123 })).toEqual({
      kind: 'tooLarge',
      size: 123,
    });
  });
});

describe('formatBytes', () => {
  it('1 MB 以下说 KB —— 小文件显示「0.0 MB」看着像坏掉了（request 模块的教训）', () => {
    expect(formatBytes(512)).toBe('0.5 KB');
    expect(formatBytes(1500)).toBe('1.5 KB');
    expect(formatBytes(20 * 1024)).toBe('20 KB');
  });

  it('1 MB 起说 MB', () => {
    expect(formatBytes(2 * 1024 * 1024 + 1)).toBe('2.0 MB');
    expect(formatBytes(10 * 1024 * 1024)).toBe('10.0 MB');
  });
});

describe('isHidden / baseName', () => {
  it('点开头算隐藏（只影响画得暗不暗，不影响列不列）', () => {
    expect(isHidden('.env')).toBe(true);
    expect(isHidden('src')).toBe(false);
  });

  it('baseName 同时认正反斜杠（Windows 路径）', () => {
    expect(baseName('a/b/c.txt')).toBe('c.txt');
    expect(baseName('D:\\work\\alpha\\main.rs')).toBe('main.rs');
    expect(baseName('name')).toBe('name');
    expect(baseName('')).toBe('');
  });
});
