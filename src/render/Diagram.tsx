/**
 * 把算好的布局画成 SVG。
 *
 * 这是**纯展示**组件：不发请求、不改状态、不做命中测试 —— 命中测试统一由 core/layout
 * 的 hitTest 负责，交互在 Canvas 层处理。这样导出 SVG 时可以直接序列化这棵 DOM，
 * 屏幕上看到的就是导出的内容，不存在"导出的图和屏幕上不一样"的经典问题。
 *
 * 箭头头部用显式 path 画，而不是 <marker>：marker 的缩放行为在不同渲染器
 * （浏览器 / Illustrator / Inkscape）里不一致，显式 path 在哪都一样。
 */

import type { ReactNode } from 'react';
import type { Id, MessageKind, ParticipantKind } from '../core/model';
import type {
  ActivationGeom,
  Layout,
  MessageGeom,
  NoteGeom,
  ParticipantBoxGeom,
} from '../core/layout';
import type { PendingMessage, Selection } from '../state/store';

// 空心箭头刻意画得比实心的大一圈：同步/异步的差别本来就只有箭头形状，
// 尺寸一样大时在正常缩放下几乎分不出来
const HEAD_LEN_FILLED = 12;
const HEAD_W_FILLED = 10;
const HEAD_LEN_OPEN = 14;
const HEAD_W_OPEN = 13;

/** 箭头头部的 path。dir 为 +1 表示朝右，-1 朝左。 */
function headPath(tipX: number, tipY: number, dir: 1 | -1, filled: boolean): string {
  const len = filled ? HEAD_LEN_FILLED : HEAD_LEN_OPEN;
  const w = filled ? HEAD_W_FILLED : HEAD_W_OPEN;
  const baseX = tipX - dir * len;
  if (filled) {
    return `M ${tipX} ${tipY} L ${baseX} ${tipY - w / 2} L ${baseX} ${tipY + w / 2} Z`;
  }
  return `M ${baseX} ${tipY - w / 2} L ${tipX} ${tipY} L ${baseX} ${tipY + w / 2}`;
}

/** 同步消息用实心箭头，异步和返回用空心 —— 这是 UML 的约定 */
function isFilledHead(kind: MessageKind): boolean {
  return kind === 'sync';
}

function lines(text: string): string[] {
  return text.split('\n');
}

/** 多行文本，从 anchorY 向上堆叠，让最后一行尽量贴近给定基线 */
function MultiLineText(props: {
  text: string;
  x: number;
  y: number;
  anchor: 'middle' | 'start' | 'end';
  className: string;
}): ReactNode {
  const ls = lines(props.text);
  if (ls.length === 1) {
    return (
      <text className={props.className} x={props.x} y={props.y} textAnchor={props.anchor}>
        {props.text}
      </text>
    );
  }
  return (
    <text className={props.className} x={props.x} y={props.y} textAnchor={props.anchor}>
      {ls.map((line, i) => (
        <tspan key={i} x={props.x} dy={i === 0 ? -(ls.length - 1) * 1.2 + 'em' : '1.2em'}>
          {line}
        </tspan>
      ))}
    </text>
  );
}

// ---------------------------------------------------------------------------
// 参与者
// ---------------------------------------------------------------------------

function ActorShape({ box }: { box: { x: number; y: number; width: number; height: number } }): ReactNode {
  const cx = box.x + box.width / 2;
  const r = Math.min(box.width, box.height) * 0.16;
  const headCy = box.y + r + 2;
  const bodyTop = headCy + r;
  const bodyBottom = box.y + box.height * 0.62;
  const armY = bodyTop + (bodyBottom - bodyTop) * 0.3;
  const armHalf = box.width * 0.22;
  const legSpread = box.width * 0.2;

  return (
    <g className="rd-participant-icon">
      <circle cx={cx} cy={headCy} r={r} />
      <line x1={cx} y1={bodyTop} x2={cx} y2={bodyBottom} />
      <line x1={cx - armHalf} y1={armY} x2={cx + armHalf} y2={armY} />
      <line x1={cx} y1={bodyBottom} x2={cx - legSpread} y2={box.y + box.height} />
      <line x1={cx} y1={bodyBottom} x2={cx + legSpread} y2={box.y + box.height} />
    </g>
  );
}

