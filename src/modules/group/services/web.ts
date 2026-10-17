/**
 * 浏览器实现（内存假实现，给 e2e 和 `npm run dev` 用）。
 *
 * ⚠️ **事件顺序和形状必须和 Rust 那边一模一样**（否则 e2e 假绿、真机全是 bug）：
 *
 * ```
 * turnStarted → memberQueued…（全部）→ memberStarted → memberText…
 *             → memberTool… → memberFinished → … → turnFinished
 * ```
 *
 * `turnFinished` 一定是最后一条；`seq` **每一轮从 1 重新开始**（Rust 的
 * EventSink 就是每轮一个）—— 所以 reducer 必须把 `turnStarted` 当成新轮次的
 * 起点，不能拿上一轮的 seq 把它挡掉。
 *
 * 语义对齐点：
 * * 不 @ = 所有启用成员；@ 了 = 只跑被点名的（未知 id 在这里也报错）；
 * * **顺序模式**：后发言的成员回复里带上前面成员的发言片段（能验出「看到彼此」）；
 *   并行模式没有这一段；
 * * prompt 里带「失败」时，**最后一个**成员走失败分支（e2e 用）。
 *
 * 数据只放在模块级内存里：刷新页面就重置（和浏览器版其它模块一致）。
 */

import type {
  CliKind,
  CliProbe,
  GroupClient,
  GroupConfigInput,
  GroupDetail,
  GroupEvent,
  GroupMessage,
  GroupSummary,
  MemberConfig,
  SendAck,
  SendRequest,
} from './types';

const TICK = 12;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let nextId = 1;
const newId = (prefix: string): string => `${prefix}_${nextId++}`;

const groups = new Map<string, GroupDetail>();
const history = new Map<string, GroupMessage[]>();

interface FakeRun {
  cancelled: boolean;
}

/**
 * `Omit<GroupEvent, 'seq'>` 作用在**联合类型**上会塌成公共字段 —— 必须分发。
 * （TS 的 Omit 不分配，这是个经典坑。）
 */
type EventPayload = GroupEvent extends infer T
  ? T extends GroupEvent
    ? Omit<T, 'seq'>
    : never
  : never;
/** 每个群最多一轮（和 Rust 的 `GroupRuntime` 一致）。 */
const running = new Map<string, FakeRun>();

