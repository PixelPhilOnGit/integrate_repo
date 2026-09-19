/**
 * 文件树的搜索过滤。
 *
 * 定的是三件事的**关系**：显示哪些（含祖先）、谁是真命中、搜索期间要撑开哪些
 * 目录。这三样错一个的表现都很具体：少了祖先 = 用户看见一个不知在哪儿的文件名；
 * 多撑开一个 = 清空搜索之后树的形状回不去；漏掉兄弟 = 「明明有这个文件却搜不到」。
 */
import { describe, expect, it } from 'vitest';
import type { FileNode } from '../../src/shared/platform/types';
import { filterTree } from '../../src/modules/diagram/core/treeFilter';

const tree: FileNode[] = [
  {
    name: 'shared',
    path: 'shared',
    kind: 'dir',
    children: [{ name: 'a.seq.json', path: 'shared/a.seq.json', kind: 'file' }],
  },
  {
    name: 'api',
    path: 'api',
    kind: 'dir',
    children: [
      { name: 'orders.seq.json', path: 'api/orders.seq.json', kind: 'file' },
      {
        name: 'nested',
        path: 'api/nested',
        kind: 'dir',
        children: [{ name: 'deep.seq.json', path: 'api/nested/deep.seq.json', kind: 'file' }],
      },
    ],
  },
  { name: 'readme.md', path: 'readme.md', kind: 'file' },
];

describe('文件树搜索', () => {
  it('空查询：什么都不过滤（三个集合都是空的）', () => {
    const got = filterTree(tree, '');
    expect(got.visible.size).toBe(0);
    expect(got.hits.size).toBe(0);
    expect(got.expand.size).toBe(0);
    // 全是空白也一样
    expect(filterTree(tree, '   ').visible.size).toBe(0);
  });

  it('命中文件时，**祖先一起留下**并撑开（不然用户不知道它在哪儿）', () => {
    const got = filterTree(tree, 'deep');
    expect(got.hits.has('api/nested/deep.seq.json')).toBe(true);
    expect(got.visible.has('api/nested/deep.seq.json')).toBe(true);
    expect(got.visible.has('api/nested')).toBe(true); // 祖先
    expect(got.visible.has('api')).toBe(true); // 祖先的祖先
    // 撑开链路上的每一层目录
    expect(got.expand.has('api')).toBe(true);
    expect(got.expand.has('api/nested')).toBe(true);
  });

  it('祖先只是「含着命中」，**不算命中**（渲染时要能画得淡一点）', () => {
    const got = filterTree(tree, 'deep');
    expect(got.hits.has('api')).toBe(false);
    expect(got.hits.has('api/nested')).toBe(false);
  });

  it('搜索命中目录时，父目录要撑开（否则看不见它）', () => {
    const got = filterTree(tree, 'nested');
    expect(got.hits.has('api/nested')).toBe(true);
    expect(got.visible.has('api/nested')).toBe(true);
    expect(got.expand.has('api')).toBe(true);
  });

  it('⚠️ 搜目录名会把它**里面的文件**也带出来 —— 路径匹配的必然后果，故意的', () => {
    // `api/nested/deep.seq.json` 的**路径里**含 `nested`，所以它也算命中，
    // 于是「撑开 api/nested」是对的（不然那个命中的文件看不见）。
    // 这和 VS Code 文件树的过滤行为一致：名字或路径里出现就算。
    const got = filterTree(tree, 'nested');
    expect(got.hits.has('api/nested/deep.seq.json')).toBe(true);
    expect(got.expand.has('api/nested')).toBe(true);
  });

  it('⚠️ 不同分支里的兄弟都要遍历到（短路写法会漏掉后面那些）', () => {
    // `seq` 在 shared/ 和 api/ 两条分支里都有命中，两边都得留下
    const got = filterTree(tree, 'seq');
    expect(got.visible.has('shared/a.seq.json')).toBe(true);
    expect(got.visible.has('api/orders.seq.json')).toBe(true);
    expect(got.visible.has('api/nested/deep.seq.json')).toBe(true);
    expect(got.visible.has('shared')).toBe(true);
    expect(got.visible.has('api')).toBe(true);
  });

  it('没有命中的分支整个不显示', () => {
    const got = filterTree(tree, 'readme');
    expect(got.visible.has('readme.md')).toBe(true);
    expect(got.visible.has('api')).toBe(false);
    expect(got.visible.has('shared')).toBe(false);
  });

  it('按**路径**也能搜到（用户记的往往是路径片段）', () => {
    const got = filterTree(tree, 'apior'); // api/orders
    expect(got.hits.has('api/orders.seq.json')).toBe(true);
  });

  it('一条都不匹配 → 什么都不显示（调用方据此显示「没有匹配的」）', () => {
    expect(filterTree(tree, 'zzzzz').visible.size).toBe(0);
  });
});
