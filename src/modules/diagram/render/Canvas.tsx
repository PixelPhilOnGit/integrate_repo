/**
 * 画布：渲染 + 交互。
 *
 * 缩放走 viewBox 而不是 CSS transform —— CSS 缩放会把矢量文字变成位图糊掉，
 * 改 viewBox 时 SVG 按新尺寸重新排版，放到 4 倍文字依然是锐利的。
 *
 * 拖拽期间每一步都从**拖拽开始时的文档快照**重新计算，而不是在当前值上累加增量。
 * 否则浮点误差会累积，而且中途改变主意（比如撤销）会产生难以预测的偏移。
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Doc, Id, MessageKind } from '../core/model';
import { hitActivationEdge, hitTest, type HitTarget, type Layout } from '../core/layout';
import {
  moveMessage,
  moveParticipant,
  setActivationEndAtY,
  updateMessage,
  updateNote,
} from '../core/commands';
import { themeToCss } from '../core/theme';
import { Diagram, PREVIEW_LABEL } from './Diagram';
import { ContextMenu, type MenuItem } from '../../../shared/ui/ContextMenu';
import { InlineEditor } from './InlineEditor';
import type { AppStore } from '../state/store';
import type { AppState } from '../types';

/** 指针移动超过这么多像素才算"拖"，避免手抖把点击变成拖拽 */
const DRAG_THRESHOLD = 3;
/** 激活条下边缘这么宽的一条带子用来拖拽截断 */
const ACTIVATION_EDGE = 9;
/**
 * 横向移动不超过这么点，就当成"在原地拉一个小回环"（自调用）。
 *
 * 比"必须把鼠标拖回原来那条生命线"宽容得多 —— 后者要求用户精确地拖回起点，
 * 实际上很难做到。StarUML 这类工具也是"几乎没动 = 自消息"。
 */
const SELF_DRAG_THRESHOLD = 16;
/**
 * 消息两端各留这么宽的一条带子用来改收发方。
 *
 * 一条消息上有三个拖拽区：**两端改 from/to，中间改纵向位置**。
 * 只能上下拖的话，"把这条消息改发给另一个人"就得绕到属性面板去选下拉框，
 * 而画顺序图时改流向是非常频繁的操作。
 */
const MESSAGE_END_ZONE = 14;

type DragState =
  | { kind: 'participant'; id: Id; origin: number; grabDoc: number; base: Doc }
  | { kind: 'message'; id: Id; origin: number; grabDoc: number; base: Doc }
  | { kind: 'note'; id: Id; originX: number; originY: number; grabX: number; grabY: number; base: Doc }
  | { kind: 'pan'; startViewX: number; startViewY: number; startPanX: number; startPanY: number }
  /** 从生命线/激活条上拖出一条消息 */
  | { kind: 'create-message'; from: Id; y: number; startDocX: number }
  /** 拖消息的某一端，改它的收发方 */
  | { kind: 'message-end'; id: Id; field: 'from' | 'to'; base: Doc }
  /** 拖激活条的下边缘来截断它 */
  | { kind: 'activation-edge'; id: Id; base: Doc };

/**
 * 按住修饰键切换要画的消息类型。
 *
 * 用 Alt 而不是 Ctrl，是因为 **macOS 上 Ctrl+点按等于右键**，拖拽会当场被打断。
 * Alt 在 Windows 和 macOS 上都不会和系统抢，Cmd（Meta）作为 macOS 的顺手指法一起支持。
 *
 * 已知边界：Linux 的 GNOME/KDE 默认把 Alt+拖拽当成"移动窗口"，会被窗口管理器截获。
 * 目标平台是 Windows + macOS，所以这里接受这个取舍；真要在 Linux 上重度使用，
 * 需要另配一个不冲突的键。
 */
function kindFromModifiers(e: {
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}): MessageKind {
  if (e.altKey || e.metaKey) return 'async';
  if (e.shiftKey) return 'return';
  return 'sync';
}