/** boundary / control / entity 的左上角小图标，沿用 UML 的圈线约定 */
function KindIcon({ kind, x, y }: { kind: ParticipantKind; x: number; y: number }): ReactNode {
  if (kind === 'object' || kind === 'actor') return null;
  const r = 5;
  const cx = x + 10;
  const cy = y + 10;
  return (
    <g className="rd-participant-icon">
      <circle cx={cx} cy={cy} r={r} />
      {kind === 'boundary' && <line x1={cx - r} y1={cy} x2={cx - r - 5} y2={cy} />}
      {kind === 'control' && <path d={`M ${cx - 4} ${cy - r - 3} L ${cx} ${cy - r} L ${cx + 4} ${cy - r - 3}`} />}
      {kind === 'entity' && <line x1={cx - r} y1={cy + r + 3} x2={cx + r} y2={cy + r + 3} />}
      {kind === 'database' && <path d={`M ${cx - 3} ${cy - 2} h 6 M ${cx - 3} ${cy + 2} h 6`} />}
    </g>
  );
}

function ParticipantBox({
  geom,
  selected,
}: {
  geom: ParticipantBoxGeom;
  selected: boolean;
}): ReactNode {
  const { shape, kind } = geom;
  return (
    <g data-participant-id={geom.id}>
      {/* 整个头部都可点选，不必精确点到火柴人的线条上 */}
      <rect
        className="rd-hit"
        x={geom.box.x}
        y={geom.box.y}
        width={geom.box.width}
        height={geom.box.height}
      />
      {kind === 'actor' ? (
        <ActorShape box={shape} />
      ) : (
        <>
          <rect
            className="rd-participant-box"
            x={shape.x}
            y={shape.y}
            width={shape.width}
            height={shape.height}
            rx={4}
          />
          <KindIcon kind={kind} x={shape.x} y={shape.y} />
        </>
      )}
      <text
        className="rd-participant-label"
        x={geom.labelAnchorX + (kind === 'actor' || kind === 'object' ? 0 : 6)}
        y={geom.labelY}
        textAnchor="middle"
      >
        {geom.label}
      </text>
      {selected && (
        <rect
          className="rd-selection"
          x={geom.box.x - 3}
          y={geom.box.y - 3}
          width={geom.box.width + 6}
          height={geom.box.height + 6}
          rx={5}
        />
      )}
    </g>
  );
}

// ---------------------------------------------------------------------------
// 消息
// ---------------------------------------------------------------------------

