/**
 * 右侧面板：选中元素的属性 + 主题样式。
 *
 * 属性面板的价值在于处理拖拽做不到的事 —— 改消息的收发方、给消息手动编号、
 * 开关激活条。拖拽只负责位置。
 */

import { useState, type ReactNode } from 'react';
import type { Id, MessageKind, ParticipantKind, Theme } from '../core/model';
import { MESSAGE_KINDS, PARTICIPANT_KINDS } from '../core/model';
import { messagesOnParticipant } from '../core/commands';
import { messageKindLabel, participantKindLabel } from '../core/mermaid';
import { THEMES } from '../core/theme';
import type { AppState, AppStore } from '../state/store';

/** 主题里所有"字符串型"的颜色字段，抽出来是为了让循环里的类型收窄到 string */
type ColorKey =
  | 'background'
  | 'textColor'
  | 'lineColor'
  | 'participantFill'
  | 'participantStroke'
  | 'activationFill'
  | 'activationStroke'
  | 'noteFill'
  | 'noteStroke'
  | 'noteTextColor'
  | 'syncMessageColor'
  | 'asyncMessageColor'
  | 'returnMessageColor';

const COLOR_FIELDS: readonly (readonly [ColorKey, string])[] = [
  ['background', '背景'],
  ['textColor', '文字'],
  ['lineColor', '生命线'],
  ['participantFill', '参与者填充'],
  ['participantStroke', '参与者描边'],
  ['activationFill', '激活条填充'],
  ['activationStroke', '激活条描边'],
  ['noteFill', '注释填充'],
  ['noteStroke', '注释描边'],
  ['noteTextColor', '注释文字'],
  // 这三种是叠加在 UML 箭头形状差异之上的视觉强化，
  // 同步/异步光靠箭头头区分在正常缩放下看不出来
  ['syncMessageColor', '同步消息'],
  ['asyncMessageColor', '异步消息'],
  ['returnMessageColor', '返回消息'],
];

export interface InspectorProps {
  state: AppState;
  store: AppStore;
}

type Tab = 'props' | 'style';

export function Inspector({ state, store }: InspectorProps): ReactNode {
  const [tab, setTab] = useState<Tab>('props');

  return (
    <div className="rd-panel rd-inspector" data-testid="inspector">
      <div className="rd-tabs">
        <button
          type="button"
          className={tab === 'props' ? 'is-active' : ''}
          data-testid="tab-props"
          onClick={() => setTab('props')}
        >
          属性
        </button>
        <button
          type="button"
          className={tab === 'style' ? 'is-active' : ''}
          data-testid="tab-style"
          onClick={() => setTab('style')}
        >
          样式
        </button>
      </div>

      <div className="rd-panel-body">
        {tab === 'props' ? <PropsTab state={state} store={store} /> : <StyleTab state={state} store={store} />}
      </div>
    </div>
  );
}

