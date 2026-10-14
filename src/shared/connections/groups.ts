/**
 * 连接目录 —— 用户自己建的目录树（「生产」「某某项目」那类）。
 *
 * 三个连接模块（Redis / SQL / SSH）共用这一份：**数据形状和存储在这里，
 * 树逻辑也是**（`buildTree` 这个纯函数），各模块只负责把结果画出来。
 *
 * # 界面叫「目录」，内部叫 group
 *
 * 改的只有用户看得到的字（2026-10-14 用户拍板：「还不如叫目录」）。字段名、
 * 存储键（`'groups'`）、函数名一个字没动 —— 数据兼容、diff 也小。
 * 读代码看到 group，就是在说用户界面上的那个目录。
 *
 * # 目录**可以嵌套**
 *
 * 早先是单层（当时的理由是「几十条连接，一层+搜索就够」）。用户要了树之后
 * `ConnectionGroup` 加了 `parentId`：**缺字段 = 顶层**，老数据零迁移。
 * 树是手改得动的存储里长出来的，所以下面这些不入眼的输入都必须能画出来：
 *
 * * **悬空 parentId**（父目录被删了/手改过）→ 当顶层（不丢东西）；
 * * **环**（A 挂 B、B 挂 A）→ 沿 parentId 上溯见环就剪断当顶层 ——
 *   渲染是递归的，一个环就是栈爆。父指针唯一，所以剪完每个目录只画一次；
 * * 悬空 `groupId` 的连接 → 未分组（见 `ConnectionProfileBase.groupId` 的说明）。
 *
 * # 和「按引擎分」不是一回事
 *
 * SQL 模块的侧栏第一层是**引擎**（pg / mysql / mongo / ck）—— 那是**系统给的**，
 * 每条连接自己带着 `kind` 字段。这一层是**用户自己分的**，两个维度。
 * 顺序是**引擎在上、目录在下**（2026-09-20 和用户确认过）。
 * Redis / SSH 只有一种协议，没有引擎那层，所以它们的第一层就是目录树。
 *
 * # 存哪儿
 *
 * 和连接档案**同一个键值存储、不同的键**（`profiles` / `groups`）。
 * 形状不同，混在一个键里迟早互相带坏 —— 尤其目录的 `sanitize` 和连接的完全不一样。
 */

import { newId } from '../ids';
import type { KeyValueStore } from '../platform/kv';
import {
  asArray,
  asRecord,
  asString,
  createProfileStore,
  nextAvailableName,
} from './profiles';
import type { ConnectionGroup, ConnectionProfileBase, ProfileStore } from './types';

/** 目录在键值存储里的键名。三个模块各用各的命名空间，所以这个名字够用 */
const GROUP_KEY = 'groups';

/**
 * 目录的持久化。
 *
 * 直接复用连接档案那一套（`createProfileStore`）—— 它只做「读进来整形 / 整个存回去」，
 * 和「存的是连接还是目录」无关。**密码那件事也一并继承了**：目录的读写路径里没有凭据，
 * 但同一个键值存储里躺着连接的密码，威胁模型是一样的（见 `profiles.ts` 的 TODO(security)）。
 */
export function createGroupStore(kv: KeyValueStore): ProfileStore<ConnectionGroup> {
  return createProfileStore<ConnectionGroup>(kv, { key: GROUP_KEY, sanitize: sanitizeGroups });
}

/** 存储里的目录也不可信：手改过、旧版本写的、干脆坏了。坏记录丢掉，别让整份列表消失 */
function sanitizeGroups(raw: unknown): ConnectionGroup[] {
  const groups: ConnectionGroup[] = [];

  for (const item of asArray(raw)) {
    const record = asRecord(item);
    if (record === null) continue;

    const id = asString(record.id);
    if (id === '') continue; // 没有 id 的目录挂不住连接

    const group: ConnectionGroup = { id, name: asString(record.name) || '未命名目录' };
    // `parentId` 可选读；空串不挂这个键（存回去的 JSON 干净些，同 `withoutGroup` 的理）
    const parentId = asString(record.parentId);
    if (parentId !== '') group.parentId = parentId;
    groups.push(group);
  }

  return groups;
}

