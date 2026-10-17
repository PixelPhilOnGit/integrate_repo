/**
 * 群组模块的 store。
 *
 * # 两条容易写错的地方
 *
 * 1. **事件只往「发起这一轮的那个群」的时间线上写**。用户发完消息切去别的群，
 *    后台事件还会继续来 —— 不判断的话它们会被拼到**另一个群**的时间线上。
 *    切走的那些群靠 `runningGroups` 记状态，切回来时用 `history()` 对账。
 * 2. **`turnFinished` 之后用 DB 历史对账**：内存里的占位消息 key 是
 *    `pending:...`，对账之后换成 `db:<id>`，和重开模块时的形状一致。
 *
 * store 不直接 import 平台实现：`GroupClient` 是注入的（单测里塞假客户端）。
 */

import type { ShellApi } from '../../../shell/types';
import {
  messagesFromDb,
  reduceEvent,
  type ChatMessage,
  type MemberRun,
} from '../core/chat';
import { parseMentions } from '../core/mention';
import { blankMember, toConfigInput, validateGroupConfig } from '../core/config';
import { groupClient } from '../services';
import type {
  CliKind,
  CliProbe,
  GroupClient,
  GroupDetail,
  GroupEvent,
  GroupSummary,
} from '../services/types';

export interface GroupState {
  ready: boolean;
  groups: GroupSummary[];
  selectedId: string | null;
  detail: GroupDetail | null;
  messages: ChatMessage[];
  runs: Record<string, MemberRun>;
  activeTurnId: string | null;
  /** 哪些群有一轮在跑（按群；切走之后仍然记着） */
  runningGroups: Record<string, boolean>;
  /** 正在等 `send` 的 ack（按钮禁用用） */
  sending: boolean;
  /** 正在落库（防止加成员后立刻编辑造成的重复创建） */
  saving: boolean;
  /** reducer 的 seq 水位 */
  lastSeq: number;
  error: string | null;
  notice: string | null;
}

function initialState(): GroupState {
  return {
    ready: false,
    groups: [],
    selectedId: null,
    detail: null,
    messages: [],
    runs: {},
    activeTurnId: null,
    runningGroups: {},
    sending: false,
    saving: false,
    lastSeq: 0,
    error: null,
    notice: null,
  };
}

const NOTICE_MS = 1800;

export class GroupStore {
  private listeners = new Set<() => void>();
  private state: GroupState = initialState();
  private initPromise: Promise<void> | null = null;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  /** 外壳能力。默认空实现：store 可能在注入之前就被构造（单测里直接 new） */
  private shell: ShellApi = {
    setStatus: () => {},
    reportError: () => {},
    openInspector: () => {},
  };

  constructor(private client: GroupClient) {}

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getSnapshot = (): GroupState => this.state;

  attachShell(shell: ShellApi): void {
    this.shell = shell;
  }

  /** 惰性初始化（由 `onActivate` 触发，只跑一次）。 */
  init(): Promise<void> {
    this.initPromise ??= this.doInit();
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    try {
      const groups = await this.client.list();
      this.set({ ready: true, groups });
      const first = groups[0];
      if (first !== undefined && this.state.selectedId === null) {
        await this.selectGroup(first.id);
      }
    } catch (e) {
      this.set({ ready: true, error: describeError(e) });
      this.shell.reportError(e);
    }
  }

  async refreshGroups(): Promise<void> {
    try {
      const groups = await this.client.list();
      this.set({ groups });
    } catch (e) {
      this.set({ error: describeError(e) });
    }
  }

  async selectGroup(id: string): Promise<void> {
    if (this.state.selectedId === id && this.state.detail !== null) return;
    this.set({
      selectedId: id,
      detail: null,
      messages: [],
      runs: {},
      activeTurnId: null,
      lastSeq: 0,
      error: null,
    });
    try {
      const [detail, rows] = await Promise.all([
        this.client.get(id),
        this.client.history(id),
      ]);
      // 加载期间用户可能又切走了
      if (this.state.selectedId !== id) return;
      this.set({ detail, messages: messagesFromDb(rows) });
    } catch (e) {
      this.set({ error: describeError(e) });
    }
  }

  async createGroup(name: string): Promise<void> {
    try {
      const detail = await this.client.create(name);
      await this.refreshGroups();
      await this.selectGroup(detail.id);
      this.flashNotice(`建好了：${detail.name}`);
      // 新群还没成员 —— 直接请出检查器，少一次「去哪加成员」的寻找。
      this.shell.openInspector();
    } catch (e) {
      this.set({ error: describeError(e) });
    }
  }

