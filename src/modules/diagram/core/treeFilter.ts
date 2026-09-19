/**
 * 文件树的搜索过滤：**算出「显示哪些、展开哪些」，不改树本身**。
 *
 * # 为什么是「保留祖先」而不是「只留命中的」
 *
 * 在一个树里只显示命中的节点，用户会看到一堆**不知道在哪儿**的文件 ——
 * 树的全部意义就是「它在哪儿」。所以命中的节点连**它的祖先**一起留下，
 * 祖先只是「含着命中的子孙」，本身不一定命中（渲染时可以画得淡一点）。
 *
 * # 为什么展开状态要算在返回值里
 *
 * 用户手点的展开/折叠状态存在组件里，**搜索期间不能去改它** ——
 * 一改，清空搜索之后树就回不到原样了（用户会发现「我折起来的那几个目录
 * 自己开了」）。所以这里只**算出**「搜索期间需要撑开哪些目录」，
 * 由组件临时叠加在用点击状态之上：搜索一清空，叠加就没了。
 */

import type { FileNode } from '../../../shared/platform/types';
import { fuzzyBest } from '../../../shared/search';

export interface FilteredTree {
  /** 还显示哪些节点（按路径）。**包含**命中的和「含着命中的子孙」的那些 */
  visible: Set<string>;
  /** 真正命中的节点（渲染时用来和「只是含着命中」的祖先区分开） */
  hits: Set<string>;
  /** 搜索期间要撑开的目录（子孙里有命中） */
  expand: Set<string>;
}

/**
 * 一次遍历算完三样东西。
 *
 * 名字和路径**都要搜**：`shared` 既要能找到叫 `shared` 的目录，
 * 也要能找到 `D:\ws\shared\x.seq.json` 这种路径里带它的（用户记的往往是路径片段）。
 */
export function filterTree(nodes: readonly FileNode[], query: string): FilteredTree {
  const out: FilteredTree = { visible: new Set(), hits: new Set(), expand: new Set() };
  if (query.trim() === '') return out;

  const walk = (node: FileNode): boolean => {
    const selfHit = fuzzyBest(query, [node.name, node.path]) !== null;

    let childVisible = false;
    for (const child of node.children ?? []) {
      // ⚠️ 不能用 `childVisible ||= walk(child)` 那种短路写法：短路会**跳过**
      // 后面兄弟节点的遍历，于是它们一个都不会进 visible
      const childHit = walk(child);
      childVisible = childVisible || childHit;
    }

    if (!selfHit && !childVisible) return false;

    out.visible.add(node.path);
    if (selfHit) out.hits.add(node.path);
    // 子孙里有东西要显示 → 这个目录得撑开（否则那些子孙看不见）
    if (node.kind === 'dir' && childVisible) out.expand.add(node.path);
    return true;
  };

  for (const node of nodes) walk(node);
  return out;
}