/**
 * 新建一个目录，名字在**同级**里自动去重（「新建目录」「新建目录 2」……）。
 *
 * 同级 = 同一个 `parentId` 下的那些。不同分支下同名是允许的 —— 嵌套之后
 * 同名目录光看名字分不清，但每个地方显示的都是**全路径**（见 `groupPath`）。
 */
export function newGroup(
  existing: readonly ConnectionGroup[],
  parentId: string | null = null,
): ConnectionGroup {
  const siblings = existing.filter((g) => (g.parentId ?? null) === parentId);
  const group: ConnectionGroup = {
    id: newId('grp'),
    name: nextAvailableName(
      siblings.map((g) => g.name),
      '新建目录',
    ),
  };
  if (parentId !== null) group.parentId = parentId;
  return group;
}

/** 目录树的一节：目录 + 它的子目录 + 直接挂在它下面的连接（两处都保持传进来的顺序） */
export interface TreeNode<P> {
  group: ConnectionGroup;
  children: Array<TreeNode<P>>;
  items: P[];
}

/** 建树的结果：未分组的（平铺在最上面）+ 顶层目录 */
export interface GroupedTree<P> {
  /** 没分组的（**含 `groupId` 指向一个已经不存在的目录的**）—— 画在最上面 */
  ungrouped: P[];
  /** 顶层目录，顺序跟着传进来的 `groups`（= 用户的创建顺序） */
  roots: Array<TreeNode<P>>;
}

/**
 * 把连接和目录搭成一棵树。**纯函数**，三个模块共用。
 *
 * 这个功能最容易出错的地方就是这里（未分组的落哪儿、空目录画不画、目录没了
 * 怎么办、手改出环怎么办），所以它单独成函数、单独测得到。
 *
 * 四条规矩：
 *
 * 1. **未分组的排在最前面**，每个目录里**连接在前、子目录在后** —— 同一个理：
 *    新建的连接就是未分组/直接挂着的，不放在显眼处用户得先展开几层才找得着。
 * 2. **空目录照画**（除非调用方说 `hideEmpty`）—— 见下面那段，这条踩过。
 * 3. **指向不存在的目录 = 未分组 / 顶层** —— 存储是手改得动的。
 * 4. **顺序一个字不动**：未分组按入参顺序、同级目录按 `groups` 数组顺序
 *    （= 创建顺序）、组内按入参顺序。三棵树传进来的 `profiles` 都是先过滤过的，
 *    **这个顺序就是用户摆出来的树的形状**，重排等于让树自己变形。
 *
 * # ⚠️ 空目录为什么必须画出来
 *
 * 一开始这里写的是「空组不画」，理由是「和 SQL 那边只画有连接的引擎同一个道理」。
 * **那个类比是错的**：引擎那层是**系统给的**（pg/mysql/mongo/ck 四个固定的），
 * 空的是噪音；而目录是**用户自己建的** —— 他刚点完「＋目录」，界面上什么都没
 * 出现，只会以为那个按钮坏了。（e2e 一跑就撞出来了：建完目录找不到它。）
 *
 * @param hideEmpty 子树里**一条命中都没有**的目录也藏起来（递归：自己名下没有、
 *   后代里也没有的才藏）。**只有搜索的时候传 true** —— 那时用户在找具体的一条，
 *   一屏空壳是噪音。（传进来的 `profiles` 已经是过滤过的，
 *   所以「空」在那时意味着「这棵子树里一条都没命中」。）
 */
