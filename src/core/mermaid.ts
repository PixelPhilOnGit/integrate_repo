/**
 * 导出 Mermaid sequenceDiagram 文本。
 *
 * 这是**有损**转换：精确坐标、自定义配色、字号都表达不了。
 * 换来的好处是能把图贴进 README、PR 描述、文档站，被各类工具直接渲染。
 * 所以定位是"导出一条可分享的近似图"，不是"换一种格式存盘"。
 *
 * 生成策略：把消息和激活条的起止拆成一条按 y 排序的事件流，按时间顺序输出
 * activate/deactivate —— 否则 Mermaid 渲染出来的激活条会串位。
 */

import type { Doc, Id, Message } from './model';

const SAFE_ID = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Mermaid sequenceDiagram 的保留字。
 *
 * 光看"是不是合法标识符"不够：`end`、`loop`、`alt` 这些完全符合标识符规则，
 * 但一旦出现在 `A->>B:` 的位置上就会把语法打乱，导出的图直接解析失败，
 * 而且 Mermaid 报的是"Parse error on line N"，用户根本无从下手。
 *
 * 这份清单是拿 mermaid.parse() 逐个实测出来的 —— 见 tests/unit/mermaid-valid.test.ts。
 */
const RESERVED = new Set([
  'end',
  'loop',
  'alt',
  'else',
  'opt',
  'par',
  'and',
  'rect',
  'critical',
  'break',
  'box',
  'note',
  'activate',
  'deactivate',
  'participant',
  'actor',
  'autonumber',
  'sequencediagram',
  'over',
  'left',
  'right',
  'of',
  'create',
  'destroy',
  'links',
  'link',
  'properties',
  'title',
  'accdescription',
  'accdescr',
  'direction',
]);

/** 别名能不能直接当 Mermaid 标识符用 */
function isUsableId(id: string): boolean {
  return SAFE_ID.test(id) && !RESERVED.has(id.toLowerCase());
}

/**
 * Mermaid 的别名有限制：中文名当别名解析不了，关键字当别名会打乱语法。
 * 所以只在别名本来就可用时沿用（可读性好），否则退化成 P1、P2…
 * 显示名始终走 `as`，不受影响。
 */
function buildIdMap(doc: Doc): Map<Id, string> {
  const used = new Set<string>();
  const map = new Map<Id, string>();
  let n = 0;
  for (const p of doc.participants) {
    const preferred = p.alias && isUsableId(p.alias) ? p.alias : '';
    let id = preferred;
    if (!id || used.has(id)) {
      do {
        n += 1;
        id = `P${n}`;
      } while (used.has(id));
    }
    used.add(id);
    map.set(p.id, id);
  }
  return map;
}

function escapeLabel(text: string): string {
  // 换行在 Mermaid 里用 <br/> 表示；分号会被当成语句结束符，换成全角
  return text.replace(/\r?\n/g, '<br/>').replace(/;/g, '；');
}

function messageOperator(kind: Message['kind']): string {
  switch (kind) {
    case 'async':
      return '-)';
    case 'return':
      return '-->>';
    default:
      return '->>';
  }
}

interface Event {
  y: number;
  /** 同一个 y 上：deactivate(50) → 消息行(100+) → activate(200) */
  order: number;
  text: string;
}

export function toMermaid(doc: Doc, opts: { comment?: boolean } = {}): string {
  const withComment = opts.comment !== false;
  const ids = buildIdMap(doc);
  const byId = new Map(doc.messages.map((m) => [m.id, m]));

  const lines: string[] = ['sequenceDiagram'];
  if (withComment) {
    lines.push('    %% 由 rustDraw 导出：版面坐标与配色不会保留');
    lines.push('    %% 如需继续编辑，请使用 .seq.json 源文件');
  }

  for (const p of doc.participants) {
    const kind = p.kind === 'actor' ? 'actor' : 'participant';
    lines.push(`    ${kind} ${ids.get(p.id)} as ${escapeLabel(p.name)}`);
  }

  if (doc.theme.showSequenceNumbers) {
    lines.push('    autonumber');
  }

  const events: Event[] = [];
  let seq = 0;
  for (const m of doc.messages) {
    const from = ids.get(m.from);
    const to = ids.get(m.to);
    if (!from || !to) continue;
    seq += 1;
    events.push({
      y: m.y,
      order: 100 + seq,
      text: `    ${from}${messageOperator(m.kind)}${to}: ${escapeLabel(m.label)}`,
    });
  }

  for (const a of doc.activations) {
    const pid = ids.get(a.participant);
    if (!pid) continue;
    const startMsg = byId.get(a.startMessageId);
    if (!startMsg) continue;
    events.push({ y: startMsg.y, order: 200, text: `    activate ${pid}` });

    const endMsg = a.endMessageId ? byId.get(a.endMessageId) : undefined;
    if (endMsg) {
      // 结束消息之前关闭，否则 Mermaid 会把返回箭头也算进激活范围
      events.push({ y: endMsg.y, order: 50, text: `    deactivate ${pid}` });
    } else {
      // 没有终点：图末收尾，避免 Mermaid 报"激活未关闭"
      events.push({
        y: Number.MAX_SAFE_INTEGER,
        order: 999,
        text: `    deactivate ${pid}`,
      });
    }
  }

  events.sort((a, b) => (a.y === b.y ? a.order - b.order : a.y - b.y));
  for (const e of events) lines.push(e.text);

  for (const n of doc.notes) {
    const target = nearestParticipantMermaidId(doc, ids, n.attachTo, n.x);
    if (!target) continue;
    lines.push(`    Note over ${target}: ${escapeLabel(n.text)}`);
  }

  return lines.join('\n') + '\n';
}

/** 注释要挂在哪个参与者上：优先 attachTo，否则取横坐标最近的 */
export function nearestParticipantMermaidId(
  doc: Doc,
  ids: Map<Id, string>,
  attachTo: Id | undefined,
  x: number,
): string | null {
  if (attachTo) {
    const direct = ids.get(attachTo);
    if (direct) return direct;
  }
  let bestId: Id | undefined;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const p of doc.participants) {
    const d = Math.abs(p.x - x);
    if (d < bestDist) {
      bestDist = d;
      bestId = p.id;
    }
  }
  return bestId ? (ids.get(bestId) ?? null) : null;
}

export function messageKindLabel(kind: Message['kind']): string {
  switch (kind) {
    case 'sync':
      return '同步消息';
    case 'async':
      return '异步消息';
    case 'return':
      return '返回消息';
    case 'self':
      return '自调用';
  }
}

export function participantKindLabel(kind: Doc['participants'][number]['kind']): string {
  switch (kind) {
    case 'actor':
      return '参与者';
    case 'object':
      return '对象';
    case 'boundary':
      return '边界';
    case 'control':
      return '控制';
    case 'entity':
      return '实体';
    case 'database':
      return '数据库';
  }
}