function MessageShape({ geom, selected }: { geom: MessageGeom; selected: boolean }): ReactNode {
  // 线型和箭头的颜色都由类型决定：形状管 UML 语义，颜色管一眼可辨
  const filled = isFilledHead(geom.kind);
  const lineCls = `rd-message-line rd-message-line--${geom.kind}`;
  const headCls = `rd-arrow-head rd-arrow-head--${geom.kind}`;
  // 箭头本体太细，加一层覆盖"标签+箭头"的透明命中区，点标签也能选中消息
  const hit = (
    <rect
      className="rd-hit"
      x={geom.bounds.x}
      y={geom.bounds.y}
      width={geom.bounds.width}
      height={geom.bounds.height}
    />
  );

  if (geom.kind === 'self') {
    // 自调用：折线回到起点，箭头朝左
    const w = geom.x2 - geom.x1;
    return (
      <g data-message-id={geom.id}>
        {hit}
        <path className={lineCls} d={geom.path} />
        <path className={headCls} d={headPath(geom.x2, geom.y2, -1, filled)} />
        <MultiLineText
          className="rd-message-label"
          text={geom.label}
          x={geom.labelX}
          y={geom.labelY}
          anchor="start"
        />
        {geom.seqLabel && (
          <text className="rd-message-seq" x={geom.x2 - w / 2} y={geom.y1 - 7} textAnchor="middle">
            {geom.seqLabel}
          </text>
        )}
        {selected && (
          <rect
            className="rd-selection"
            x={geom.bounds.x}
            y={geom.bounds.y}
            width={geom.bounds.width}
            height={geom.bounds.height}
            rx={3}
          />
        )}
      </g>
    );
  }

  const dir: 1 | -1 = geom.x2 >= geom.x1 ? 1 : -1;
  return (
    <g data-message-id={geom.id}>
      {hit}
      <path
        className={lineCls}
        d={`M ${geom.x1} ${geom.y1} L ${geom.x2} ${geom.y2}`}
      />
      <path className={headCls} d={headPath(geom.x2, geom.y2, dir, filled)} />
      <MultiLineText
        className="rd-message-label"
        text={
          geom.seqLabel ? `${geom.seqLabel}: ${geom.label}` : geom.label
        }
        x={geom.labelX}
        y={geom.labelY}
        anchor="middle"
      />
      {selected && (
        <rect
          className="rd-selection"
          x={geom.bounds.x}
          y={geom.bounds.y}
          width={geom.bounds.width}
          height={geom.bounds.height}
          rx={3}
        />
      )}
    </g>
  );
}

// ---------------------------------------------------------------------------
// 激活条与注释
// ---------------------------------------------------------------------------

function ActivationShape({ geom, selected }: { geom: ActivationGeom; selected: boolean }): ReactNode {
  return (
    <g data-activation-id={geom.id}>
      <rect
        className="rd-activation"
        x={geom.x}
        y={geom.y}
        width={geom.width}
        height={geom.height}
        // 嵌套越深越不透明，视觉上能看出层级
        opacity={Math.max(0.55, 1 - geom.depth * 0.12)}
      />
      {selected && (
        <rect
          className="rd-selection"
          x={geom.x - 2}
          y={geom.y - 2}
          width={geom.width + 4}
          height={geom.height + 4}
        />
      )}
    </g>
  );
}

function NoteShape({ geom, selected }: { geom: NoteGeom; selected: boolean }): ReactNode {
  const fold = 12;
  return (
    <g data-note-id={geom.id}>
      <path
        className="rd-note"
        d={`M ${geom.x} ${geom.y} H ${geom.x + geom.width - fold} L ${geom.x + geom.width} ${geom.y + fold} V ${geom.y + geom.height} H ${geom.x} Z`}
      />
      <path
        className="rd-note"
        d={`M ${geom.x + geom.width - fold} ${geom.y} V ${geom.y + fold} H ${geom.x + geom.width}`}
        fill="none"
      />
      {geom.lines.map((line, i) => (
        <text
          key={i}
          className="rd-note-text"
          x={geom.x + 8}
          y={geom.y + 8 + geom.lineHeight * (i + 0.8)}
        >
          {line}
        </text>
      ))}
      {selected && (
        <rect
          className="rd-selection"
          x={geom.x - 2}
          y={geom.y - 2}
          width={geom.width + 4}
          height={geom.height + 4}
        />
      )}
    </g>
  );
}

// ---------------------------------------------------------------------------
// 整体
// ---------------------------------------------------------------------------

export interface DiagramProps {
  layout: Layout;
  selection: Selection;
  /** 拖拽画消息时的预览，还没有落到文档里 */
  pending?: PendingMessage | null;
}

/**
 * 拖拽画消息时的预览线。
 *
 * 故意画成虚线半透明：它是"还没定下来"的东西，视觉上要和已存在的消息区分开，
 * 否则松手前后看起来一样、用户不知道到底成没成。
 */
