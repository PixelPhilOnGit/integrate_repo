/**
 * 磁盘格式：序列化、解析、校验、迁移。
 *
 * 解析走的路径是"宽容读取 + 严格写出"：
 *   - 写出去的一定是当前版本、字段完整
 *   - 读进来的一律当作不可信输入（用户可能手改过、可能是旧版本、可能被截断），
 *     能修就修，修不了就丢掉单个元素，**绝不因为一个坏字段让整个文件打不开**
 *
 * 尤其是悬空引用：消息指向不存在的参与者、激活条指向不存在的消息 ——
 * 这些如果放任进入渲染层，会导致布局算出 NaN 坐标，整个画布白屏。
 * 所以在这里统一清理掉。
 */

import type {
  Activation,
  Doc,
  Message,
  MessageKind,
  Note,
  Participant,
  ParticipantKind,
  Theme,
} from './model';
import { MESSAGE_KINDS, PARTICIPANT_KINDS, SCHEMA_VERSION } from './model';
import { DARK_THEME, LIGHT_THEME, defaultTheme, getTheme } from './theme';

export class DocParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocParseError';
  }
}

export function serializeDoc(doc: Doc): string {
  return JSON.stringify({ ...doc, schemaVersion: SCHEMA_VERSION }, null, 2) + '\n';
}

// ---------------------------------------------------------------------------
// 基础类型守卫
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}

function optStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function optNum(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v)
    ? (v as T)
    : fallback;
}

// ---------------------------------------------------------------------------
// 主题
// ---------------------------------------------------------------------------

export function parseTheme(v: unknown): Theme {
  if (!isRecord(v)) return defaultTheme();
  // 只写了 themeId 的旧文件（或手写文件）
  if (typeof v.id === 'string' && v.participantFill === undefined) {
    return getTheme(v.id);
  }
  const base = v.mode === 'dark' ? DARK_THEME : LIGHT_THEME;
  return {
    id: str(v.id, 'custom'),
    name: str(v.name, '自定义'),
    mode: v.mode === 'dark' ? 'dark' : 'light',
    background: str(v.background, base.background),
    fontFamily: str(v.fontFamily, base.fontFamily),
    fontSize: num(v.fontSize, base.fontSize),
    messageFontSize: num(v.messageFontSize, base.messageFontSize),
    textColor: str(v.textColor, base.textColor),
    lineColor: str(v.lineColor, base.lineColor),
    participantFill: str(v.participantFill, base.participantFill),
    participantStroke: str(v.participantStroke, base.participantStroke),
    activationFill: str(v.activationFill, base.activationFill),
    activationStroke: str(v.activationStroke, base.activationStroke),
    noteFill: str(v.noteFill, base.noteFill),
    noteStroke: str(v.noteStroke, base.noteStroke),
    noteTextColor: str(v.noteTextColor, base.noteTextColor),
    // 这三个是后加的：老文件里没有，回落到内置主题的默认值
    syncMessageColor: str(v.syncMessageColor, base.syncMessageColor),
    asyncMessageColor: str(v.asyncMessageColor, base.asyncMessageColor),
    returnMessageColor: str(v.returnMessageColor, base.returnMessageColor),
    lineWidth: num(v.lineWidth, base.lineWidth),
    messageSpacing: num(v.messageSpacing, base.messageSpacing),
    participantGap: num(v.participantGap, base.participantGap),
    showSequenceNumbers: bool(v.showSequenceNumbers, base.showSequenceNumbers),
  };
}

// ---------------------------------------------------------------------------
// 元素
// ---------------------------------------------------------------------------

function parseParticipant(v: unknown): Participant | null {
  if (!isRecord(v)) return null;
  const id = optStr(v.id);
  if (!id) return null;
  const p: Participant = {
    id,
    kind: oneOf<ParticipantKind>(v.kind, PARTICIPANT_KINDS, 'object'),
    name: str(v.name, '未命名'),
    x: num(v.x, 0),
  };
  const alias = optStr(v.alias);
  if (alias) p.alias = alias;
  const groupId = optStr(v.groupId);
  if (groupId) p.groupId = groupId;
  return p;
}

function parseMessage(v: unknown): Message | null {
  if (!isRecord(v)) return null;
  const id = optStr(v.id);
  const from = optStr(v.from);
  const to = optStr(v.to);
  if (!id || !from || !to) return null;
  const m: Message = {
    id,
    kind: oneOf<MessageKind>(v.kind, MESSAGE_KINDS, 'sync'),
    from,
    to,
    label: str(v.label, ''),
    y: num(v.y, 0),
  };
  const seq = optNum(v.seq);
  if (seq !== undefined) m.seq = seq;
  const groupId = optStr(v.groupId);
  if (groupId) m.groupId = groupId;
  return m;
}