export function createWebGroupClient(): GroupClient {
  return {
    async list(): Promise<GroupSummary[]> {
      return [...groups.values()]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((g) => ({
          id: g.id,
          name: g.name,
          workspace: g.workspace,
          mode: g.mode,
          memberCount: g.members.length,
          updatedAt: g.updatedAt,
        }));
    },

    async create(name: string): Promise<GroupDetail> {
      const trimmed = name.trim();
      if (trimmed === '') throw new Error('群名不能为空');
      const now = Date.now();
      const detail: GroupDetail = {
        id: newId('g'),
        name: trimmed,
        workspace: '',
        mode: 'sequential',
        contextTurns: 6,
        contextChars: 24000,
        timeoutSecs: 600,
        members: [],
        createdAt: now,
        updatedAt: now,
      };
      groups.set(detail.id, detail);
      history.set(detail.id, []);
      return detail;
    },

    async get(id: string): Promise<GroupDetail> {
      const detail = groups.get(id);
      if (!detail) throw new Error(`找不到：群 ${id}`);
      return detail;
    },

    async save(config: GroupConfigInput): Promise<GroupDetail> {
      const detail = groups.get(config.id);
      if (!detail) throw new Error(`找不到：群 ${config.id}`);

      if (config.name.trim() === '') throw new Error('群名不能为空');
      const seen = new Set<string>();
      const members: MemberConfig[] = config.members.map((m, index) => {
        const name = m.name.trim();
        if (name === '') throw new Error('成员名字不能为空');
        const lower = name.toLowerCase();
        if (seen.has(lower)) throw new Error(`成员名字重复了：${name}`);
        seen.add(lower);
        if (m.kind === 'custom' && m.command.trim() === '') {
          throw new Error(`成员「${name}」是自定义工具，必须填命令`);
        }
        return {
          id: m.id.trim() === '' ? newId('m') : m.id,
          name,
          kind: m.kind,
          command: m.command.trim(),
          model: m.model.trim(),
          rolePrompt: m.rolePrompt,
          permission: m.permission,
          extraArgs: m.extraArgs,
          position: index,
          enabled: m.enabled,
        };
      });

      const next: GroupDetail = {
        ...detail,
        name: config.name.trim(),
        workspace: config.workspace,
        mode: config.mode,
        contextTurns: config.contextTurns,
        contextChars: config.contextChars,
        timeoutSecs: config.timeoutSecs,
        members,
        updatedAt: Date.now(),
      };
      groups.set(detail.id, next);
      return next;
    },

    async remove(id: string): Promise<boolean> {
      if (running.has(id)) throw new Error('这个群还有一轮在跑 —— 先停止，或者等它跑完');
      history.delete(id);
      return groups.delete(id);
    },

    async history(id: string): Promise<GroupMessage[]> {
      return history.get(id) ?? [];
    },

    async clearHistory(id: string): Promise<void> {
      if (running.has(id)) throw new Error('这个群还有一轮在跑 —— 先停止，或者等它跑完');
      history.set(id, []);
    },

    async send(request: SendRequest): Promise<SendAck> {
      const detail = groups.get(request.groupId);
      if (!detail) throw new Error(`找不到：群 ${request.groupId}`);
      if (running.has(request.groupId)) {
        throw new Error('这个群还有一轮在跑 —— 先停止，或者等它跑完');
      }
      const text = request.text.trim();
      if (text === '') throw new Error('消息不能为空');

      const enabled = detail.members
        .filter((m) => m.enabled)
        .sort((a, b) => a.position - b.position);
      let selected: MemberConfig[];
      if (request.mentionIds.length === 0) {
        selected = enabled;
      } else {
        selected = [];
        for (const id of request.mentionIds) {
          const hit = enabled.find((m) => m.id === id);
          if (!hit) throw new Error(`@ 了一个不存在或已停用的成员（${id}）`);
          if (!selected.some((m) => m.id === id)) selected.push(hit);
        }
        selected.sort((a, b) => a.position - b.position);
      }
      if (selected.length === 0) {
        throw new Error('这个群还没有可用的成员 —— 先去右侧检查器加一个');
      }

      const run: FakeRun = { cancelled: false };
      running.set(detail.id, run);

      const turnId = newId('turn');
      let seq = 0;
      const emit = (kind: EventPayload): void => {
        seq += 1;
        request.onEvent({ seq, ...kind } as GroupEvent);
      };

      const now = Date.now();
      const userMessageId = addMessage(detail.id, {
        turnId,
        speakerKind: 'user',
        memberId: null,
        speakerName: '你',
        memberPosition: -1,
        text,
        tools: [],
        status: 'done',
        error: '',
        usage: null,
        createdAt: now,
      });

      emit({
        kind: 'turnStarted',
        turnId,
        groupId: detail.id,
        userMessageId,
        userText: text,
        memberIds: selected.map((m) => m.id),
        mode: detail.mode,
        startedAt: now,
      });
      selected.forEach((m, position) => {
        emit({ kind: 'memberQueued', memberId: m.id, position });
      });

      void drive(detail, selected, text, turnId, emit, run).finally(() => {
        running.delete(detail.id);
      });

      return {
        turnId,
        memberIds: selected.map((m) => m.id),
        userMessageId,
      };
    },

    async stop(groupId: string, _turnId: string): Promise<void> {
      const run = running.get(groupId);
      if (run) run.cancelled = true;
    },

    async probe(kind: CliKind, command: string | null): Promise<CliProbe> {
      const program =
        command?.trim() ||
        (kind === 'custom' ? '' : kind);
      if (program === '') {
        return {
          available: false,
          program,
          version: null,
          error: '自定义工具要先填命令',
        };
      }
      return {
        available: true,
        program,
        version: `${program} v9.9.9（浏览器假实现）`,
        error: null,
      };
    },
  };
}

function addMessage(
  groupId: string,
  message: Omit<GroupMessage, 'id'>,
): number {
  const list = history.get(groupId) ?? [];
  const id = nextId++;
  list.push({ id, ...message });
  history.set(groupId, list);
  return id;
}

const truncate = (s: string, n: number): string =>
  s.length <= n ? s : `${s.slice(0, n)}…`;