function PendingPreview({ layout, pending }: {
  layout: Layout;
  pending: PendingMessage;
}): ReactNode {
  const xOf = (id: string): number | null => {
    const l = layout.lifelines.find((x) => x.participantId === id);
    return l ? l.x : null;
  };
  const x1 = xOf(pending.from);
  const x2 = xOf(pending.to);
  if (x1 === null || x2 === null) return null;

  const filled = isFilledHead(pending.kind);

  if (pending.kind === 'self') {
    const w = 48;
    const h = 36;
    return (
      <g className="rd-preview-group">
        <path
          className="rd-preview-line"
          d={`M ${x1} ${pending.y} H ${x1 + w} V ${pending.y + h} H ${x1}`}
        />
        <path
          className={filled ? 'rd-preview-head' : 'rd-preview-head rd-preview-head--open'}
          d={headPath(x1, pending.y + h, -1, filled)}
        />
        <text className="rd-preview-label" x={x1 + w + 8} y={pending.y + h / 2}>
          自调用
        </text>
      </g>
    );
  }

  const dir: 1 | -1 = x2 >= x1 ? 1 : -1;
  return (
    <g className="rd-preview-group">
      <path className="rd-preview-line" d={`M ${x1} ${pending.y} L ${x2} ${pending.y}`} />
      <path
        className={filled ? 'rd-preview-head' : 'rd-preview-head rd-preview-head--open'}
        d={headPath(x2, pending.y, dir, filled)}
      />
      <text className="rd-preview-label" x={(x1 + x2) / 2} y={pending.y - 7} textAnchor="middle">
        {PREVIEW_LABEL[pending.kind]}
      </text>
    </g>
  );
}

const PREVIEW_LABEL: Record<MessageKind, string> = {
  sync: '同步消息',
  async: '异步消息',
  return: '返回消息',
  self: '自调用',
};

export { PREVIEW_LABEL };

/** 被选中的元素 id（不管哪种类型），用于快速比对 */
export function selectedId(sel: Selection): Id | null {
  return sel.type === 'none' ? null : sel.id;
}

export function Diagram({ layout, selection, pending }: DiagramProps): ReactNode {
  const selId = selectedId(selection);
  const selType = selection.type;

  return (
    <g>
      {/* 生命线画在最底层，避免盖住消息箭头 */}
      <g>
        {layout.lifelines.map((l) => (
          <line
            key={l.participantId}
            /**
             * 拖拽画消息时，把"松手会吸到哪条生命线"高亮出来。
             * 没有这个反馈，用户只能凭感觉猜——横向吸附到最近的生命线这件事
             * 本身是不可见的。自调用时 to === from，高亮的就是起点那条，也对。
             */
            className={
              pending && pending.to === l.participantId
                ? 'rd-lifeline rd-lifeline--target'
                : 'rd-lifeline'
            }
            x1={l.x}
            y1={l.y1}
            x2={l.x}
            y2={l.y2}
          />
        ))}
      </g>

      <g>
        {layout.activations.map((a) => (
          <ActivationShape key={a.id} geom={a} selected={selType === 'activation' && selId === a.id} />
        ))}
      </g>

      <g>
        {layout.messages.map((m) => (
          <MessageShape key={m.id} geom={m} selected={selType === 'message' && selId === m.id} />
        ))}
      </g>

      {/* 拖拽画消息时的预览，画在已有消息之上 */}
      {pending && (
        <g data-testid="pending-message">
          <PendingPreview layout={layout} pending={pending} />
        </g>
      )}

      <g>
        {layout.notes.map((n) => (
          <NoteShape key={n.id} geom={n} selected={selType === 'note' && selId === n.id} />
        ))}
      </g>

      <g>
        {layout.participants.map((p) => (
          <ParticipantBox
            key={p.id}
            geom={p}
            selected={selType === 'participant' && selId === p.id}
          />
        ))}
      </g>
    </g>
  );
}