function parseActivation(v: unknown): Activation | null {
  if (!isRecord(v)) return null;
  const id = optStr(v.id);
  const participant = optStr(v.participant);
  const startMessageId = optStr(v.startMessageId);
  if (!id || !participant || !startMessageId) return null;
  const a: Activation = { id, participant, startMessageId };
  const end = optStr(v.endMessageId);
  if (end) a.endMessageId = end;
  const parent = optStr(v.parentId);
  if (parent) a.parentId = parent;
  const groupId = optStr(v.groupId);
  if (groupId) a.groupId = groupId;
  return a;
}

function parseNote(v: unknown): Note | null {
  if (!isRecord(v)) return null;
  const id = optStr(v.id);
  if (!id) return null;
  const n: Note = {
    id,
    text: str(v.text, ''),
    x: num(v.x, 0),
    y: num(v.y, 0),
  };
  const attachTo = optStr(v.attachTo);
  if (attachTo) n.attachTo = attachTo;
  return n;
}

// ---------------------------------------------------------------------------
// 迁移
// ---------------------------------------------------------------------------

/**
 * 把任意版本的原始对象迁移到当前版本。
 * 目前只有 v1，所以这里主要是把缺失的 schemaVersion 补上；
 * 以后加 v2 时在这里按版本号逐级升级，不要改动 parseDoc 的主流程。
 */
export function migrate(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  const version = num(raw.schemaVersion, 1);
  let doc: Record<string, unknown> = { ...raw };

  // 未来的迁移链写在这里，例如：
  // if (version < 2) { doc = migrateV1ToV2(doc); }

  doc.schemaVersion = Math.max(version, SCHEMA_VERSION);
  return doc;
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

export function parseDoc(text: string, fallbackTitle = '未命名'): Doc {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new DocParseError(`文件不是合法的 JSON：${(e as Error).message}`);
  }
  if (!isRecord(raw)) {
    throw new DocParseError('文件内容不是一个对象');
  }

  const migrated = migrate(raw);
  if (!isRecord(migrated)) {
    throw new DocParseError('迁移后的内容不是一个对象');
  }

  const participantList = Array.isArray(migrated.participants)
    ? migrated.participants
        .map(parseParticipant)
        .filter((p): p is Participant => p !== null)
    : [];

  // 参与者 id 去重（手改文件很容易撞）
  const seenP = new Set<string>();
  const participants = participantList.filter((p) => {
    if (seenP.has(p.id)) return false;
    seenP.add(p.id);
    return true;
  });

  const messageList = Array.isArray(migrated.messages)
    ? migrated.messages.map(parseMessage).filter((m): m is Message => m !== null)
    : [];

  // 丢掉指向不存在参与者的消息 —— 否则布局会算出 NaN
  const messages = messageList.filter(
    (m) => seenP.has(m.from) && seenP.has(m.to),
  );

  const messageIds = new Set(messages.map((m) => m.id));
  const activationList = Array.isArray(migrated.activations)
    ? migrated.activations
        .map(parseActivation)
        .filter((a): a is Activation => a !== null)
    : [];

  const activationIds = new Set(activationList.map((a) => a.id));
  const activations = activationList
    .filter((a) => seenP.has(a.participant) && messageIds.has(a.startMessageId))
    // 终点消息没了就退回"自动延伸"，比整条丢掉更符合预期
    .map((a) =>
      a.endMessageId && !messageIds.has(a.endMessageId)
        ? { ...a, endMessageId: undefined }
        : a,
    )
    // 父激活条没了（被删或本来就不存在）→ 退化成最外层，而不是留一个悬空指针。
    // 悬空指针不会崩，但会让这条激活条永远算不出正确的缩进层级。
    .map((a) => (a.parentId && !activationIds.has(a.parentId) ? { ...a, parentId: undefined } : a));

  const notes = Array.isArray(migrated.notes)
    ? migrated.notes
        .map(parseNote)
        .filter((n): n is Note => n !== null)
        // attachTo 悬空就退化成自由注释
        .map((n) => (n.attachTo && !seenP.has(n.attachTo) ? { ...n, attachTo: undefined } : n))
    : [];

  return {
    schemaVersion: SCHEMA_VERSION,
    title: str(migrated.title, fallbackTitle),
    theme: parseTheme(migrated.theme),
    participants,
    messages,
    activations,
    notes,
  };
}

/** 从文件名推出默认标题，供新建文档和解析失败时的兜底使用 */
export function titleFromFileName(fileName: string): string {
  return fileName.replace(/\.seq\.json$/i, '').replace(/\.json$/i, '') || '未命名';
}
