/**
 * 群 / 成员的配置默认值与校验（纯逻辑）。
 *
 * 校验在**前端和后端各做一遍**：前端为了即时反馈（失焦就告诉用户哪里不对），
 * 后端因为「前端说什么不算数」。两边的规则要一样 —— 这里改了什么，
 * `group/src/store.rs` 的 `validate_members` 也要跟着改。
 */

import type {
  CliKind,
  GroupConfigInput,
  GroupDetail,
  MemberConfig,
  Permission,
} from '../services/types';

export const KIND_LABEL: Record<CliKind, string> = {
  claude: 'Claude Code',
  csc: 'csc（CoStrict）',
  codex: 'Codex',
  custom: '自定义 CLI',
};

export const KIND_HINT: Record<CliKind, string> = {
  claude: '命令默认 claude；无头模式 `-p --output-format stream-json`',
  csc: '深信服 CoStrict；与 Claude 同构（`csc -p …`）',
  codex: '命令默认 codex；无头模式 `codex exec --json`',
  custom: '任何能读 stdin、把回答写到 stdout 的程序；命令必填',
};

export const PERMISSION_LABEL: Record<Permission, string> = {
  readOnly: '只读',
  workspaceWrite: '可写工作目录',
  full: '完全权限',
};

/**
 * ⚠️ 权限文案必须写实 —— 三轮 CLI 的「权限」不是一回事：
 * * codex 的 workspace-write 是**真沙箱**（系统级）；
 * * claude / csc 的 allowlist 是它们自己的权限系统，不是 OS 沙箱；
 * * 自定义工具的档位**没有强制力**，只是通过环境变量告知。
 */
export const PERMISSION_HINT: Record<Permission, string> = {
  readOnly: '只允许读文件/搜索。claude/csc 靠 allowlist（权限系统，不是 OS 沙箱）。',
  workspaceWrite:
    '可读写共享工作目录，但**不允许跑命令**。codex 有系统沙箱；claude/csc 为尽力而为。',
  full: '跳过所有权限检查，可改任意文件。⚠️ 危险 —— 只在临时目录里用。',
};

let memberSeq = 0;

/**
 * 新成员的默认值（position 由调用方给；名字要群内唯一）。
 *
 * ⚠️ **id 在客户端就生成**（不是留空等后端分配）：成员一加进来用户就会开始
 * 编辑名字，如果 id 还是空串，那次编辑会被丢掉、或者下一次保存把同一个成员
 * 再建一遍。后端接受客户端给的 id（只校验它不属于别的群），代价是客户端要
 * 保证唯一（时间戳 + 计数器够了）。
 */
export function blankMember(position: number, name = ''): MemberConfig {
  memberSeq += 1;
  return {
    id: `m_${Date.now().toString(36)}_${memberSeq}`,
    name,
    kind: 'claude',
    command: '',
    model: '',
    rolePrompt: '',
    permission: 'workspaceWrite',
    extraArgs: [],
    position,
    enabled: true,
  };
}

/**
 * 校验一份待保存的配置。返回**第一处**错误的文案；`null` = 没问题。
 *
 * 和 `store.rs` 的规则一一对应（成员名唯一、custom 必须有命令、范围限制）。
 */
export function validateGroupConfig(
  detail: Pick<
    GroupDetail,
    'name' | 'contextTurns' | 'contextChars' | 'timeoutSecs' | 'members'
  >,
): string | null {
  if (detail.name.trim() === '') return '群名不能为空';
  if (detail.name.trim().length > 60) return '群名太长了（最多 60 个字）';
  if (detail.contextTurns < 1 || detail.contextTurns > 50) {
    return '上下文轮数要在 1..50 之间';
  }
  if (detail.contextChars < 1000 || detail.contextChars > 200000) {
    return '上下文字符预算要在 1000..200000 之间';
  }
  if (detail.timeoutSecs < 10 || detail.timeoutSecs > 3600) {
    return '单个成员超时要在 10..3600 秒之间';
  }
  if (detail.members.length > 12) return '一个群最多 12 个成员';

  const seen = new Set<string>();
  for (const m of detail.members) {
    const name = m.name.trim();
    if (name === '') return '成员名字不能为空';
    if (name.length > 30) return `成员名太长了：${name}`;
    const lower = name.toLowerCase();
    if (seen.has(lower)) return `成员名字重复了：${name}`;
    seen.add(lower);
    if (m.kind === 'custom' && m.command.trim() === '') {
      return `成员「${name}」是自定义工具，必须填命令`;
    }
  }
  return null;
}

/** 把界面上的 GroupDetail 转成保存用的输入（成员按 position 排序）。 */
export function toConfigInput(detail: GroupDetail): GroupConfigInput {
  const members = [...detail.members]
    .sort((a, b) => a.position - b.position)
    .map((m, index) => ({
      id: m.id,
      name: m.name.trim(),
      kind: m.kind,
      command: m.command.trim(),
      model: m.model.trim(),
      rolePrompt: m.rolePrompt,
      permission: m.permission,
      extraArgs: m.extraArgs,
      position: index,
      enabled: m.enabled,
    }));
  return {
    id: detail.id,
    name: detail.name.trim(),
    workspace: detail.workspace,
    mode: detail.mode,
    contextTurns: detail.contextTurns,
    contextChars: detail.contextChars,
    timeoutSecs: detail.timeoutSecs,
    members,
  };
}

/** `extraArgs` 在界面上是一行一个（比 JSON 数组好敲，也不容易打错引号）。 */
export function parseExtraArgs(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

export function formatExtraArgs(args: string[]): string {
  return args.join('\n');
}