/** 假成员的一次发言。顺序模式下 `prior` 是前面成员的回答。 */
async function drive(
  detail: GroupDetail,
  members: MemberConfig[],
  prompt: string,
  turnId: string,
  emit: (kind: EventPayload) => void,
  run: FakeRun,
): Promise<void> {
  const startedAt = Date.now();
  const prior: Array<{ name: string; text: string }> = [];
  // e2e 的停止用例需要一个**慢到来得及点**的轮次（真实 CLI 动辄几十秒，
  // 这里用 prompt 里的「慢」当开关，和「失败」同一个用法）。
  const tick = prompt.includes('慢') ? 150 : TICK;

  const say = async (member: MemberConfig, position: number): Promise<void> => {
    if (run.cancelled) {
      emit({
        kind: 'memberFinished',
        memberId: member.id,
        messageId: null,
        status: 'cancelled',
        text: '',
        error: null,
        usage: null,
        elapsedMs: Date.now() - startedAt,
      });
      return;
    }

    emit({ kind: 'memberStarted', memberId: member.id, startedAt: Date.now() });
    emit({ kind: 'memberActivity', memberId: member.id, activity: 'thinking' });

    const seen =
      detail.mode === 'sequential' && prior.length > 0
        ? `（看到 ${prior
            .map((p) => `${p.name} 说「${truncate(p.text, 24)}」`)
            .join('、')}）`
        : '';
    const full = `「${member.name}」回答：${seen}这是第 ${position + 1} 位成员的回复。`;
    const parts = [full.slice(0, 8), full.slice(8, 20), full.slice(20)];

    for (const part of parts) {
      if (run.cancelled) break;
      if (part === '') continue;
      emit({ kind: 'memberText', memberId: member.id, text: part });
      await sleep(tick);
    }

    // 一条工具痕迹（让 e2e 能验工具行的渲染与收尾）
    const toolName =
      member.kind === 'codex'
        ? 'command'
        : member.kind === 'custom'
          ? 'tool'
          : 'read_file';
    emit({
      kind: 'memberTool',
      memberId: member.id,
      toolId: `${member.id}_tool`,
      name: toolName,
      display: `读 ${member.name} 的上下文`,
      state: 'started',
    });
    await sleep(tick);
    emit({
      kind: 'memberTool',
      memberId: member.id,
      toolId: `${member.id}_tool`,
      name: toolName,
      display: `读 ${member.name} 的上下文`,
      state: 'finished',
    });

    // 「失败」分支：最后一个成员失败，前面的照常完成（e2e 验「单个失败不终止整轮」）。
    const shouldFail =
      prompt.includes('失败') && position === members.length - 1;

    const messageId = addMessage(detail.id, {
      turnId,
      speakerKind: 'member',
      memberId: member.id,
      speakerName: member.name,
      memberPosition: position,
      text: full,
      tools: [
        {
          toolId: `${member.id}_tool`,
          name: toolName,
          display: `读 ${member.name} 的上下文`,
          isError: false,
        },
      ],
      status: shouldFail ? 'failed' : 'done',
      error: shouldFail ? '假实现：这一轮失败了' : '',
      usage: null,
      createdAt: Date.now(),
    });

    emit({
      kind: 'memberFinished',
      memberId: member.id,
      messageId,
      status: shouldFail ? 'failed' : 'done',
      text: full,
      error: shouldFail ? '假实现：这一轮失败了' : null,
      usage: null,
      elapsedMs: Date.now() - startedAt,
    });

    if (!shouldFail) {
      prior.push({ name: member.name, text: full });
    }
  };

  if (detail.mode === 'sequential') {
    for (let i = 0; i < members.length; i += 1) {
      const member = members[i];
      if (member === undefined) break;
      if (run.cancelled) {
        // 还没轮到的成员：各自收一条「已停止」，前端占位才不会挂着
        for (let j = i; j < members.length; j += 1) {
          const rest = members[j];
          if (rest === undefined) continue;
          emit({
            kind: 'memberFinished',
            memberId: rest.id,
            messageId: null,
            status: 'cancelled',
            text: '',
            error: null,
            usage: null,
            elapsedMs: Date.now() - startedAt,
          });
        }
        break;
      }
      await say(member, i);
    }
  } else {
    await Promise.all(members.map((m, i) => say(m, i)));
  }

  emit({
    kind: 'turnFinished',
    turnId,
    status: run.cancelled ? 'cancelled' : 'done',
    error: null,
    elapsedMs: Date.now() - startedAt,
  });
}

/** 给 e2e 用的重置钩子（单 worker 串行跑，每个用例开始前清一次）。 */
export function __resetGroupsForTest(): void {
  groups.clear();
  history.clear();
  running.clear();
  nextId = 1;
}
