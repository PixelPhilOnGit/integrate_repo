/**
 * 群组协作的 IPC 契约。
 *
 * ⚠️ **形状必须和 Rust 的 `devtoolkit-group` 一字不差**：
 * * `GroupEvent` ↔ `group/src/event.rs`（`#[serde(tag = "kind", rename_all =
 *   "camelCase", rename_all_fields = "camelCase")]`）；
 * * `GroupDetail` / `MemberConfig` / `GroupMessage` ↔ `group/src/store.rs`。
 *
 * 这条缝两端各自的测试都盖不到（前端跑假实现、Rust 直接构造值），所以
 * `src-tauri/src/group_commands.rs` 里有一组**手写前端 JSON** 的 contract 测试。
 */

export type CliKind = 'claude' | 'csc' | 'codex' | 'custom';
export type Permission = 'readOnly' | 'workspaceWrite' | 'full';
export type TurnMode = 'sequential' | 'parallel';

export interface GroupSummary {
  id: string;
  name: string;
  workspace: string;
  mode: TurnMode;
  memberCount: number;
  updatedAt: number;
}

export interface MemberConfig {
  id: string;
  name: string;
  kind: CliKind;
  command: string;
  model: string;
  rolePrompt: string;
  permission: Permission;
  extraArgs: string[];
  position: number;
  enabled: boolean;
}

export interface GroupDetail {
  id: string;
  name: string;
  workspace: string;
  mode: TurnMode;
  contextTurns: number;
  contextChars: number;
  timeoutSecs: number;
  members: MemberConfig[];
  createdAt: number;
  updatedAt: number;
}

/** 消息里的一条工具痕迹（和 `store::ToolTrace` 对应）。 */
export interface ToolTrace {
  toolId: string | null;
  name: string;
  display: string;
  /** `null` = 还没有结果 */
  isError: boolean | null;
}

export interface GroupMessage {
  id: number;
  turnId: string;
  speakerKind: 'user' | 'member' | 'system';
  memberId: string | null;
  speakerName: string;
  memberPosition: number;
  text: string;
  tools: ToolTrace[];
  status: 'done' | 'failed' | 'cancelled';
  error: string;
  usage: string | null;
  createdAt: number;
}

export type MemberActivity = 'thinking' | 'tool';
export type ToolState = 'started' | 'finished' | 'failed';
export type MemberStatus = 'done' | 'failed' | 'cancelled';
export type TurnStatus = 'done' | 'failed' | 'cancelled';

/**
 * 一轮里推上来的事件。`seq` 严格递增，**顺序就是应用顺序**。
 *
 * `turnFinished` 一定是最后一条；前端以它为硬边界，之后的事件一律忽略。
 */
export type GroupEvent = { seq: number } & (
  | {
      kind: 'turnStarted';
      turnId: string;
      groupId: string;
      userMessageId: number;
      userText: string;
      memberIds: string[];
      mode: TurnMode;
      startedAt: number;
    }
  | { kind: 'memberQueued'; memberId: string; position: number }
  | { kind: 'memberStarted'; memberId: string; startedAt: number }
  | { kind: 'memberText'; memberId: string; text: string }
  | { kind: 'memberActivity'; memberId: string; activity: MemberActivity }
  | {
      kind: 'memberTool';
      memberId: string;
      toolId: string | null;
      name: string;
      display: string;
      state: ToolState;
    }
  | {
      kind: 'memberFinished';
      memberId: string;
      messageId: number | null;
      status: MemberStatus;
      text: string;
      error: string | null;
      usage: string | null;
      elapsedMs: number;
    }
  | {
      kind: 'turnFinished';
      turnId: string;
      status: TurnStatus;
      error: string | null;
      elapsedMs: number;
    }
);

export interface SendAck {
  turnId: string;
  memberIds: string[];
  userMessageId: number;
}

export interface CliProbe {
  available: boolean;
  program: string;
  version: string | null;
  error: string | null;
}

/** 保存用的输入（成员 id 为空串 = 新成员）。 */
export interface GroupConfigInput {
  id: string;
  name: string;
  workspace: string;
  mode: TurnMode;
  contextTurns: number;
  contextChars: number;
  timeoutSecs: number;
  members: Array<{
    id: string;
    name: string;
    kind: CliKind;
    command: string;
    model: string;
    rolePrompt: string;
    permission: Permission;
    extraArgs: string[];
    position: number;
    enabled: boolean;
  }>;
}

export interface SendRequest {
  groupId: string;
  text: string;
  mentionIds: string[];
  onEvent: (event: GroupEvent) => void;
}

export interface GroupClient {
  list(): Promise<GroupSummary[]>;
  create(name: string): Promise<GroupDetail>;
  get(id: string): Promise<GroupDetail>;
  save(config: GroupConfigInput): Promise<GroupDetail>;
  remove(id: string): Promise<boolean>;
  history(id: string, limit?: number): Promise<GroupMessage[]>;
  send(request: SendRequest): Promise<SendAck>;
  stop(groupId: string, turnId: string): Promise<void>;
  clearHistory(groupId: string): Promise<void>;
  probe(kind: CliKind, command: string | null): Promise<CliProbe>;
}