  async deleteGroup(id: string): Promise<void> {
    try {
      await this.client.remove(id);
      const groups = await this.client.list();
      const wasSelected = this.state.selectedId === id;
      this.set({ groups });
      if (wasSelected) {
        this.set({
          selectedId: null,
          detail: null,
          messages: [],
          runs: {},
          activeTurnId: null,
          lastSeq: 0,
        });
        const first = groups[0];
        if (first !== undefined) await this.selectGroup(first.id);
      }
      this.flashNotice('群已删除');
    } catch (e) {
      this.set({ error: describeError(e) });
    }
  }

  // ---------------------------------------------------------------- 配置编辑

  /** 只改内存里的草稿；`persist()` 才落库。 */
  patchDetail(patch: Partial<GroupDetail>): void {
    const detail = this.state.detail;
    if (detail === null) return;
    this.set({ detail: { ...detail, ...patch } });
  }

  patchMember(memberId: string, patch: Partial<GroupDetail['members'][number]>): void {
    const detail = this.state.detail;
    if (detail === null) return;
    const members = detail.members.map((m) =>
      m.id === memberId ? { ...m, ...patch } : m,
    );
    this.set({ detail: { ...detail, members } });
  }

  /**
   * 加一个成员并**立刻落库**（拿到 id 才能编辑）。
   *
   * ⚠️ 不立刻落库的话，用户接着编辑名字时那次 `persist()` 会带着一个空 id
   * 的成员再存一次 —— 后端每次都会**新建一条**，成员列表里凭空多一个。
   */
  async addMember(): Promise<void> {
    const detail = this.state.detail;
    if (detail === null) return;
    const members = [...detail.members, blankMember(detail.members.length, uniqueMemberName(detail))];
    this.set({ detail: { ...detail, members } });
    await this.persist();
  }

  async removeMember(memberId: string): Promise<void> {
    const detail = this.state.detail;
    if (detail === null) return;
    const members = detail.members
      .filter((m) => m.id !== memberId)
      .map((m, index) => ({ ...m, position: index }));
    this.set({ detail: { ...detail, members } });
    await this.persist();
  }

  /** 保存当前草稿。成功返回 true。 */
  async persist(): Promise<boolean> {
    const detail = this.state.detail;
    if (detail === null) return false;
    const problem = validateGroupConfig(detail);
    if (problem !== null) {
      this.set({ error: problem });
      return false;
    }
    this.set({ saving: true });
    try {
      const saved = await this.client.save(toConfigInput(detail));
      this.set({ detail: saved, error: null, saving: false });
      await this.refreshGroups();
      this.flashNotice('已保存');
      return true;
    } catch (e) {
      this.set({ error: describeError(e), saving: false });
      return false;
    }
  }

  // ---------------------------------------------------------------- 跑一轮

  /**
   * 发一句话。`@` 解析在这里做（纯函数），未知提及**直接拦住**。
   */
  async send(text: string): Promise<boolean> {
    const detail = this.state.detail;
    if (detail === null || this.state.sending) return false;
    if (this.state.runningGroups[detail.id] === true) return false;
    const trimmed = text.trim();
    if (trimmed === '') return false;

    const enabled = detail.members.filter((m) => m.enabled);
    if (enabled.length === 0) {
      this.set({ error: '这个群还没有可用的成员 —— 先去右侧检查器加一个' });
      this.shell.openInspector();
      return false;
    }

    const parsed = parseMentions(
      trimmed,
      enabled.map((m) => ({ memberId: m.id, name: m.name })),
    );
    if (parsed.unknown.length > 0) {
      // ⚠️ 不静默退化成「全员」：用户会以为只是没点名。
      this.set({
        error: `群里没有这些成员：${parsed.unknown.map((n) => `@${n}`).join('、')}`,
      });
      return false;
    }

    const groupId = detail.id;
    this.set({ sending: true, error: null });
    try {
      const ack = await this.client.send({
        groupId,
        text: trimmed,
        mentionIds: parsed.mentions.map((m) => m.memberId),
        onEvent: (event) => this.onEvent(groupId, event),
      });
      // 事件可能先于 ack 到达：turnStarted 已经把 activeTurnId 设好了。
      this.set({
        activeTurnId: this.state.activeTurnId ?? ack.turnId,
        runningGroups: { ...this.state.runningGroups, [groupId]: true },
        sending: false,
      });
      return true;
    } catch (e) {
      this.set({ sending: false, error: describeError(e) });
      return false;
    }
  }

