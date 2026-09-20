/**
 * 侧栏那两件事的纯逻辑：**会话按状态筛**、**工作目录置顶**。
 *
 * 都是"只是把显示出来的东西换个顺序/挑一部分"，一个字都不动 `state` ——
 * 和搜索那条规矩一样（搜索期间 `expanded` 一个字不动）。
 *
 * # 为什么需要状态筛选
 *
 * 一个项目开十个会话之后，标题全是「claude #1」「claude #2」…… **搜索帮不上忙**
 * （用户根本不知道哪个是哪个）。能用来缩小范围的只有**状态**：「谁在等我」
 * 「谁还在跑」。用户最早提这个需求时的原话是「一个目录下开很多会话时只能一个个看」。
 *
 * ⚠️ 和顶部那个「需要你」队列不是一回事：那是**跨所有目录**按等待时长排的行动列表；
 * 这里是**在当前树上按状态过滤**，两个都在，各管各的。
 */

import { WAITING, type AgentSession, type AgentWorkspace, type SessionStatus } from './types';

/**
 * 会话筛选的三个档。
 *
 * 刻意**不做「已完成」「已退出」**：那两个是终态，用户不会去"找"它们。
 * 这两个档是**行动导向**的 —— 「谁在等我」要我去处理，「谁在跑」我还得等。
 */
export type SessionFilter = 'all' | 'waiting' | 'active';

export const SESSION_FILTERS: readonly SessionFilter[] = ['all', 'waiting', 'active'];

export const SESSION_FILTER_LABEL: Record<SessionFilter, string> = {
  all: '全部',
  waiting: '需要你',
  active: '在跑',
};

/** 这个状态的会话算不算落在这个档里 */
export function matchesSessionFilter(status: SessionStatus, filter: SessionFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'waiting':
      return status === WAITING;
    case 'active':
      // 「在跑」把 `starting` 也算上：用户问「哪个还在动」的时候，
      // 「正在启动」和「正在干活」是同一个答案 —— 反正都不用他管
      return status === 'working' || status === 'starting';
  }
}

/**
 * 置顶 / 取消置顶（取消时把字段**真的删掉**，别留一个 `pinned: false`）。
 *
 * 和 `shared/connections/groups.ts` 的 `withoutGroup` 一个路子：存进去的 JSON
 * 干净些，也省得下次读出来又得处理两种「没置顶」的形状。
 */
export function withPin(workspace: AgentWorkspace, pinned: boolean): AgentWorkspace {
  const next = { ...workspace };
  if (pinned) next.pinned = true;
  else delete next.pinned;
  return next;
}

/** 每个档里各有多少个会话（chip 上显示的那个数字）。按**全部会话**算，不按当前目录 */
export function sessionCounts(sessions: readonly AgentSession[]): Record<SessionFilter, number> {
  const counts: Record<SessionFilter, number> = { all: 0, waiting: 0, active: 0 };

  for (const session of sessions) {
    for (const filter of SESSION_FILTERS) {
      if (matchesSessionFilter(session.status, filter)) counts[filter] += 1;
    }
  }

  return counts;
}

/**
 * 置顶的排前面，其余**保持原顺序**。
 *
 * ⚠️ 靠 `Array.prototype.sort` 的**稳定性**（ES2019 起规范要求）：置顶只是
 * 「把这几条拎到上面」，不该顺手把用户自己摆的顺序也打乱 —— 同档内必须原序。
 */
export function sortWorkspaces(workspaces: readonly AgentWorkspace[]): AgentWorkspace[] {
  return [...workspaces].sort(
    (a, b) => Number(b.pinned === true) - Number(a.pinned === true),
  );
}