function PropsTab({ state, store }: InspectorProps): ReactNode {
  const { doc, selection } = state;
  // 激活条面板里选择的"从哪条消息之后断开"。
  // 必须放在组件顶层：PropsTab 会按选中类型走不同的 return 分支，
  // 把 useState 放进分支里会让 hook 数量在多次渲染间变化，直接报错。
  const [splitAt, setSplitAt] = useState<Id | ''>('');

  if (selection.type === 'none') {
    return (
      <div className="rd-form">
        <p className="rd-hint">点选图上的元素来编辑它的属性。</p>
        <h4>文档</h4>
        <label className="rd-field">
          <span>标题</span>
          <input
            value={doc.title}
            data-testid="doc-title"
            onChange={(e) => store.setTitle(e.target.value)}
          />
        </label>
        <p className="rd-hint">
          参与者 {doc.participants.length} 个 · 消息 {doc.messages.length} 条 · 激活条{' '}
          {doc.activations.length} 个
        </p>
        <button type="button" disabled={doc.participants.length < 3} onClick={() => store.distributeParticipants()}>
          参与者均匀分布
        </button>
        <button type="button" disabled={doc.messages.length < 3} onClick={() => store.distributeMessages()}>
          消息均匀分布
        </button>
      </div>
    );
  }

  if (selection.type === 'participant') {
    const p = doc.participants.find((x) => x.id === selection.id);
    if (!p) return <p className="rd-hint">该参与者已被删除。</p>;
    return (
      <div className="rd-form">
        <h4>参与者</h4>
        <label className="rd-field">
          <span>名称</span>
          <input
            value={p.name}
            data-testid="participant-name"
            onChange={(e) => store.updateParticipant(p.id, { name: e.target.value })}
          />
        </label>
        <label className="rd-field">
          <span>别名</span>
          <input
            value={p.alias ?? ''}
            placeholder="导出 Mermaid 时用作标识符"
            onChange={(e) => store.updateParticipant(p.id, { alias: e.target.value || undefined })}
          />
        </label>
        <label className="rd-field">
          <span>形态</span>
          <select
            value={p.kind}
            onChange={(e) => store.updateParticipant(p.id, { kind: e.target.value as ParticipantKind })}
          >
            {PARTICIPANT_KINDS.map((k) => (
              <option key={k} value={k}>
                {participantKindLabel(k)}
              </option>
            ))}
          </select>
        </label>
        <label className="rd-field">
          <span>横坐标</span>
          <input
            type="number"
            value={Math.round(p.x)}
            onChange={(e) => store.updateParticipant(p.id, { x: Number(e.target.value) })}
          />
        </label>
      </div>
    );
  }

  if (selection.type === 'message') {
    const m = doc.messages.find((x) => x.id === selection.id);
    if (!m) return <p className="rd-hint">该消息已被删除。</p>;
    const activation = doc.activations.find(
      (a) => a.participant === m.to && a.startMessageId === m.id,
    );
    return (
      <div className="rd-form">
        <h4>{messageKindLabel(m.kind)}</h4>
        <label className="rd-field">
          <span>文字</span>
          <textarea
            rows={2}
            value={m.label}
            data-testid="message-label"
            onChange={(e) => store.updateMessage(m.id, { label: e.target.value })}
          />
        </label>
        <label className="rd-field">
          <span>类型</span>
          <select
            value={m.kind}
            data-testid="message-kind"
            onChange={(e) => {
              const kind = e.target.value as MessageKind;
              store.updateMessage(m.id, {
                kind,
                to: kind === 'self' ? m.from : m.to,
              });
            }}
          >
            {MESSAGE_KINDS.map((k) => (
              <option key={k} value={k}>
                {messageKindLabel(k)}
              </option>
            ))}
          </select>
        </label>
        <label className="rd-field">
          <span>发送方</span>
          <select
            value={m.from}
            data-testid="message-from"
            onChange={(e) => store.updateMessage(m.id, { from: e.target.value })}
          >
            {doc.participants.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        {m.kind !== 'self' && (
          <label className="rd-field">
            <span>接收方</span>
            <select
              value={m.to}
              data-testid="message-to"
              onChange={(e) => store.updateMessage(m.id, { to: e.target.value })}
            >
              {doc.participants.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="rd-field">
          <span>序号</span>
          <input
            type="number"
            value={m.seq ?? ''}
            placeholder="自动"
            onChange={(e) =>
              store.updateMessage(m.id, {
                seq: e.target.value === '' ? undefined : Number(e.target.value),
              })
            }
          />
        </label>
        <label className="rd-field">
          <span>纵坐标</span>
          <input
            type="number"
            value={Math.round(m.y)}
            onChange={(e) => store.updateMessage(m.id, { y: Number(e.target.value) })}
          />
        </label>
        {m.kind !== 'return' && m.kind !== 'self' && (
          <button type="button" onClick={() => store.toggleActivation(m.to, m.id)}>
            {activation ? '移除接收方激活条' : '在接收方加激活条'}
          </button>
        )}
        <button type="button" className="rd-danger" onClick={() => store.deleteSelection()}>
          删除这条消息
        </button>
      </div>
    );
  }

  if (selection.type === 'activation') {
    const a = doc.activations.find((x) => x.id === selection.id);
    if (!a) return <p className="rd-hint">该激活条已被删除。</p>;

    const owner = doc.participants.find((p) => p.id === a.participant);
    const startMsg = doc.messages.find((m) => m.id === a.startMessageId);
    const endMsg = a.endMessageId ? doc.messages.find((m) => m.id === a.endMessageId) : undefined;
    const labelOf = (id: Id | undefined): string => {
      const m = id ? doc.messages.find((x) => x.id === id) : undefined;
      return m ? `「${m.label || '无文字'}」` : '未知消息';
    };

    // 能作为断开点的消息：同一条生命线上、且在当前起点之后
    const usable = messagesOnParticipant(doc, a.participant).filter(
      (m) => !startMsg || m.y > startMsg.y,
    );
    const picked = usable.some((m) => m.id === splitAt) ? splitAt : '';

    return (
      <div className="rd-form">
        <h4>激活条</h4>
        <p className="rd-hint">
          挂在「{owner?.name ?? '未知'}」上，起点绑定在 {labelOf(a.startMessageId)}，
          终点
          {endMsg ? `绑定在 ${labelOf(a.endMessageId)}` : '自动延伸到下一条激活条'}。
        </p>
        <p className="rd-hint">
          起止都跟着消息走 —— 拖动消息它会自动跟随。也可以直接**拖激活条的下边缘**
          来截断，拖到最下面会恢复自动延伸。
        </p>

        <h4>分段执行</h4>
        <p className="rd-hint">
          同一个参与者「先执行一段、中途空着、再执行一段」时，在这里断开并接上新的一段。
          只截断不新开的话，图上看不出中间那段没在忙。
        </p>
        <label className="rd-field">
          <span>在这条消息之后断开</span>
          <select
            value={picked}
            data-testid="activation-split-at"
            onChange={(e) => setSplitAt(e.target.value)}
          >
            <option value="">选择一条消息…</option>
            {usable.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label || '（无文字）'}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          data-testid="btn-split-activation"
          disabled={!picked}
          onClick={() => {
            if (picked) store.splitActivation(a.id, picked);
            setSplitAt('');
          }}
        >
          截断并新开一段
        </button>

        <button type="button" className="rd-danger" onClick={() => store.deleteSelection()}>
          删除激活条
        </button>
      </div>
    );
  }

  const n = doc.notes.find((x) => x.id === selection.id);
  if (!n) return <p className="rd-hint">该注释已被删除。</p>;
  return (
    <div className="rd-form">
      <h4>注释</h4>
      <label className="rd-field">
        <span>文字</span>
        <textarea
          rows={3}
          value={n.text}
          data-testid="note-text"
          onChange={(e) => store.updateNote(n.id, { text: e.target.value })}
        />
      </label>
      <button type="button" className="rd-danger" onClick={() => store.deleteSelection()}>
        删除注释
      </button>
    </div>
  );
}

function StyleTab({ state, store }: InspectorProps): ReactNode {
  const t = state.doc.theme;
  return (
    <div className="rd-form">
      <h4>预设主题</h4>
      <div className="rd-theme-grid">
        {THEMES.map((preset) => (
          <button
            key={preset.id}
            type="button"
            className={`rd-theme-chip${t.id === preset.id ? ' is-active' : ''}`}
            style={{ background: preset.background, color: preset.textColor, borderColor: preset.participantStroke }}
            onClick={() => store.setTheme({ ...preset })}
          >
            {preset.name}
          </button>
        ))}
      </div>

      <h4>配色</h4>
      {COLOR_FIELDS.map(([key, label]) => (
        <label className="rd-field rd-color" key={key}>
          <span>{label}</span>
          <input
            type="color"
            value={t[key]}
            data-testid={`theme-${key}`}
            onChange={(e) => store.patchTheme({ [key]: e.target.value } as Partial<Theme>)}
          />
        </label>
      ))}

      <h4>尺寸</h4>
      <label className="rd-field">
        <span>参与者字号</span>
        <input
          type="number"
          min={8}
          max={40}
          value={t.fontSize}
          data-testid="theme-fontSize"
          onChange={(e) => store.patchTheme({ fontSize: Number(e.target.value) })}
        />
      </label>
      <label className="rd-field">
        <span>消息字号</span>
        <input
          type="number"
          min={8}
          max={40}
          value={t.messageFontSize}
          onChange={(e) => store.patchTheme({ messageFontSize: Number(e.target.value) })}
        />
      </label>
      <label className="rd-field">
        <span>线宽</span>
        <input
          type="number"
          min={0.5}
          max={6}
          step={0.25}
          value={t.lineWidth}
          onChange={(e) => store.patchTheme({ lineWidth: Number(e.target.value) })}
        />
      </label>
      <label className="rd-field">
        <span>消息间距</span>
        <input
          type="number"
          min={20}
          max={160}
          value={t.messageSpacing}
          onChange={(e) => store.patchTheme({ messageSpacing: Number(e.target.value) })}
        />
      </label>
      <label className="rd-field">
        <span>参与者间距</span>
        <input
          type="number"
          min={80}
          max={500}
          value={t.participantGap}
          onChange={(e) => store.patchTheme({ participantGap: Number(e.target.value) })}
        />
      </label>

      <label className="rd-field rd-check">
        <input
          type="checkbox"
          checked={t.showSequenceNumbers}
          data-testid="theme-seq"
          onChange={(e) => store.patchTheme({ showSequenceNumbers: e.target.checked })}
        />
        <span>显示消息序号</span>
      </label>

      <label className="rd-field">
        <span>字体</span>
        <input
          value={t.fontFamily}
          onChange={(e) => store.patchTheme({ fontFamily: e.target.value })}
        />
      </label>
    </div>
  );
}