  async stop(): Promise<void> {
    const detail = this.state.detail;
    const turnId = this.state.activeTurnId;
    if (detail === null || turnId === null) return;
    try {
      await this.client.stop(detail.id, turnId);
    } catch (e) {
      this.set({ error: describeError(e) });
    }
  }

  async clearHistory(): Promise<void> {
    const detail = this.state.detail;
    if (detail === null) return;
    if (this.state.runningGroups[detail.id] === true) return;
    try {
      await this.client.clearHistory(detail.id);
      this.set({ messages: [], runs: {}, lastSeq: 0 });
    } catch (e) {
      this.set({ error: describeError(e) });
    }
  }

  async probe(kind: CliKind, command: string | null): Promise<CliProbe> {
    return await this.client.probe(kind, command);
  }

  dismissError(): void {
    this.set({ error: null });
  }

  // ---------------------------------------------------------------- 内部

  private onEvent(groupId: string, event: GroupEvent): void {
    // 不是当前选中的群：只更新「它还在跑」这个事实，别往当前时间线里掺。
    if (this.state.selectedId !== groupId) {
      if (event.kind === 'turnFinished') {
        const runningGroups = { ...this.state.runningGroups };
        delete runningGroups[groupId];
        this.set({ runningGroups });
      }
      return;
    }

    const chat = {
      messages: this.state.messages,
      runs: this.state.runs,
      activeTurnId: this.state.activeTurnId,
      lastSeq: this.state.lastSeq,
    };
    const next = reduceEvent(chat, event, (memberId) => this.memberName(memberId));

    const runningGroups = { ...this.state.runningGroups };
    if (event.kind === 'turnFinished') {
      delete runningGroups[groupId];
    } else {
      runningGroups[groupId] = true;
    }

    this.set({
      messages: next.messages,
      runs: next.runs,
      activeTurnId: next.activeTurnId,
      lastSeq: next.lastSeq,
      runningGroups,
      sending: next.activeTurnId === null ? false : this.state.sending,
    });

    if (event.kind === 'turnFinished') {
      void this.reconcile(groupId);
    }
  }

  /** 一轮结束后用 DB 历史对账（把占位 key 换成正式 id，顺带补齐失败原因）。 */
  private async reconcile(groupId: string): Promise<void> {
    try {
      const rows = await this.client.history(groupId);
      if (this.state.selectedId !== groupId) return;
      // 对账期间又开始了一轮就别覆盖（那是新轮次的内存态）。
      if (this.state.activeTurnId !== null) return;
      // ⚠️ 保留 runs：侧栏要显示上一轮每个成员的结局（完成/失败），
      // 清掉的话一轮刚跑完状态就全变回「空闲」，看起来像没跑过。
      this.set({ messages: messagesFromDb(rows) });
    } catch {
      // 对账失败不影响已经显示的内容；下次选中时还会再读。
    }
  }

  private memberName(memberId: string): string {
    return (
      this.state.detail?.members.find((m) => m.id === memberId)?.name ?? '成员'
    );
  }

  private set(patch: Partial<GroupState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }

  private flashNotice(text: string): void {
    if (this.noticeTimer !== null) clearTimeout(this.noticeTimer);
    this.set({ notice: text });
    this.noticeTimer = setTimeout(() => {
      this.noticeTimer = null;
      this.set({ notice: null });
    }, NOTICE_MS);
  }
}

/** 新成员的默认名：`新成员`、`新成员 2`…（群内唯一，避免一加就撞校验） */
function uniqueMemberName(detail: GroupDetail): string {
  const names = new Set(detail.members.map((m) => m.name.trim().toLowerCase()));
  if (!names.has('新成员')) return '新成员';
  for (let n = 2; n < 100; n += 1) {
    if (!names.has(`新成员 ${n}`)) return `新成员 ${n}`;
  }
  return `新成员 ${Date.now()}`;
}

function describeError(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message;
  return String(e);
}

/** 模块级单例（服务按运行环境在 `services/index.ts` 里选好）。 */
export const groupStore = new GroupStore(groupClient);