export function buildTree<P extends ConnectionProfileBase>(
  profiles: readonly P[],
  groups: readonly ConnectionGroup[],
  hideEmpty = false,
): GroupedTree<P> {
  // 每个目录先开一个空节（顺序 = groups 数组顺序）
  const nodes = new Map<string, TreeNode<P>>();
  for (const group of groups) {
    nodes.set(group.id, { group, children: [], items: [] });
  }

  // 挂连接：悬空 groupId 落未分组
  const ungrouped: P[] = [];
  for (const profile of profiles) {
    const node = profile.groupId === undefined ? undefined : nodes.get(profile.groupId);
    if (node === undefined) ungrouped.push(profile);
    else node.items.push(profile);
  }

  // 有效父边（父不存在 = 没边，当顶层）
  const parentOf = new Map<string, string>();
  for (const group of groups) {
    if (group.parentId !== undefined && nodes.has(group.parentId)) {
      parentOf.set(group.id, group.parentId);
    }
  }

  /**
   * 这条目录的上溯链里有环吗（含自己指自己）。
   *
   * 有环的**按顶层画**：不丢东西，而且父指针唯一 —— 剪完每个目录恰好出现一次
   *（环里每个都变顶层兄弟）。链长就是目录层数（几十），逐条上溯够快，
   * 不做记忆化也不设深度上限（正常用户到不了会出问题的那种深度；真被手改成
   * 一万层，那也是先炸在别处）。
   */
  const hasCycle = (id: string): boolean => {
    const seen = new Set<string>([id]);
    let cursor = parentOf.get(id);
    while (cursor !== undefined) {
      if (seen.has(cursor)) return true;
      seen.add(cursor);
      cursor = parentOf.get(cursor);
    }
    return false;
  };

  // 连父子。**按 groups 数组顺序遍历**：同级目录的先后 = 创建先后
  const roots: Array<TreeNode<P>> = [];
  for (const group of groups) {
    const node = nodes.get(group.id);
    if (node === undefined) continue; // 到不了（nodes 就是从这里建的），守卫一下类型
    const parentId = parentOf.get(group.id);
    const parent = parentId === undefined ? undefined : nodes.get(parentId);
    if (parent === undefined || hasCycle(group.id)) roots.push(node);
    else parent.children.push(node);
  }

  if (!hideEmpty) return { ungrouped, roots };

  // 搜索时的剪枝：自己名下没有、后代里也没有命中的，整节藏掉
  const prune = (node: TreeNode<P>): TreeNode<P> | null => {
    const children = node.children
      .map(prune)
      .filter((n): n is TreeNode<P> => n !== null);
    if (node.items.length === 0 && children.length === 0) return null;
    return { group: node.group, children, items: node.items };
  };
  const kept = roots.map(prune).filter((n): n is TreeNode<P> => n !== null);
  return { ungrouped, roots: kept };
}

/**
 * 一棵子树里有几条连接 —— 目录头上那个数字用它。
 *
 * ⚠️ 是**子树总数**不是直接成员数：嵌套之后「直接成员 0、后代里还有 3 条」
 * 显示 0 看着就像个空目录，用户会以为东西丢了。
 */
export function subtreeCount<P>(node: TreeNode<P>): number {
  return node.items.length + node.children.reduce((n, child) => n + subtreeCount(child), 0);
}

/**
 * 目录的**全路径**（`"生产/项目A"`）。
 *
 * 嵌套之后同名目录光看名字分不清，菜单、下拉、悬浮提示都用它；e2e 也靠
 * `data-group-path` 定位（目录 id 是随机的，名字会重）。上溯带 visited ——
 * 手改出的环不能让它转不出来。
 */
export function groupPath(groups: readonly ConnectionGroup[], id: string): string {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const parts: string[] = [];
  const seen = new Set<string>();
  let cursor = byId.get(id);
  while (cursor !== undefined && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    parts.unshift(cursor.name);
    cursor = cursor.parentId === undefined ? undefined : byId.get(cursor.parentId);
  }
  return parts.join('/');
}

