/**
 * 连接分组 —— 用户自己建的目录（「生产」「测试」「某某项目」那类）。
 *
 * 三个连接模块（Redis / SQL / SSH）共用这一份：**数据形状和存储在这里，
 * 分组逻辑也是**（`assignGroups` 这个纯函数），各模块只负责把结果画出来。
 *
 * # 和「按引擎分」不是一回事
 *
 * SQL 模块的侧栏第一层是**引擎**（pg / mysql / mongo / ck）—— 那是**系统给的**，
 * 每条连接自己带着 `kind` 字段。这一层是**用户自己分的**，两个维度。
 * 顺序是**引擎在上、分组在下**（2026-09-20 和用户确认过）。
 * Redis / SSH 只有一种协议，没有引擎那层，所以它们的第一层就是分组。
 *
 * # 存哪儿
 *
 * 和连接档案**同一个键值存储、不同的键**（`profiles` / `groups`）。
 * 形状不同，混在一个键里迟早互相带坏 —— 尤其组的 `sanitize` 和连接的完全不一样。
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

/** 组在键值存储里的键名。三个模块各用各的命名空间，所以这个名字够用 */
const GROUP_KEY = 'groups';

/**
 * 组的持久化。
 *
 * 直接复用连接档案那一套（`createProfileStore`）—— 它只做「读进来整形 / 整个存回去」，
 * 和「存的是连接还是组」无关。**密码那件事也一并继承了**：组的读写路径里没有凭据，
 * 但同一个键值存储里躺着连接的密码，威胁模型是一样的（见 `profiles.ts` 的 TODO(security)）。
 */
export function createGroupStore(kv: KeyValueStore): ProfileStore<ConnectionGroup> {
  return createProfileStore<ConnectionGroup>(kv, { key: GROUP_KEY, sanitize: sanitizeGroups });
}

/** 存储里的组也不可信：手改过、旧版本写的、干脆坏了。坏记录丢掉，别让整份列表消失 */
function sanitizeGroups(raw: unknown): ConnectionGroup[] {
  const groups: ConnectionGroup[] = [];

  for (const item of asArray(raw)) {
    const record = asRecord(item);
    if (record === null) continue;

    const id = asString(record.id);
    if (id === '') continue; // 没有 id 的组挂不住连接

    groups.push({ id, name: asString(record.name) || '未命名分组' });
  }

  return groups;
}

/** 新建一个组，名字自动去重（「新建分组」「新建分组 2」……） */
export function newGroup(existing: readonly ConnectionGroup[]): ConnectionGroup {
  return {
    id: newId('grp'),
    name: nextAvailableName(
      existing.map((g) => g.name),
      '新建分组',
    ),
  };
}

/** 分组之后的样子：一堆没分组的 + 若干个有成员的分组 */
export interface GroupedProfiles<P> {
  /** 没分组的（**含 `groupId` 指向一个已经不存在的组的**）—— 画在最上面 */
  ungrouped: P[];
  /** 有成员的分组，顺序跟着传进来的 `groups`（= 用户的创建顺序） */
  groups: Array<{ group: ConnectionGroup; items: P[] }>;
}

/**
 * 把连接按组分好。**纯函数**，三个模块共用。
 *
 * 这个功能最容易出错的地方就是这里（未分组的落哪儿、空组画不画、组没了怎么办），
 * 所以它单独成函数、单独测得到。
 *
 * 三条规矩：
 *
 * 1. **未分组的排在最前面** —— 新建的连接就是未分组，不放最上面的话用户得先
 *    展开某个组才找得着它（或者以为没建成功）。
 * 2. **空组照画**（除非调用方说 `hideEmpty`）—— 见下面那段，这条踩过。
 * 3. **指向不存在的组 = 未分组** —— 见 `ConnectionProfileBase.groupId` 的说明。
 *
 * # ⚠️ 空组为什么必须画出来
 *
 * 一开始这里写的是「空组不画」，理由是「和 SQL 那边只画有连接的引擎同一个道理」。
 * **那个类比是错的**：引擎那层是**系统给的**（pg/mysql/mongo/ck 四个固定的），
 * 空的是噪音；而分组是**用户自己建的** —— 他刚点完「＋分组」，界面上什么都没
 * 出现，只会以为那个按钮坏了。（e2e 一跑就撞出来了：建完组找不到它。）
 *
 * @param hideEmpty 一条成员都没有的组也藏起来。**只有搜索的时候传 true** ——
 *   那时用户在找具体的一条，一屏空壳是噪音。（传进来的 `profiles` 已经是过滤过的，
 *   所以「空」在那时意味着「这个组里一条都没命中」。）
 */
export function assignGroups<P extends ConnectionProfileBase>(
  profiles: readonly P[],
  groups: readonly ConnectionGroup[],
  hideEmpty = false,
): GroupedProfiles<P> {
  const known = new Set(groups.map((g) => g.id));
  const ungrouped: P[] = [];
  const byGroup = new Map<string, P[]>();

  for (const profile of profiles) {
    const gid = profile.groupId;
    if (gid === undefined || !known.has(gid)) {
      ungrouped.push(profile);
      continue;
    }
    const bucket = byGroup.get(gid);
    if (bucket === undefined) byGroup.set(gid, [profile]);
    else bucket.push(profile);
  }

  return {
    ungrouped,
    groups: groups
      .filter((group) => !hideEmpty || byGroup.has(group.id))
      .map((group) => ({ group, items: byGroup.get(group.id) ?? [] })),
  };
}

/**
 * 把一个连接放进某个组（传 `null` = 移出分组，落回未分组）。
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

/**
 * 删掉一个组，成员落回未分组。
 *
 * ⚠️ 渲染的正确性**不依赖**这一步（指向不存在的组本来就当未分组，见 `assignGroups`）——
 * 这里做只是不让数据越攒越脏：删了又建同名组时，那些悬空的 id 不会把旧成员吸进去。
 */
export function removeGroup<P extends ConnectionProfileBase>(
  profiles: readonly P[],
  groupId: string,
): P[] {
  return profiles.map((profile) => (profile.groupId === groupId ? withoutGroup(profile) : profile));
}