/** 把文档坐标吸附到最近的一条生命线上（顺序图里横向永远是吸附到生命线） */
function nearestParticipant(doc: Doc, x: number): Id | null {
  let best: Id | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const p of doc.participants) {
    const d = Math.abs(p.x - x);
    if (d < bestDist) {
      bestDist = d;
      best = p.id;
    }
  }
  return best;
}

export interface CanvasProps {
  state: AppState;
  store: AppStore;
  /** 由 App 统一算好传进来，避免 Toolbar 和 Canvas 各算一遍 */
  layout: Layout;
}

export function Canvas({ state, store, layout }: CanvasProps): ReactNode {
  const { doc, viewport, selection, editing } = state;

  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const movedRef = useRef(false);
  const [dragging, setDragging] = useState(false);
  /** 画布上的右键菜单。记下命中目标，菜单项按它分支 */
  const [menu, setMenu] = useState<{ x: number; y: number; hit: HitTarget | null } | null>(null);
  const [size, setSize] = useState({ width: 800, height: 600 });
  // 是否已经量到真实容器尺寸。初始的 800x600 只是占位，
  // 拿它去做"适应窗口"会算出错误的缩放
  const [measured, setMeasured] = useState(false);

  // 容器尺寸 → viewBox 的换算依据
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () => {
      const r = el.getBoundingClientRect();
      setSize({ width: Math.max(1, r.width), height: Math.max(1, r.height) });
      setMeasured(true);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /**
   * 打开文件时自动适应窗口。
   * 不做这件事的话，比视口宽的图会被裁掉右侧 —— 用户第一眼看到的是一张残缺的图，
   * 得自己想到去缩放才能看全。
   *
   * 用 path 做「只适配一次」的标记：之后编辑文档会不断重建 layout，
   * 不能每改一笔就把视图拉回去。
   */
  const fittedFor = useRef<string | null>(null);
  useEffect(() => {
    const path = state.currentPath;
    if (!path || !measured || fittedFor.current === path) return;
    fittedFor.current = path;
    store.fitTo(size.width, size.height, layout.bounds);
  }, [state.currentPath, measured, size.width, size.height, layout, store]);

  const toDoc = useCallback(
    (clientX: number, clientY: number) => {
      const svg = svgRef.current;
      if (!svg) return { docX: 0, docY: 0, viewX: 0, viewY: 0 };
      const r = svg.getBoundingClientRect();
      const viewX = clientX - r.left;
      const viewY = clientY - r.top;
      return {
        viewX,
        viewY,
        docX: viewport.panX + viewX / viewport.zoom,
        docY: viewport.panY + viewY / viewport.zoom,
      };
    },
    [viewport],
  );

  // ------------------------------------------------------------------ 指针

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>): void => {
    if (e.button === 2) return;
    const { docX, docY } = toDoc(e.clientX, e.clientY);
    // 记下最后落点：新建注释时若没有选中项，就放在用户刚点过的地方，
    // 而不是永远贴第一个参与者
    store.lastPointer = { x: docX, y: docY };
    const hit = hitTest(layout, { x: docX, y: docY });

    // 中键，或左键点在空白处 → 平移画布
    if (e.button === 1 || !hit) {
      if (e.button === 0) store.select({ type: 'none' });
      dragRef.current = {
        kind: 'pan',
        startViewX: e.clientX,
        startViewY: e.clientY,
        startPanX: viewport.panX,
        startPanY: viewport.panY,
      };
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }

    // 激活条的截断手柄优先于其它一切命中（理由见 hitActivationEdge 的注释）
    const edgeId = hitActivationEdge(layout, { x: docX, y: docY });
    if (edgeId) {
      store.select({ type: 'activation', id: edgeId });
      dragRef.current = { kind: 'activation-edge', id: edgeId, base: doc };
      movedRef.current = false;
      setDragging(true);
      store.beginDrag();
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }

    // 走到这里 hit 一定非空
    const base = doc;
    switch (hit.type) {
      case 'participant': {
        const p = doc.participants.find((x) => x.id === hit.id);
        if (!p) return;
        store.select({ type: 'participant', id: hit.id });
        dragRef.current = { kind: 'participant', id: hit.id, origin: p.x, grabDoc: docX, base };
        break;
      }
      case 'message': {
        const m = doc.messages.find((x) => x.id === hit.id);
        if (!m) return;
        store.select({ type: 'message', id: hit.id });

        // 三个拖拽区：两端改收发方、中间改纵向位置。
        // 自调用两端是同一个人，"改另一端"没有意义，所以只有中间区。
        const g = layout.messages.find((x) => x.id === hit.id);
        if (m.kind !== 'self' && g) {
          const nearFrom = Math.abs(docX - g.x1) <= MESSAGE_END_ZONE;
          const nearTo = Math.abs(docX - g.x2) <= MESSAGE_END_ZONE;
          // 消息很短时两个区会重叠，这时不猜，当成拖中间
          if (nearFrom !== nearTo) {
            dragRef.current = {
              kind: 'message-end',
              id: hit.id,
              field: nearFrom ? 'from' : 'to',
              base: doc,
            };
            movedRef.current = false;
            setDragging(true);
            store.beginDrag();
            e.currentTarget.setPointerCapture(e.pointerId);
            return;
          }
        }

        dragRef.current = { kind: 'message', id: hit.id, origin: m.y, grabDoc: docY, base };
        break;
      }
      case 'note': {
        const n = doc.notes.find((x) => x.id === hit.id);
        if (!n) return;
        store.select({ type: 'note', id: hit.id });
        dragRef.current = {
          kind: 'note',
          id: hit.id,
          originX: n.x,
          originY: n.y,
          grabX: docX,
          grabY: docY,
          base,
        };
        break;
      }
      case 'activation': {
        const act = layout.activations.find((a) => a.id === hit.id);
        if (!act) return;

        // 注意：下边缘的截断手柄在上面用 hitActivationEdge 单独拦掉了，
        // 走不到这里。这里处理的是激活条本体：按下先当点选，
        // 拖动了就变成"从这条生命线上拉出一条消息"。
        store.select({ type: 'activation', id: hit.id });
        dragRef.current = {
          kind: 'create-message',
          from: act.participant,
          y: docY,
          startDocX: docX,
        };
        movedRef.current = false;
        setDragging(true);
        e.currentTarget.setPointerCapture(e.pointerId);
        return;
      }
      case 'lifeline': {
        // 生命线：同理，点选所属参与者，拖动则是拉出一条消息
        store.select({ type: 'participant', id: hit.id });
        dragRef.current = {
          kind: 'create-message',
          from: hit.id,
          y: docY,
          startDocX: docX,
        };
        movedRef.current = false;
        setDragging(true);
        e.currentTarget.setPointerCapture(e.pointerId);
        return;
      }
    }
    movedRef.current = false;
    setDragging(true);
    store.beginDrag();
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  /**
   * 悬停时光标反馈。
   *
   * 直接写 DOM 的 style 而不是走 React state：这个函数每次指针移动都会调，
   * 进 state 会让整棵树每帧重渲染。用 ref 比对，值没变就不写。
   */
  const cursorRef = useRef('default');
  const updateHoverCursor = (e: React.PointerEvent<SVGSVGElement>): void => {
    const { docX, docY } = toDoc(e.clientX, e.clientY);
    const point = { x: docX, y: docY };
    const hit = hitTest(layout, point);
    let next = 'default';
    if (hitActivationEdge(layout, point, ACTIVATION_EDGE)) {
      next = 'ns-resize';
    } else if (hit?.type === 'lifeline') {
      next = 'crosshair';
    } else if (hit?.type === 'activation') {
      next = 'crosshair';
    } else if (hit?.type === 'message') {
      const g = layout.messages.find((x) => x.id === hit.id);
      const m = doc.messages.find((x) => x.id === hit.id);
      if (g && m && m.kind !== 'self') {
        const nearFrom = Math.abs(docX - g.x1) <= MESSAGE_END_ZONE;
        const nearTo = Math.abs(docX - g.x2) <= MESSAGE_END_ZONE;
        // 两端是"左右拉"的手势，中间是"上下拖"
        next = nearFrom !== nearTo ? 'ew-resize' : 'move';
      } else {
        next = 'move';
      }
    } else if (hit) {
      next = 'move';
    }
    if (next !== cursorRef.current) {
      cursorRef.current = next;
      e.currentTarget.style.cursor = next;
    }
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>): void => {
    const drag = dragRef.current;

    if (!drag) {
      updateHoverCursor(e);
      return;
    }

    if (drag.kind === 'pan') {
      const zoom = viewport.zoom;
      store.setViewport({
        panX: drag.startPanX - (e.clientX - drag.startViewX) / zoom,
        panY: drag.startPanY - (e.clientY - drag.startViewY) / zoom,
      });
      return;
    }

    const { docX, docY } = toDoc(e.clientX, e.clientY);

    // ---- 从生命线上拖出一条新消息 ----
    if (drag.kind === 'create-message') {
      if (!movedRef.current) {
        if (Math.abs(docX - drag.startDocX) < DRAG_THRESHOLD) return;
        movedRef.current = true;
      }
      const target = nearestParticipant(doc, docX);
      if (!target) return;
      // 横向几乎没动、或者吸附回了原来那条生命线 → 自调用。
      // 这时修饰键不参与判断，形状已经决定了。
      const nearlyStill = Math.abs(docX - drag.startDocX) < SELF_DRAG_THRESHOLD;
      const isSelf = target === drag.from || nearlyStill;
      const kind: MessageKind = isSelf ? 'self' : kindFromModifiers(e);
      store.setPendingMessage({
        from: drag.from,
        to: isSelf ? drag.from : target,
        y: Math.round(drag.y),
        kind,
      });
      return;
    }

    // ---- 拖消息的某一端换收发方 ----
    if (drag.kind === 'message-end') {
      movedRef.current = true;
      const target = nearestParticipant(doc, docX);
      if (!target) return;
      const cur = drag.base.messages.find((m) => m.id === drag.id);
      if (!cur) return;
      // 不允许把两端拖成同一个人：那会变成一条零长度的退化箭头
      const other = drag.field === 'from' ? cur.to : cur.from;
      if (target === other) return;
      const patch = drag.field === 'from' ? { from: target } : { to: target };
      store.preview(updateMessage(drag.base, drag.id, patch));
      return;
    }

    // ---- 拖激活条下边缘截断 ----
    if (drag.kind === 'activation-edge') {
      movedRef.current = true;
      // 每次都从拖拽开始时的文档重算，而不是在当前预览上叠加
      store.preview(setActivationEndAtY(drag.base, drag.id, docY));
      return;
    }

    // ---- 移动已有元素 ----
    // 位移超过阈值才算拖拽，避免手抖把点击变成移动
    if (!movedRef.current) {
      const moved =
        drag.kind === 'note'
          ? Math.abs(docX - drag.grabX) + Math.abs(docY - drag.grabY) > 2
          : Math.abs((drag.kind === 'message' ? docY : docX) - drag.grabDoc) > 2;
      if (!moved) return;
      movedRef.current = true;
    }

    switch (drag.kind) {
      case 'participant':
        store.preview(moveParticipant(drag.base, drag.id, Math.round(drag.origin + (docX - drag.grabDoc))));
        break;
      case 'message':
        store.preview(moveMessage(drag.base, drag.id, Math.round(drag.origin + (docY - drag.grabDoc))));
        break;
      case 'note':
        store.preview(
          updateNote(drag.base, drag.id, {
            x: Math.round(drag.originX + (docX - drag.grabX)),
            y: Math.round(drag.originY + (docY - drag.grabY)),
          }),
        );
        break;
    }
  };

  const endDrag = (e: React.PointerEvent<SVGSVGElement>): void => {
    const drag = dragRef.current;
    dragRef.current = null;
    setDragging(false);
    if (!drag) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }

    // 平移不进撤销栈
    if (drag.kind === 'pan') return;

    // 画消息：真的拖动了才落成消息，没动就当一次普通点击（选中已经做过了）
    if (drag.kind === 'create-message') {
      if (movedRef.current) store.commitPendingMessage();
      else store.cancelPendingMessage();
      return;
    }

    // 拖元素和拖激活条边缘一样：整段只记一次撤销
    store.endDrag();
  };

  const onDoubleClick = (e: React.MouseEvent<SVGSVGElement>): void => {
    const { docX, docY } = toDoc(e.clientX, e.clientY);
    const hit = hitTest(layout, { x: docX, y: docY });
    if (!hit) return;
    if (hit.type === 'participant' || hit.type === 'message' || hit.type === 'note') {
      store.startEditing({ type: hit.type, id: hit.id });
    }
  };

  // 用原生监听器绑 wheel：React 的 onWheel 是 passive 的，preventDefault 会失效，
  // 导致 ctrl+滚轮同时触发浏览器缩放
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const viewX = e.clientX - rect.left;
      const viewY = e.clientY - rect.top;
      if (e.ctrlKey || e.metaKey) {
        store.zoomAt(e.deltaY < 0 ? 1.1 : 1 / 1.1, viewX, viewY);
      } else if (e.shiftKey) {
        store.setViewport({ panX: viewport.panX + e.deltaY / viewport.zoom });
      } else {
        store.setViewport({ panY: viewport.panY + e.deltaY / viewport.zoom });
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [store, viewport.panX, viewport.panY, viewport.zoom]);

  // 内联编辑提交
  const commitEditing = (text: string): void => {
    if (!editing) return;
    if (editing.type === 'participant') store.updateParticipant(editing.id, { name: text });
    else if (editing.type === 'message') store.updateMessage(editing.id, { label: text });
    else store.updateNote(editing.id, { text });
    store.stopEditing();
  };

  /**
   * 画布上的右键菜单。
   *
   * 报告里说这是"最大的性价比洼地"：改消息类型、反转方向、删元素这些高频操作
   * 以前只能绕到右侧属性面板。菜单里同时显示快捷键提示 ——
   * 那是用户学会快捷键的唯一有效途径。
   */
  const itemsFor = (hit: HitTarget | null): MenuItem[] => {
    if (!hit) {
      return [
        { label: '添加参与者', onSelect: () => store.addParticipant('object') },
        { label: '添加注释', onSelect: () => store.addNote() },
      ];
    }

    if (hit.type === 'message') {
      const m = doc.messages.find((x) => x.id === hit.id);
      if (!m) return [];
      const neighbour = doc.participants.find((p) => p.id !== m.from);
      const asKind = (kind: MessageKind): MenuItem => ({
        label: PREVIEW_LABEL[kind],
        checked: kind === m.kind,
        onSelect: () => {
          // 从自调用切回有方向的类型时，to 还停在 from 上会变成零长度箭头，
          // 所以顺手换一个别的参与者
          const to = kind === 'self' ? m.from : m.from === m.to ? (neighbour?.id ?? m.to) : m.to;
          store.updateMessage(m.id, { kind, to });
        },
      });
      const hasActivation = doc.activations.some(
        (a) => a.participant === m.to && a.startMessageId === m.id,
      );
      const items: MenuItem[] = [
        { label: '消息类型', onSelect: () => undefined, disabled: true },
        asKind('sync'),
        asKind('async'),
        asKind('return'),
        asKind('self'),
        {
          label: '反转方向',
          separatorBefore: true,
          disabled: m.kind === 'self',
          onSelect: () => store.updateMessage(m.id, { from: m.to, to: m.from }),
        },
      ];
      if (m.kind === 'sync' || m.kind === 'self') {
        items.push({
          label: hasActivation ? '移除接收方激活条' : '在接收方加激活条',
          onSelect: () => store.toggleActivation(m.to, m.id),
        });
      }
      items.push({ label: '删除', danger: true, shortcut: 'Del', onSelect: () => store.deleteSelection() });
      return items;
    }

    if (hit.type === 'participant') {
      const p = doc.participants.find((x) => x.id === hit.id);
      if (!p) return [];
      return [
        { label: '在此加自调用', onSelect: () => store.addSelfMessage(p.id) },
        {
          label: '在此加注释',
          onSelect: () => {
            store.select({ type: 'participant', id: p.id });
            store.addNote();
          },
        },
        { label: '删除参与者', danger: true, separatorBefore: true, onSelect: () => store.deleteSelection() },
      ];
    }

    return [{ label: '删除', danger: true, shortcut: 'Del', onSelect: () => store.deleteSelection() }];
  };

  const cursor = dragging ? 'grabbing' : 'default';

  return (
    <div className="rd-canvas" ref={wrapRef} style={{ cursor }}>
      <svg
        ref={svgRef}
        className="rd-root"
        data-testid="canvas-svg"
        width={size.width}
        height={size.height}
        viewBox={`${viewport.panX} ${viewport.panY} ${size.width / viewport.zoom} ${size.height / viewport.zoom}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={onDoubleClick}
        onContextMenu={(e) => {
          e.preventDefault();
          const { docX, docY } = toDoc(e.clientX, e.clientY);
          const hit = hitTest(layout, { x: docX, y: docY });
          // 右键选中：让菜单作用的对象一目了然
          if (hit) store.select({ type: hit.type === 'lifeline' ? 'participant' : hit.type, id: hit.id });
          setMenu({ x: e.clientX, y: e.clientY, hit });
        }}
      >
        <style data-rd-theme="true">{themeToCss(doc.theme)}</style>
        <Diagram layout={layout} selection={selection} pending={state.pendingMessage} />
      </svg>

      {state.pendingMessage && (
        <div className="rd-draw-hint" data-testid="draw-hint">
          <strong>正在创建：{PREVIEW_LABEL[state.pendingMessage.kind]}</strong>
          <span>按住 Alt / Cmd 改异步 · Shift 改返回 · 几乎不横向移动就是自调用</span>
        </div>
      )}

      {editing && (
        <InlineEditor
          doc={doc}
          layout={layout}
          viewport={viewport}
          target={editing}
          onCommit={commitEditing}
          onCancel={() => store.stopEditing()}
        />
      )}

      <ZoomBadge state={state} store={store} layout={layout} size={size} />

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={itemsFor(menu.hit)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

interface ZoomBadgeProps extends CanvasProps {
  size: { width: number; height: number };
}

function ZoomBadge({ state, store, layout, size }: ZoomBadgeProps): ReactNode {
  return (
    <div className="rd-zoom-badge">
      <button type="button" onClick={() => store.setViewport({ zoom: state.viewport.zoom / 1.2 })}>
        −
      </button>
      <span data-testid="zoom-level">{Math.round(state.viewport.zoom * 100)}%</span>
      <button type="button" onClick={() => store.setViewport({ zoom: state.viewport.zoom * 1.2 })}>
        +
      </button>
      <button
        type="button"
        title="适应窗口"
        onClick={() => store.fitTo(size.width, size.height, layout.bounds)}
      >
        ⤢
      </button>
    </div>
  );
}