/** 某个目录的**全部后代目录 id**（不含自己）。环里互相认爹的情况下也不会转不完 */
export function descendantIds(groups: readonly ConnectionGroup[], id: string): Set<string> {
  const childrenOf = new Map<string, string[]>();
  for (const group of groups) {
    if (group.parentId === undefined) continue;
    const arr = childrenOf.get(group.parentId);
    if (arr === undefined) childrenOf.set(group.parentId, [group.id]);
    else arr.push(group.id);
  }

  const out = new Set<string>();
  const stack = [...(childrenOf.get(id) ?? [])];
  while (stack.length > 0) {
    const next = stack.pop();
    if (next === undefined || next === id || out.has(next)) continue; // 回到自己 = 环，停
    out.add(next);
    stack.push(...(childrenOf.get(next) ?? []));
  }
  return out;
}

/**
 * 把目录挪到另一个目录下面（`parentId = null` = 挪到顶层）。返回**新的** groups
 *（调用方负责存下去）。
 *
 * ⚠️ 目标是**自己或自己的后裔**时 no-op —— 那是环。这条守卫的**权威在纯函数里**
 *（UI 的「不亮高亮」只是配合；真调进来也得拦住）。目标不存在同样 no-op。
 */
export function moveGroupIn(
  groups: readonly ConnectionGroup[],
  id: string,
  parentId: string | null,
): ConnectionGroup[] {
  const group = groups.find((g) => g.id === id);
  if (group === undefined) return [...groups];
  if (parentId !== null) {
    if (parentId === id || descendantIds(groups, id).has(parentId)) return [...groups];
    if (!groups.some((g) => g.id === parentId)) return [...groups];
  }
  if ((group.parentId ?? null) === parentId) return [...groups]; // 已经在那儿了

  return groups.map((g) => {
    if (g.id !== id) return g;
    if (parentId === null) {
      const next = { ...g };
      delete next.parentId; // 真删字段而不是设成 undefined（同 withoutGroup 的理）
      return next;
    }
    return { ...g, parentId };
  });
}

/**
 * 删一棵目录子树要动的东西（**只算，不动**）。
 *
 * ⚠️ 连接必须按**整个子树的 id 集合**挑 —— 只按被点的那一个 id 过滤的话，
 * 子目录里的连接会变成悬空的 `groupId` 落回未分组（界面上看就是「目录没了、
 * 连接还在」，会被当成 bug 来查）。
 */
export function removeGroupTree<P extends ConnectionProfileBase>(
  profiles: readonly P[],
  groups: readonly ConnectionGroup[],
  id: string,
): { removedGroupIds: Set<string>; removedProfiles: P[]; remainingGroups: ConnectionGroup[] } {
  const removedGroupIds = descendantIds(groups, id);
  removedGroupIds.add(id);
  return {
    removedGroupIds,
    removedProfiles: profiles.filter(
      (p) => p.groupId !== undefined && removedGroupIds.has(p.groupId),
    ),
    remainingGroups: groups.filter((g) => !removedGroupIds.has(g.id)),
  };
}

/**
 * 把一个连接放进某个目录（传 `null` = 移出，落回未分组）。**可以放进任意层级
 * 的目录**（传的是目录 id，深几层无所谓）。
 *
 * 返回**新的**档案（调用方负责存下去）。移出时把字段真的删掉而不是设成
 * `undefined` —— 后者存进 JSON 会留下一个 `"groupId": null`，
 * 下次读出来又是另一种形状，没必要。
 */
export function withGroup<P extends ConnectionProfileBase>(profile: P, groupId: string | null): P {
  if (groupId !== null) return { ...profile, groupId };
  return withoutGroup(profile);
}

/** 去掉 `groupId` 字段本身（不是设成 undefined）—— 存进去的 JSON 干净些 */
export function withoutGroup<P extends ConnectionProfileBase>(profile: P): P {
  const next = { ...profile };
  delete next.groupId;
  return next;
}
